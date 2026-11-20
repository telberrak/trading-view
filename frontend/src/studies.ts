import { HistogramSeries, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { icon } from './icons';
import { atr, bollinger, emaArr, macd, rsi, smaArr, stochastic, vwap, type Bar } from './indicators';

/**
 * Indicators ("studies"). Overlays draw on the price pane; oscillators get their own pane below it,
 * the way TradingView stacks them. Settings persist in localStorage.
 */
export type Kind = 'ema' | 'sma' | 'vwap' | 'bb' | 'rsi' | 'macd' | 'stoch' | 'atr';
export interface StudyCfg { id: string; kind: Kind; params: number[]; color: string; on: boolean }

interface Output { name: string; color: string; values: number[]; hist?: boolean; colors?: string[]; dashed?: boolean }
interface Def {
  title: string;
  pane: boolean;
  params: [string, number][];
  intradayOnly?: boolean;
  levels?: number[];
  label: (p: number[]) => string;
  calc: (bars: Bar[], p: number[], color: string) => Output[];
}

const UP = '#22ab94', DOWN = '#f23645';
export const DEFS: Record<Kind, Def> = {
  ema: { title: 'Moving Average Exponential', pane: false, params: [['Length', 9]], label: (p) => `EMA ${p[0]}`,
    calc: (b, p, c) => [{ name: 'EMA', color: c, values: emaArr(b.map((x) => x.close), p[0]) }] },
  sma: { title: 'Moving Average', pane: false, params: [['Length', 50]], label: (p) => `SMA ${p[0]}`,
    calc: (b, p, c) => [{ name: 'SMA', color: c, values: smaArr(b.map((x) => x.close), p[0]) }] },
  vwap: { title: 'VWAP (intraday)', pane: false, params: [], intradayOnly: true, label: () => 'VWAP',
    calc: (b, _p, c) => [{ name: 'VWAP', color: c, values: vwap(b).map((x) => x.value) }] },
  bb: { title: 'Bollinger Bands', pane: false, params: [['Length', 20], ['StdDev', 2]], label: (p) => `BB ${p[0]} ${p[1]}`,
    calc: (b, p, c) => {
      const r = bollinger(b, p[0], p[1]);
      return [{ name: 'Basis', color: '#ff6d00', values: r.mid, dashed: true }, { name: 'Upper', color: c, values: r.upper }, { name: 'Lower', color: c, values: r.lower }];
    } },
  rsi: { title: 'Relative Strength Index', pane: true, params: [['Length', 14]], levels: [70, 30], label: (p) => `RSI ${p[0]}`,
    calc: (b, p, c) => [{ name: 'RSI', color: c, values: rsi(b, p[0]) }] },
  macd: { title: 'MACD', pane: true, params: [['Fast', 12], ['Slow', 26], ['Signal', 9]], levels: [0], label: (p) => `MACD ${p.join(' ')}`,
    calc: (b, p, c) => {
      const r = macd(b, p[0], p[1], p[2]);
      const colors = r.hist.map((h, i) => (h >= 0 ? (h >= (r.hist[i - 1] ?? h) ? '#26a69a' : '#b2dfdb') : (h <= (r.hist[i - 1] ?? h) ? '#ff5252' : '#ffcdd2')));
      return [{ name: 'Histogram', color: UP, values: r.hist, hist: true, colors }, { name: 'MACD', color: c, values: r.line }, { name: 'Signal', color: '#ff6d00', values: r.signal }];
    } },
  stoch: { title: 'Stochastic', pane: true, params: [['%K length', 14], ['%K smoothing', 3], ['%D smoothing', 3]], levels: [80, 20], label: (p) => `Stoch ${p.join(' ')}`,
    calc: (b, p, c) => { const r = stochastic(b, p[0], p[1], p[2]); return [{ name: '%K', color: c, values: r.k }, { name: '%D', color: '#ff6d00', values: r.d }]; } },
  atr: { title: 'Average True Range', pane: true, params: [['Length', 14]], label: (p) => `ATR ${p[0]}`,
    calc: (b, p, c) => [{ name: 'ATR', color: c, values: atr(b, p[0]) }] },
};
const ADD_ORDER: Kind[] = ['ema', 'sma', 'bb', 'vwap', 'rsi', 'macd', 'stoch', 'atr'];
const PALETTE = ['#2962ff', '#ff9800', '#e040fb', '#26c6da', '#ffeb3b', '#ef5350', '#66bb6a', '#ab47bc', '#7e57c2'];
void DOWN;

const DEFAULT: StudyCfg[] = [
  { id: 'ema1', kind: 'ema', params: [9], color: '#2962ff', on: true },
  { id: 'ema2', kind: 'ema', params: [21], color: '#ff9800', on: true },
  { id: 'vwap', kind: 'vwap', params: [], color: '#e040fb', on: true },
];

function loadCfg(): StudyCfg[] {
  try {
    const s = localStorage.getItem('studies');
    if (s) return JSON.parse(s);
    const old = localStorage.getItem('indicators'); // earlier format: {kind, period}
    if (old) return (JSON.parse(old) as { id: string; kind: Kind; period?: number; color: string; on: boolean }[])
      .map((o) => ({ id: o.id, kind: o.kind, params: o.period ? [o.period] : [], color: o.color, on: o.on }));
  } catch { /* fall through */ }
  return DEFAULT.map((d) => ({ ...d }));
}

const fmt = (v: number) => (Math.abs(v) >= 0.1 || v === 0 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toPrecision(4));

interface Ctx { chart: IChartApi; getBars: () => Bar[]; isIntraday: () => boolean; wrap: HTMLElement; onChange: () => void }

export function initStudies({ chart, getBars, isIntraday, wrap, onChange }: Ctx) {
  const cfgs = loadCfg();
  const built = new Map<string, { series: ISeriesApi<'Line' | 'Histogram'>[]; out: Output[]; pane: number }>();
  let builtSig = '';
  const legends: HTMLDivElement[] = [];

  const visible = () => cfgs.filter((c) => c.on && DEFS[c.kind] && (!DEFS[c.kind].intradayOnly || isIntraday()));
  const signature = () => visible().map((c) => `${c.id}:${c.kind}`).join('|');

  function rebuild() {
    for (const b of built.values()) b.series.forEach((s) => chart.removeSeries(s));
    built.clear();
    for (let i = chart.panes().length - 1; i > 0; i--) if (!chart.panes()[i].getSeries().length) chart.removePane(i);
    let pane = 0;
    for (const c of visible()) {
      const def = DEFS[c.kind];
      const idx = def.pane ? ++pane : 0;
      const outs = def.calc([], c.params, c.color);
      const series = outs.map((o, j) => {
        const s = o.hist
          ? chart.addSeries(HistogramSeries, { color: o.color, priceLineVisible: false, lastValueVisible: false }, idx)
          : chart.addSeries(LineSeries, { color: o.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: !def.pane || j > 0 || outs.length === 1,
            crosshairMarkerVisible: false, lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid }, idx);
        return s;
      });
      const lvlHost = series.find((_, j) => !outs[j].hist) ?? series[0];
      for (const lv of def.levels ?? []) lvlHost.createPriceLine({ price: lv, color: '#555', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      built.set(c.id, { series, out: [], pane: idx });
    }
    const panes = chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? Math.max(2, panes.length) * 1.5 : 1));
    builtSig = signature();
    while (legends.length) legends.pop()!.remove();
  }

  function compute() {
    if (signature() !== builtSig) rebuild();
    const bars = getBars();
    for (const c of visible()) {
      const b = built.get(c.id);
      if (!b) continue;
      b.out = DEFS[c.kind].calc(bars, c.params, c.color);
      b.out.forEach((o, j) => {
        const data = [];
        for (let i = 0; i < bars.length; i++) {
          if (Number.isNaN(o.values[i])) continue;
          const pt: { time: UTCTimestamp; value: number; color?: string } = { time: bars[i].time as UTCTimestamp, value: o.values[i] };
          if (o.colors) pt.color = o.colors[i];
          data.push(pt);
        }
        if (!o.hist) b.series[j].applyOptions({ color: o.color });
        b.series[j].setData(data);
      });
    }
  }

  function indexAt(time?: number) {
    const bars = getBars();
    if (!bars.length) return -1;
    if (time === undefined) return bars.length - 1;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].time <= time) lo = m; else hi = m - 1; }
    return lo;
  }
  const valuesHtml = (b: { out: Output[] }, i: number) => b.out
    .map((o) => `<span style="color:${o.hist ? (o.colors?.[i] ?? o.color) : o.color}">${i >= 0 && !Number.isNaN(o.values[i]) ? fmt(o.values[i]) : '–'}</span>`).join(' ');

  /** Legend line for overlays, shown under the OHLC row. */
  function overlayLegend(time?: number) {
    const i = indexAt(time);
    return visible().filter((c) => !DEFS[c.kind].pane && built.has(c.id))
      .map((c) => `<span><span style="color:${c.color}">${DEFS[c.kind].label(c.params)}</span> ${valuesHtml(built.get(c.id)!, i)}</span>`).join('');
  }

  /** Small legends at the top-left of each oscillator pane. */
  function paneLegends(time?: number) {
    const i = indexAt(time);
    const panes = chart.panes();
    const list = visible().filter((c) => DEFS[c.kind].pane && built.has(c.id));
    while (legends.length > list.length) legends.pop()!.remove();
    list.forEach((c, n) => {
      let div = legends[n];
      if (!div) { div = document.createElement('div'); div.className = 'pane-legend'; wrap.appendChild(div); legends[n] = div; }
      const idx = built.get(c.id)!.pane;
      let top = 0;
      for (let k = 0; k < idx && k < panes.length; k++) top += panes[k].getHeight() + 1; // 1px pane separator
      div.style.top = `${top + 4}px`;
      div.innerHTML = `<span class="name">${DEFS[c.kind].label(c.params)}</span> ${valuesHtml(built.get(c.id)!, i)}`;
    });
  }

  // ---------- menu ----------
  function changed() {
    try { localStorage.setItem('studies', JSON.stringify(cfgs)); } catch { /* ignore */ }
    compute();
    onChange();
  }
  function editParams(c: StudyCfg) {
    const def = DEFS[c.kind];
    if (!def.params.length) return;
    const s = window.prompt(`${def.title}: ${def.params.map((p) => p[0]).join(', ')}`, c.params.join(', '));
    if (s == null) return;
    const v = s.split(/[,\s]+/).map(Number).filter((x) => x > 0);
    if (v.length !== def.params.length) return;
    c.params = v.map((x, i) => (def.params[i][0] === 'StdDev' ? x : Math.round(x)));
    c.on = true;
  }
  function renderMenu(menu: HTMLElement) {
    menu.innerHTML = '<div class="hint">On chart (click to show or hide)</div>';
    cfgs.forEach((c, i) => {
      const def = DEFS[c.kind];
      if (!def) return;
      const b = document.createElement('button');
      b.innerHTML = `<span class="swatch" style="background:${c.color};opacity:${c.on ? 1 : 0.25}"></span><span></span><span class="spacer"></span>`;
      (b.children[1] as HTMLElement).textContent = def.label(c.params) + (def.intradayOnly ? ' (intraday)' : '');
      b.onclick = (e) => { e.stopPropagation(); c.on = !c.on; changed(); renderMenu(menu); };
      if (def.params.length) {
        const ed = document.createElement('span');
        ed.className = 'mini'; ed.textContent = 'edit';
        ed.onclick = (e) => { e.stopPropagation(); editParams(c); changed(); renderMenu(menu); };
        b.appendChild(ed);
      }
      const del = document.createElement('span');
      del.className = 'mini'; del.textContent = '×'; del.title = 'Remove';
      del.onclick = (e) => { e.stopPropagation(); cfgs.splice(i, 1); changed(); renderMenu(menu); };
      b.appendChild(del);
      menu.appendChild(b);
    });
    const h = document.createElement('div');
    h.className = 'hint'; h.textContent = 'Add indicator';
    menu.appendChild(h);
    for (const k of ADD_ORDER) {
      const def = DEFS[k];
      const b = document.createElement('button');
      b.innerHTML = `${icon('plus', 14)}<span></span><span class="spacer"></span><span class="mini">${def.pane ? 'pane' : 'overlay'}</span>`;
      (b.children[1] as HTMLElement).textContent = def.title;
      b.onclick = (e) => {
        e.stopPropagation();
        const c: StudyCfg = { id: `${k}${Date.now()}`, kind: k, params: def.params.map((p) => p[1]), color: PALETTE[cfgs.length % PALETTE.length], on: true };
        cfgs.push(c);
        changed();
        renderMenu(menu);
      };
      menu.appendChild(b);
    }
  }

  return { compute, overlayLegend, paneLegends, renderMenu };
}
