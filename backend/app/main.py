"""Local charting server: IBKR (TWS / IB Gateway) -> FastAPI -> browser."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from ib_async import IB

from . import contracts, watchlists
from .details import details as symbol_details
from .quotes import QuoteSession
from .alerts import AlertEngine
from .streams import TIMEFRAMES, ChartStream
from .trading import Trading

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

HOST = os.getenv("IB_HOST", "127.0.0.1")
# Tried in order: TWS live, TWS paper, Gateway live, Gateway paper. Set IB_PORT to force one.
PORTS = [int(os.getenv("IB_PORT"))] if os.getenv("IB_PORT") else [7496, 7497, 4001, 4002]
CLIENT_ID = int(os.getenv("IB_CLIENT_ID", "71"))
INFO_CODES = {2104, 2106, 2107, 2108, 2119, 2158, 2100, 2150}

ib = IB()
state = {"port": None, "error": None}
listeners: set[asyncio.Queue] = set()
event_queues: set[asyncio.Queue] = set()


def broadcast(msg: dict):
    for q in list(event_queues):
        q.put_nowait(msg)


alerts = AlertEngine(ib, broadcast)
trading = Trading(ib, broadcast)


def _on_error(req_id, code, msg, *_):
    if code in INFO_CODES:
        return
    if code == 162 and "cancelled" in str(msg).lower():
        return  # we cancelled it ourselves (symbol/timeframe switch); not an error
    if code == 366:
        return  # "No historical data query found": a cancel racing a finished request
    log.warning("IB error %s (req %s): %s", code, req_id, msg)
    for q in list(listeners):
        q.put_nowait({"type": "notice", "code": code, "message": msg})


async def connect():
    for port in PORTS:
        try:
            await ib.connectAsync(HOST, port, clientId=CLIENT_ID, readonly=False, timeout=5)
            ib.reqMarketDataType(3)  # live where subscribed, delayed otherwise
            state.update(port=port, error=None)
            try:
                await asyncio.wait_for(ib.reqAllOpenOrdersAsync(), 10)  # include orders placed in TWS itself
            except Exception:  # noqa: BLE001
                log.warning("Could not load open orders")
            log.info("Connected to IBKR on %s:%s", HOST, port)
            return
        except Exception as e:  # noqa: BLE001
            state["error"] = f"{port}: {e!r}"
            ib.disconnect()
    log.error("Could not reach TWS / IB Gateway on ports %s. Is the API enabled?", PORTS)


async def keep_connected():
    while True:
        if not ib.isConnected():
            state["port"] = None
            await connect()
        await asyncio.sleep(10)


@asynccontextmanager
async def lifespan(_: FastAPI):
    ib.errorEvent += _on_error
    trading.attach()
    tasks = [asyncio.create_task(keep_connected()), asyncio.create_task(alerts.run())]
    yield
    for t in tasks:
        t.cancel()
    ib.disconnect()


app = FastAPI(title="trading-view", lifespan=lifespan)


@app.get("/api/status")
async def status():
    return {"connected": ib.isConnected(), "port": state["port"], "error": state["error"],
            "timeframes": list(TIMEFRAMES)}


@app.get("/api/search")
async def search(q: str):
    if not ib.isConnected():
        return JSONResponse({"error": "Not connected to IBKR"}, status_code=503)
    return await contracts.search(ib, q)


@app.websocket("/ws")
async def chart_ws(ws: WebSocket):
    """One socket per chart. Client sends {"type":"subscribe","key":..,"tf":..}."""
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue()
    listeners.add(queue)
    stream: ChartStream | None = None

    async def sender():
        while True:
            await ws.send_json(await queue.get())

    send_task = asyncio.create_task(sender())
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") != "subscribe":
                continue
            if stream:
                stream.stop()
                stream = None
            key, tf = msg.get("key", "AAPL"), msg.get("tf", "1D")
            if tf not in TIMEFRAMES:
                queue.put_nowait({"type": "notice", "message": f"Unknown timeframe {tf}"})
                continue
            if not ib.isConnected():
                queue.put_nowait({"type": "notice", "message": "Not connected to TWS / IB Gateway"})
                continue
            try:
                r = await contracts.resolve(ib, key)
                stream = ChartStream(ib, queue, r, tf)
                await stream.start()
            except Exception as e:  # noqa: BLE001
                log.exception("subscribe failed")
                queue.put_nowait({"type": "notice", "message": str(e)})
    except WebSocketDisconnect:
        pass
    finally:
        if stream:
            stream.stop()
        listeners.discard(queue)
        send_task.cancel()


@app.get("/api/details")
async def get_details(key: str):
    if not ib.isConnected():
        return JSONResponse({"error": "Not connected to IBKR"}, status_code=503)
    try:
        return await symbol_details(ib, key.upper())
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/alerts")
async def list_alerts():
    return alerts.list()


@app.post("/api/alerts")
async def create_alert(body: dict = Body(...)):
    try:
        a = alerts.create(body)
    except (KeyError, ValueError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    broadcast({"type": "alerts", "alerts": alerts.list()})
    return a


@app.patch("/api/alerts/{alert_id}")
async def update_alert(alert_id: str, body: dict = Body(...)):
    try:
        a = alerts.update(alert_id, body)
    except StopIteration:
        return JSONResponse({"error": "not found"}, status_code=404)
    broadcast({"type": "alerts", "alerts": alerts.list()})
    return a


@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str):
    alerts.delete(alert_id)
    broadcast({"type": "alerts", "alerts": alerts.list()})
    return {"ok": True}


@app.get("/api/account")
async def get_account():
    return {**trading.account(), "orders": trading.orders(), "positions": trading.positions(), "fills": trading.fills()}


@app.post("/api/orders")
async def place_order(body: dict = Body(...)):
    if body.get("confirmed") is not True:
        return JSONResponse({"error": "Order must be confirmed"}, status_code=400)
    try:
        return await trading.place(body)
    except (KeyError, ValueError, TypeError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.delete("/api/orders/{order_id}")
async def cancel_order(order_id: int):
    if not trading.cancel(order_id):
        return JSONResponse({"error": "Order not found or already done"}, status_code=404)
    return {"ok": True}


@app.websocket("/ws/events")
async def events_ws(ws: WebSocket):
    """Server-to-browser events: alert fired, alert list changed."""
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue()
    event_queues.add(q)
    try:
        await ws.send_json({"type": "alerts", "alerts": alerts.list()})
        while True:
            await ws.send_json(await q.get())
    except Exception:  # noqa: BLE001 - socket closed
        pass
    finally:
        event_queues.discard(q)


@app.get("/api/watchlists")
async def get_watchlists():
    return watchlists.load()


@app.put("/api/watchlists")
async def put_watchlists(data: dict = Body(...)):
    return watchlists.save(data)


@app.post("/api/watchlists/import")
async def import_watchlist(payload: dict = Body(...)):
    """Body: {"name": "My list", "text": "<TWS export or tickers>"} -> adds a new list."""
    keys = watchlists.parse_tws_export(payload.get("text", ""))
    if not keys:
        return JSONResponse({"error": "No symbols found in that file"}, status_code=400)
    data = watchlists.load()
    data["lists"].append({"name": payload.get("name") or "Imported", "symbols": keys})
    data["active"] = len(data["lists"]) - 1
    return watchlists.save(data)


@app.websocket("/ws/quotes")
async def quotes_ws(ws: WebSocket):
    """Client sends {"type":"symbols","keys":[...]}; server pushes {"type":"quotes","data":{key: quote}}."""
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue()
    session = QuoteSession(ib, queue)

    async def sender():
        while True:
            await ws.send_json(await queue.get())

    tasks = [asyncio.create_task(sender()), asyncio.create_task(session.run())]
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "symbols" and ib.isConnected():
                await session.set_symbols([str(k).upper() for k in msg.get("keys", [])])
    except WebSocketDisconnect:
        pass
    finally:
        session.stop()
        for t in tasks:
            t.cancel()


# Serve the built front end (frontend/dist) at /
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(DIST / "index.html")
