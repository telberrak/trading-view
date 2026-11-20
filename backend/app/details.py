"""Symbol details for the side panel: names, exchange and whether the market is open now."""
from __future__ import annotations

import datetime as dt
import logging
from zoneinfo import ZoneInfo

from ib_async import IB

from . import contracts

log = logging.getLogger("details")
_cache: dict[str, dict] = {}


def is_open(hours: str, tz_id: str, now: dt.datetime | None = None) -> bool | None:
    """IBKR hours look like '20261120:0930-20261120:1600;20261121:CLOSED'."""
    if not hours or not tz_id:
        return None
    try:
        tz = ZoneInfo(tz_id)
    except Exception:  # noqa: BLE001
        return None
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(tz)
    for part in hours.split(";"):
        if "CLOSED" in part or "-" not in part:
            continue
        a, b = part.split("-")
        try:
            start = dt.datetime.strptime(a, "%Y%m%d:%H%M").replace(tzinfo=tz)
            end = dt.datetime.strptime(b, "%Y%m%d:%H%M").replace(tzinfo=tz)
        except ValueError:
            continue
        if start <= now < end:
            return True
    return False


async def details(ib: IB, key: str) -> dict:
    r = await contracts.resolve(ib, key)
    if key not in _cache:
        cds = await ib.reqContractDetailsAsync(r.live)
        cd = cds[0] if cds else None
        _cache[key] = {
            "key": key,
            "name": (cd.longName if cd else "") or r.label,
            "exchange": r.live.primaryExchange or r.live.exchange,
            "secType": r.sec_type,
            "currency": r.live.currency,
            "hours": (cd.liquidHours if r.sec_type == "STK" else cd.tradingHours) if cd else "",
            "tz": cd.timeZoneId if cd else "",
            "expiry": getattr(r.live, "lastTradeDateOrContractMonth", ""),
        }
    d = dict(_cache[key])
    d["open"] = is_open(d.pop("hours"), d.pop("tz"))
    return d
