"""Saved layouts and templates (indicator sets, chart styles), kept as JSON on disk."""
from __future__ import annotations

import json
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data" / "library.json"
KINDS = ("layouts", "indicatorTemplates", "chartTemplates")


def load() -> dict:
    try:
        data = json.loads(DATA.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    return {k: data.get(k, {}) if isinstance(data.get(k), dict) else {} for k in KINDS}


def save(data: dict) -> dict:
    out = {k: {str(n)[:60]: v for n, v in (data.get(k) or {}).items()} for k in KINDS}
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out
