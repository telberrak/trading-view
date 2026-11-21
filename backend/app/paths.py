"""Where the app keeps its files. The desktop app points these at the user's app-data folder and at the
bundled front end; running from the repo uses backend/data and frontend/dist."""
from __future__ import annotations

import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("TV_DATA_DIR") or _ROOT / "backend" / "data")
DIST_DIR = Path(os.getenv("TV_FRONTEND_DIR") or _ROOT / "frontend" / "dist")
