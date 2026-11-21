"""Data providers other than IBKR: Binance, OANDA, IG, Polygon and Databento.

A provider symbol key starts with the provider's name, e.g. "BINANCE:BTCUSDT", "OANDA:EUR_USD",
"IG:CS.D.EURUSD.CFD.IP", "POLYGON:AAPL", "DATABENTO:GLBX.MDP3:ES.c.0". Everything else is an IBKR key.

Each provider gives chart history, live bars (a websocket where the provider has a free one, otherwise
polling), symbol search and a watchlist quote. Keys and passwords live in DATA_DIR/providers.json on this
machine only, entered from the app's Data providers screen.
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import datetime as dt
import io
import json
import logging
import re
import time
from typing import AsyncIterator, Callable

import httpx

from .paths import DATA_DIR

log = logging.getLogger("providers")
CFG_FILE = DATA_DIR / "providers.json"

# chart timeframe -> seconds per bar (None = calendar D/W/M)
TF_SEC = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1D": 86400, "1W": 604800, "1M": None}

# ---------- settings ----------
FIELDS: dict[str, list[dict]] = {
    "binance": [],
    "oanda": [{"name": "token", "label": "API token", "secret": True},
              {"name": "accountId", "label": "Account ID (optional)"},
              {"name": "env", "label": "Environment", "options": ["live", "practice"]}],
    "ig": [{"name": "apiKey", "label": "API key", "secret": True},
           {"name": "username", "label": "Username"},
           {"name": "password", "label": "Password", "secret": True},
           {"name": "env", "label": "Environment", "options": ["live", "demo"]}],
    "polygon": [{"name": "apiKey", "label": "API key", "secret": True}],
    "databento": [{"name": "apiKey", "label": "API key", "secret": True},
                  {"name": "dataset", "label": "Futures dataset", "placeholder": "GLBX.MDP3"}],
}
DEFAULTS = {"binance": {"enabled": True}, "oanda": {"env": "live"}, "ig": {"env": "live"},
            "databento": {"dataset": "GLBX.MDP3"}}


def load_cfg() -> dict:
    try:
        cfg = json.loads(CFG_FILE.read_text())
    except (OSError, ValueError):
        cfg = {}
    return {name: {**DEFAULTS.get(name, {}), **cfg.get(name, {})} for name in FIELDS}


def save_cfg(cfg: dict):
    CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(cfg, indent=2))
    with contextlib.suppress(OSError):
        CFG_FILE.chmod(0o600)


def public_cfg() -> dict:
    """Settings for the browser: secrets replaced by a flag saying one is stored."""
    out = {}
    for name, c in load_cfg().items():
        pub = {"enabled": bool(c.get("enabled")), "status": STATUS.get(name, "")}
        for f in FIELDS[name]:
            v = c.get(f["name"], "")
            pub[f["name"]] = ("•••• saved" if v else "") if f.get("secret") else v
        out[name] = pub
    return out


def update_cfg(body: dict):
    cfg = load_cfg()
    for name, vals in body.items():
        if name not in FIELDS or not isinstance(vals, dict):
            continue
        c = cfg[name]
        if "enabled" in vals:
            c["enabled"] = bool(vals["enabled"])
        for f in FIELDS[name]:
            if f["name"] not in vals:
                continue
            v = str(vals[f["name"]]).strip()
            if f.get("secret") and v.startswith("••••"):
                continue  # unchanged
            c[f["name"]] = v
        _INSTANCES.pop(name, None)  # reconnect with the new settings
    try:
        raw = json.loads(CFG_FILE.read_text())
    except (OSError, ValueError):
        raw = {}
    raw.update(cfg)
    save_cfg(raw)


STATUS: dict[str, str] = {}

# ---------- helpers ----------
_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=20, headers={"User-Agent": "ibkr-charts"})
    return _client


def bucket(t: int, tf: str) -> int:
    """Start of the chart bar holding time t (UTC seconds)."""
    sec = TF_SEC[tf]
    if sec is None:
        d = dt.datetime.fromtimestamp(t, dt.timezone.utc)
        return int(dt.datetime(d.year, d.month, 1, tzinfo=dt.timezone.utc).timestamp())
    if tf == "1W":  # weeks start Monday
        return t - (t - 345600) % 604800
    return t - t % sec


def resample(bars: list[dict], tf: str) -> list[dict]:
    """Group finer bars (sorted, UTC) into chart bars."""
    out: list[dict] = []
    for b in bars:
        s = bucket(b["time"], tf)
        if out and out[-1]["time"] == s:
            o = out[-1]
            o["high"] = max(o["high"], b["high"]); o["low"] = min(o["low"], b["low"])
            o["close"] = b["close"]; o["volume"] += b["volume"]
        else:
            out.append({**b, "time": s})
    return out


def bar(t: float, o, h, l, c, v=0.0) -> dict:  # noqa: E741
    return {"time": int(t), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v or 0)}


class Provider:
    name = ""
    title = ""
    poll = 2.0  # seconds between live polls

    def __init__(self, cfg: dict):
        self.cfg = cfg

    def ready(self) -> str | None:
        """None when usable, else what is missing."""
        return None

    async def search(self, q: str) -> list[dict]:
        return []

    async def history(self, sym: str, tf: str) -> list[dict]:
        raise NotImplementedError

    async def recent(self, sym: str, tf: str) -> list[dict]:
        """Latest bars for live polling (default: the full history call)."""
        return (await self.history(sym, tf))[-3:]

    async def live(self, sym: str, tf: str) -> AsyncIterator[dict]:
        """Yield the current (and newly closed) bars. Default: poll recent()."""
        while True:
            await asyncio.sleep(self.poll)
            try:
                for b in await self.recent(sym, tf):
                    yield b
            except Exception as e:  # noqa: BLE001
                log.warning("%s live poll %s: %s", self.name, sym, e)
                await asyncio.sleep(5)

    async def quote(self, sym: str) -> dict | None:
        return None

    def label(self, sym: str) -> str:
        return f"{sym} · {self.title}"


# ---------- Binance (public market data, no key) ----------
class Binance(Provider):
    name, title = "binance", "Binance"
    REST = "https://data-api.binance.vision/api/v3"
    WS = "wss://data-stream.binance.vision/ws"
    IV = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "2h": "2h", "4h": "4h", "1D": "1d", "1W": "1w", "1M": "1M"}
    _symbols: list[dict] | None = None

    async def _get(self, path: str, **params):
        r = await client().get(f"{self.REST}{path}", params=params)
        r.raise_for_status()
        return r.json()

    @staticmethod
    def _k(k) -> dict:
        return bar(k[0] / 1000, k[1], k[2], k[3], k[4], k[5])

    async def history(self, sym, tf):
        out: list[dict] = []
        end = None
        for _ in range(3):  # up to 3,000 bars
            params = {"symbol": sym, "interval": self.IV[tf], "limit": 1000}
            if end:
                params["endTime"] = end
            ks = await self._get("/klines", **params)
            if not ks:
                break
            out = [self._k(k) for k in ks] + out
            if len(ks) < 1000:
                break
            end = ks[0][0] - 1
        return out

    async def recent(self, sym, tf):
        return [self._k(k) for k in await self._get("/klines", symbol=sym, interval=self.IV[tf], limit=2)]

    async def live(self, sym, tf):
        import websockets  # installed with uvicorn[standard]
        url = f"{self.WS}/{sym.lower()}@kline_{self.IV[tf]}"
        while True:
            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    async for raw in ws:
                        k = json.loads(raw).get("k")
                        if k:
                            yield bar(k["t"] / 1000, k["o"], k["h"], k["l"], k["c"], k["v"])
            except Exception as e:  # noqa: BLE001
                log.warning("binance stream %s: %s; polling until it reconnects", sym, e)
                for _ in range(10):
                    await asyncio.sleep(2)
                    with contextlib.suppress(Exception):
                        for b in await self.recent(sym, tf):
                            yield b

    async def search(self, q):
        if Binance._symbols is None:
            info = await self._get("/exchangeInfo", permissions="SPOT")
            Binance._symbols = [s for s in info.get("symbols", []) if s.get("status") == "TRADING"]
        q = q.upper().replace("/", "")
        hits = [s for s in Binance._symbols if s["symbol"].startswith(q) or s["baseAsset"] == q]
        hits.sort(key=lambda s: (s["baseAsset"] != q, s["quoteAsset"] not in ("USDT", "USDC", "EUR", "BTC"), len(s["symbol"])))
        return [{"key": f"BINANCE:{s['symbol']}", "symbol": s["symbol"], "description": f"{s['baseAsset']} / {s['quoteAsset']} · Binance",
                 "type": "crypto"} for s in hits[:12]]

    async def quote(self, sym):
        t = await self._get("/ticker/24hr", symbol=sym)
        last, opn = float(t["lastPrice"]), float(t["openPrice"])
        return {"last": last, "prevClose": opn, "change": last - opn, "changePct": float(t["priceChangePercent"]),
                "volume": float(t["volume"]), "high": float(t["highPrice"]), "low": float(t["lowPrice"]),
                "bid": float(t["bidPrice"]), "ask": float(t["askPrice"])}


# ---------- OANDA (v20 REST) ----------
class Oanda(Provider):
    name, title = "oanda", "OANDA"
    poll = 2.0
    GRAN = {"1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "2h": "H2", "4h": "H4", "1D": "D", "1W": "W", "1M": "M"}
    _instruments: list[dict] | None = None

    def ready(self):
        return None if self.cfg.get("token") else "Add your OANDA API token"

    @property
    def base(self):
        return "https://api-fxpractice.oanda.com" if self.cfg.get("env") == "practice" else "https://api-fxtrade.oanda.com"

    async def _get(self, path: str, **params):
        r = await client().get(f"{self.base}{path}", params=params, headers={
            "Authorization": f"Bearer {self.cfg['token']}", "Accept-Datetime-Format": "UNIX"})
        if r.status_code == 401:
            raise ValueError("OANDA refused the token (check it, and live vs practice)")
        r.raise_for_status()
        return r.json()

    async def account(self) -> str:
        if not self.cfg.get("accountId"):
            accts = (await self._get("/v3/accounts")).get("accounts", [])
            if not accts:
                raise ValueError("No OANDA account found for this token")
            self.cfg["accountId"] = accts[0]["id"]
        return self.cfg["accountId"]

    async def _candles(self, sym, tf, count):
        params = {"granularity": self.GRAN[tf], "count": count, "price": "M"}
        if tf == "1D":
            params.update(dailyAlignment=17, alignmentTimezone="America/New_York")
        if tf == "1W":
            params.update(weeklyAlignment="Monday")
        cs = (await self._get(f"/v3/instruments/{sym}/candles", **params)).get("candles", [])
        return [bar(float(c["time"]), c["mid"]["o"], c["mid"]["h"], c["mid"]["l"], c["mid"]["c"], c.get("volume", 0)) for c in cs]

    async def history(self, sym, tf):
        return await self._candles(sym, tf, 5000)

    async def recent(self, sym, tf):
        return await self._candles(sym, tf, 2)

    async def search(self, q):
        if Oanda._instruments is None:
            acct = await self.account()
            Oanda._instruments = (await self._get(f"/v3/accounts/{acct}/instruments")).get("instruments", [])
        qn = q.upper().replace("/", "").replace("_", "")
        hits = [i for i in Oanda._instruments if qn in i["name"].replace("_", "") or qn in i.get("displayName", "").upper().replace("/", "")]
        hits.sort(key=lambda i: (not i["name"].replace("_", "").startswith(qn), i["name"]))
        return [{"key": f"OANDA:{i['name']}", "symbol": i["name"].replace("_", ""), "description": f"{i.get('displayName', i['name'])} · OANDA",
                 "type": {"CURRENCY": "forex", "CFD": "cfd", "METAL": "commodity"}.get(i.get("type", ""), "cfd")} for i in hits[:12]]

    async def quote(self, sym):
        acct = await self.account()
        p = (await self._get(f"/v3/accounts/{acct}/pricing", instruments=sym)).get("prices", [])
        if not p:
            return None
        bid, ask = float(p[0]["bids"][0]["price"]), float(p[0]["asks"][0]["price"])
        last = (bid + ask) / 2
        d = await self._candles(sym, "1D", 2)
        prev = d[-2]["close"] if len(d) > 1 else None
        return {"last": last, "bid": bid, "ask": ask, "prevClose": prev, "change": last - prev if prev else None,
                "changePct": (last - prev) / prev * 100 if prev else None, "high": d[-1]["high"] if d else None, "low": d[-1]["low"] if d else None}

    def label(self, sym):
        return f"{sym.replace('_', '/')} · OANDA"


# ---------- IG (REST; live from market snapshots) ----------
class IG(Provider):
    name, title = "ig", "IG"
    poll = 2.0
    RES = {"1m": "MINUTE", "5m": "MINUTE_5", "15m": "MINUTE_15", "30m": "MINUTE_30", "1h": "HOUR", "2h": "HOUR_2", "4h": "HOUR_4",
           "1D": "DAY", "1W": "WEEK", "1M": "MONTH"}
    # IG's historical allowance is 10,000 price points a week, so charts load a modest number of bars
    MAX_POINTS = {"1m": 500, "5m": 500, "15m": 400, "30m": 400, "1h": 500, "2h": 400, "4h": 400, "1D": 500, "1W": 300, "1M": 200}

    def __init__(self, cfg):
        super().__init__(cfg)
        self.tokens: dict[str, str] | None = None
        self.hist_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
        self.cur: dict[tuple[str, str], dict] = {}

    def ready(self):
        missing = [f for f in ("apiKey", "username", "password") if not self.cfg.get(f)]
        return f"Add your IG {', '.join(missing)}" if missing else None

    @property
    def base(self):
        return "https://demo-api.ig.com/gateway/deal" if self.cfg.get("env") == "demo" else "https://api.ig.com/gateway/deal"

    async def _login(self):
        r = await client().post(f"{self.base}/session", json={"identifier": self.cfg["username"], "password": self.cfg["password"]},
                                headers={"X-IG-API-KEY": self.cfg["apiKey"], "Version": "2", "Accept": "application/json; charset=UTF-8"})
        if r.status_code >= 400:
            raise ValueError(f"IG login failed: {r.json().get('errorCode', r.status_code)}")
        self.tokens = {"CST": r.headers["CST"], "X-SECURITY-TOKEN": r.headers["X-SECURITY-TOKEN"]}

    async def _get(self, path: str, version: str = "1", **params):
        for attempt in (0, 1):
            if self.tokens is None:
                await self._login()
            r = await client().get(f"{self.base}{path}", params=params, headers={
                "X-IG-API-KEY": self.cfg["apiKey"], "Version": version, "Accept": "application/json; charset=UTF-8", **(self.tokens or {})})
            if r.status_code == 401 and attempt == 0:
                self.tokens = None  # session expired
                continue
            if r.status_code >= 400:
                code = r.json().get("errorCode", r.status_code) if r.content else r.status_code
                if "allowance" in str(code):
                    raise ValueError("IG's weekly historical data allowance is used up")
                raise ValueError(f"IG: {code}")
            return r.json()
        raise ValueError("IG session failed")

    @staticmethod
    def _mid(p: dict) -> float | None:
        b, a = p.get("bid"), p.get("ask")
        if b is not None and a is not None:
            return (b + a) / 2
        return p.get("lastTraded") or b or a

    async def history(self, sym, tf):
        key = (sym, tf)
        hit = self.hist_cache.get(key)
        if hit and time.time() - hit[0] < 600:  # reuse for 10 minutes: every bar counts against the allowance
            bars = hit[1]
        else:
            d = await self._get(f"/prices/{sym}", "3", resolution=self.RES[tf], max=self.MAX_POINTS[tf], pageSize=0)
            bars = []
            for p in d.get("prices", []):
                t = dt.datetime.fromisoformat(p["snapshotTimeUTC"]).replace(tzinfo=dt.timezone.utc).timestamp()
                o, h, l, c = (self._mid(p[k]) for k in ("openPrice", "highPrice", "lowPrice", "closePrice"))  # noqa: E741
                if None not in (o, h, l, c):
                    bars.append(bar(t, o, h, l, c, p.get("lastTradedVolume") or 0))
            self.hist_cache[key] = (time.time(), bars)
        if bars:
            self.cur[key] = dict(bars[-1])
        return bars

    async def live(self, sym, tf):
        """IG streams over Lightstreamer; here the market snapshot is polled and folded into the current bar."""
        key = (sym, tf)
        while True:
            await asyncio.sleep(self.poll)
            try:
                snap = (await self._get(f"/markets/{sym}", "3")).get("snapshot", {})
            except Exception as e:  # noqa: BLE001
                log.warning("ig poll %s: %s", sym, e)
                await asyncio.sleep(5)
                continue
            b, a = snap.get("bid"), snap.get("offer")
            if b is None or a is None:
                continue
            px = (b + a) / 2
            start = bucket(int(time.time()), tf)
            cur = self.cur.get(key)
            if cur is None or start > cur["time"]:
                cur = bar(start, px, px, px, px)
            else:
                cur = {**cur, "high": max(cur["high"], px), "low": min(cur["low"], px), "close": px}
            self.cur[key] = cur
            yield cur

    async def search(self, q):
        d = await self._get("/markets", searchTerm=q)
        return [{"key": f"IG:{m['epic']}", "symbol": m.get("instrumentName", m["epic"]),
                 "description": f"{m['epic']} · {m.get('instrumentType', '').title()}{' · ' + m['expiry'] if m.get('expiry') not in (None, '-') else ''} · IG",
                 "type": "cfd"} for m in d.get("markets", [])[:15]]

    async def quote(self, sym):
        s = (await self._get(f"/markets/{sym}", "3")).get("snapshot", {})
        b, a = s.get("bid"), s.get("offer")
        if b is None or a is None:
            return None
        last = (b + a) / 2
        chg = s.get("netChange")
        return {"last": last, "bid": b, "ask": a, "change": chg, "changePct": s.get("percentageChange"),
                "prevClose": last - chg if chg is not None else None, "high": s.get("high"), "low": s.get("low")}


# ---------- Polygon (US stocks) ----------
class Polygon(Provider):
    name, title = "polygon", "Polygon"
    poll = 15.0  # the free plan allows 5 calls a minute
    BASE = "https://api.polygon.io"
    SPAN = {"1m": (1, "minute", 5), "5m": (5, "minute", 20), "15m": (15, "minute", 45), "30m": (30, "minute", 90),
            "1h": (1, "hour", 180), "2h": (2, "hour", 365), "4h": (4, "hour", 365), "1D": (1, "day", 1825),
            "1W": (1, "week", 3650), "1M": (1, "month", 7300)}

    def ready(self):
        return None if self.cfg.get("apiKey") else "Add your Polygon API key"

    async def _get(self, path: str, **params):
        r = await client().get(f"{self.BASE}{path}", params={**params, "apiKey": self.cfg["apiKey"]})
        if r.status_code in (401, 403):
            raise ValueError(f"Polygon: {r.json().get('message', 'not authorised for this data on your plan')}")
        if r.status_code == 429:
            raise ValueError("Polygon: too many requests for your plan (free plan: 5 a minute)")
        r.raise_for_status()
        return r.json()

    async def _aggs(self, sym, tf, days):
        mult, span, _ = self.SPAN[tf]
        end = dt.date.today() + dt.timedelta(days=1)
        start = end - dt.timedelta(days=days)
        d = await self._get(f"/v2/aggs/ticker/{sym}/range/{mult}/{span}/{start}/{end}", adjusted="true", sort="asc", limit=50000)
        return [bar(a["t"] / 1000, a["o"], a["h"], a["l"], a["c"], a.get("v", 0)) for a in d.get("results", []) or []]

    async def history(self, sym, tf):
        return await self._aggs(sym, tf, self.SPAN[tf][2])

    async def recent(self, sym, tf):
        return (await self._aggs(sym, tf, 4 if TF_SEC[tf] and TF_SEC[tf] < 86400 else 40))[-2:]

    async def search(self, q):
        d = await self._get("/v3/reference/tickers", search=q, active="true", market="stocks", limit=15)
        res = d.get("results", []) or []
        res.sort(key=lambda t: (t["ticker"] != q.upper(), len(t["ticker"])))
        return [{"key": f"POLYGON:{t['ticker']}", "symbol": t["ticker"],
                 "description": f"{t.get('name', '')} · {t.get('primary_exchange', '')} · Polygon".replace(" ·  ·", " ·"), "type": "stock"} for t in res]

    async def quote(self, sym):
        d = (await self._get(f"/v2/aggs/ticker/{sym}/prev", adjusted="true")).get("results") or []
        if not d:
            return None
        prev = d[0]["c"]
        last_bars = await self.recent(sym, "1m")
        last = last_bars[-1]["close"] if last_bars else prev
        return {"last": last, "prevClose": prev, "change": last - prev, "changePct": (last - prev) / prev * 100}


# ---------- Databento (futures history; pay per use) ----------
FUT_ROOTS = set("ES NQ RTY YM MES MNQ M2K MYM EMD CL MCL NG RB HO QM GC MGC SI SIL HG PL PA ZB ZN ZF ZT UB ZC ZS ZW ZL ZM KE HE LE GF "
                "6E 6B 6J 6A 6C 6S 6N 6M M6E BTC MBT ETH MET SR3 VX".split())


class Databento(Provider):
    name, title = "databento", "Databento"
    poll = 60.0
    BASE = "https://hist.databento.com/v0"
    # chart tf -> (Databento schema, lookback)
    SCHEMA = {"1m": ("ohlcv-1m", 3), "5m": ("ohlcv-1m", 10), "15m": ("ohlcv-1m", 20), "30m": ("ohlcv-1h", 60), "1h": ("ohlcv-1h", 120),
              "2h": ("ohlcv-1h", 240), "4h": ("ohlcv-1h", 365), "1D": ("ohlcv-1d", 1825), "1W": ("ohlcv-1d", 3650), "1M": ("ohlcv-1d", 7300)}

    def ready(self):
        return None if self.cfg.get("apiKey") else "Add your Databento API key"

    async def _range(self, dataset, sym, schema, start: dt.datetime) -> list[dict]:
        params = {"dataset": dataset, "symbols": sym, "schema": schema, "start": start.isoformat(),
                  "stype_in": "continuous" if ".c." in sym or ".v." in sym or ".n." in sym else "raw_symbol",
                  "encoding": "csv", "pretty_px": "true", "pretty_ts": "false"}
        r = await client().post(f"{self.BASE}/timeseries.get_range", data=params, auth=(self.cfg["apiKey"], ""), timeout=60)
        if r.status_code == 422 and "end" in r.text:
            # asked past the data that is available yet: retry ending at the dataset's available end
            rng = await client().get(f"{self.BASE}/metadata.get_dataset_range", params={"dataset": dataset}, auth=(self.cfg["apiKey"], ""))
            params["end"] = rng.json().get("end") or rng.json().get("end_date")
            r = await client().post(f"{self.BASE}/timeseries.get_range", data=params, auth=(self.cfg["apiKey"], ""), timeout=60)
        if r.status_code >= 400:
            raise ValueError(f"Databento: {r.text[:200]}")
        rows = csv.DictReader(io.StringIO(r.text))
        return [bar(int(x["ts_event"]) / 1e9, x["open"], x["high"], x["low"], x["close"], x["volume"]) for x in rows]

    def _split(self, sym: str) -> tuple[str, str]:
        ds, s = sym.split(":", 1) if ":" in sym else (self.cfg.get("dataset") or "GLBX.MDP3", sym)
        # keys may arrive upper-cased; Databento's continuous symbols are like ES.c.0
        s = re.sub(r"\.([CVN])\.(\d+)$", lambda m: f".{m.group(1).lower()}.{m.group(2)}", s)
        return ds.upper(), s

    async def history(self, sym, tf):
        ds, s = self._split(sym)
        schema, days = self.SCHEMA[tf]
        bars = await self._range(ds, s, schema, dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days))
        return resample(sorted(bars, key=lambda b: b["time"]), tf)

    async def recent(self, sym, tf):
        ds, s = self._split(sym)
        schema = "ohlcv-1m" if (TF_SEC[tf] or 86400) < 86400 else "ohlcv-1d"
        back = dt.timedelta(seconds=(TF_SEC[tf] or 86400 * 31) * 2)
        bars = await self._range(ds, s, schema, dt.datetime.now(dt.timezone.utc) - back)
        return resample(sorted(bars, key=lambda b: b["time"]), tf)[-2:]

    async def search(self, q):
        """No free symbol search: offer the continuous front month of the root that was typed."""
        root = q.upper().strip()
        explicit = root.endswith("1!")
        root = root.rstrip("1!")
        if not root.isalnum() or len(root) > 4 or not (explicit or root in FUT_ROOTS):
            return []
        ds = self.cfg.get("dataset") or "GLBX.MDP3"
        return [{"key": f"DATABENTO:{ds}:{root}.c.0", "symbol": f"{root}1!", "description": f"{root} front month (continuous) · {ds} · Databento",
                 "type": "futures"}]

    def label(self, sym):
        ds, s = self._split(sym)
        return f"{s} · {ds} · Databento"


CLASSES: dict[str, type[Provider]] = {"BINANCE": Binance, "OANDA": Oanda, "IG": IG, "POLYGON": Polygon, "DATABENTO": Databento}
_INSTANCES: dict[str, Provider] = {}


def is_provider_key(key: str) -> bool:
    return key.split(":", 1)[0].upper() in CLASSES


def get(prefix: str) -> Provider:
    prefix = prefix.upper()
    cls = CLASSES[prefix]
    p = _INSTANCES.get(cls.name)
    if p is None:
        p = _INSTANCES[cls.name] = cls(load_cfg()[cls.name])
    if not p.cfg.get("enabled"):
        raise ValueError(f"{cls.title} is switched off in Data providers")
    missing = p.ready()
    if missing:
        raise ValueError(missing)
    return p


def split(key: str) -> tuple[Provider, str]:
    prefix, sym = key.split(":", 1)
    return get(prefix), sym


async def search_all(q: str) -> list[dict]:
    """Search every switched-on provider, in parallel; a failing one is skipped."""
    names = [k for k, cls in CLASSES.items() if load_cfg()[cls.name].get("enabled")]

    async def one(k):
        try:
            return await asyncio.wait_for(get(k).search(q), 8)
        except Exception as e:  # noqa: BLE001
            log.info("search %s: %s", k, e)
            return []
    results = await asyncio.gather(*(one(k) for k in names))
    return [r for rs in results for r in rs]


async def test(name: str) -> str:
    """Quick check used by the settings screen."""
    prefix = next(k for k, c in CLASSES.items() if c.name == name)
    _INSTANCES.pop(name, None)
    p = get(prefix)
    sample = {"binance": "BTCUSDT", "oanda": "EUR_USD", "polygon": "AAPL", "databento": "ES.c.0"}.get(name)
    if name == "ig":
        await p._login()  # type: ignore[attr-defined]
        STATUS[name] = "Connected"
        return "Logged in to IG"
    bars = await p.history(sample, "1D") if sample else []
    STATUS[name] = "Connected"
    return f"OK: {len(bars)} daily bars of {sample}"


class ProviderStream:
    """Chart history + live bars from a provider, with the same messages as the IBKR ChartStream."""

    def __init__(self, queue: asyncio.Queue, key: str, tf: str, reply_key: str | None = None):
        self.queue, self.key, self.tf = queue, key, tf
        self.reply_key = reply_key or key
        self.task: asyncio.Task | None = None

    async def start(self):
        p, sym = split(self.key)
        bars = await p.history(sym, self.tf)
        self.queue.put_nowait({"type": "history", "key": self.reply_key, "tf": self.tf, "label": p.label(sym), "bars": bars})
        if not bars:
            self.queue.put_nowait({"type": "notice", "message": f"{p.title} returned no data for {sym}"})
            return
        last = {"time": bars[-1]["time"]}

        async def run():
            async for b in p.live(sym, self.tf):
                if b["time"] >= last["time"]:
                    last["time"] = b["time"]
                    self.queue.put_nowait({"type": "bar", "bar": b})
        self.task = asyncio.create_task(run())

    def stop(self):
        if self.task:
            self.task.cancel()


async def quote_loop(keys: Callable[[], list[str]], put: Callable[[dict], None]):
    """Watchlist quotes for provider symbols, polled (fast for Binance/OANDA/IG, slow for Polygon)."""
    last: dict[str, float] = {}
    while True:
        await asyncio.sleep(1)
        now = time.time()
        out = {}
        for k in keys():
            try:
                p, sym = split(k)
            except Exception:  # noqa: BLE001
                continue
            every = 60 if p.name in ("polygon", "databento") else 3
            if now - last.get(k, 0) < every:
                continue
            last[k] = now
            with contextlib.suppress(Exception):
                q = await asyncio.wait_for(p.quote(sym), 10)
                if q:
                    out[k] = q
        if out:
            put({"type": "quotes", "data": out})


# ---------- default provider per instrument type, and per-symbol overrides ----------
TYPES = {"stock": ["ibkr", "polygon"], "futures": ["ibkr", "databento"], "forex": ["ibkr", "oanda", "ig"], "crypto": ["ibkr", "binance"]}
PREFIX = {"ibkr": "", "binance": "BINANCE", "oanda": "OANDA", "ig": "IG", "polygon": "POLYGON", "databento": "DATABENTO"}
TITLES = {"ibkr": "IBKR", "binance": "Binance", "oanda": "OANDA", "ig": "IG", "polygon": "Polygon", "databento": "Databento"}
FUT_EXCH = {**dict.fromkeys(["YM", "ZB", "ZN", "ZF", "ZT", "ZC", "ZS", "ZW", "ZL", "ZM"], "CBOT"),
            **dict.fromkeys(["CL", "NG", "RB", "HO", "MCL", "PL", "PA"], "NYMEX"), **dict.fromkeys(["GC", "SI", "HG", "MGC", "SIL"], "COMEX")}


def _routing() -> dict:
    try:
        r = json.loads(CFG_FILE.read_text()).get("_routing", {})
    except (OSError, ValueError):
        r = {}
    return {"defaults": {t: "ibkr" for t in TYPES} | r.get("defaults", {}), "overrides": r.get("overrides", {})}


def routing_cfg() -> dict:
    return {**_routing(), "types": TYPES, "titles": TITLES}


def set_routing(defaults: dict | None = None, override: tuple[str, str | None] | None = None):
    try:
        raw = json.loads(CFG_FILE.read_text())
    except (OSError, ValueError):
        raw = {}
    r = _routing()
    if defaults:
        r["defaults"].update({t: p for t, p in defaults.items() if t in TYPES and p in TYPES[t]})
    if override:
        ident, prov = override
        if prov:
            r["overrides"][ident] = prov
        else:
            r["overrides"].pop(ident, None)
    raw["_routing"] = r
    save_cfg(raw)


def identity(key: str) -> tuple[str, str] | None:
    """(instrument type, canonical symbol) for keys that several providers can serve, else None."""
    parts = key.upper().split(":")
    head = parts[0]
    if head == "BINANCE":
        s = parts[1]
        for q in ("USDT", "USDC", "FDUSD", "USD"):
            if s.endswith(q) and len(s) > len(q):
                return "crypto", s[: -len(q)] + "USD"
        return "crypto", s
    if head == "OANDA":
        b, _, q = parts[1].partition("_")
        return ("forex", b + q) if len(b) == 3 and len(q) == 3 and b not in ("XAU", "XAG") else None
    if head == "IG":
        e = key.split(":", 1)[1]
        seg = e.split(".")
        return ("forex", seg[2]) if e.startswith("CS.D.") and len(seg) > 2 and len(seg[2]) == 6 else None
    if head == "POLYGON":
        return "stock", parts[1]
    if head == "DATABENTO":
        s = parts[-1]
        return "futures", s.split(".")[0]
    if len(parts) == 1:
        return "stock", parts[0]
    sec, sym = parts[0], parts[1]
    cur = parts[3] if len(parts) > 3 else "USD"
    return {"STK": ("stock", sym), "FUT": ("futures", sym), "CASH": ("forex", sym + cur), "CRYPTO": ("crypto", sym + cur)}.get(sec)


def key_for(kind: str, canon: str, prov: str, original: str) -> str | None:
    if prov == "ibkr":
        if kind == "stock":
            return f"STK:{canon}:SMART:USD"
        if kind == "futures":
            return f"FUT:{canon}:{FUT_EXCH.get(canon, 'CME')}:USD"
        if kind == "forex":
            return f"CASH:{canon[:3]}:IDEALPRO:{canon[3:]}"
        if kind == "crypto":
            return f"CRYPTO:{canon[:-3]}:PAXOS:USD" if canon.endswith("USD") else None
    if prov == "polygon" and kind == "stock":
        return f"POLYGON:{canon}"
    if prov == "databento" and kind == "futures":
        return f"DATABENTO:{load_cfg()['databento'].get('dataset') or 'GLBX.MDP3'}:{canon}.c.0"
    if prov == "oanda" and kind == "forex":
        return f"OANDA:{canon[:3]}_{canon[3:]}"
    if prov == "ig" and kind == "forex":
        return f"IG:CS.D.{canon}.CFD.IP"
    if prov == "binance" and kind == "crypto":
        return f"BINANCE:{canon[:-3]}USDT" if canon.endswith("USD") else f"BINANCE:{canon}"
    return None


def provider_of(key: str) -> str:
    head = key.split(":", 1)[0].upper()
    return next((n for n, p in PREFIX.items() if p and p == head), "ibkr")


def route(key: str) -> str:
    """The key to actually load: the symbol's own override, else the default provider for its type."""
    ident = identity(key)
    if not ident:
        return key
    kind, canon = ident
    r = _routing()
    want = r["overrides"].get(f"{kind}:{canon}") or r["defaults"].get(kind, "ibkr")
    if want == provider_of(key):
        return key
    if want != "ibkr" and not load_cfg()[want].get("enabled"):
        return key
    return key_for(kind, canon, want, key) or key


def sources(key: str) -> dict:
    """For the chart legend: which provider serves this symbol and which others could."""
    ident = identity(key)
    used = provider_of(route(key))
    if not ident:
        return {"ident": None, "using": used, "options": []}
    kind, canon = ident
    cfg = load_cfg()
    opts = [p for p in TYPES[kind] if p == "ibkr" or cfg[p].get("enabled")]
    return {"ident": f"{kind}:{canon}", "kind": kind, "using": used, "options": [{"id": p, "title": TITLES[p]} for p in opts],
            "override": _routing()["overrides"].get(f"{kind}:{canon}")}
