"""Data providers other than IBKR: Binance, OANDA, IG, Polygon, Databento and Tradovate (which NinjaTrader's
futures accounts also run on).

A provider symbol key starts with the provider's name, e.g. "BINANCE:BTCUSDT", "OANDA:EUR_USD",
"IG:CS.D.EURUSD.CFD.IP", "POLYGON:AAPL", "DATABENTO:GLBX.MDP3:ES.c.0", "TRADOVATE:ES" (front month). Everything else is an IBKR key.

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
from typing import AsyncIterator, Awaitable, Callable

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
           {"name": "env", "label": "Environment", "options": ["live", "demo"]},
           {"name": "history", "label": "Chart history", "options": ["from OANDA or IBKR", "from IG (uses the weekly allowance)"]}],
    "polygon": [{"name": "apiKey", "label": "API key", "secret": True}],
    "tradovate": [{"name": "username", "label": "Username"},
                  {"name": "password", "label": "Password", "secret": True},
                  {"name": "cid", "label": "API key ID (cid)"},
                  {"name": "sec", "label": "API secret", "secret": True},
                  {"name": "env", "label": "Environment", "options": ["live", "demo"]},
                  {"name": "orders", "label": "Orders for its charts", "options": ["go to IBKR", "go to this Tradovate account"]}],
    "databento": [{"name": "apiKey", "label": "API key", "secret": True},
                  {"name": "dataset", "label": "Futures dataset", "placeholder": "GLBX.MDP3"}],
}
DEFAULTS = {"binance": {"enabled": True}, "oanda": {"env": "live"}, "ig": {"env": "live", "history": "from OANDA or IBKR"},
            "databento": {"dataset": "GLBX.MDP3"}, "tradovate": {"env": "demo", "orders": "go to IBKR"}}


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


# ---------- Tradovate (CME futures; NinjaTrader's futures accounts run on the same platform) ----------
MONTHS = "FGHJKMNQUVXZ"


class Tradovate(Provider):
    """REST for login, contracts and orders; one market-data websocket shared by every chart and quote.
    Bars come from md/getChart, which sends history and then keeps the subscription live."""
    name, title = "tradovate", "Tradovate"
    TF = {"1m": ("MinuteBar", 1), "5m": ("MinuteBar", 5), "15m": ("MinuteBar", 15), "30m": ("MinuteBar", 30), "1h": ("MinuteBar", 60),
          "2h": ("MinuteBar", 120), "4h": ("MinuteBar", 240), "1D": ("DailyBar", 1), "1W": ("DailyBar", 1), "1M": ("DailyBar", 1)}

    def __init__(self, cfg):
        super().__init__(cfg)
        self.token: dict | None = None
        self.ws = None
        self.ws_task: asyncio.Task | None = None
        self.ws_ready: asyncio.Future | None = None
        self.req_id = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.charts: dict[int, asyncio.Queue] = {}
        self.quotes: dict[int, dict] = {}  # contractId -> latest entries
        self.quote_ids: dict[str, int] = {}  # contract name -> contractId
        self.fronts: dict[str, tuple[float, str]] = {}
        self.lock = asyncio.Lock()
        self._open_subs: dict[tuple[str, str], tuple[asyncio.Queue, int]] = {}
        self.early: dict[int, list[dict]] = {}
        self.ticks: dict[str, float] = {}  # history() hands its live subscription to live()

    def ready(self):
        missing = [lbl for f, lbl in (("username", "username"), ("password", "password"), ("cid", "API key ID"), ("sec", "API secret"))
                   if not self.cfg.get(f)]
        return f"Add your Tradovate {', '.join(missing)}" if missing else None

    @property
    def base(self):
        return f"https://{'demo' if self.cfg.get('env') == 'demo' else 'live'}.tradovateapi.com/v1"

    @property
    def md_url(self):
        return "wss://md-demo.tradovateapi.com/v1/websocket" if self.cfg.get("env") == "demo" else "wss://md.tradovateapi.com/v1/websocket"

    # ----- login -----
    def _device_id(self) -> str:
        import uuid
        f = DATA_DIR / "device-id"
        try:
            return f.read_text().strip()
        except OSError:
            v = str(uuid.uuid4())
            with contextlib.suppress(OSError):
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(v)
            return v

    async def _auth(self) -> dict:
        async with self.lock:
            if self.token and self.token["exp"] - time.time() > 120:
                return self.token
            body = {"name": self.cfg["username"], "password": self.cfg["password"], "appId": "IBKR Charts", "appVersion": "1.0",
                    "cid": self.cfg["cid"], "sec": self.cfg["sec"], "deviceId": self._device_id()}
            r = await client().post(f"{self.base}/auth/accesstokenrequest", json=body)
            d = r.json() if r.content else {}
            if r.status_code >= 400 or "errorText" in d or "accessToken" not in d:
                if "p-ticket" in d:
                    raise ValueError(f"Tradovate is rate-limiting logins; try again in {d.get('p-time', 60)} s")
                raise ValueError(f"Tradovate login failed: {d.get('errorText') or r.status_code}")
            exp = dt.datetime.fromisoformat(d["expirationTime"].replace("Z", "+00:00")).timestamp() if d.get("expirationTime") else time.time() + 4800
            self.token = {"access": d["accessToken"], "md": d.get("mdAccessToken") or d["accessToken"], "exp": exp, "userId": d.get("userId")}
            return self.token

    async def _get(self, path: str, **params):
        t = await self._auth()
        r = await client().get(f"{self.base}{path}", params=params, headers={"Authorization": f"Bearer {t['access']}"})
        if r.status_code == 401:
            self.token = None
            t = await self._auth()
            r = await client().get(f"{self.base}{path}", params=params, headers={"Authorization": f"Bearer {t['access']}"})
        r.raise_for_status()
        return r.json()

    async def _post(self, path: str, body: dict):
        t = await self._auth()
        r = await client().post(f"{self.base}{path}", json=body, headers={"Authorization": f"Bearer {t['access']}"})
        d = r.json() if r.content else {}
        if r.status_code >= 400:
            raise ValueError(f"Tradovate: {d.get('errorText') or r.status_code}")
        return d

    # ----- contracts -----
    async def front(self, root: str) -> str:
        """Front-month contract name for a root (ES -> ESZ6), the nearest one not yet expired."""
        root = root.upper()
        if re.fullmatch(r"[A-Z0-9]+[FGHJKMNQUVXZ]\d{1,2}", root):
            return root  # already a contract (ESZ6)
        hit = self.fronts.get(root)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        best: tuple[str, str] | None = None
        for c in await self._get("/contract/suggest", t=root, l=20):
            name = c.get("name", "")
            if not re.fullmatch(re.escape(root) + r"[FGHJKMNQUVXZ]\d{1,2}", name):
                continue
            m = await self._get("/contractMaturity/item", id=c["contractMaturityId"])
            exp = m.get("expirationDate") or ""
            if exp and exp > dt.datetime.now(dt.timezone.utc).isoformat() and (best is None or exp < best[0]):
                best = (exp, name)
        if not best:
            raise ValueError(f"Tradovate has no live contract for {root}")
        self.fronts[root] = (time.time(), best[1])
        return best[1]

    async def search(self, q):
        out, seen = [], set()
        for c in await self._get("/contract/suggest", t=q.upper().rstrip("!").rstrip("1"), l=12):
            m = re.fullmatch(r"([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}", c.get("name", ""))
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            out.append({"key": f"TRADOVATE:{m.group(1)}", "symbol": f"{m.group(1)}1!", "description": f"{m.group(1)} futures, front month · Tradovate",
                        "type": "futures"})
        return out

    def label(self, sym):
        f = self.fronts.get(sym.upper())
        return f"{sym}1! · {f[1] if f else 'front month'} · Tradovate"

    # ----- market-data websocket -----
    async def _connect(self):
        import websockets
        if self.ws_ready and self.ws_ready.done() and not self.ws_ready.exception() and self.ws_task and not self.ws_task.done():
            return
        if self.ws_ready and not self.ws_ready.done():
            await self.ws_ready
            return
        loop = asyncio.get_running_loop()
        self.ws_ready = loop.create_future()
        t = await self._auth()

        async def run():
            try:
                async with websockets.connect(self.md_url, ping_interval=None, max_size=2**24) as ws:
                    self.ws = ws
                    beat = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for raw in ws:
                            if raw == "o":
                                await ws.send(f"authorize\n0\n\n{t['md']}")
                            elif raw.startswith("a"):
                                for m in json.loads(raw[1:]):
                                    self._on(m)
                            elif raw.startswith("c"):
                                break
                    finally:
                        beat.cancel()
            except Exception as e:  # noqa: BLE001
                log.warning("tradovate md socket: %s", e)
                if not self.ws_ready.done():
                    self.ws_ready.set_exception(ValueError(f"Tradovate market data: {e}"))
            finally:
                self.ws = None
                for q in self.charts.values():
                    q.put_nowait(None)  # tell chart streams to resubscribe
                for f in self.pending.values():
                    if not f.done():
                        f.set_exception(ValueError("Tradovate market data disconnected"))
                self.pending.clear()
                self.quote_ids.clear()
        self.ws_task = asyncio.create_task(run())
        await asyncio.wait_for(asyncio.shield(self.ws_ready), 15)

    @staticmethod
    async def _heartbeat(ws):
        while True:
            await asyncio.sleep(2.5)
            await ws.send("[]")

    def _on(self, m: dict):
        if m.get("i") == 0 and "s" in m:  # authorize reply
            if m["s"] == 200:
                self.ws_ready.set_result(True)
            else:
                self.ws_ready.set_exception(ValueError(f"Tradovate market data login refused: {m.get('d')}"))
            return
        if "i" in m and m["i"] in self.pending:
            f = self.pending.pop(m["i"])
            if not f.done():
                if m.get("s") == 200:
                    f.set_result(m.get("d"))
                else:
                    f.set_exception(ValueError(f"Tradovate: {m.get('d')}"))
            return
        e, d = m.get("e"), m.get("d") or {}
        if e == "chart":
            for c in d.get("charts", []):
                q = self.charts.get(c.get("id"))
                if q is not None:
                    q.put_nowait(c)
                else:  # can arrive before the getChart reply has been handed back to _chart()
                    self.early.setdefault(c.get("id"), []).append(c)
                    if len(self.early) > 50:
                        self.early.pop(next(iter(self.early)))
        elif e == "md":
            for qt in d.get("quotes", []):
                self.quotes[qt["contractId"]] = qt.get("entries", {})

    async def _request(self, endpoint: str, body: dict):
        await self._connect()
        self.req_id += 1
        i = self.req_id
        f = asyncio.get_running_loop().create_future()
        self.pending[i] = f
        await self.ws.send(f"{endpoint}\n{i}\n\n{json.dumps(body)}")
        return await asyncio.wait_for(f, 15)

    @staticmethod
    def _bar(b: dict) -> dict:
        t = dt.datetime.fromisoformat(b["timestamp"].replace("Z", "+00:00")).timestamp()
        vol = (b.get("upVolume") or 0) + (b.get("downVolume") or 0)
        return bar(t, b["open"], b["high"], b["low"], b["close"], vol)

    async def _chart(self, sym: str, tf: str, count: int) -> tuple[asyncio.Queue, int]:
        name = await self.front(sym)
        kind, size = self.TF[tf]
        d = await self._request("md/getChart", {"symbol": name, "chartDescription": {"underlyingType": kind, "elementSize": size,
                                "elementSizeUnit": "UnderlyingUnits", "withHistogram": False}, "timeRange": {"asMuchAsElements": count}})
        q: asyncio.Queue = asyncio.Queue()
        for k in ("historicalId", "realtimeId"):
            if d and d.get(k) is not None:
                self.charts[d[k]] = q
                for c in self.early.pop(d[k], []):
                    q.put_nowait(c)
        return q, (d or {}).get("historicalId") or (d or {}).get("realtimeId") or 0

    async def _cancel(self, sub: int):
        for k in [k for k, v in self.charts.items() if v is self.charts.get(sub)]:
            self.charts.pop(k, None)
        with contextlib.suppress(Exception):
            await self._request("md/cancelChart", {"subscriptionId": sub})

    async def history(self, sym, tf):
        """Bars up to now; the subscription stays open and live() picks it up (see stream())."""
        bars, _ = await self._open(sym, tf)
        return bars

    async def _open(self, sym, tf):
        q, sub = await self._chart(sym, tf, 3000 if TF_SEC.get(tf) and TF_SEC[tf] < 86400 else 1500)
        got: dict[int, dict] = {}
        while True:
            c = await asyncio.wait_for(q.get(), 30)
            if c is None:
                raise ValueError("Tradovate market data disconnected")
            for b in c.get("bars", []):
                x = self._bar(b)
                got[x["time"]] = x
            if c.get("eoh"):
                break
        bars = [got[t] for t in sorted(got)]
        if tf in ("1W", "1M"):
            bars = resample(bars, tf)
        self._open_subs[(sym, tf)] = (q, sub)
        return bars, (q, sub)

    async def live(self, sym, tf):
        key = (sym, tf)
        while True:
            q_sub = self._open_subs.pop(key, None)
            if q_sub is None:
                try:
                    _, q_sub = await self._open(sym, tf)
                    self._open_subs.pop(key, None)
                except Exception as e:  # noqa: BLE001
                    log.warning("tradovate live %s: %s", sym, e)
                    await asyncio.sleep(5)
                    continue
            q, sub = q_sub
            try:
                while True:
                    c = await q.get()
                    if c is None:
                        break  # socket dropped: resubscribe
                    for b in c.get("bars", []):
                        x = self._bar(b)
                        if tf in ("1W", "1M"):
                            x = {**x, "time": bucket(x["time"], tf)}
                        yield x
            finally:
                if self.ws:
                    asyncio.create_task(self._cancel(sub))

    async def quote(self, sym):
        name = await self.front(sym)
        if name not in self.quote_ids:
            d = await self._request("md/subscribeQuote", {"symbol": name})
            cid = None
            if isinstance(d, dict):
                cid = d.get("contractId")
            if cid is None:
                c = await self._get("/contract/find", name=name)
                cid = c["id"]
            self.quote_ids[name] = cid
            await asyncio.sleep(0.5)
        e = self.quotes.get(self.quote_ids[name])
        if not e:
            return None
        px = lambda k: (e.get(k) or {}).get("price")  # noqa: E731
        last = px("Trade")
        if last is None:
            return None
        prev = px("SettlementPrice")
        return {"last": last, "bid": px("Bid"), "ask": px("Offer"), "high": px("HighPrice"), "low": px("LowPrice"), "prevClose": prev,
                "change": last - prev if prev else None, "changePct": (last - prev) / prev * 100 if prev else None,
                "volume": (e.get("TotalTradeVolume") or {}).get("size")}

    # ----- orders -----
    def routes_orders(self) -> bool:
        return str(self.cfg.get("orders", "")).startswith("go to this Tradovate")

    async def account(self) -> dict:
        accts = [a for a in await self._get("/account/list") if a.get("active", True)]
        if not accts:
            raise ValueError("No active Tradovate account")
        return accts[0]

    async def _tick(self, sym: str) -> float:
        root = re.sub(r"[FGHJKMNQUVXZ]\d{1,2}$", "", sym.upper())
        if root not in self.ticks:
            try:
                self.ticks[root] = float((await self._get("/product/find", name=root)).get("tickSize") or 0.01)
            except Exception:  # noqa: BLE001
                return 0.01
        return self.ticks[root]

    async def place(self, sym: str, body: dict) -> dict:
        """Market / limit / stop / stop-limit, or an entry with a target and a stop as one OSO bracket."""
        a = await self.account()
        name = await self.front(sym)
        action = {"BUY": "Buy", "SELL": "Sell"}[str(body["action"]).upper()]
        qty = float(body["qty"])
        if not qty > 0 or qty != int(qty):
            raise ValueError("Quantity must be a whole number above zero")
        otype = {"MKT": "Market", "LMT": "Limit", "STP": "Stop", "STP LMT": "StopLimit"}[str(body.get("type", "MKT")).upper()]
        o = {"accountSpec": a["name"], "accountId": a["id"], "action": action, "symbol": name, "orderQty": int(qty),
             "orderType": otype, "timeInForce": "GTC" if str(body.get("tif")).upper() == "GTC" else "Day", "isAutomated": True}
        tick = await self._tick(sym)
        snap = lambda v: round(round(float(v) / tick) * tick, 10)  # noqa: E731  prices off the tick grid are rejected
        if body.get("lmtPrice"):
            o["price"] = snap(body["lmtPrice"])
        if body.get("auxPrice"):
            o["stopPrice"] = snap(body["auxPrice"])
        tp, sl = body.get("takeProfit"), body.get("stopLoss")
        if tp is not None and sl is not None:
            exit_side = "Sell" if action == "Buy" else "Buy"
            o["bracket1"] = {"action": exit_side, "orderType": "Limit", "price": snap(tp)}
            o["bracket2"] = {"action": exit_side, "orderType": "Stop", "stopPrice": snap(sl)}
            log.warning("Tradovate bracket %s %s %s %s tp=%s sl=%s acct=%s", action, qty, name, otype, tp, sl, a["name"])
            d = await self._post("/order/placeOSO", o)
        else:
            log.warning("Tradovate order %s %s %s %s %s acct=%s", action, qty, name, otype, o.get("price") or o.get("stopPrice") or "", a["name"])
            d = await self._post("/order/placeorder", o)
        if d.get("failureReason") or d.get("failureText"):
            raise ValueError(f"Tradovate rejected the order: {d.get('failureText') or d.get('failureReason')}")
        return {"orderId": d.get("orderId"), "status": "Submitted", "broker": "Tradovate", "account": a["name"]}


CLASSES: dict[str, type[Provider]] = {"BINANCE": Binance, "OANDA": Oanda, "IG": IG, "POLYGON": Polygon, "DATABENTO": Databento, "TRADOVATE": Tradovate}
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
    if name == "tradovate":
        await p._auth()  # type: ignore[attr-defined]
        a = await p.account()  # type: ignore[attr-defined]
        front = await p.front("ES")  # type: ignore[attr-defined]
        STATUS[name] = "Connected"
        return f"Logged in · account {a['name']} · ES front month {front}"
    if name == "ig":
        await p._login()  # type: ignore[attr-defined]
        STATUS[name] = "Connected"
        return "Logged in to IG"
    bars = await p.history(sample, "1D") if sample else []
    STATUS[name] = "Connected"
    return f"OK: {len(bars)} daily bars of {sample}"


class ProviderStream:
    """Chart history + live bars from a provider, with the same messages as the IBKR ChartStream."""

    def __init__(self, queue: asyncio.Queue, key: str, tf: str, reply_key: str | None = None,
                 ibkr_history: Callable[[str, str], Awaitable[list[dict]]] | None = None):
        self.queue, self.key, self.tf = queue, key, tf
        self.reply_key = reply_key or key
        self.ibkr_history = ibkr_history
        self.task: asyncio.Task | None = None

    async def _seed(self, p: "IG", sym: str) -> tuple[list[dict], str]:
        """IG is used as a live feed: its history allowance (10,000 points a week) is kept for trading,
        so the bars before now come from OANDA, else IBKR, for the same market."""
        ident = identity(self.key)
        if ident and ident[0] == "forex":
            canon = ident[1]
            with contextlib.suppress(Exception):
                bars = await get("OANDA").history(f"{canon[:3]}_{canon[3:]}", self.tf)
                if bars:
                    return bars, "OANDA"
            if self.ibkr_history:
                with contextlib.suppress(Exception):
                    bars = await self.ibkr_history(key_for("forex", canon, "ibkr", self.key) or "", self.tf)
                    if bars:
                        return bars, "IBKR"
        return [], ""

    async def start(self):
        p, sym = split(self.key)
        live_only = p.name == "ig" and not str(p.cfg.get("history", "")).startswith("from IG")
        src = ""
        if live_only:
            bars, src = await self._seed(p, sym)  # type: ignore[arg-type]
            if bars:
                p.cur[(sym, self.tf)] = dict(bars[-1])  # type: ignore[attr-defined]
        else:
            bars = await p.history(sym, self.tf)
        self.queue.put_nowait({"type": "history", "key": self.reply_key, "tf": self.tf, "label": p.label(sym), "bars": bars})
        if live_only:
            self.queue.put_nowait({"type": "notice", "message": f"IG live prices; earlier bars from {src}" if src else
                                   "IG gives live prices only here, so this chart starts now. History comes from OANDA or IBKR for forex; "
                                   "for other IG markets you can switch Chart history to IG in Data providers."})
        elif not bars:
            self.queue.put_nowait({"type": "notice", "message": f"{p.title} returned no data for {sym}"})
            return
        last = {"time": bars[-1]["time"] if bars else 0}

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
            every = 60 if p.name in ("polygon", "databento") else 1 if p.name == "tradovate" else 3
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
TYPES = {"stock": ["ibkr", "polygon"], "futures": ["ibkr", "tradovate", "databento"], "forex": ["ibkr", "oanda", "ig"], "crypto": ["ibkr", "binance"]}
PREFIX = {"ibkr": "", "binance": "BINANCE", "oanda": "OANDA", "ig": "IG", "polygon": "POLYGON", "databento": "DATABENTO", "tradovate": "TRADOVATE"}
TITLES = {"ibkr": "IBKR", "binance": "Binance", "oanda": "OANDA", "ig": "IG", "polygon": "Polygon", "databento": "Databento", "tradovate": "Tradovate"}
FUT_EXCH = {**dict.fromkeys(["YM", "ZB", "ZN", "ZF", "ZT", "ZC", "ZS", "ZW", "ZL", "ZM"], "CBOT"),
            **dict.fromkeys(["CL", "NG", "RB", "HO", "MCL", "PL", "PA"], "NYMEX"), **dict.fromkeys(["GC", "SI", "HG", "MGC", "SIL"], "COMEX")}


# recommended defaults (2026-11-21): crypto from Binance, forex from OANDA, stocks and futures from IBKR.
# A default whose provider is off or has no key falls back to IBKR.
DEFAULT_ROUTES = {"stock": "ibkr", "futures": "ibkr", "forex": "oanda", "crypto": "binance"}


def _usable(prov: str) -> bool:
    if prov == "ibkr":
        return True
    c = load_cfg()[prov]
    return bool(c.get("enabled")) and CLASSES[PREFIX[prov]](c).ready() is None


def _routing() -> dict:
    try:
        r = json.loads(CFG_FILE.read_text()).get("_routing", {})
    except (OSError, ValueError):
        r = {}
    return {"defaults": DEFAULT_ROUTES | r.get("defaults", {}), "overrides": r.get("overrides", {})}


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
    if head == "TRADOVATE":
        return "futures", re.sub(r"1!$", "", parts[1])
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
    if prov == "tradovate" and kind == "futures":
        return f"TRADOVATE:{canon}"
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
    if not _usable(want):
        return key
    return key_for(kind, canon, want, key) or key


def sources(key: str) -> dict:
    """For the chart legend: which provider serves this symbol and which others could."""
    ident = identity(key)
    used = provider_of(route(key))
    if not ident:
        return {"ident": None, "using": used, "options": []}
    kind, canon = ident
    opts = [p for p in TYPES[kind] if _usable(p)]
    return {"ident": f"{kind}:{canon}", "kind": kind, "using": used, "options": [{"id": p, "title": TITLES[p]} for p in opts],
            "override": _routing()["overrides"].get(f"{kind}:{canon}")}


def order_broker(key: str) -> tuple["Tradovate", str] | None:
    """(Tradovate, symbol) when this chart's orders should go to Tradovate, else None (IBKR)."""
    real = route(key)
    if not real.upper().startswith("TRADOVATE:"):
        return None
    with contextlib.suppress(Exception):
        p, sym = split(real)
        if p.routes_orders():  # type: ignore[attr-defined]
            return p, sym  # type: ignore[return-value]
    return None
