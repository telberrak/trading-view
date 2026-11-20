"""Live quotes for the watchlist: last price, change and % change vs. previous close."""
from __future__ import annotations

import asyncio
import logging
import math

from ib_async import IB, Ticker

from . import contracts

log = logging.getLogger("quotes")


def _num(v) -> float | None:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or v <= 0 else v


def snapshot(t: Ticker) -> dict:
    last = _num(t.last) or _num(t.marketPrice()) or _num(t.close)
    prev = _num(t.close)
    vol = _num(t.volume)
    out = {"last": last, "prevClose": prev, "change": None, "changePct": None, "volume": vol,
           "bid": _num(t.bid), "ask": _num(t.ask), "open": _num(t.open), "high": _num(t.high), "low": _num(t.low),
           "high52": _num(getattr(t, "high52week", None)), "low52": _num(getattr(t, "low52week", None)),
           "avgVolume": _num(getattr(t, "avVolume", None))}
    if last is not None and prev is not None:
        out["change"] = last - prev
        out["changePct"] = (last - prev) / prev * 100
    return out


class QuoteSession:
    """Quote subscriptions for one browser socket. Sends changed quotes every 0.5 s."""

    def __init__(self, ib: IB, queue: asyncio.Queue):
        self.ib, self.queue = ib, queue
        self.tickers: dict[str, Ticker] = {}
        self.sent: dict[str, dict] = {}

    async def set_symbols(self, keys: list[str]):
        keys = list(dict.fromkeys(k for k in keys if not k.startswith("###")))[:90]  # stay under IBKR's ~100 market data lines
        for k in [k for k in self.tickers if k not in keys]:
            self.ib.cancelMktData(self.tickers.pop(k).contract)
            self.sent.pop(k, None)
        for k in keys:
            if k in self.tickers:
                continue
            try:
                r = await contracts.resolve(self.ib, k)
                self.tickers[k] = self.ib.reqMktData(r.live, "165" if r.sec_type == "STK" else "", False, False)  # 165: 52-week range, avg volume
            except Exception as e:  # noqa: BLE001
                self.queue.put_nowait({"type": "quote_error", "key": k, "message": str(e)})

    async def run(self):
        while True:
            await asyncio.sleep(0.5)
            changed = {}
            for k, t in self.tickers.items():
                q = snapshot(t)
                if q != self.sent.get(k):
                    self.sent[k] = q
                    changed[k] = q
            if changed:
                self.queue.put_nowait({"type": "quotes", "data": changed})

    def stop(self):
        for t in self.tickers.values():
            try:
                self.ib.cancelMktData(t.contract)
            except Exception:  # noqa: BLE001
                pass
        self.tickers.clear()
