@echo off
REM Starts the charting app: installs packages on first run, builds the front end, runs the local server.
cd /d "%~dp0"

if not exist backend\.venv\Scripts\python.exe python -m venv backend\.venv || goto :err
backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt || goto :err

cd frontend
if not exist node_modules call npm install || goto :err
call npm run build || goto :err
cd ..

start "" http://127.0.0.1:8000
cd backend
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
goto :eof

:err
echo Something failed above.
pause
