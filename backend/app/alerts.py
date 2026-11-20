"""Price alerts that run in the server, so they fire even when no chart is open.

Each alert watches one symbol and fires once when its condition is met:
  crossing  price moves through the level in either direction
  above     price is at or above the level
  below     price is at or below the level
"""
from __future__ import annotations

import asyncio
import json
import logging
import platform
import subprocess
import time
import uuid
from pathlib import Path

from ib_async import IB, Ticker

from . import contracts
from .quotes import snapshot

log = logging.getLogger("alerts")
DATA = Path(__file__).resolve().parents[1] / "data" / "alerts.json"
CONDITIONS = {"crossing", "above", "below"}


def load() -> list[dict]:
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def store(alerts: list[dict]):
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(alerts, indent=2), encoding="utf-8")


def triggered(cond: str, level: float, prev: float | None, last: float) -> bool:
    if cond == "above":
        return last >= level
    if cond == "below":
        return last <= level
    if prev is None:  # crossing needs a previous price to compare with
        return False
    return (prev < level <= last) or (prev > level >= last)


def os_notify(title: str, text: str):
    """Native notification on macOS so alerts show even when the browser is closed."""
    if platform.system() != "Darwin":
        return
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
    try:
        subprocess.Popen(["osascript", "-e",
                          f'display notification "{esc(text)}" with title "{esc(title)}" sound name "Glass"'])
    except Exception:  # noqa: BLE001
        log.exception("macOS notification failed")


class AlertEngine:
    def __init__(self, ib: IB, broadcast):
        self.ib = ib
        self.broadcast = broadcast  # callable(dict) -> None, pushes to every open browser
        self.alerts: list[dict] = load()
        self.tickers: dict[str, Ticker] = {}
        self.prev: dict[str, float] = {}

    # ---------- CRUD ----------
    def list(self) -> list[dict]:
        return self.alerts

    def create(self, body: dict) -> dict:
        cond = body.get("condition", "crossing")
        if cond not in CONDITIONS:
            raise ValueError(f"condition must be one of {sorted(CONDITIONS)}")
        a = {
            "id": uuid.uuid4().hex[:10],
            "key": str(body["key"]).upper(),
            "condition": cond,
            "price": float(body["price"]),
            "message": str(body.get("message") or "")[:200],
            "active": True,
            "created": int(time.time()),
            "triggeredAt": None,
        }
        self.alerts.append(a)
        store(self.alerts)
        return a

    def update(self, alert_id: str, body: dict) -> dict:
        a = next(x for x in self.alerts if x["id"] == alert_id)
        for f in ("price", "condition", "message", "active"):
            if f in body:
                a[f] = float(body[f]) if f == "price" else body[f]
        if body.get("active"):
            a["triggeredAt"] = None
            self.prev.pop(alert_id, None)
        store(self.alerts)
        return a

    def delete(self, alert_id: str):
        self.alerts = [x for x in self.alerts if x["id"] != alert_id]
        self.prev.pop(alert_id, None)
        store(self.alerts)

    # ---------- monitoring ----------
    async def _sync_subscriptions(self):
        wanted = {a["key"] for a in self.alerts if a["active"]}
        for k in [k for k in self.tickers if k not in wanted]:
            self.ib.cancelMktData(self.tickers.pop(k).contract)
        for k in wanted - set(self.tickers):
            try:
                r = await contracts.resolve(self.ib, k)
                self.tickers[k] = self.ib.reqMktData(r.live, "", False, False)
            except Exception as e:  # noqa: BLE001
                log.warning("alert symbol %s: %s", k, e)

    async def run(self):
        while True:
            await asyncio.sleep(0.5)
            if not self.ib.isConnected():
                self.tickers.clear()
                continue
            try:
                await self._sync_subscriptions()
                self._check()
            except Exception:  # noqa: BLE001
                log.exception("alert check failed")

    def _check(self):
        fired = False
        for a in self.alerts:
            if not a["active"] or a["key"] not in self.tickers:
                continue
            last = snapshot(self.tickers[a["key"]])["last"]
            if last is None:
                continue
            prev = self.prev.get(a["id"])
            self.prev[a["id"]] = last
            if triggered(a["condition"], a["price"], prev, last):
                a["active"] = False
                a["triggeredAt"] = int(time.time())
                a["lastPrice"] = last
                fired = True
                name = a["key"].split(":")[1] if ":" in a["key"] else a["key"]
                verb = {"crossing": "crossed", "above": "is above", "below": "is below"}[a["condition"]]
                text = a["message"] or f"{name} {verb} {a['price']:g} (last {last:g})"
                log.info("ALERT %s", text)
                self.broadcast({"type": "alert", "alert": a, "text": text})
                os_notify(f"Alert: {name}", text)
        if fired:
            store(self.alerts)
            self.broadcast({"type": "alerts", "alerts": self.alerts})
