import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { initAlerts } from './alerts';
import { initDrawings } from './drawings';
import { avatar, icon } from './icons';
import { type Bar } from './indicators';
import type { ISeriesApi } from 'lightweight-charts';
import { initStudies, orderFlow } from './studies';
import { initFootprint } from './footprint';
import { initProfiles } from './profile';
import { initTrading } from './trading';
import { initSideLayout } from './layout';
import { loadColors, openChartSettings, withAlpha, type ChartColors } from './settings';
import { attachSearch, shortName } from './search';
import { initWatchlist, type Details } from './watchlist';
import { initMultiChart } from './multichart';
import { initScreener } from './screener';
import { askName, lib, loadLibrary, onLibrary, updateLibrary } from './library';
import { CHART_ID, EMBED, PREFIX, listen, post, syncOpts } from './sync';
import './style.css';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'] as const;
type TF = (typeof TIMEFRAMES)[number];
const TF_LABEL: Record<TF, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1D': 'D', '1W': 'W', '1M': 'M' };
const TF_LEGEND: Record<TF, string> = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '1h', '2h': '2h', '4h': '4h', '1D': '1D', '1W': '1W', '1M': '1M' };
const INTRADAY = new Set<TF>(['1m', '5m', '15m', '30m', '1h', '2h', '4h']);
const TF_SEC: Partial<Record<TF, number>> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };
// Bottom range buttons: timeframe to switch to and how far back to show (days; 0 = everything)
const RANGES: [string, TF, number][] = [
  ['1D', '1m', 1], ['5D', '5m', 5], ['1M', '30m', 31], ['3M', '1h', 92], ['6M', '2h', 183],
  ['YTD', '1D', -1], ['1Y', '1D', 365], ['5Y', '1W', 1826], ['All', '1M', 0],
];


// ---------- persisted settings ----------
// symbol, timeframe and chart type are kept per chart in a multi-chart layout
const PER_CHART = new Set(['key', 'tf', 'chartType']);
const pk = (k: string) => (PER_CHART.has(k) ? PREFIX + k : k);
function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(pk(k)); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) { try { localStorage.setItem(pk(k), JSON.stringify(v)); } catch { /* ignore */ } }
if (EMBED) document.body.classList.add('embed');
function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
document.querySelectorAll<HTMLElement>('[data-icon]').forEach((n) => (n.innerHTML = icon(n.dataset.icon!)));

let key: string = load('key', 'STK:AAPL:SMART:USD');
let tf: TF = load('tf', '1D');
if (!TIMEFRAMES.includes(tf)) tf = '1D';


// ---------- chart ----------
const css = getComputedStyle(document.documentElement);
void css;
let colors: ChartColors = loadColors();
const chart = createChart(el('chart'), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 12, attributionLogo: false },
  grid: { vertLines: { color: colors.grid, visible: colors.gridOn }, horzLines: { color: colors.grid, visible: colors.gridOn } },
  crosshair: { mode: CrosshairMode.Normal,
    vertLine: { color: '#6a6a6a', style: LineStyle.Dashed, labelBackgroundColor: '#2a2a2a' },
    horzLine: { color: '#6a6a6a', style: LineStyle.Dashed, labelBackgroundColor: '#2a2a2a' } },
  rightPriceScale: { borderColor: '#2a2a2a' },
  timeScale: { borderColor: '#2a2a2a', rightOffset: 10, timeVisible: true, secondsVisible: false },
});
const candles = chart.addSeries(CandlestickSeries, {
});
const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol',
  lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });

// ---------- chart types ----------
// `candles` always holds the price data (alerts, drawings and autoscale hang off it). For bar, line and
// area styles it turns transparent and a second series on the same scale does the drawing.
const CHART_TYPES = { candles: 'Candles', hollow: 'Hollow candles', ha: 'Heikin Ashi', bars: 'Bars', line: 'Line', area: 'Area', footprint: 'Footprint' } as const;
type ChartType = keyof typeof CHART_TYPES;
let chartType: ChartType = load('chartType', 'candles');
if (!(chartType in CHART_TYPES)) chartType = 'candles';
let styleSeries: ISeriesApi<'Bar'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null = null;
const CLEAR = 'rgba(0,0,0,0)';
function applyChartType() {
  if (styleSeries) { chart.removeSeries(styleSeries); styleSeries = null; }
  const c = colors;
  const solid = { upColor: c.up, downColor: c.down, borderVisible: c.border, borderUpColor: c.borderUp, borderDownColor: c.borderDown,
    wickUpColor: c.wickUp, wickDownColor: c.wickDown, lastValueVisible: true, priceLineVisible: true };
  footprint.setShown(chartType === 'footprint');
  volume.applyOptions({ visible: colors.volume && chartType !== 'footprint' });
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: colors.volume && chartType !== 'footprint' ? 0.24 : 0.08 } });
  if (chartType === 'candles' || chartType === 'ha') candles.applyOptions(solid);
  else if (chartType === 'hollow') candles.applyOptions({ ...solid, upColor: CLEAR, borderVisible: true, borderUpColor: c.border ? c.borderUp : c.up, borderDownColor: c.border ? c.borderDown : c.down });
  else {
    const fpType = chartType === 'footprint'; // footprint draws its own candles; keep the price line
    candles.applyOptions({ upColor: CLEAR, downColor: CLEAR, borderVisible: false, wickUpColor: CLEAR, wickDownColor: CLEAR, lastValueVisible: fpType, priceLineVisible: fpType });
    if (fpType) { /* drawn by the footprint primitive */ } else if (chartType === 'bars') styleSeries = chart.addSeries(BarSeries, { upColor: c.up, downColor: c.down, thinBars: false });
    else if (chartType === 'line') styleSeries = chart.addSeries(LineSeries, { color: c.line, lineWidth: 2 });
    else styleSeries = chart.addSeries(AreaSeries, { lineColor: c.line, topColor: withAlpha(c.line, 0.35), bottomColor: withAlpha(c.line, 0), lineWidth: 2 });
  }
  el('ct-btn').innerHTML = icon(`ct-${chartType}`);
  syncFlow();
  el('ct-btn').title = `Chart type: ${CHART_TYPES[chartType]}`;
  setMain();
}
function heikinAshi(src: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of src) {
    const p = out[out.length - 1];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = p ? (p.open + p.close) / 2 : (b.open + b.close) / 2;
    out.push({ ...b, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) });
  }
  return out;
}
const asCandle = (b: Bar) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
const asValue = (b: Bar) => ({ time: b.time as UTCTimestamp, value: b.close });
/** Push all of `bars` into the price series for the current chart type. */
function setMain() {
  candles.setData((chartType === 'ha' ? heikinAshi(bars) : bars).map(asCandle));
  if (styleSeries && chartType === 'bars') (styleSeries as ISeriesApi<'Bar'>).setData(bars.map(asCandle));
  else if (styleSeries) (styleSeries as ISeriesApi<'Line'>).setData(bars.map(asValue));
}
/** Update just the latest bar. */
function updateMain(b: Bar) {
  if (chartType === 'ha') { setMain(); return; }
  candles.update(asCandle(b));
  if (styleSeries && chartType === 'bars') (styleSeries as ISeriesApi<'Bar'>).update(asCandle(b));
  else if (styleSeries) (styleSeries as ISeriesApi<'Line'>).update(asValue(b));
}

const drawings = initDrawings({ chart, candles, getBars: () => bars, wrap: el('chart-wrap') });

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
  color: withAlpha(b.close >= b.open ? colors.volUp : colors.volDown, 0.75) });

let profiles: ReturnType<typeof initProfiles> | null = null;
const studies = initStudies({ chart, getBars: () => bars, isIntraday: () => INTRADAY.has(tf), wrap: el('chart-wrap'),
  onChange: () => { renderLegend(); syncFlow(); }, custom: (items) => profiles?.set(items), storeKey: `${PREFIX}studies` });
function computeIndicators() { studies.compute(); }

// ---------- footprint / order flow ----------
let fpRedrawPending = 0;
const footprint = initFootprint({ chart, candles, getBars: () => bars, shift, barSeconds: () => TF_SEC[tf] ?? null,
  colors: () => ({ up: colors.up, down: colors.down, wickUp: colors.wickUp, wickDown: colors.wickDown, text: colors.text }),
  onData: () => { // order-flow indicators follow the data, at most a few times a second
    profiles?.flowChanged();
    if (fpRedrawPending) return;
    fpRedrawPending = window.setTimeout(() => { fpRedrawPending = 0; if (studies.needsFlow()) { computeIndicators(); renderLegend(); } }, 250);
  } });
orderFlow.bar = (t) => footprint.bar(t);
profiles = initProfiles({ chart, candles, getBars: () => bars, flow: (t) => footprint.bar(t) });
let flowOn = false;
const wantFlow = () => INTRADAY.has(tf) && (chartType === 'footprint' || studies.needsFlow());
/** Ask the server for order-flow data only while the footprint or a delta indicator is showing. */
function syncFlow() {
  const want = wantFlow();
  const st = el('fp-status');
  if (chartType === 'footprint' && !INTRADAY.has(tf)) { st.hidden = false; st.textContent = 'Footprint works on 1m to 4h charts; showing candles.'; }
  else if (!want) st.hidden = true;
  if (want === flowOn) return;
  flowOn = want;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'footprint', on: want }));
  if (want) { st.hidden = false; st.textContent = 'Order flow: loading trades from IBKR…'; }
}
function fpStatus(m: { status?: string; note?: string; reach?: number | null }) {
  if (!m.status || !flowOn) return;
  const st = el('fp-status');
  st.hidden = false;
  if (m.status === 'loading') st.textContent = 'Order flow: loading trades from IBKR…';
  else if (m.note) st.textContent = `Order flow: ${m.note}`;
  else if (m.reach) {
    const d = new Date(m.reach * 1000);
    st.textContent = `Order flow from ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (IBKR history limit) · live`;
  } else st.textContent = 'Order flow · live';
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
  setMain();
  volume.setData(bars.map(volBar));
  computeIndicators();
  if (pendingRange !== null) { applyRange(pendingRange); pendingRange = null; } else chart.timeScale().scrollToRealTime();
  drawings.show(key);
  renderLegend();
}

function updateBar(raw: Bar) {
  const b = { ...raw, time: shift(raw.time) };
  const last = allBars[allBars.length - 1];
  if (last && b.time < last.time) return;
  if (last && b.time === last.time) allBars[allBars.length - 1] = b; else allBars.push(b);
  if (replayIdx != null) return; // live updates wait until replay ends
  bars = allBars;
  updateMain(b);
  volume.update(volBar(b));
  computeIndicators();
  renderLegend();
  drawings.refresh();
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
  const inds = studies.overlayLegend(b.time);
  studies.paneLegends(b.time);
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
    else if (m.type === 'fp' || m.type === 'fp_up') {
      if (m.key !== key || m.tf !== tf) return;
      if (m.type === 'fp') footprint.snapshot(m); else footprint.patch(m);
      fpStatus(m);
    }
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
  setMain();
  volume.setData([]);
  computeIndicators();
  renderLegend();
  el<HTMLInputElement>('symbol').value = shortName(key);
  document.title = `${shortName(key)} · Charts`;
  footprint.reset();
  flowOn = wantFlow();
  el('fp-status').hidden = true;
  if (flowOn) fpStatus({ status: 'loading' });
  syncFlow();
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', key, tf, fp: flowOn }));
}

// ---------- timeframes ----------
const tfBox = el('timeframes');
for (const t of TIMEFRAMES) {
  const b = document.createElement('button');
  b.textContent = TF_LABEL[t];
  b.onclick = () => setTf(t);
  tfBox.appendChild(b);
}
function setTf(t: TF, fromSync = false) {
  tf = t; renderTfs(); subscribe();
  if (!fromSync && syncOpts().interval) post({ type: 'tf', from: CHART_ID, tf: t });
}
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

// ---------- chart type menu ----------
const ctMenu = el('ct-menu');
for (const [k, name] of Object.entries(CHART_TYPES)) {
  const b = document.createElement('button');
  b.innerHTML = `${icon(`ct-${k}`, 18)}<span>${name}</span>`;
  b.dataset.ct = k;
  b.onclick = (e) => { e.stopPropagation(); chartType = k as ChartType; save('chartType', k); ctMenu.hidden = true; applyChartType(); renderLegend(); };
  ctMenu.appendChild(b);
}
el('ct-btn').onclick = (e) => { e.stopPropagation(); ctMenu.hidden = !ctMenu.hidden; ctMenu.querySelectorAll<HTMLElement>('button').forEach((x) => x.classList.toggle('on', x.dataset.ct === chartType)); };
document.addEventListener('click', () => { ctMenu.hidden = true; });
applyChartType();

// ---------- indicators menu ----------
const indMenu = el('ind-menu');
studies.renderMenu(indMenu);
el('ind-btn').onclick = (e) => { e.stopPropagation(); indMenu.hidden = !indMenu.hidden; };
document.addEventListener('click', () => { indMenu.hidden = true; });
indMenu.onclick = (e) => e.stopPropagation();

// ---------- toolbar extras ----------
function applyColors(c: ChartColors) {
  colors = c;
  chart.applyOptions({ layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid, visible: c.gridOn }, horzLines: { color: c.grid, visible: c.gridOn } } });
  volume.applyOptions({ visible: c.volume && chartType !== 'footprint' }); // footprint shows volume per bar itself
  volume.setData(bars.map(volBar));
  applyChartType();
  el('chart-wrap').style.background = c.bg;
}
el('settings-btn').onclick = () => openChartSettings(colors, applyColors);
applyColors(colors);

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
  setMain();
  volume.setData(bars.map(volBar));
  computeIndicators();
  renderLegend();
  drawings.refresh();
}
function replayStep() {
  if (replayIdx == null) return;
  if (replayIdx >= allBars.length - 1) { pauseReplay(); notice('Replay reached the latest bar.'); return; }
  replayIdx += 1;
  const b = allBars[replayIdx];
  bars = allBars.slice(0, replayIdx + 1);
  updateMain(b);
  volume.update(volBar(b));
  computeIndicators();
  renderLegend();
  drawings.refresh();
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

// ---------- right rail toggles (main page only) ----------
function railToggle(btnId: string, panelId: string, store: string, dflt = true) {
  const btn = el(btnId), panel = el(panelId);
  const apply = (on: boolean) => {
    btn.classList.toggle('active', on);
    panel.classList.toggle('hidden', !on);
    const anyOn = ['watchlist', 'details', 'trading', 'alerts'].some((id) => !el(id).classList.contains('hidden'));
    el('side').classList.toggle('hidden', !anyOn);
    sideLayout?.layout();
  };
  let on = load(store, dflt);
  apply(on);
  btn.onclick = () => { on = !on; save(store, on); apply(on); };
}
const sideLayout = EMBED ? null : initSideLayout();
if (!EMBED) {
  railToggle('rail-wl', 'watchlist', 'showWatchlist');
  railToggle('rail-det', 'details', 'showDetails');
  railToggle('rail-tr', 'trading', 'showTrading', false);
  railToggle('rail-al', 'alerts', 'showAlerts', false);
}

// ---------- symbol search + watchlist ----------
/** Switch this chart's symbol. `fromSync`: the change came from another chart, so don't echo it back. */
function choose(k: string, fromSync = false) {
  key = k; details = null; subscribe(); watchlist?.setActive(key); alerts?.refreshLines(); trading?.symbolChanged();
  if (!fromSync && syncOpts().symbol) post({ type: 'symbol', from: CHART_ID, key: k });
}
/** Symbols picked in the side panels go to whichever chart is active in the layout. */
const pick = (k: string) => { if (!multi?.route(k)) choose(k); };
const multi = EMBED ? null : initMultiChart(() => { sideLayout?.layout(); chart.timeScale().applyOptions({}); });
const alerts = EMBED ? null : initAlerts({ getKey: () => key, getLast: () => allBars[allBars.length - 1]?.close ?? null, candles, onPick: pick });
const trading = EMBED ? null : initTrading({ getKey: () => key, getLast: () => allBars[allBars.length - 1]?.close ?? null, candles, onPick: pick });
attachSearch(el<HTMLInputElement>('symbol'), el<HTMLUListElement>('results'), (k) => choose(k));
const screener = EMBED ? null : initScreener(pick, () => chart.timeScale().applyOptions({}));
if (!EMBED) {
  const btn = el('rail-sc'), box = el('screener');
  let on = load('showScreener', false);
  const apply = () => { btn.classList.toggle('active', on); box.classList.toggle('hidden', !on); if (on) screener?.shown(); };
  apply();
  btn.onclick = () => { on = !on; save('showScreener', on); apply(); };
}
const watchlist = EMBED ? null : initWatchlist(pick, (d) => { if (d.key === key) { details = d; renderLegend(); } });
watchlist?.setActive(key);
// TradingView habit: start typing anywhere to search
window.addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[a-zA-Z]$/.test(e.key)) { const i = el<HTMLInputElement>('symbol'); i.focus(); i.value = ''; }
});

// ---------- saved layouts and chart style templates (layout menu, main page) ----------
const CHART_KEYS = ['key', 'tf', 'chartType', 'studies'];
const prefixOf = (i: number) => (i === 0 ? '' : `c${i}:`);
function snapshotLayout() {
  const n = multi!.count();
  return { layout: multi!.layout, sync: syncOpts(), charts: Array.from({ length: n }, (_, i) =>
    Object.fromEntries(CHART_KEYS.map((k) => [k, localStorage.getItem(prefixOf(i) + k)]))) };
}
function restoreLayout(l: { layout: string; sync: unknown; charts: Record<string, string | null>[] }) {
  l.charts.forEach((c, i) => CHART_KEYS.forEach((k) => {
    const v = c[k];
    if (v == null) localStorage.removeItem(prefixOf(i) + k); else localStorage.setItem(prefixOf(i) + k, v);
  }));
  localStorage.setItem('layout', JSON.stringify(l.layout));
  if (l.sync) localStorage.setItem('layoutSync', JSON.stringify(l.sync));
  location.reload();
}
function libRow(menu: HTMLElement, name: string, onPick: () => void, onDelete: () => void, title: string) {
  const b = document.createElement('button');
  b.innerHTML = '<span></span><span class="spacer"></span><span class="mini" title="Delete">×</span>';
  (b.children[0] as HTMLElement).textContent = name;
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onPick(); };
  (b.lastElementChild as HTMLElement).onclick = (e) => { e.stopPropagation(); onDelete(); };
  menu.appendChild(b);
}
multi?.addMenuSection((menu) => {
  const hint = (t: string) => { const h = document.createElement('div'); h.className = 'hint'; h.textContent = t; menu.appendChild(h); };
  const action = (label: string, f: () => void) => {
    const b = document.createElement('button');
    b.innerHTML = `${icon('plus', 14)}<span></span>`;
    (b.children[1] as HTMLElement).textContent = label;
    b.onclick = (e) => { e.stopPropagation(); f(); };
    menu.appendChild(b);
  };
  const rerender = () => { multi!.closeMenu(); el('layout-btn').click(); };
  hint('Saved layouts');
  action('Save layout as…', async () => {
    const name = askName('Layout name', localStorage.getItem('layoutName') ? JSON.parse(localStorage.getItem('layoutName')!) : '');
    if (!name) return;
    const snap = snapshotLayout();
    await updateLibrary((l) => { l.layouts[name] = snap; });
    localStorage.setItem('layoutName', JSON.stringify(name));
    rerender();
  });
  for (const [name, l] of Object.entries(lib().layouts))
    libRow(menu, name, () => { localStorage.setItem('layoutName', JSON.stringify(name)); restoreLayout(l); },
      async () => { await updateLibrary((x) => { delete x.layouts[name]; }); rerender(); }, 'Open this layout');
  hint('Chart style templates');
  action('Save chart style as…', async () => {
    const name = askName('Style name');
    if (!name) return;
    await updateLibrary((l) => { l.chartTemplates[name] = { colors: colors, chartType }; });
    rerender();
  });
  for (const [name, t] of Object.entries(lib().chartTemplates))
    libRow(menu, name, () => {
      localStorage.setItem('chartColors', JSON.stringify(t.colors));
      for (let i = 0; i < 4; i++) localStorage.setItem(prefixOf(i) + 'chartType', JSON.stringify(t.chartType));
      location.reload();
    }, async () => { await updateLibrary((x) => { delete x.chartTemplates[name]; }); rerender(); }, 'Apply colours and chart type to all charts');
});
onLibrary(() => studies.renderMenu(indMenu));
loadLibrary();

// ---------- multi-chart sync ----------
let hovering = false;
el('chart-wrap').addEventListener('pointerenter', () => (hovering = true));
el('chart-wrap').addEventListener('pointerleave', () => { hovering = false; if (syncOpts().crosshair) post({ type: 'xhair', from: CHART_ID, time: null }); });
if (EMBED) window.addEventListener('pointerdown', () => post({ type: 'focus', from: CHART_ID }), true);
const realTime = (t: number) => (INTRADAY.has(tf) ? t + new Date(t * 1000).getTimezoneOffset() * 60 : t);
chart.subscribeCrosshairMove((p) => {
  if (!hovering || !syncOpts().crosshair) return;
  post({ type: 'xhair', from: CHART_ID, time: p.time === undefined ? null : realTime(p.time as number) });
});
listen((m) => {
  if (m.type === 'symbol' && syncOpts().symbol && m.key !== key) choose(m.key, true);
  else if (m.type === 'tf' && syncOpts().interval && m.tf !== tf && (TIMEFRAMES as readonly string[]).includes(m.tf)) setTf(m.tf as TF, true);
  else if (m.type === 'setSymbol' && m.to === CHART_ID) choose(m.key);
  else if (m.type === 'reload' && EMBED) location.reload();
  else if (m.type === 'xhair' && !hovering && syncOpts().crosshair) {
    if (m.time === null || !bars.length) { chart.clearCrosshairPosition(); return; }
    const target = shift(m.time);
    let lo = 0, hi = bars.length - 1;
    if (target < bars[0].time) { chart.clearCrosshairPosition(); return; }
    while (lo < hi) { const k = (lo + hi + 1) >> 1; if (bars[k].time <= target) lo = k; else hi = k - 1; }
    chart.setCrosshairPosition(bars[lo].close, bars[lo].time as UTCTimestamp, candles);
  }
});

// ---------- connection status ----------
let wasConnected: boolean | null = null;
async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const c = el('conn');
    if (s.connected && wasConnected === false) { watchlist?.resubscribe(); subscribe(); } // IBKR came back
    wasConnected = s.connected;
    c.classList.toggle('ok', s.connected);
    c.title = s.connected ? `Connected to IBKR on port ${s.port}` : `Not connected to TWS / IB Gateway (${s.error ?? ''})`;
  } catch { el('conn').classList.remove('ok'); }
}
setInterval(pollStatus, 5000);
pollStatus();
connect();
