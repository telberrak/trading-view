"""Stock screener on top of IBKR's market scanner (the same scans as TWS's Market Scanner).

IBKR returns up to 50 symbols per scan, ranked by the chosen scan code, after applying its own filters
(price, volume, market cap, % change). Quotes for the results come from one snapshot request.
"""
from __future__ import annotations

import asyncio
import logging
import math

from ib_async import IB, ScannerSubscription, TagValue

log = logging.getLogger("scanner")

SCANS = {
    "TOP_PERC_GAIN": "Top % gainers",
    "TOP_PERC_LOSE": "Top % losers",
    "MOST_ACTIVE": "Most active (volume)",
    "MOST_ACTIVE_USD": "Most active ($ volume)",
    "HOT_BY_VOLUME": "Unusual volume",
    "TOP_OPEN_PERC_GAIN": "Gap up (since open)",
    "TOP_OPEN_PERC_LOSE": "Gap down (since open)",
    "HIGH_VS_52W_HL": "Near 52-week high",
    "LOW_VS_52W_HL": "Near 52-week low",
    "HIGH_VS_13W_HL": "Near 13-week high",
    "LOW_VS_13W_HL": "Near 13-week low",
    "TOP_TRADE_COUNT": "Most trades",
    "HOT_BY_PRICE": "Hot by price",
    "OPT_VOLUME_MOST_ACTIVE": "Most active options",
    "HALTED": "Halted",
}
# market -> (instrument, location code, currency)
MARKETS = {
    "US": ("STK", "STK.US.MAJOR", "USD"),
    "NASDAQ": ("STK", "STK.NASDAQ", "USD"),
    "NYSE": ("STK", "STK.NYSE", "USD"),
    "LSE": ("STOCK.EU", "STK.EU.LSE", "GBP"),
    "EU": ("STOCK.EU", "STK.EU", "EUR"),
}
# our filter name -> IBKR scanner filter tag
FILTERS = {
    "priceAbove": "priceAbove", "priceBelow": "priceBelow",
    "volumeAbove": "volumeAbove", "avgVolumeAbove": "avgVolumeAbove",
    "mktCapAbove": "marketCapAbove1e6", "mktCapBelow": "marketCapBelow1e6",  # millions
    "changeAbove": "changePercAbove", "changeBelow": "changePercBelow",
}


def options() -> dict:
    return {"scans": SCANS, "markets": list(MARKETS), "filters": list(FILTERS)}


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and abs(f) < 1e300 else None


async def run(ib: IB, body: dict) -> dict:
    scan = str(body.get("scan") or "TOP_PERC_GAIN")
    if scan not in SCANS:
        raise ValueError(f"Unknown scan {scan}")
    inst, loc, cur = MARKETS.get(str(body.get("market") or "US"), MARKETS["US"])
    rows = max(1, min(50, int(body.get("rows") or 50)))
    tags = []
    for name, tag in FILTERS.items():
        v = _num(body.get(name))
        if v is not None:
            tags.append(TagValue(tag, str(v)))
    sub = ScannerSubscription(instrument=inst, locationCode=loc, scanCode=scan, numberOfRows=rows)
    data = await asyncio.wait_for(ib.reqScannerDataAsync(sub, [], tags), 20)
    out, contracts = [], []
    for d in data or []:
        c = d.contractDetails.contract
        if c is None or not c.symbol:
            continue
        currency = c.currency or cur
        out.append({"rank": d.rank, "symbol": c.symbol, "name": d.contractDetails.longName or "",
                    "exchange": c.primaryExchange or c.exchange, "key": f"STK:{c.symbol}:SMART:{currency}".upper()})
        contracts.append(c)
    if contracts:
        try:
            for c in contracts:
                c.exchange = "SMART"
            tickers = await asyncio.wait_for(ib.reqTickersAsync(*contracts), 15)
            by_id = {t.contract.conId: t for t in tickers}
            for row, c in zip(out, contracts):
                t = by_id.get(c.conId)
                if not t:
                    continue
                last = _num(t.last) if _num(t.last) is not None else _num(t.close)
                prev = _num(t.close)
                row.update(last=last, volume=_num(t.volume),
                           change=(last - prev) / prev * 100 if last and prev else None)
        except Exception as e:  # noqa: BLE001 - results are still useful without quotes
            log.warning("scanner quotes failed: %s", e)
    return {"rows": out}
