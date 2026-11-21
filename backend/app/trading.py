"""Order entry, open orders, fills and positions through the TWS API.

Orders go to whatever account TWS / IB Gateway is logged into (live or paper). The browser shows a
review step before anything is sent; this module validates again on the server.
"""
from __future__ import annotations

import logging
import math
from typing import Callable

from ib_async import IB, Order, Trade

from . import contracts

log = logging.getLogger("trading")

ORDER_TYPES = {"MKT", "LMT", "STP", "STP LMT"}
TIFS = {"DAY", "GTC", "IOC"}


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or f >= 1.7e308 else f


def _round(v: float, tick: float) -> float:
    """Snap a price to the contract's tick size, as IBKR rejects prices off the tick grid."""
    return round(round(v / tick) * tick, 10)


def trade_dict(t: Trade) -> dict:
    c, o, s = t.contract, t.order, t.orderStatus
    return {
        "orderId": o.orderId, "permId": o.permId, "account": o.account,
        "symbol": c.symbol, "secType": c.secType, "localSymbol": c.localSymbol,
        "action": o.action, "qty": _num(o.totalQuantity), "type": o.orderType,
        "lmtPrice": _num(o.lmtPrice), "auxPrice": _num(o.auxPrice), "tif": o.tif,
        "status": s.status, "filled": _num(s.filled), "remaining": _num(s.remaining),
        "avgFillPrice": _num(s.avgFillPrice),
        "log": [e.message for e in t.log if e.message][-1:],
    }


def position_dict(p) -> dict:
    c = p.contract
    mult = _num(c.multiplier) or 1.0
    return {"account": p.account, "symbol": c.symbol, "secType": c.secType, "localSymbol": c.localSymbol,
            "position": _num(p.position), "avgPrice": (_num(p.avgCost) or 0) / mult}


class Trading:
    def __init__(self, ib: IB, broadcast: Callable[[dict], None]):
        self.ib, self.broadcast = ib, broadcast
        self._attached = False
        self._ticks: dict[str, float] = {}

    def attach(self):
        if self._attached:
            return
        self._attached = True
        self.ib.orderStatusEvent += self._on_order
        self.ib.newOrderEvent += self._on_order
        self.ib.cancelOrderEvent += self._on_order
        self.ib.positionEvent += lambda _p: self.broadcast({"type": "positions", "positions": self.positions()})
        self.ib.execDetailsEvent += self._on_fill

    def _on_order(self, t: Trade):
        self.broadcast({"type": "orders", "orders": self.orders()})

    def _on_fill(self, t: Trade, fill):
        e = fill.execution
        self.broadcast({"type": "fill", "fill": {"symbol": t.contract.symbol, "side": e.side, "qty": _num(e.shares),
                                                  "price": _num(e.price), "time": e.time.timestamp() if e.time else None}})

    # ---------- reads ----------
    def account(self) -> dict:
        accts = list(self.ib.managedAccounts()) if self.ib.isConnected() else []
        return {"accounts": accts, "paper": bool(accts) and all(a.upper().startswith("D") for a in accts),
                "connected": self.ib.isConnected()}

    def orders(self) -> list[dict]:
        return [trade_dict(t) for t in self.ib.openTrades()]

    def positions(self) -> list[dict]:
        return [position_dict(p) for p in self.ib.positions() if _num(p.position)]

    def fills(self) -> list[dict]:
        out = []
        for f in self.ib.fills()[-50:]:
            e = f.execution
            out.append({"symbol": f.contract.symbol, "secType": f.contract.secType, "side": e.side,
                        "qty": _num(e.shares), "price": _num(e.price),
                        "time": e.time.timestamp() if e.time else None})
        return out[::-1]

    # ---------- writes ----------
    async def place(self, body: dict) -> dict:
        if not self.ib.isConnected():
            raise ValueError("Not connected to IBKR")
        key = str(body["key"])
        if key.split(":", 1)[0].upper() in ("BINANCE", "OANDA", "IG", "POLYGON", "DATABENTO"):
            raise ValueError("Orders go through IBKR; this symbol comes from another data provider")
        action = str(body["action"]).upper()
        if action not in ("BUY", "SELL"):
            raise ValueError("Side must be BUY or SELL")
        qty = float(body["qty"])
        otype = str(body.get("type", "MKT")).upper()
        if otype not in ORDER_TYPES:
            raise ValueError(f"Unsupported order type {otype}")
        r = await contracts.resolve(self.ib, key)
        if r.sec_type in ("STK", "FUT") and qty != int(qty):
            raise ValueError("Quantity must be a whole number")
        if not qty > 0:
            raise ValueError("Quantity must be above zero")
        tif = str(body.get("tif", "DAY")).upper()
        if tif not in TIFS:
            raise ValueError(f"Unsupported time in force {tif}")
        if r.sec_type == "CRYPTO" and otype == "MKT":
            tif = "IOC"  # IBKR only takes IOC market orders for crypto
        lmt = _num(body.get("lmtPrice"))
        aux = _num(body.get("auxPrice"))
        if otype in ("LMT", "STP LMT") and not (lmt and lmt > 0):
            raise ValueError("Limit price required")
        if otype in ("STP", "STP LMT") and not (aux and aux > 0):
            raise ValueError("Stop price required")
        accounts = self.ib.managedAccounts()
        account = str(body.get("account") or (accounts[0] if accounts else ""))
        if accounts and account not in accounts:
            raise ValueError(f"Unknown account {account}")
        tp = _num(body.get("takeProfit"))
        sl = _num(body.get("stopLoss"))
        bracket = tp is not None or sl is not None
        if bracket:
            if otype not in ("MKT", "LMT") or tp is None or sl is None:
                raise ValueError("A bracket needs a market or limit entry, a target and a stop")
            ref = lmt if otype == "LMT" else None
            if ref is not None and ((action == "BUY" and not sl < ref < tp) or (action == "SELL" and not tp < ref < sl)):
                raise ValueError("For a long the stop must be below the entry and the target above it (the reverse for a short)")
            tick = await self._tick(r)
            tp, sl = _round(tp, tick), _round(sl, tick)
            lmt = _round(lmt, tick) if lmt else lmt
        rth = bool(body.get("outsideRth")) and r.sec_type == "STK"
        order = Order(action=action, totalQuantity=qty, orderType=otype, tif=tif, account=account,
                      outsideRth=rth, transmit=not bracket)
        if lmt:
            order.lmtPrice = lmt
        if aux:
            order.auxPrice = aux
        if bracket:
            # parent + take-profit limit + stop-loss stop, the two exits one-cancels-other; only the last transmits
            order.orderId = self.ib.client.getReqId()
            exit_side = "SELL" if action == "BUY" else "BUY"
            take = Order(action=exit_side, totalQuantity=qty, orderType="LMT", lmtPrice=tp, tif=tif, account=account,
                         outsideRth=rth, parentId=order.orderId, transmit=False)
            stop = Order(action=exit_side, totalQuantity=qty, orderType="STP", auxPrice=sl, tif=tif, account=account,
                         outsideRth=rth, parentId=order.orderId, transmit=True)
            log.warning("Placing bracket %s %s %s %s lmt=%s tp=%s sl=%s tif=%s acct=%s", action, qty,
                        r.live.localSymbol or r.live.symbol, otype, lmt, tp, sl, tif, account)
            trade = self.ib.placeOrder(r.live, order)
            self.ib.placeOrder(r.live, take)
            self.ib.placeOrder(r.live, stop)
            return trade_dict(trade)
        log.warning("Placing %s %s %s %s lmt=%s aux=%s tif=%s acct=%s", action, qty, r.live.localSymbol or r.live.symbol,
                    otype, lmt, aux, tif, account)
        trade = self.ib.placeOrder(r.live, order)
        return trade_dict(trade)

    async def _tick(self, r) -> float:
        if r.key not in self._ticks:
            try:
                cds = await self.ib.reqContractDetailsAsync(r.live)
                self._ticks[r.key] = float(cds[0].minTick) if cds and cds[0].minTick else 0.01
            except Exception:
                return 0.01
        return self._ticks[r.key]

    def cancel(self, order_id: int) -> bool:
        for t in self.ib.openTrades():
            if t.order.orderId == order_id:
                self.ib.cancelOrder(t.order)
                return True
        return False
