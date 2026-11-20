import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { ema, vwap, type Bar, type Point } from './indicators';
import { attachSearch, shortName } from './search';
import { initWatchlist } from './watchlist';
import './style.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1D', '1W', '1M'] as const;
type TF = (typeof TIMEFRAMES)[number];
const INTRADAY = new Set<TF>(['1m', '5m', '15m', '1h']);

interface IndicatorCfg { id: string; kind: 'ema' | 'vwap'; period?: number; color: string; on: boolean }

// ---------- persisted settings ----------
function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

let key: string = load('key', 'STK:AAPL:SMART:USD');
let tf: TF = load('tf', '1D');
const indicators: IndicatorCfg[] = load('indicators', [
  { id: 'ema1', kind: 'ema', period: 9, color: '#2962ff', on: true },
  { id: 'ema2', kind: 'ema', period: 21, color: '#ff9800', on: true },
  { id: 'vwap', kind: 'vwap', color: '#e040fb', on: true },
]);

// ---------- chart ----------
const chart = createChart(el('chart'), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc', fontSize: 12,
    attributionLogo: true },
  grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a2e39' },
  timeScale: { borderColor: '#2a2e39', rightOffset: 8, timeVisible: true, secondsVisible: false },
});
const candles = chart.addSeries(CandlestickSeries, {
  upColor: '#089981', downColor: '#f23645', borderVisible: false,
  wickUpColor: '#089981', wickDownColor: '#f23645',
});
const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol',
  lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
candles.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });

const lines = new Map<string, ISeriesApi<'Line'>>();
const lineData = new Map<string, Point[]>();
let bars: Bar[] = [];
let label = '';
let loading = false;

// IBKR sends UTC; shift intraday bars so the axis shows your local time.
const shift = (t: number) => (INTRADAY.has(tf) ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t);
const volBar = (b: Bar) => ({ time: b.time as UTCTimestamp, value: b.volume,
  color: b.close >= b.open ? 'rgba(8,153,129,.5)' : 'rgba(242,54,69,.5)' });

function computeIndicators() {
  for (const cfg of indicators) {
    let s = lines.get(cfg.id);
    const show = cfg.on && (cfg.kind !== 'vwap' || INTRADAY.has(tf));
    if (!show) { if (s) { chart.removeSeries(s); lines.delete(cfg.id); } lineData.delete(cfg.id); continue; }
    if (!s) {
      s = chart.addSeries(LineSeries, { color: cfg.color, lineWidth: 1, priceLineVisible: false,
        lastValueVisible: true, crosshairMarkerVisible: false });
      lines.set(cfg.id, s);
    }
    const pts = cfg.kind === 'ema' ? ema(bars, cfg.period!) : vwap(bars);
    lineData.set(cfg.id, pts);
    s.setData(pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
  }
}

function setHistory(raw: Bar[]) {
  bars = raw.map((b) => ({ ...b, time: shift(b.time) }));
  candles.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
  volume.setData(bars.map(volBar));
  computeIndicators();
  chart.timeScale().scrollToRealTime();
  renderLegend();
}

function updateBar(raw: Bar) {
  const b = { ...raw, time: shift(raw.time) };
  const last = bars[bars.length - 1];
  if (last && b.time < last.time) return;
  if (last && b.time === last.time) bars[bars.length - 1] = b; else bars.push(b);
  candles.update({ ...b, time: b.time as UTCTimestamp });
  volume.update(volBar(b));
  computeIndicators();
  renderLegend();
}

// ---------- legend (TradingView-style OHLC readout) ----------
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
function renderLegend(param?: MouseEventParams) {
  let b = bars[bars.length - 1];
  if (param?.time !== undefined) b = bars.find((x) => x.time === param.time) ?? b;
  if (!b) {
    el('legend').innerHTML = `<span class="title"></span><span class="ind">${loading ? 'Loading from IBKR…' : ''}</span>`;
    el('legend').querySelector('.title')!.textContent = `${label || shortName(key)} · ${tf}`;
    return;
  }
  const i = bars.indexOf(b);
  const prev = i > 0 ? bars[i - 1].close : b.open;
  const chg = b.close - prev;
  const col = chg >= 0 ? '#089981' : '#f23645';
  const inds = indicators.filter((c) => lineData.has(c.id)).map((c) => {
    const p = lineData.get(c.id)!.find((x) => x.time === b.time);
    const name = c.kind === 'ema' ? `EMA ${c.period}` : 'VWAP';
    return `<span style="color:${c.color}">${name} ${p ? fmt(p.value) : '–'}</span>`;
  }).join('&nbsp;&nbsp;');
  el('legend').innerHTML = `<div><span class="title">${label || key} · ${tf}</span>
    <span class="ohlc" style="color:${col}"><span>O ${fmt(b.open)}</span><span>H ${fmt(b.high)}</span>
    <span>L ${fmt(b.low)}</span><span>C ${fmt(b.close)}</span>
    <span>${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${((chg / prev) * 100).toFixed(2)}%)</span></span></div>
    <div class="ind">${inds}</div>`;
}
chart.subscribeCrosshairMove(renderLegend);

// ---------- notices ----------
// Notices stay up until the next symbol/timeframe change or a click.
function notice(msg: string) {
  const n = el('notice');
  if (n.hidden) n.textContent = '';
  const line = document.createElement('div');
  line.textContent = msg;
  n.appendChild(line);
  while (n.childElementCount > 4) n.firstElementChild!.remove();
  n.hidden = false;
}
function clearNotice() { const n = el('notice'); n.hidden = true; n.textContent = ''; }
el('notice').onclick = clearNotice;

// ---------- socket ----------
let ws: WebSocket | null = null;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => subscribe();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'history') {
      if (m.key !== key || m.tf !== tf) return;
      label = m.label;
      loading = false;
      if (!m.bars.length) {
        const crypto = key.startsWith('CRYPTO');
        notice(`IBKR returned no data for ${shortName(key)} on ${tf}. ` + (crypto
          ? 'Crypto needs crypto trading permission on your IBKR account (Client Portal > Settings > Trading Permissions > Cryptocurrency).'
          : 'Check your IBKR market data subscription for this exchange.'));
      }
      setHistory(m.bars);
    } else if (m.type === 'bar') updateBar(m.bar);
    else if (m.type === 'notice') notice(m.code ? `IBKR ${m.code}: ${m.message}` : m.message);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
function subscribe() {
  clearNotice();
  loading = true;
  save('key', key);
  save('tf', tf);
  label = '';
  bars = [];
  candles.setData([]);
  volume.setData([]);
  computeIndicators();
  renderLegend();
  el<HTMLInputElement>('symbol').value = shortName(key);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', key, tf }));
}
function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

// ---------- timeframe buttons ----------
const tfBox = el('timeframes');
for (const t of TIMEFRAMES) {
  const b = document.createElement('button');
  b.textContent = t;
  b.onclick = () => { tf = t; renderTfs(); subscribe(); };
  tfBox.appendChild(b);
}
function renderTfs() { [...tfBox.children].forEach((c, i) => c.classList.toggle('active', TIMEFRAMES[i] === tf)); }
renderTfs();

// ---------- indicator toggles (click = on/off, double-click EMA = change period) ----------
const indBox = el('indicators');
function renderInds() {
  indBox.innerHTML = '';
  for (const cfg of indicators) {
    const b = document.createElement('button');
    b.textContent = cfg.kind === 'ema' ? `EMA ${cfg.period}` : 'VWAP';
    b.style.color = cfg.on ? cfg.color : '';
    b.title = cfg.kind === 'ema' ? 'Click to toggle, double-click to change period' : 'Click to toggle (intraday only)';
    b.onclick = () => { cfg.on = !cfg.on; save('indicators', indicators); renderInds(); computeIndicators(); renderLegend(); };
    if (cfg.kind === 'ema') {
      b.ondblclick = () => {
        const p = Number(window.prompt('EMA period', String(cfg.period)));
        if (p > 0) { cfg.period = Math.round(p); cfg.on = true; save('indicators', indicators); renderInds(); computeIndicators(); renderLegend(); }
      };
    }
    indBox.appendChild(b);
  }
}
renderInds();

// ---------- symbol search ----------
const input = el<HTMLInputElement>('symbol');
function choose(k: string) { key = k; subscribe(); watchlist.setActive(key); }
attachSearch(input, el<HTMLUListElement>('results'), choose);
const watchlist = initWatchlist(choose);
watchlist.setActive(key);
// TradingView habit: start typing anywhere to search
window.addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[a-zA-Z]$/.test(e.key)) { input.focus(); input.value = ''; }
});

// ---------- connection status ----------
let wasConnected: boolean | null = null;
async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const c = el('conn');
    if (s.connected && wasConnected === false) { watchlist.resubscribe(); subscribe(); } // IBKR came back
    wasConnected = s.connected;
    c.classList.toggle('ok', s.connected);
    c.title = s.connected ? `Connected to IBKR on port ${s.port}` : `Not connected to TWS / IB Gateway (${s.error ?? ''})`;
  } catch { el('conn').classList.remove('ok'); }
}
setInterval(pollStatus, 5000);
pollStatus();
connect();
