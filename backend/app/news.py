"""Headlines and articles from the news providers your IBKR account subscribes to.

Free API feeds on most accounts are Briefing.com (BRFG, BRFUPDN) and Dow Jones (DJNL); others need a
subscription in Client Portal. Futures and crypto rarely have symbol-tagged news.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import re
import time

from ib_async import IB

from . import contracts

log = logging.getLogger("news")
_providers: list[str] | None = None
_cache: dict[str, tuple[float, list[dict]]] = {}
_META = re.compile(r"^\{[^}]*\}!?\s*")


async def providers(ib: IB) -> list[str]:
    global _providers
    if _providers is None:
        try:
            _providers = [p.code for p in await asyncio.wait_for(ib.reqNewsProvidersAsync(), 10)]
        except Exception:  # noqa: BLE001
            log.exception("news providers")
            return []
    return _providers


async def headlines(ib: IB, key: str) -> dict:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 120:
        return {"providers": _providers or [], "items": hit[1]}
    codes = await providers(ib)
    if not codes:
        return {"providers": [], "items": []}
    r = await contracts.resolve(ib, key)
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=14)
    items: list[dict] = []
    try:
        news = await asyncio.wait_for(
            ib.reqHistoricalNewsAsync(r.live.conId, "+".join(codes), start.strftime("%Y-%m-%d %H:%M:%S.0"), "", 40), 15)
    except Exception as e:  # noqa: BLE001
        log.warning("news for %s failed: %s", key, e)
        news = None
    for n in news or []:
        t = n.time if isinstance(n.time, dt.datetime) else None
        items.append({"time": t.timestamp() if t else None, "provider": n.providerCode, "id": n.articleId,
                      "headline": _META.sub("", n.headline or "")})
    items.sort(key=lambda x: x["time"] or 0, reverse=True)
    _cache[key] = (time.time(), items)
    return {"providers": codes, "items": items}


async def article(ib: IB, provider: str, article_id: str) -> dict:
    a = await asyncio.wait_for(ib.reqNewsArticleAsync(provider, article_id), 15)
    if a is None:
        raise ValueError("Article not available")
    return {"type": a.articleType, "text": a.articleText}  # type 0 = text/HTML, 1 = base64 PDF
