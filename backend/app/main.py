"""Local charting server: IBKR (TWS / IB Gateway) -> FastAPI -> browser."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from ib_async import IB

from . import contracts
from .streams import TIMEFRAMES, ChartStream

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


def _on_error(req_id, code, msg, *_):
    if code in INFO_CODES:
        return
    log.warning("IB error %s (req %s): %s", code, req_id, msg)
    for q in list(listeners):
        q.put_nowait({"type": "notice", "code": code, "message": msg})


async def connect():
    for port in PORTS:
        try:
            await ib.connectAsync(HOST, port, clientId=CLIENT_ID, readonly=True, timeout=5)
            ib.reqMarketDataType(3)  # live where subscribed, delayed otherwise
            state.update(port=port, error=None)
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
    task = asyncio.create_task(keep_connected())
    yield
    task.cancel()
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


# Serve the built front end (frontend/dist) at /
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(DIST / "index.html")
