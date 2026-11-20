"""Watchlists saved as JSON on disk, plus import of TWS watchlist exports."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from .contracts import parse_key

DATA = Path(__file__).resolve().parents[1] / "data" / "watchlists.json"

DEFAULT = {
    "active": 0,
    "lists": [
        {"name": "Stocks", "symbols": [f"STK:{s}:SMART:USD" for s in ("SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA")]},
        {"name": "Futures", "symbols": ["FUT:ES:CME:USD", "FUT:NQ:CME:USD", "FUT:CL:NYMEX:USD", "FUT:GC:COMEX:USD"]},
        {"name": "Crypto", "symbols": ["CRYPTO:BTC:PAXOS:USD", "CRYPTO:ETH:PAXOS:USD"]},
    ],
}


def load() -> dict:
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return json.loads(json.dumps(DEFAULT))


def save(data: dict) -> dict:
    lists = [
        {"name": str(l.get("name") or "List")[:40],
         "symbols": list(dict.fromkeys(str(s).upper() for s in l.get("symbols", []) if s))}
        for l in data.get("lists", [])
    ] or json.loads(json.dumps(DEFAULT))["lists"]
    active = min(max(int(data.get("active", 0)), 0), len(lists) - 1)
    out = {"active": active, "lists": lists}
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out


def parse_tws_export(text: str) -> list[str]:
    """Turn a TWS watchlist export (or a plain list of tickers) into contract keys.

    TWS rows look like:  DES,AAPL,STK,SMART/NASDAQ,,,,,
                         DES,ES,FUT,CME,,202512,,,
                         DES,BTC,CRYPTO,PAXOS,,,,,
    Lines that are just a ticker (or comma/space separated tickers) are read as US stocks.
    """
    keys: list[str] = []
    for row in csv.reader(io.StringIO(text.replace("\t", ","))):
        cells = [c.strip() for c in row if c is not None]
        if not any(cells):
            continue
        if cells[0].upper() == "DES" and len(cells) >= 3:
            sym, sec = cells[1].upper(), cells[2].upper()
            route = cells[3].upper() if len(cells) > 3 else ""
            exch = route.split("/")[-1] if route else ""
            if sec == "STK":
                keys.append(f"STK:{sym}:SMART:USD")
            elif sec in ("FUT", "CONTFUT"):
                keys.append(f"FUT:{sym}:{exch or 'CME'}:USD")
            elif sec == "CRYPTO":
                keys.append(f"CRYPTO:{sym}:{exch or 'PAXOS'}:USD")
            continue
        if cells[0].upper() in ("SYM", "SYMBOL", "COLUMN", "HED"):  # headers / TWS column rows
            continue
        for c in cells:
            for tok in c.split():
                tok = tok.upper()
                if ":" in tok:
                    keys.append(":".join(parse_key(tok)))
                elif tok.replace(".", "").replace("-", "").isalnum() and len(tok) <= 12:
                    keys.append(f"STK:{tok}:SMART:USD")
    return list(dict.fromkeys(keys))
