"""Local charting server: IBKR (TWS / IB Gateway) -> FastAPI -> browser."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from ib_async import IB

from . import contracts, library, news, providers, scanner, watchlists
from .details import details as symbol_details
from .quotes import QuoteSession
from .alerts import AlertEngine
from .footprint import FootprintStream
from .streams import TIMEFRAMES, ChartStream, bar_dict
from .trading import Trading
from .paths import DIST_DIR

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
    async def ibkr():
        if not ib.isConnected():
            return []
        try:
            return [{**r, "provider": "IBKR"} for r in await contracts.search(ib, q)]
        except Exception:  # noqa: BLE001
            log.exception("IBKR search")
            return []
    a, b = await asyncio.gather(ibkr(), providers.search_all(q))
    out = a + [{**r, "provider": providers.TITLES[providers.provider_of(r["key"])]} for r in b]
    # the default provider for each instrument type first
    defaults = providers.routing_cfg()["defaults"]
    kind_of = {"stock": "stock", "futures": "futures", "forex": "forex", "crypto": "crypto"}
    out.sort(key=lambda r: 0 if defaults.get(kind_of.get(r.get("type", ""), ""), "ibkr") == providers.provider_of(r["key"]) else 1)
    return out[:40]


@app.get("/api/providers")
async def get_providers():
    return {"providers": providers.public_cfg(), "fields": providers.FIELDS, "routing": providers.routing_cfg()}


@app.put("/api/providers")
async def put_providers(body: dict = Body(...)):
    if "providers" in body:
        providers.update_cfg(body["providers"])
    if "defaults" in body:
        providers.set_routing(defaults=body["defaults"])
    return await get_providers()


@app.post("/api/providers/{name}/test")
async def test_provider(name: str):
    if name not in providers.FIELDS:
        return JSONResponse({"error": "Unknown provider"}, status_code=404)
    try:
        return {"ok": True, "message": await providers.test(name)}
    except Exception as e:  # noqa: BLE001
        providers.STATUS[name] = f"Error: {e}"
        return JSONResponse({"ok": False, "error": str(e) or type(e).__name__}, status_code=400)


@app.get("/api/providers/sources")
async def data_sources(key: str):
    return providers.sources(key)


@app.put("/api/providers/override")
async def set_override(body: dict = Body(...)):
    providers.set_routing(override=(str(body["ident"]), body.get("provider") or None))
    return {"ok": True}


async def ibkr_history(key: str, tf: str) -> list[dict]:
    """IBKR bars for a key, history only (used to give IG's live feed a past)."""
    if not ib.isConnected():
        return []
    r = await contracts.resolve(ib, key)
    size, duration, _ = TIMEFRAMES[tf]
    bars = await asyncio.wait_for(ib.reqHistoricalDataAsync(r.history, endDateTime="", durationStr=duration, barSizeSetting=size,
                                                            whatToShow=r.what_to_show, useRTH=r.use_rth, formatDate=2, timeout=20), 25)
    return [bar_dict(b) for b in bars or []]


@app.websocket("/ws")
async def chart_ws(ws: WebSocket):
    """One socket per chart. Client sends {"type":"subscribe","key":..,"tf":..,"fp":bool}
    and {"type":"footprint","on":bool} to switch order-flow data on or off for the current chart."""
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue()
    listeners.add(queue)
    stream: ChartStream | None = None
    fp: FootprintStream | None = None
    current = None  # (resolved contract, tf)

    async def sender():
        while True:
            await ws.send_json(await queue.get())

    def stop_fp():
        nonlocal fp
        if fp:
            fp.stop()
            fp = None

    async def start_fp():
        nonlocal fp
        stop_fp()
        if current:
            fp = FootprintStream(ib, queue, *current)
            try:
                await fp.start()
            except Exception as e:  # noqa: BLE001
                log.exception("footprint failed")
                queue.put_nowait({"type": "notice", "message": f"Footprint: {e}"})

    send_task = asyncio.create_task(sender())
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "footprint":
                if msg.get("on"):
                    if not fp:
                        await start_fp()
                else:
                    stop_fp()
                continue
            if msg.get("type") != "subscribe":
                continue
            if stream:
                stream.stop()
                stream = None
            stop_fp()
            current = None
            key, tf = msg.get("key", "AAPL"), msg.get("tf", "1D")
            if tf not in TIMEFRAMES:
                queue.put_nowait({"type": "notice", "message": f"Unknown timeframe {tf}"})
                continue
            real = providers.route(key)
            if providers.is_provider_key(real):
                try:
                    stream = providers.ProviderStream(queue, real, tf, reply_key=key, ibkr_history=ibkr_history)
                    await stream.start()
                except Exception as e:  # noqa: BLE001
                    log.warning("provider subscribe %s: %s", real, e)
                    queue.put_nowait({"type": "history", "key": key, "tf": tf, "label": real, "bars": []})
                    queue.put_nowait({"type": "notice", "message": str(e)})
                if msg.get("fp"):
                    queue.put_nowait({"type": "notice", "message": "Order flow (footprint, delta, bubbles) needs IBKR tick data"})
                continue
            if not ib.isConnected():
                queue.put_nowait({"type": "notice", "message": "Not connected to TWS / IB Gateway"})
                continue
            try:
                r = await contracts.resolve(ib, real)
                current = (r, tf)
                stream = ChartStream(ib, queue, r, tf)
                await stream.start()
            except Exception as e:  # noqa: BLE001
                log.exception("subscribe failed")
                queue.put_nowait({"type": "notice", "message": str(e)})
                continue
            if msg.get("fp"):
                await start_fp()
    except WebSocketDisconnect:
        pass
    finally:
        if stream:
            stream.stop()
        stop_fp()
        listeners.discard(queue)
        send_task.cancel()


@app.get("/api/details")
async def get_details(key: str):
    real = providers.route(key)
    if providers.is_provider_key(real) and not providers.is_provider_key(key):
        # an IBKR symbol whose data comes from another provider: IBKR's description, the provider's name as exchange
        prov = providers.provider_of(real)
        d = None
        if ib.isConnected():
            with contextlib.suppress(Exception):
                d = await symbol_details(ib, key.upper())
        if d is None:
            d = await get_details(real)
        d = dict(d)
        d["exchange"] = providers.TITLES[prov]
        if prov == "binance":
            d["open"] = True  # crypto trades around the clock
        return d
    if providers.is_provider_key(key):
        prov = providers.provider_of(key)
        ident = providers.identity(key)
        return {"key": key, "name": key.split(":", 1)[1], "exchange": providers.TITLES[prov], "secType": (ident or ("cfd",))[0].upper(),
                "currency": "", "open": True if prov == "binance" else None, "industry": "", "category": "", "minTick": None, "multiplier": "", "localSymbol": ""}
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


@app.get("/api/news")
async def get_news(key: str):
    if providers.is_provider_key(key):
        return []
    if not ib.isConnected():
        return JSONResponse({"error": "Not connected to IBKR"}, status_code=503)
    try:
        return await news.headlines(ib, key.upper())
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/news/article")
async def get_article(provider: str, id: str):  # noqa: A002
    try:
        return await news.article(ib, provider, id)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Article not available"}, status_code=404)


@app.get("/api/account")
async def get_account():
    return {**trading.account(), "orders": trading.orders(), "positions": trading.positions(), "fills": trading.fills()}


@app.post("/api/orders")
async def place_order(body: dict = Body(...)):
    if body.get("confirmed") is not True:
        return JSONResponse({"error": "Order must be confirmed"}, status_code=400)
    try:
        key = str(body.get("key", ""))
        tv = providers.order_broker(key)
        if tv:
            return await tv[0].place(tv[1], body)
        if providers.is_provider_key(key):  # a chart opened from another provider's search: send its IBKR twin
            ident = providers.identity(key)
            twin = ident and providers.key_for(ident[0], ident[1], "ibkr", key)
            if not twin:
                raise ValueError("Orders go through IBKR, and this symbol has no IBKR equivalent")
            body = {**body, "key": twin}
        return await trading.place(body)
    except (KeyError, ValueError, TypeError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/orders/broker")
async def order_broker(key: str):
    """Where an order for this chart goes, for the confirm screen."""
    tv = providers.order_broker(key)
    if tv:
        env = tv[0].cfg.get("env")
        return {"broker": "Tradovate", "live": env != "demo"}
    return {"broker": "IBKR"}


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


@app.get("/api/scanner")
async def scanner_options():
    return scanner.options()


@app.post("/api/scanner")
async def run_scanner(body: dict = Body(...)):
    if not ib.isConnected():
        return JSONResponse({"error": "Not connected to IBKR"}, status_code=503)
    try:
        return await scanner.run(ib, body)
    except Exception as e:  # noqa: BLE001
        log.warning("scanner failed: %s", e)
        return JSONResponse({"error": str(e) or "IBKR scanner timed out"}, status_code=400)


@app.get("/api/library")
async def get_library():
    return library.load()


@app.put("/api/library")
async def put_library(data: dict = Body(...)):
    return library.save(data)


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

    prov_keys: dict[str, str] = {}  # browser key -> provider key
    tasks = [asyncio.create_task(sender()), asyncio.create_task(session.run()),
             asyncio.create_task(providers.quote_loop(lambda: list(prov_keys.values()),
                                                      lambda m: queue.put_nowait({**m, "data": {rev.get(k, k): v for k, v in m["data"].items()}})))]
    rev: dict[str, str] = {}
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") != "symbols":
                continue
            keys = [str(k).upper() for k in msg.get("keys", []) if not str(k).startswith("###")]
            routed = {k: providers.route(k) for k in keys}
            prov_keys.clear(); prov_keys.update({k: r for k, r in routed.items() if providers.is_provider_key(r)})
            rev.clear(); rev.update({r: k for k, r in prov_keys.items()})
            session.alias = {r: k for k, r in routed.items() if not providers.is_provider_key(r)}
            if ib.isConnected():
                await session.set_symbols([r for r in routed.values() if not providers.is_provider_key(r)])
    except WebSocketDisconnect:
        pass
    finally:
        session.stop()
        for t in tasks:
            t.cancel()


# Serve the built front end (frontend/dist) at /
DIST = DIST_DIR
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(DIST / "index.html")
