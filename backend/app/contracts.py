"""Contract keys and IBKR contract resolution.

A contract key is a short string the front end uses to name an instrument:

    STK:AAPL:SMART:USD      stock (routed via SMART)
    FUT:ES:CME:USD          continuous future (front month for live data)
    CRYPTO:BTC:PAXOS:USD    crypto
"""
from __future__ import annotations

from dataclasses import dataclass

from ib_async import IB, ContFuture, Contract, Crypto, Forex, Future, Stock


@dataclass
class Resolved:
    key: str
    sec_type: str
    history: Contract  # contract used for historical bars
    live: Contract  # contract used for live updates
    what_to_show: str
    use_rth: bool
    label: str


def parse_key(key: str) -> tuple[str, str, str, str]:
    parts = key.upper().split(":")
    if len(parts) == 1:  # plain "AAPL" means a US stock
        return "STK", parts[0], "SMART", "USD"
    while len(parts) < 4:
        parts.append({2: "SMART", 3: "USD"}.get(len(parts), ""))
    sec, sym, exch, cur = parts[:4]
    if sec == "CRYPTO" and exch == "SMART":
        exch = "PAXOS"
    return sec, sym, exch, cur


_cache: dict[str, Resolved] = {}
FX = {"USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "SEK", "NOK", "DKK", "SGD", "HKD", "MXN", "ZAR", "PLN", "CZK", "HUF", "TRY", "CNH", "ILS"}


async def resolve(ib: IB, key: str) -> Resolved:
    if key in _cache:
        return _cache[key]
    sec, sym, exch, cur = parse_key(key)
    if sec == "STK":
        c = Stock(sym, exch, cur)
        [q] = await ib.qualifyContractsAsync(c) or [None]
        if q is None:
            raise ValueError(f"Unknown stock {sym}")
        r = Resolved(key, sec, q, q, "TRADES", True, f"{sym} · {q.primaryExchange or exch}")
    elif sec == "FUT":
        cf = ContFuture(sym, exch, currency=cur)
        [q] = await ib.qualifyContractsAsync(cf) or [None]
        if q is None:
            raise ValueError(f"Unknown future {sym} on {exch}")
        front = Future(conId=q.conId, exchange=q.exchange)
        await ib.qualifyContractsAsync(front)
        r = Resolved(key, sec, q, front, "TRADES", False,
                     f"{sym}1! · {exch} ({front.lastTradeDateOrContractMonth})")
    elif sec == "CASH":
        c = Forex(sym + cur, exch if exch != "SMART" else "IDEALPRO")
        [q] = await ib.qualifyContractsAsync(c) or [None]
        if q is None:
            raise ValueError(f"Unknown currency pair {sym}{cur}")
        r = Resolved(key, sec, q, q, "MIDPOINT", False, f"{sym}/{cur} · IDEALPRO")
    elif sec == "CRYPTO":
        c = Crypto(sym, exch, cur)
        [q] = await ib.qualifyContractsAsync(c) or [None]
        if q is None:
            raise ValueError(f"Unknown crypto {sym} on {exch}")
        r = Resolved(key, sec, q, q, "AGGTRADES", False, f"{sym}{cur} · {exch}")
    else:
        raise ValueError(f"Unsupported type {sec}")
    _cache[key] = r
    return r


async def search(ib: IB, text: str) -> list[dict]:
    """Symbol search, mapped to contract keys the app understands."""
    out: list[dict] = []
    seen: set[str] = set()

    def add(key: str, label: str, desc: str, kind: str):
        if key not in seen:
            seen.add(key)
            out.append({"key": key, "symbol": label, "description": desc, "type": kind})

    pair = text.upper().replace("/", "").replace(".", "")
    if len(pair) == 6 and pair[:3] in FX and pair[3:] in FX:
        add(f"CASH:{pair[:3]}:IDEALPRO:{pair[3:]}", pair, "Forex · IBKR IDEALPRO", "forex")
    for d in await ib.reqMatchingSymbolsAsync(text) or []:
        c = d.contract
        desc = getattr(c, "description", "") or ""
        if c.secType == "STK":
            add(f"STK:{c.symbol}:SMART:{c.currency}", c.symbol, f"{desc} {c.primaryExchange} {c.currency}".strip(), "stock")
        if c.secType == "CASH":
            add(f"CASH:{c.symbol}:IDEALPRO:{c.currency}", f"{c.symbol}{c.currency}", "Forex · IBKR IDEALPRO", "forex")
        if c.secType == "CRYPTO":
            add(f"CRYPTO:{c.symbol}:PAXOS:{c.currency or 'USD'}", c.symbol, "Crypto · PAXOS", "crypto")
        if "FUT" in (d.derivativeSecTypes or []) and c.secType in ("IND", "FUT"):
            exch = c.primaryExchange or c.exchange
            add(f"FUT:{c.symbol}:{exch}:{c.currency}", f"{c.symbol}1!", f"Continuous future · {exch}", "futures")
    return out[:25]
