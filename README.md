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

The left toolbar groups the tools like TradingView. Click a group to use the tool shown; click the small corner arrow (or right-click) to pick another one in that group.

- Lines: trend line, ray, extended line, info line, arrow, horizontal line, horizontal ray, vertical line, cross line, parallel channel.
- Fib, pitchfork and Gann: Fib retracement, trend-based Fib extension, Fib channel, Fib time zones, Fib speed fan, pitchfork, Gann fan, Gann box.
- Patterns: XABCD, ABCD, triangle, head and shoulders, Elliott impulse (12345) and correction (ABC) waves.
- Forecasting and measurement: long and short position (click entry, target, stop), date and price range, date range, price range, temporary measure.
- Shapes and brushes: rectangle, ellipse, circle, triangle, brush and highlighter (press and drag).
- Text and annotations: text, callout, note, price label, arrow marks up/down, flag.
- Shortcuts: Alt+T trend, Alt+H horizontal line, Alt+J horizontal ray, Alt+V vertical line, Alt+C cross line, Alt+F Fib, Alt+R rectangle. Esc cancels.
- Click a drawing to select it: a small bar appears to change its colour and width, edit its text (or double-click it), clone or delete it. Drag it or its handles to move. Delete/Backspace removes it.
- Magnet snaps to open/high/low/close. The pin keeps the tool active after each drawing. Lock, hide and remove-all are below.
- Drawings can be placed in the empty space right of the last bar. Undo/redo: arrows in the top bar, Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z.
- Saved in the browser per symbol and kept across timeframes.

Every colour setting (chart settings, indicators, drawings) opens a TradingView-style picker: preset grid,
your recent custom colours ("+" for any colour) and an opacity slider.

## Chart tabs

The strip at the very top holds chart tabs, like TradingView's. Each tab is a whole layout (1, 2 or 4 charts with
their symbols, intervals, chart types and indicators). "+" opens a new tab on the current symbol, click to switch,
× to close, double-click to rename (unnamed tabs show their symbol and interval). Tabs are kept between sessions.
Drawings work like TradingView's: each tab keeps its own. Select a drawing to choose where it shows from the
bar at the top: "All charts in this tab" (default: every chart of that symbol in the tab), "This chart only", or
"All tabs". Closing a tab removes its drawings, except those set to "All tabs". Drawings made before tabs
existed belong to the first tab.

## Trading (live orders)

- The SELL / BUY buttons at the top-left of the chart (or Shift+S / Shift+B) open an order ticket: market, limit, stop or stop-limit, DAY or GTC, and for stocks optional outside-hours.
- "Review order" shows a confirmation with the account and a red LIVE ACCOUNT badge (blue PAPER when TWS is logged into paper). Nothing is sent until you press "Send BUY/SELL order".
- **Armed** (the tick box next to BUY): when ticked, the bar turns red and orders skip the confirm screen. BUY / SELL and Shift+B / Shift+S send a market order for the quantity in the box at once, a ticket sends as soon as you submit it, and position Market/Limit buttons send the bracket straight away (unless the stop or target is on the wrong side, which still shows the screen). It is off every time the app starts.
- Long / Short position drawings look like TradingView's: target and stop zones with labels (distance, %, ticks and amount for the quantity in the box next to BUY/SELL), an Open PnL / Qty / Risk-reward box, shading and a dashed line to the current price. Handles on the left edge move the target, entry and stop; the one on the right sets the width.
- They can be sent as a trade: click the drawing and use **Market** or **Limit** on the bar at the top. Market enters now, Limit enters at the drawn entry price. Either way the drawn target (limit) and stop (stop order) go with it as one bracket, the exits cancelling each other when one fills, with prices snapped to the contract's tick size. Quantity comes from the box next to BUY/SELL and can be changed on the confirm screen, along with DAY or GTC. Market is blocked if the price is already past the stop or target.
- Orders go to the account TWS / IB Gateway is logged into. Futures trade the front-month contract shown in the chart title; crypto market orders are sent IOC (an IBKR rule).
- The wallet icon on the right rail opens positions, working orders (× cancels) and today's fills. Positions and working orders also show as lines on the chart.
- If TWS shows its own order-precaution pop-ups, they still need clicking in TWS (or turn them off under API > Precautions).

## Colours

- The gear icon in the top bar opens chart settings: candle body, wick and border colours, line/area colour, background, grid, scale text and volume colours (or hide volume). Changes preview live; "Defaults" resets.
- In the Indicators menu, "settings" on any indicator changes its lengths, the colour of each of its lines and the line width.

## Data providers

IBKR stays the default for everything, and the only route for orders. The database button at the top right opens
**Data providers**, where you switch other sources on, enter their keys and press **Test**. Keys and passwords are
saved only in the app's data folder (`providers.json`, readable by your user only), never in the repo, and are
never shown again.

| Provider | What it gives | Key |
|---|---|---|
| Binance | Crypto spot, live over a websocket | none |
| OANDA | Forex, metals, index CFDs | API token from the OANDA hub (Manage API Access); live or practice |
| IG | CFDs and spread bets | API key (My IG > Settings > API keys) plus your IG username and password; live or demo |
| Polygon | US stocks | API key. The free plan is end-of-day data and 5 calls a minute |
| Databento | CME futures history (OHLCV) | API key. Billed per use; the chart refreshes once a minute |
| Rithmic | not added | needs their API agreement, a conformance test and a login from an FCM or prop firm that clears through Rithmic |

**Default provider per type.** Out of the box: Binance for crypto, OANDA for forex, IBKR for stocks and futures; a default that is off or has no key yet falls back to IBKR. Polygon and Databento are off until you switch them on. IG is a live feed: a chart on IG takes its earlier bars from OANDA (or IBKR) for forex, so IG's 10,000-points-a-week history allowance isn't used; for other IG markets, set Chart history to IG. At the top of the dialog you can change the provider for Stocks, Futures, Forex and Crypto.
Any symbol of that type then loads from it. The chart title shows the source; click it to use another provider for
just that symbol (a dot marks an override). Search lists results from every switched-on provider, default first.

Limits worth knowing: order flow (footprint, bubbles, delta) needs IBKR's tick data; IG updates by polling its price snapshot every 2 seconds; Polygon and Databento are polled.

## Layout

- Drag the left edge of the right sidebar to make it wider or narrower, and drag the bars between the watchlist, details, trading and alerts panels to resize them. Sizes are remembered; double-click a bar to reset it.

## Symbol details and news

- The details panel (info icon on the right rail) shows price, day and 52-week range, open, bid/ask, volume and average volume, sector, and for futures the contract, multiplier and tick size.
- News lists recent headlines for the symbol from the news feeds your IBKR account has (the free API feeds are usually Briefing.com and Dow Jones); click one to read it. Futures and crypto rarely have symbol news.

## Footprint and order flow

Pick **Footprint** in the chart type menu (1m to 4h charts). Each bar shows sell × buy volume at every
price, a thin candle on its left, the point of control (yellow box), imbalances (bold green/red: buyers
at a price at least 3× the sellers one row lower, and the reverse) and the bar's delta and volume
underneath. Rows merge automatically when you zoom out; when the bars get too narrow it falls back to
candles with the delta under each bar. Indicators adds **Volume Delta** (histogram per bar) and
**Cumulative Volume Delta** (resets each session).

What comes from IBKR and what it means:
- Live trades come from tick-by-tick data and are classified against the bid/ask at that moment. This
  needs a real-time market data subscription for the instrument, and uses one of your few tick-by-tick
  slots, so it only runs for the chart you are looking at.
- IBKR sends at most 1,000 historical trades per request, so on first load the app fetches up to 15,000
  recent trades (the status box bottom-left says how far back that reached). Historical trades carry no
  bid/ask, so they are classified with the tick rule (up-tick = buy, down-tick = sell).
- Every complete minute is saved in `backend/data/ticks.sqlite` (10 days kept), so history builds up
  while the app runs and later loads only fetch the gap.

## Levels and volume profile

From **Indicators**:
- **Previous session O/H/L/C**: the previous session's open, high, low and close (PDO/PDH/PDL/PDC), held
  flat through the session. A session starts after a gap of 45 minutes or more (overnight for stocks,
  the daily break for futures) or on a new day; on daily charts it is the previous bar. In its settings,
  **Sessions to show** (default 1, the current session only) draws the levels for that many recent sessions,
  each with its own previous session's levels, and **Show labels** puts the PDH/PDL/... text on each line.
- **Price bubbles (order flow)**: on intraday charts, a green bubble where the volume bought at the ask at one
  price within a bar reaches the **Minimum size** (contracts or shares), a red one for volume sold at the bid.
  Bubble size grows with the volume (up to **Largest bubble**); colours and buys/sells on or off in settings.
  It uses the same tick data as the footprint, so it covers the period that data reaches back to.
- **Asia session High/Low**: high and low between two hours of your local time, 00:00 to 08:00 by default
  (London time on your Mac). The lines follow the range while the window is open, then hold until the
  next one. Change the hours in the indicator's settings.
- **Volume Profile (session)**: one profile per session with POC, VAH and VAL. **Volume Profile (visible
  range)** builds one profile from the bars on screen, on the right edge. Settings: number of rows and
  value area % (70 by default). When order-flow data is on (footprint chart or a delta indicator) the
  profile uses the exact traded volume at each price; otherwise each bar's volume is spread over its range.

Every line in these (and the other indicators) has its own tick box and colour in the settings dialog.

## Multi-chart layouts

The layout button (top right) switches between one chart, two side by side, two stacked and four
(2 × 2). Each chart keeps its own symbol, interval, chart type and indicators. Click a chart to make it
active (blue outline); the watchlist, alerts and positions send symbols to the active chart. Sync
options in the same menu: symbol, interval and crosshair (on by default).

Each extra chart is its own IBKR data stream (history plus live bars), and a footprint chart also uses
a tick-by-tick slot, so four footprint charts may hit your IBKR limits.

## Saved layouts and templates

- **Layouts**: layout menu > *Save layout as…* stores the grid, sync options and every chart's symbol,
  interval, chart type and indicators under a name. Pick a saved layout in the same menu to open it.
- **Indicator templates**: Indicators > *Save indicators as template…*; click a template in that menu to
  replace the chart's indicators with it (works in every chart of a layout).
- **Chart style templates**: layout menu > *Save chart style as…* keeps the colours and chart type;
  picking one applies it to all charts.

All of these are saved in `backend/data/library.json`, so they survive browser resets.

## Screener

The funnel button on the right rail opens the screener under the charts. It runs IBKR's market scanner
(the same scans as TWS's Market Scanner): top % gainers/losers, most active, unusual volume, gap
up/down, near 52- or 13-week high/low, most trades, halted, and more, on US major, NASDAQ, NYSE, LSE
or Europe. Filters: price, % change, volume, average volume and market cap. Up to 50 results; click a
column to sort, click a row to chart it in the active chart, tick *every 60s* to refresh.

Compared with TradingView's screener: IBKR ranks by one scan at a time and returns at most 50 rows, and
there are no technical filters (RSI, moving averages…) or most fundamental columns. Quotes in the table
are one snapshot per scan (delayed if you have no real-time subscription).

## Desktop app (Mac and Windows)

The app also comes as a normal desktop application: double-click it and the charts open in their own
window. No terminal and no browser tab. Closing the window stops everything. TWS or IB Gateway still
runs separately, with the API enabled, as before.

**Get it:** on GitHub, open *Releases* and download `IBKR-Charts-…-mac-arm64.dmg` (Apple Silicon Mac) or
`IBKR-Charts-…-windows-setup.exe`. New versions are built automatically when a version tag is pushed
(`git tag v1.0.1 && git push origin v1.0.1`); you can also run the *Desktop app* workflow by hand from
the Actions tab and download the files from that run.

**Mac:** open the .dmg and drag *IBKR Charts* to Applications. The app isn't signed with an Apple
developer certificate, so the first time macOS blocks it: open System Settings > Privacy & Security,
scroll down and click *Open Anyway* (or run `xattr -dr com.apple.quarantine "/Applications/IBKR Charts.app"`).

**Windows:** run the setup .exe. SmartScreen may say it protected your PC (unsigned app): click
*More info* > *Run anyway*. The installer adds a Start menu and desktop shortcut.

Your watchlists, alerts, layouts and footprint history live in the app's data folder (File > Open data
folder). To carry over what you have from running `start.sh`, quit the app and copy the files from
`backend/data/` into that folder.

Build it yourself: `cd frontend && npm run build`, `cd backend && pip install pyinstaller && pyinstaller tv-backend.spec`,
then `cd desktop && npm install && npx electron-builder`. For development, `cd desktop && npm start`
uses the repo's backend and built front end.

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
