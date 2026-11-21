"""Footprint (order flow): every trade split into buy and sell volume at each price, kept per minute.

Live trades come from IBKR tick-by-tick data and are classified against the bid/ask at that moment
(at or above the ask = buy, at or below the bid = sell, in between = tick rule). History comes from
IBKR historical ticks, which carry no bid/ask, so those trades are classified with the tick rule
(up-tick = buy, down-tick = sell, unchanged = same as the last move).

IBKR returns at most 1,000 historical trades per request, so the backfill is limited. To build up
history anyway, every complete minute is saved to a local SQLite file (backend/data/ticks.sqlite) and
re-used on the next load; only the gap since the last saved minute is fetched again.

The browser receives 1-minute footprints and groups them into whatever bars the chart shows.
"""
from __future__ import annotations

import asyncio
import copy
import datetime as dt
import logging
import math
import sqlite3
import time
from pathlib import Path

from ib_async import IB

from .contracts import Resolved
from .streams import TIMEFRAMES

log = logging.getLogger("footprint")

DB = Path(__file__).resolve().parents[1] / "data" / "ticks.sqlite"
KEEP_DAYS = 10
MAX_PAGES = 15  # x 1,000 trades of history per load
PAGE_PAUSE = 0.5  # IBKR pacing: no more than 5 requests for one contract in 2 seconds

Mins = dict[int, dict[float, list[float]]]  # minute start -> price -> [sell, buy]


# ---------- local store ----------
class Store:
    def __init__(self, path: Path = DB):
        self.path = path
        self._db: sqlite3.Connection | None = None

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(self.path)
            self._db.executescript("""
                CREATE TABLE IF NOT EXISTS fp (key TEXT, t INTEGER, price REAL, sell REAL, buy REAL,
                                               PRIMARY KEY (key, t, price)) WITHOUT ROWID;
                CREATE TABLE IF NOT EXISTS cover (key TEXT, start INTEGER, end INTEGER);
            """)
        return self._db

    def load(self, key: str, since: int) -> Mins:
        out: Mins = {}
        for t, p, s, b in self.db.execute("SELECT t, price, sell, buy FROM fp WHERE key=? AND t>=?", (key, since)):
            out.setdefault(t, {})[p] = [s, b]
        return out

    def latest_end(self, key: str) -> int | None:
        row = self.db.execute("SELECT MAX(end) FROM cover WHERE key=?", (key,)).fetchone()
        return row[0] if row and row[0] else None

    def save(self, key: str, mins: Mins, start: int, end: int):
        """Replace minutes in [start, end) and record that range as complete."""
        if end <= start:
            return
        db = self.db
        with db:
            db.execute("DELETE FROM fp WHERE key=? AND t>=? AND t<?", (key, start, end))
            db.executemany("INSERT INTO fp VALUES (?,?,?,?,?)",
                           [(key, t, p, sb[0], sb[1]) for t, lv in mins.items() if start <= t < end for p, sb in lv.items()])
            # merge overlapping / touching ranges
            rows = db.execute("SELECT start, end FROM cover WHERE key=? AND end>=? AND start<=?", (key, start, end)).fetchall()
            lo = min([start] + [r[0] for r in rows])
            hi = max([end] + [r[1] for r in rows])
            db.execute("DELETE FROM cover WHERE key=? AND end>=? AND start<=?", (key, start, end))
            db.execute("INSERT INTO cover VALUES (?,?,?)", (key, lo, hi))
            cut = int(time.time()) - KEEP_DAYS * 86400
            db.execute("DELETE FROM fp WHERE key=? AND t<?", (key, cut))
            db.execute("DELETE FROM cover WHERE key=? AND end<?", (key, cut))
            db.execute("UPDATE cover SET start=? WHERE key=? AND start<?", (cut, key, cut))


store = Store()


# ---------- helpers ----------
def _add(mins: Mins, t: float, price: float, size: float, buy: bool, tick: float):
    m = int(t) - int(t) % 60
    p = round(round(price / tick) * tick, 10)
    cell = mins.setdefault(m, {}).setdefault(p, [0.0, 0.0])
    cell[1 if buy else 0] += size


def _merge(*parts: Mins) -> Mins:
    out: Mins = {}
    for part in parts:
        for t, lv in part.items():
            dst = out.setdefault(t, {})
            for p, (s, b) in lv.items():
                c = dst.setdefault(p, [0.0, 0.0])
                c[0] += s
                c[1] += b
    return out


def _wire(mins: Mins, only: set[int] | None = None) -> list:
    keys = sorted(only if only is not None else mins)
    return [[t, [[p, round(sb[0], 8), round(sb[1], 8)] for p, sb in sorted(mins[t].items())]] for t in keys if t in mins]


def _num(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return math.nan
    return f if math.isfinite(f) and f < 1e300 else math.nan


class FootprintStream:
    """Footprint data for one chart. Pushes {"type":"fp"} snapshots and {"type":"fp_up"} live updates."""

    def __init__(self, ib: IB, queue: asyncio.Queue, r: Resolved, tf: str):
        self.ib, self.queue, self.r, self.tf = ib, queue, r, tf
        self.tick = 0.01
        self.base: Mins = {}  # minutes loaded from the store
        self.hist: Mins = {}  # minutes built from historical ticks
        self.live: Mins = {}  # minutes built from live ticks
        self.dirty: set[int] = set()
        self.t0 = 0.0  # when the live feed started
        self.cov_start: int | None = None  # first minute we know is complete (None until backfill ends)
        self.live_ok = False
        self.last_px = math.nan
        self.last_dir = 1
        self.tbt = None
        self.quote = None
        self._c_tbt = copy.copy(r.live)  # own contract objects so our tickers stay separate from the quote panel
        self._c_q = copy.copy(r.live)
        self.tasks: list[asyncio.Task] = []
        self.stopped = False

    # ----- lifecycle -----
    async def start(self):
        if TIMEFRAMES[self.tf][2] is None:
            self.queue.put_nowait({"type": "fp", "key": self.r.key, "tf": self.tf, "mins": [], "tick": self.tick,
                                   "status": "unsupported", "note": "Footprint works on intraday timeframes (1m to 4h)."})
            return
        try:
            [cd] = (await asyncio.wait_for(self.ib.reqContractDetailsAsync(self.r.live), 10)) or [None]
            if cd and cd.minTick:
                self.tick = float(cd.minTick)
        except Exception:  # noqa: BLE001
            log.warning("no contract details for %s", self.r.key)
        self.t0 = time.time()
        self.quote = self.ib.reqMktData(self._c_q, "", False, False)
        self.tbt = self.ib.reqTickByTickData(self._c_tbt, "AllLast", 0, False)
        self.tbt.updateEvent += self._on_ticks
        since = int(self.t0) - (3 if self.tf == "1m" else KEEP_DAYS) * 86400
        try:
            self.base = store.load(self.r.key, since)
            stop_at = store.latest_end(self.r.key)
        except Exception:  # noqa: BLE001
            log.exception("footprint store unavailable")
            self.base, stop_at = {}, None
        self._snapshot("loading")
        self.tasks = [asyncio.create_task(self._backfill(stop_at)), asyncio.create_task(self._pump())]

    def stop(self):
        self.stopped = True
        for t in self.tasks:
            t.cancel()
        try:
            if self.tbt is not None:
                self.tbt.updateEvent -= self._on_ticks
                self.ib.cancelTickByTickData(self._c_tbt, "AllLast")
            if self.quote is not None:
                self.ib.cancelMktData(self._c_q)
        except Exception:  # noqa: BLE001
            log.exception("footprint stop failed")
        self._persist()

    # ----- history -----
    async def _backfill(self, stop_at: int | None):
        ticks: list[tuple[float, float, float]] = []  # (time, price, size), oldest first
        end = dt.datetime.fromtimestamp(self.t0, dt.timezone.utc)
        limit = int(self.t0) - KEEP_DAYS * 86400
        if stop_at and stop_at > limit:
            limit = stop_at
        earliest = math.inf
        note = ""
        for page in range(MAX_PAGES):
            if self.stopped:
                return
            try:
                got = await asyncio.wait_for(self.ib.reqHistoricalTicksAsync(
                    self._c_tbt, "", end, 1000, "TRADES", useRth=False), 30)
            except Exception as e:  # noqa: BLE001
                log.warning("historical ticks failed for %s: %s", self.r.key, e)
                note = "IBKR did not return trade history; footprint fills in from live trades."
                break
            rows = [(t.time.timestamp(), _num(t.price), _num(t.size)) for t in got or []]
            rows = [x for x in rows if x[2] > 0 and x[1] > 0 and x[0] < int(self.t0)]
            if not rows:
                break
            first = min(x[0] for x in rows)
            # the page repeats the trades of its boundary second: keep the new page's copy of them
            # (keep IBKR's order within a second: the tick rule depends on it)
            rows.sort(key=lambda x: x[0])
            ticks = rows + [x for x in ticks if int(x[0]) != int(earliest)]
            if first >= earliest:  # more than 1,000 trades in one second: step past it
                first = earliest - 1
            earliest = first
            self.hist = self._classify(ticks, limit)
            self._patch(set(self.hist), "loading")
            if earliest <= limit:
                break
            end = dt.datetime.fromtimestamp(earliest, dt.timezone.utc)
            await asyncio.sleep(PAGE_PAUSE)
        if stop_at and earliest <= stop_at:
            self.cov_start = stop_at  # joins up with what is already saved
        elif ticks:
            self.cov_start = int(earliest) - int(earliest) % 60 + 60
        else:
            self.cov_start = int(self.t0) - int(self.t0) % 60 + 60
        self.reach = int(earliest) if ticks and earliest > limit else None
        self._patch(set(self.hist), "ready", note)
        self._persist()

    def _classify(self, ticks: list[tuple[float, float, float]], limit: float) -> Mins:
        mins: Mins = {}
        prev, direction = math.nan, 1
        for t, p, s in ticks:
            if p > prev:
                direction = 1
            elif p < prev:
                direction = -1
            prev = p
            if t < limit:
                continue
            _add(mins, t, p, s, direction > 0, self.tick)
        if ticks and not self.live_ok:  # seed the live tick rule
            self.last_px, self.last_dir = ticks[-1][1], direction
        return mins

    # ----- live -----
    def _on_ticks(self, ticker):
        q = self.quote
        bid = _num(q.bid) if q else math.nan
        ask = _num(q.ask) if q else math.nan
        for tk in ticker.tickByTicks or []:
            p, s = _num(getattr(tk, "price", None)), _num(getattr(tk, "size", None))
            if not (p > 0 and s > 0):
                continue
            if p > self.last_px:
                self.last_dir = 1
            elif p < self.last_px:
                self.last_dir = -1
            self.last_px = p
            if ask > 0 and p >= ask:
                buy = True
            elif bid > 0 and p <= bid:
                buy = False
            else:
                buy = self.last_dir > 0
            t = tk.time.timestamp() if getattr(tk, "time", None) else time.time()
            _add(self.live, t, p, s, buy, self.tick)
            self.dirty.add(int(t) - int(t) % 60)
            self.live_ok = True

    async def _pump(self):
        n = 0
        while not self.stopped:
            await asyncio.sleep(0.5)
            if self.dirty:
                self._patch(self.dirty)
                self.dirty = set()
            n += 1
            if n % 120 == 0:
                self._persist()

    def _patch(self, keys: set[int], status: str | None = None, note: str = ""):
        """Send the full content of the given minutes (replacing what the browser has for them)."""
        parts = [{t: src[t] for t in keys if t in src} for src in (self.base, self.hist, self.live)]
        msg = {"type": "fp_up", "key": self.r.key, "tf": self.tf, "mins": _wire(_merge(*parts), keys)}
        if status:
            msg.update(status=status, note=note, reach=getattr(self, "reach", None))
        self.queue.put_nowait(msg)

    # ----- output -----
    def _snapshot(self, status: str, note: str = ""):
        mins = _merge(self.base, self.hist, self.live)
        self.queue.put_nowait({"type": "fp", "key": self.r.key, "tf": self.tf, "tick": self.tick,
                               "status": status, "note": note, "mins": _wire(mins)})

    def _persist(self):
        if self.cov_start is None:
            return
        now = time.time() if self.live_ok else self.t0
        end = int(now) - int(now) % 60
        try:
            store.save(self.r.key, _merge(self.hist, self.live), self.cov_start, end)
        except Exception:  # noqa: BLE001
            log.exception("footprint save failed")
