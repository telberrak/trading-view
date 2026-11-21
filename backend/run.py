"""Entry point for the bundled desktop backend (and handy for running by hand): python run.py [port]."""
import os
import sys
import threading

import uvicorn

from app.main import app

def _exit_with_parent():
    """The desktop app keeps our stdin open; when it closes (app quit or crashed), stop right away."""
    try:
        while sys.stdin.read(1024):
            pass
    except Exception:  # noqa: BLE001
        pass
    os._exit(0)


if __name__ == "__main__":
    if os.getenv("TV_WATCH_STDIN") == "1":
        threading.Thread(target=_exit_with_parent, daemon=True).start()
    port = int(sys.argv[1] if len(sys.argv) > 1 else os.getenv("TV_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
