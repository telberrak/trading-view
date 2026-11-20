#!/usr/bin/env bash
# Starts the charting app on macOS / Linux: installs packages on first run,
# builds the front end, then runs the local server on http://127.0.0.1:8000.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null || { echo "python3 not found. Install it (e.g. brew install python@3.12)."; exit 1; }
command -v npm >/dev/null || { echo "npm not found. Install Node.js (e.g. brew install node)."; exit 1; }

if [ ! -x backend/.venv/bin/python ]; then
  echo "Creating Python environment..."
  "$PY" -m venv backend/.venv
fi
backend/.venv/bin/python -m pip install -q -r backend/requirements.txt

(
  cd frontend
  [ -d node_modules ] || npm install
  npm run build
)

URL="http://127.0.0.1:8000"
( sleep 2
  if command -v open >/dev/null; then open "$URL"; elif command -v xdg-open >/dev/null; then xdg-open "$URL"; fi
) &

cd backend
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
