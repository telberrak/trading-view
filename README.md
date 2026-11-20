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
- Timeframes: 1m 5m 15m 30m 1h 2h 4h D W M. Intraday times are shown in your local time.
- Bottom bar: 1D 5D 1M 3M 6M YTD 1Y 5Y All jump to a range (switching timeframe like TradingView); clock on the right.
- Indicators menu: toggle EMA 9 / EMA 21 / VWAP, edit EMA periods, add more EMAs. VWAP shows on intraday charts only.
- Left toolbar: crosshair, trend line (click two points), horizontal line (click a price), hide and clear drawings. Drawings are saved in the browser per symbol.
- Top right: save chart image, full screen. Right rail: show/hide the watchlist and the symbol details panel.

## Alerts

- Alert button (or Alt+A) on the current symbol: Crossing, Greater than or Less than a price, with an optional message.
- Alerts run in the local server, so they keep watching while the browser is closed (as long as `start.sh` is running).
- When one fires: a toast in the app, a sound, a browser notification if the tab is in the background, and a macOS notification.
- Bell icon on the right rail lists alerts; restart a triggered one with ↻. Active alerts show as dashed orange lines on the chart.
- Saved in `backend/data/alerts.json`.

## Watchlist

- Lists on the right with live last price, change and % change (vs. previous close). Starter lists: Stocks, Futures, Crypto.
- Click a row to chart it; Up/Down arrow keys step through the list. Drag rows to reorder, hover and click × to remove.
- `+` searches IBKR and adds a symbol. The `⋯` menu adds a collapsible section, makes/renames/deletes lists and imports.
- **Import** takes a TWS watchlist export (in TWS: right-click the watchlist tab > Export page content, or any .csv/.txt of tickers) and adds it as a new list.
- Lists are saved in `backend/data/watchlists.json` (not committed).

If a chart stays empty, a yellow note explains why (usually a missing market data subscription or, for crypto, missing crypto trading permission).

## Develop

`npm run dev` in `frontend` (hot reload on :5173) with the server running on :8000.
