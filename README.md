# trading-view

Personal TradingView-style charts on live IBKR data. See PLAN.md for the roadmap.

## Run

Needs Python 3.10+ and Node.js 18+ (macOS: `brew install python node`).

1. In TWS: Global Configuration > API > Settings (File menu on Windows, TWS/Edit menu on macOS),
   tick **Enable ActiveX and Socket Clients**. To place orders from the app, untick **Read-Only API** (otherwise orders are rejected with error 321).
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
- Indicators menu: overlays (EMA, SMA, Bollinger Bands, VWAP) and oscillators in their own panes (RSI, MACD, Stochastic, ATR). Click one to show or hide it, "edit" changes its lengths, × removes it; add as many as you like. VWAP is intraday only and resets at each session start.
- Chart type button (next to the timeframes): candles, hollow candles, Heikin Ashi, bars, line, area. Remembered between sessions.
- Left toolbar: drawing tools (see Drawings below).
- Top right: save chart image, full screen. Right rail: show/hide the watchlist and the symbol details panel.

## Drawings

- Tools: trend line, ray, horizontal line, vertical line, parallel channel (3 clicks: two points, then the width), Fib retracement, rectangle, text, and the measure ruler (price change, %, bars and time).
- Click a drawing to select it, drag it or its handles to move, Delete/Backspace removes it, Esc cancels.
- Magnet snaps points to the nearest open/high/low/close. Lock stops drawings being selected or moved. The eye hides them; the bin removes all on this symbol.
- Undo/redo: the arrows in the top bar, Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (or Ctrl+Y).
- Drawings are saved in the browser per symbol and stay put across timeframes.

## Trading (live orders)

- The SELL / BUY buttons at the top-left of the chart (or Shift+S / Shift+B) open an order ticket: market, limit, stop or stop-limit, DAY or GTC, and for stocks optional outside-hours.
- "Review order" shows a confirmation with the account and a red LIVE ACCOUNT badge (blue PAPER when TWS is logged into paper). Nothing is sent until you press "Send BUY/SELL order".
- Orders go to the account TWS / IB Gateway is logged into. Futures trade the front-month contract shown in the chart title; crypto market orders are sent IOC (an IBKR rule).
- The wallet icon on the right rail opens positions, working orders (× cancels) and today's fills. Positions and working orders also show as lines on the chart.
- If TWS shows its own order-precaution pop-ups, they still need clicking in TWS (or turn them off under API > Precautions).

## Colours

- The gear icon in the top bar opens chart settings: candle body, wick and border colours, line/area colour, background, grid, scale text and volume colours (or hide volume). Changes preview live; "Defaults" resets.
- In the Indicators menu, "settings" on any indicator changes its lengths, the colour of each of its lines and the line width.

## Layout

- Drag the left edge of the right sidebar to make it wider or narrower, and drag the bars between the watchlist, details, trading and alerts panels to resize them. Sizes are remembered; double-click a bar to reset it.

## Symbol details and news

- The details panel (info icon on the right rail) shows price, day and 52-week range, open, bid/ask, volume and average volume, sector, and for futures the contract, multiplier and tick size.
- News lists recent headlines for the symbol from the news feeds your IBKR account has (the free API feeds are usually Briefing.com and Dow Jones); click one to read it. Futures and crypto rarely have symbol news.

## Bar replay

Replay button > click the bar to start from. Then play/pause, step one bar (Shift+Right), pick a speed, choose a new start or exit.
Live updates keep arriving in the background and appear when you exit. How far back you can go depends on how much history
IBKR returns for the timeframe (about 3 days of 1m bars, months of 1h bars, years of daily bars).

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
