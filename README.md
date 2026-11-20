# trading-view

Personal TradingView-style charts on live IBKR data. See PLAN.md for the roadmap.

## Run

Needs Python 3.10+ and Node.js 18+ (macOS: `brew install python node`).

1. In TWS: Global Configuration > API > Settings (File menu on Windows, TWS/Edit menu on macOS),
   tick **Enable ActiveX and Socket Clients**. The app is read-only, so "Read-Only API" can stay ticked.
   Add 127.0.0.1 to trusted IPs.
2. Start it:
   - **Windows:** double-click `start.bat`
   - **macOS / Linux:** `./start.sh` in Terminal (first time: `chmod +x start.sh` if needed)

   The first run installs packages (a minute or two), then opens http://127.0.0.1:8000.

The server tries TWS live (7496), TWS paper (7497), Gateway live (4001), Gateway paper (4002) in that order.
Force one with `set IB_PORT=7497` before `start.bat` (Windows) or `IB_PORT=7497 ./start.sh` (macOS). The dot top-right is green when connected.

## Use

- Type a symbol anywhere (like TradingView) and pick from the list: stocks, continuous futures (`ES1!`), crypto.
- Or type a key directly: `AAPL`, `FUT:ES:CME`, `FUT:NQ:CME`, `FUT:GC:COMEX`, `CRYPTO:BTC:PAXOS`.
- Timeframes: 1m 5m 15m 1h 1D 1W 1M. Intraday times are shown in your local time.
- Indicators: click EMA 9 / EMA 21 / VWAP to toggle; double-click an EMA to change its period. VWAP shows on intraday charts only.

## Develop

`npm run dev` in `frontend` (hot reload on :5173) with the server running on :8000.
