"""Chart data: history + live updates for one chart, pushed over a WebSocket."""
from __future__ import annotations

import asyncio
import datetime as dt
import logging

from ib_async import IB, BarDataList, RealTimeBarList

from .contracts import Resolved

log = logging.getLogger("streams")

# timeframe -> (IBKR bar size, history duration, seconds per bar or None for D/W/M)
TIMEFRAMES: dict[str, tuple[str, str, int | None]] = {
    "1m": ("1 min", "3 D", 60),
    "5m": ("5 mins", "15 D", 300),
    "15m": ("15 mins", "30 D", 900),
    "1h": ("1 hour", "6 M", 3600),
    "1D": ("1 day", "5 Y", None),
    "1W": ("1 week", "15 Y", None),
    "1M": ("1 month", "20 Y", None),
}


def _ts(t) -> int:
    if isinstance(t, dt.datetime):
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return int(t.timestamp())
    return int(dt.datetime(t.year, t.month, t.day, tzinfo=dt.timezone.utc).timestamp())


def bar_dict(b) -> dict:
    return {
        "time": _ts(b.date if hasattr(b, "date") else b.time),
        "open": float(b.open_ if hasattr(b, "open_") else b.open),
        "high": float(b.high),
        "low": float(b.low),
        "close": float(b.close),
        "volume": float(b.volume or 0),
    }


class ChartStream:
    def __init__(self, ib: IB, queue: asyncio.Queue, r: Resolved, tf: str):
        self.ib, self.queue, self.r, self.tf = ib, queue, r, tf
        self.hist: BarDataList | None = None
        self.rt: RealTimeBarList | None = None
        self.current: dict | None = None  # bar being built from real-time bars

    async def start(self):
        size, duration, _ = TIMEFRAMES[self.tf]
        # (whatToShow, keepUpToDate) attempts, best first. Futures stream live via real-time bars.
        if self.r.sec_type == "FUT":
            attempts = [(self.r.what_to_show, False)]
        elif self.r.sec_type == "CRYPTO":
            attempts = [("AGGTRADES", True), ("AGGTRADES", False), ("MIDPOINT", False)]
        else:
            attempts = [(self.r.what_to_show, True), (self.r.what_to_show, False)]
        bars, keep = [], False
        for what, keep in attempts:
            bars = await self._history(size, duration, what, keep)
            if bars:
                break
        data = [bar_dict(b) for b in bars or []]
        self.current = dict(data[-1]) if data else None
        self.queue.put_nowait({"type": "history", "key": self.r.key, "tf": self.tf,
                               "label": self.r.label, "bars": data})
        if not data:
            return
        if keep:
            bars.updateEvent += self._on_hist_update
        else:
            self.rt = self.ib.reqRealTimeBars(self.r.live, 5, "TRADES" if self.r.sec_type != "CRYPTO" else "MIDPOINT", False)
            self.rt.updateEvent += self._on_rt_update

    async def _history(self, size: str, duration: str, what: str, keep: bool):
        try:
            self.hist = await asyncio.wait_for(self.ib.reqHistoricalDataAsync(
                self.r.history, endDateTime="", durationStr=duration, barSizeSetting=size,
                whatToShow=what, useRTH=self.r.use_rth, formatDate=2,
                keepUpToDate=keep, timeout=20), 25)
        except asyncio.TimeoutError:
            log.warning("history timeout %s %s %s", self.r.key, what, keep)
            self.hist = None
        return self.hist or []

    def _on_hist_update(self, bars: BarDataList, has_new_bar: bool):
        if has_new_bar and len(bars) > 1:
            self.queue.put_nowait({"type": "bar", "bar": bar_dict(bars[-2])})
        if bars:
            self.queue.put_nowait({"type": "bar", "bar": bar_dict(bars[-1])})

    def _on_rt_update(self, bars: RealTimeBarList, has_new_bar: bool):
        if not bars:
            return
        b = bar_dict(bars[-1])
        sec = TIMEFRAMES[self.tf][2]
        cur = self.current
        if sec is not None:
            start = b["time"] - b["time"] % sec
            if cur is None or start > cur["time"]:
                cur = {**b, "time": start}
            else:
                cur = self._merge(cur, b)
        else:
            cur = b if cur is None else self._merge(cur, b)
        self.current = cur
        self.queue.put_nowait({"type": "bar", "bar": cur})

    @staticmethod
    def _merge(cur: dict, b: dict) -> dict:
        return {**cur, "high": max(cur["high"], b["high"]), "low": min(cur["low"], b["low"]),
                "close": b["close"], "volume": cur["volume"] + b["volume"]}

    def stop(self):
        try:
            if self.hist is not None and getattr(self.hist, "keepUpToDate", False):
                self.hist.updateEvent -= self._on_hist_update
                self.ib.cancelHistoricalData(self.hist)
            if self.rt is not None:
                self.rt.updateEvent -= self._on_rt_update
                self.ib.cancelRealTimeBars(self.rt)
        except Exception:  # noqa: BLE001 - best effort on teardown
            log.exception("stop failed")
