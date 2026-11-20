# TradingView-style charting app: implementation plan

As of 2026-11-20. Live version (with comments): https://claude.ai/artifact/NQibXvSH3ZezeKS4CnjK7F

## Goal and scope

A local, single-user charting app on your Windows PC that looks and feels like TradingView, fed by your IBKR account, so you can drop the TradingView subscription. A usable v1 is about 4 to 6 weeks of part-time work.

**In scope**
- TradingView-style candlestick charts: dark theme, crosshair, zoom and pan, timeframe switcher (1m to 1M), volume pane
- Watchlist sidebar with live last price, change and % change, grouped lists, click to load the chart
- Indicators: overlays (SMA, EMA, VWAP, Bollinger) and sub-panes (RSI, MACD, Stochastic, ATR), with editable settings
- Basic drawing tools: trend line, horizontal line, Fibonacci retracement
- Layouts and drawings saved locally

**Out of scope:** Pine Script, community, ideas, social, screeners, order entry (can come later).

## Architecture and stack

1. **IB Gateway** (or TWS), logged in, exposes the API on localhost (4001 Gateway live, 7497 TWS paper).
2. **Backend: Python 3.12, FastAPI + ib_async.** Historical bars, live ticks / 5-second bars aggregated into the chosen timeframe, indicator calculation, WebSocket push to the browser.
3. **Cache: SQLite** (or Parquet) for downloaded bars, so charts open instantly and IBKR history limits are hit less.
4. **Indicators: pandas-ta** on the server; simple ones (SMA, EMA) also in the browser for instant redraw.
5. **Front end: TypeScript + Vite + TradingView's open-source Lightweight Charts** (Apache 2.0). Watchlist, timeframe bar, indicator dialog, layout persistence built around it.
6. **Packaging:** one start script that launches the backend and opens the browser; optional Tauri desktop wrapper later.

Drawing tools are not built into Lightweight Charts, so they are custom work (or a plugin) in Phase 4.

## Phased milestones

| Phase | What you get | Effort |
| --- | --- | --- |
| 0. Setup | Repo in this folder, IB Gateway API enabled, Python and Node installed, script printing a live quote | 0.5 day |
| 1. Chart MVP | One symbol, candles + volume, timeframe switcher, cached IBKR history, live bar updates | 1 week |
| 2. Watchlist | Live price and % change, multiple lists, add/remove/reorder, click to switch chart, optional IBKR watchlist import | 1 week |
| 3. Indicators | Indicator picker, overlays and sub-panes, settings dialog, saved per chart | 1 week |
| 4. TradingView feel | TV-matching themes, keyboard shortcuts, symbol search, drawing tools, saved layouts, multi-chart grid | 1-2 weeks |
| 5. Nice to have | Price alerts with desktop notifications, positions and P&L overlay, Tauri desktop app | later |

Usable day to day after Phase 2.

## IBKR market data notes (approximate, from memory)

- **Subscriptions:** the API needs the same market data subscriptions as TWS. US stocks are typically covered by the US Securities Snapshot and Futures Value Bundle (about $10/month, often waived above a commission threshold); LSE, Euronext and futures exchanges are separate add-ons. Without them you get 15-minute delayed data, which the app will label.
- **Market data lines:** about 100 simultaneous live streams by default; a 50-symbol watchlist plus a few charts fits.
- **History pacing:** roughly 60 historical requests per 10 minutes; the local cache plus incremental top-up stays within this.
- **One session at a time:** logging in on mobile/web can bump the API session. Develop on the paper account or use a second username.
- **Gateway restarts:** IB Gateway restarts daily; IBC (open source) can auto-login. The backend reconnects automatically.

## Open questions

- [ ] Which markets do you trade (US stocks, UK/EU stocks, futures, FX, crypto, options)?
- [ ] Which indicators are must-haves on day one?
- [ ] Which timeframes do you use most?
- [ ] TWS or IB Gateway today, and do you have a paper account for development?
- [ ] Should the watchlist sync with your IBKR watchlists?
- [ ] Are Python and Node already installed on your PC?
