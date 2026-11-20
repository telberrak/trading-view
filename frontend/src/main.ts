import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { initAlerts } from './alerts';
import { initDrawings } from './drawings';
import { avatar, icon } from './icons';
import { ema, vwap, type Bar, type Point } from './indicators';
import { attachSearch, shortName } from './search';
import { initWatchlist, type Details } from './watchlist';
import './style.css';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'] as const;
type TF = (typeof TIMEFRAMES)[number];
const TF_LABEL: Record<TF, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1D': 'D', '1W': 'W', '1M': 'M' };
const TF_LEGEND: Record<TF, string> = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '1h', '2h': '2h', '4h': '4h', '1D': '1D', '1W': '1W', '1M': '1M' };
const INTRADAY = new Set<TF>(['1m', '5m', '15m', '30m', '1h', '2h', '4h']);
// Bottom range buttons: timeframe to switch to and how far back to show (days; 0 = everything)
const RANGES: [string, TF, number][] = [
  ['1D', '1m', 1], ['5D', '5m', 5], ['1M', '30m', 31], ['3M', '1h', 92], ['6M', '2h', 183],
  ['YTD', '1D', -1], ['1Y', '1D', 365], ['5Y', '1W', 1826], ['All', '1M', 0],
];

interface IndicatorCfg { id: string; kind: 'ema' | 'vwap'; period?: number; color: string; on: boolean }

// ---------- persisted settings ----------
function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
document.querySelectorAll<HTMLElement>('[data-icon]').forEach((n) => (n.innerHTML = icon(n.dataset.icon!)));

let key: string = load('key', 'STK:AAPL:SMART:USD');
let tf: TF = load('tf', '1D');
if (!TIMEFRAMES.includes(tf)) tf = '1D';
const indicators: IndicatorCfg[] = load('indicators', [
  { id: 'ema1', kind: 'ema', period: 9, color: '#2962ff', on: true },
  { id: 'ema2', kind: 'ema', period: 21, color: '#ff9800', on: true },
  { id: 'vwap', kind: 'vwap', color: '#e040fb', on: true },
]);

// ---------- chart ----------
const css = getComputedStyle(document.documentElement);
const UP = css.getPropertyValue('--candle-up').trim();
const DOWN = css.getPropertyValue('--candle-down').trim();
const chart = createChart(el('chart'), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: '#000000' }, textColor: '#dbdbdb', fontSize: 12, attributionLogo: false },
  grid: { vertLines: { color: '#0e0e0e' }, horzLines: { color: '#0e0e0e' } },
  crosshair: { mode: CrosshairMode.Normal,
    vertLine: { color: '#6a6a6a', style: LineStyle.Dashed, labelBackgroundColor: '#2a2a2a' },
    horzLine: { color: '#6a6a6a', style: LineStyle.Dashed, labelBackgroundColor: '#2a2a2a' } },
  rightPriceScale: { borderColor: '#2a2a2a' },
  timeScale: { borderColor: '#2a2a2a', rightOffset: 10, timeVisible: true, secondsVisible: false },
});
const candles = chart.addSeries(CandlestickSeries, {
  upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
});
const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol',
  lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });
const drawings = initDrawings(chart, candles, el('chart-wrap'));

const lines = new Map<string, ISeriesApi<'Line'>>();
const lineData = new Map<string, Point[]>();
let bars: Bar[] = []; // what the chart shows (a prefix of allBars during replay)
let allBars: Bar[] = [];
let replayIdx: number | null = null; // index of the last visible bar while replaying
let label = '';
let loading = false;
let details: Details | null = null;
let pendingRange: number | null = null;

// IBKR sends UTC; shift intraday bars so the axis shows your local time.
const shift = (t: number) => (INTRADAY.has(tf) ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t);
const volBar = (b: Bar) => ({ time: b.time as UTCTimestamp, value: b.volume,
  color: b.close >= b.open ? 'rgba(38,120,110,.75)' : 'rgba(140,48,44,.75)' });

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
    s.applyOptions({ color: cfg.color });
    const pts = cfg.kind === 'ema' ? ema(bars, cfg.period!) : vwap(bars);
    lineData.set(cfg.id, pts);
    s.setData(pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
  }
}

function applyRange(days: number) {
  if (!bars.length) return;
  const ts = chart.timeScale();
  if (days === 0) { ts.fitContent(); return; }
  const last = bars[bars.length - 1].time;
  let from: number;
  if (days === -1) {
    const now = new Date();
    from = Date.UTC(now.getFullYear(), 0, 1) / 1000;
  } else from = last - days * 86400;
  ts.setVisibleRange({ from: Math.max(from, bars[0].time) as UTCTimestamp, to: last as UTCTimestamp });
}

function setHistory(raw: Bar[]) {
  allBars = raw.map((b) => ({ ...b, time: shift(b.time) }));
  bars = replayIdx == null ? allBars : allBars.slice(0, replayIdx + 1);
  candles.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
  volume.setData(bars.map(volBar));
  computeIndicators();
  if (pendingRange !== null) { applyRange(pendingRange); pendingRange = null; } else chart.timeScale().scrollToRealTime();
  drawings.show(key, tf);
  renderLegend();
}

function updateBar(raw: Bar) {
  const b = { ...raw, time: shift(raw.time) };
  const last = allBars[allBars.length - 1];
  if (last && b.time < last.time) return;
  if (last && b.time === last.time) allBars[allBars.length - 1] = b; else allBars.push(b);
  if (replayIdx != null) return; // live updates wait until replay ends
  bars = allBars;
  candles.update({ ...b, time: b.time as UTCTimestamp });
  volume.update(volBar(b));
  computeIndicators();
  renderLegend();
}

// ---------- legend (header with name, status and OHLC) ----------
const fmt = (v: number) => (Math.abs(v) >= 0.1 || v === 0 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toPrecision(4));
function renderLegend(param?: MouseEventParams) {
  const lg = el('legend');
  let b = bars[bars.length - 1];
  if (param?.time !== undefined) b = bars.find((x) => x.time === param.time) ?? b;
  const name = details?.name || label || shortName(key);
  const exch = details?.exchange ? ` · ${details.exchange}` : '';
  const status = details?.open == null ? '' : `<span class="status ${details.open ? '' : 'closed'}">${details.open ? 'Open' : 'Closed'}</span>`;
  const head = `<span class="title">${avatar(shortName(key), 18)}<span class="t"></span></span>${status}`;
  if (!b) {
    lg.innerHTML = `<div class="row">${head}<span class="ind">${loading ? 'Loading from IBKR…' : ''}</span></div>`;
    lg.querySelector('.t')!.textContent = `${name} · ${TF_LEGEND[tf]}${exch}`;
    return;
  }
  const i = bars.indexOf(b);
  const prev = i > 0 ? bars[i - 1].close : b.open;
  const chg = b.close - prev;
  const cls = chg >= 0 ? 'up' : 'down';
  const inds = indicators.filter((c) => lineData.has(c.id)).map((c) => {
    const p = lineData.get(c.id)!.find((x) => x.time === b.time);
    const n = c.kind === 'ema' ? `EMA ${c.period}` : 'VWAP';
    return `<span style="color:${c.color}">${n} ${p ? fmt(p.value) : '–'}</span>`;
  }).join('');
  lg.innerHTML = `<div class="row">${head}
    <span class="ohlc ${cls}"><b>O</b>${fmt(b.open)}<b>H</b>${fmt(b.high)}<b>L</b>${fmt(b.low)}<b>C</b>${fmt(b.close)}
    &nbsp;${chg >= 0 ? '+' : ''}${fmt(chg)} (${chg >= 0 ? '+' : ''}${((chg / prev) * 100).toFixed(2)}%)</span></div>
    <div class="ind">${inds}</div>`;
  lg.querySelector('.t')!.textContent = `${name} · ${TF_LEGEND[tf]}${exch}`;
}
chart.subscribeCrosshairMove(renderLegend);

// ---------- notices (stay until the next symbol/timeframe change or a click) ----------
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

// ---------- chart socket ----------
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
        notice(`IBKR returned no data for ${shortName(key)} on ${TF_LABEL[tf]}. ` + (crypto
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
  save('key', key);
  save('tf', tf);
  clearNotice();
  loading = true;
  label = '';
  stopReplay(false);
  bars = [];
  allBars = [];
  drawings.clear();
  candles.setData([]);
  volume.setData([]);
  computeIndicators();
  renderLegend();
  el<HTMLInputElement>('symbol').value = shortName(key);
  document.title = `${shortName(key)} · Charts`;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', key, tf }));
}

// ---------- timeframes ----------
const tfBox = el('timeframes');
for (const t of TIMEFRAMES) {
  const b = document.createElement('button');
  b.textContent = TF_LABEL[t];
  b.onclick = () => setTf(t);
  tfBox.appendChild(b);
}
function setTf(t: TF) { tf = t; renderTfs(); subscribe(); }
function renderTfs() { [...tfBox.children].forEach((c, i) => c.classList.toggle('active', TIMEFRAMES[i] === tf)); }
renderTfs();

// ---------- bottom range bar + clock ----------
const rangeBox = el('ranges');
for (const [name, rtf, days] of RANGES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => {
    if (tf === rtf && bars.length) applyRange(days);
    else { pendingRange = days; setTf(rtf); }
  };
  rangeBox.appendChild(b);
}
function tick() {
  const d = new Date();
  const off = -d.getTimezoneOffset() / 60;
  el('clock').textContent = `${d.toLocaleTimeString('en-GB')} UTC${off >= 0 ? '+' : ''}${off}`;
}
setInterval(tick, 1000);
tick();

// ---------- indicators menu ----------
const indMenu = el('ind-menu');
function renderIndMenu() {
  indMenu.innerHTML = '<div class="hint">Click to show or hide</div>';
  indicators.forEach((cfg, i) => {
    const b = document.createElement('button');
    const name = cfg.kind === 'ema' ? `EMA ${cfg.period}` : 'VWAP (intraday)';
    b.innerHTML = `<span class="swatch" style="background:${cfg.color};opacity:${cfg.on ? 1 : 0.25}"></span><span></span><span class="spacer"></span>`;
    (b.children[1] as HTMLElement).textContent = name;
    b.onclick = (e) => { e.stopPropagation(); cfg.on = !cfg.on; changedInds(); };
    if (cfg.kind === 'ema') {
      const edit = document.createElement('span');
      edit.textContent = 'edit';
      edit.style.color = 'var(--muted)';
      edit.onclick = (e) => {
        e.stopPropagation();
        const p = Number(window.prompt('EMA period', String(cfg.period)));
        if (p > 0) { cfg.period = Math.round(p); cfg.on = true; changedInds(); }
      };
      b.appendChild(edit);
      const del = document.createElement('span');
      del.textContent = '×';
      del.style.color = 'var(--muted)';
      del.onclick = (e) => { e.stopPropagation(); indicators.splice(i, 1); changedInds(); };
      b.appendChild(del);
    }
    indMenu.appendChild(b);
  });
  const add = document.createElement('button');
  add.innerHTML = `${icon('plus', 14)}<span>Add EMA…</span>`;
  add.onclick = (e) => {
    e.stopPropagation();
    const p = Number(window.prompt('EMA period', '50'));
    if (p > 0) {
      const palette = ['#26c6da', '#ffeb3b', '#ef5350', '#66bb6a', '#ab47bc', '#ffa726'];
      indicators.push({ id: `ema${Date.now()}`, kind: 'ema', period: Math.round(p), color: palette[indicators.length % palette.length], on: true });
      changedInds();
    }
  };
  indMenu.appendChild(add);
}
function changedInds() { save('indicators', indicators); renderIndMenu(); computeIndicators(); renderLegend(); }
renderIndMenu();
el('ind-btn').onclick = (e) => { e.stopPropagation(); indMenu.hidden = !indMenu.hidden; };
document.addEventListener('click', () => { indMenu.hidden = true; });
indMenu.onclick = (e) => e.stopPropagation();

// ---------- toolbar extras ----------
el('shot-btn').onclick = () => {
  const a = document.createElement('a');
  a.href = chart.takeScreenshot().toDataURL('image/png');
  a.download = `${shortName(key)}-${tf}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
  a.click();
};
el('full-btn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
};

// ---------- bar replay ----------
const replayBar = el('replay-bar');
let replaySelecting = false;
let replayTimer = 0;
let replaySpeed = 1000;
function redrawReplay() {
  bars = replayIdx == null ? allBars : allBars.slice(0, replayIdx + 1);
  candles.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
  volume.setData(bars.map(volBar));
  computeIndicators();
  renderLegend();
}
function replayStep() {
  if (replayIdx == null) return;
  if (replayIdx >= allBars.length - 1) { pauseReplay(); notice('Replay reached the latest bar.'); return; }
  replayIdx += 1;
  const b = allBars[replayIdx];
  bars = allBars.slice(0, replayIdx + 1);
  candles.update({ ...b, time: b.time as UTCTimestamp });
  volume.update(volBar(b));
  computeIndicators();
  renderLegend();
}
function pauseReplay() { clearInterval(replayTimer); replayTimer = 0; el('rp-play').innerHTML = icon('play', 18); }
function playReplay() {
  if (replayTimer) { pauseReplay(); return; }
  replayTimer = window.setInterval(replayStep, replaySpeed);
  el('rp-play').innerHTML = icon('pause', 18);
}
function startReplaySelect() {
  if (!allBars.length) return;
  replaySelecting = true;
  replayBar.hidden = false;
  el('replay-btn').classList.add('active');
  el('rp-hint').textContent = 'Click a bar to start replay from there';
  el('chart-wrap').classList.add('drawing');
}
function stopReplay(redraw = true) {
  pauseReplay();
  const was = replayIdx != null || replaySelecting;
  replayIdx = null;
  replaySelecting = false;
  replayBar.hidden = true;
  el('replay-btn').classList.remove('active');
  el('chart-wrap').classList.remove('drawing');
  if (was && redraw) { redrawReplay(); chart.timeScale().scrollToRealTime(); }
}
chart.subscribeClick((p) => {
  if (!replaySelecting || p.time === undefined) return;
  const i = allBars.findIndex((b) => b.time === p.time);
  if (i < 0) return;
  replaySelecting = false;
  replayIdx = i;
  el('chart-wrap').classList.remove('drawing');
  el('rp-hint').textContent = '';
  redrawReplay();
});
el('replay-btn').onclick = () => (replayIdx != null || replaySelecting ? stopReplay() : startReplaySelect());
el('rp-play').onclick = () => { if (replayIdx != null) playReplay(); };
el('rp-step').onclick = () => { pauseReplay(); replayStep(); };
el('rp-select').onclick = () => { pauseReplay(); startReplaySelect(); };
el('rp-exit').onclick = () => stopReplay();
el<HTMLSelectElement>('rp-speed').onchange = (e) => {
  replaySpeed = Number((e.target as HTMLSelectElement).value);
  if (replayTimer) { pauseReplay(); playReplay(); }
};
window.addEventListener('keydown', (e) => {
  if (replayIdx == null || document.activeElement instanceof HTMLInputElement) return;
  if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); pauseReplay(); replayStep(); }
});
el('rp-play').innerHTML = icon('play', 18);
el('rp-step').innerHTML = icon('step', 18);

// ---------- right rail toggles ----------
function railToggle(btnId: string, panelId: string, store: string, dflt = true) {
  const btn = el(btnId), panel = el(panelId);
  const apply = (on: boolean) => {
    btn.classList.toggle('active', on);
    panel.classList.toggle('hidden', !on);
    const anyOn = ['watchlist', 'details', 'alerts'].some((id) => !el(id).classList.contains('hidden'));
    el('side').classList.toggle('hidden', !anyOn);
  };
  let on = load(store, dflt);
  apply(on);
  btn.onclick = () => { on = !on; save(store, on); apply(on); };
}
railToggle('rail-wl', 'watchlist', 'showWatchlist');
railToggle('rail-det', 'details', 'showDetails');
railToggle('rail-al', 'alerts', 'showAlerts', false);

// ---------- symbol search + watchlist ----------
function choose(k: string) { key = k; details = null; subscribe(); watchlist.setActive(key); alerts.refreshLines(); }
const alerts = initAlerts({ getKey: () => key, getLast: () => allBars[allBars.length - 1]?.close ?? null, candles, onPick: (k) => choose(k) });
attachSearch(el<HTMLInputElement>('symbol'), el<HTMLUListElement>('results'), choose);
const watchlist = initWatchlist(choose, (d) => { if (d.key === key) { details = d; renderLegend(); } });
watchlist.setActive(key);
// TradingView habit: start typing anywhere to search
window.addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[a-zA-Z]$/.test(e.key)) { const i = el<HTMLInputElement>('symbol'); i.focus(); i.value = ''; }
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
