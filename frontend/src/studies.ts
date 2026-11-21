import { HistogramSeries, LineSeries, LineStyle, LineType, type IChartApi, type IPrimitivePaneRenderer, type ISeriesApi, type ISeriesPrimitive, type Time, type UTCTimestamp } from 'lightweight-charts';
import { compact } from './footprint';
import { icon } from './icons';
import { askName, lib, updateLibrary } from './library';
import { atr, bollinger, emaArr, macd, prevSession, rsi, sessionStarts, smaArr, stochastic, vwap, windowRange, type Bar } from './indicators';

/**
 * Indicators ("studies"). Overlays draw on the price pane; oscillators get their own pane below it,
 * the way TradingView stacks them. Settings persist in localStorage.
 */
export type Kind = 'ema' | 'sma' | 'vwap' | 'bb' | 'rsi' | 'macd' | 'stoch' | 'atr' | 'delta' | 'cvd' | 'prev' | 'asia' | 'vps' | 'vpvr';

/** Order-flow numbers per bar, supplied by the footprint module (undefined where IBKR gave no trades). */
export const orderFlow: { bar: (t: number) => { delta: number } | undefined } = { bar: () => undefined };
const FLOW_KINDS = new Set<Kind>(['delta', 'cvd']);
export interface StudyCfg {
  id: string; kind: Kind; params: number[]; color: string; on: boolean;
  colors?: Record<string, string>; width?: number;
  hidden?: string[]; // outputs (lines) switched off in settings
}
/** Studies drawn by their own renderer rather than as line series (volume profiles). */
export interface CustomItem { cfg: StudyCfg; outs: { name: string; color: string; on: boolean }[] }

/** Apply the user's colour choices (per output line) on top of the defaults. */
function styled(c: StudyCfg, outs: Output[]): Output[] {
  return outs.map((o) => (o.hist || !c.colors?.[o.name] ? o : { ...o, color: c.colors[o.name] }));
}

interface Output { off?: boolean; name: string; color: string; values: number[]; hist?: boolean; colors?: string[]; dashed?: boolean; title?: string; step?: boolean; breaks?: boolean[]; tags?: { i: number; text: string }[] }
interface Def {
  title: string;
  pane: boolean;
  params: [string, number][];
  intradayOnly?: boolean;
  levels?: number[];
  label: (p: number[]) => string;
  format?: (v: number) => string;
  custom?: boolean; // drawn by a renderer outside this module
  calc: (bars: Bar[], p: number[], color: string) => Output[];
}

const UP = '#22ab94', DOWN = '#f23645';
const compactFmt = (v: number) => compact(Math.round(v * 100) / 100);
const BASE_DEFS: Partial<Record<Kind, Def>> = {
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
  delta: { title: 'Volume Delta (order flow)', pane: true, params: [], intradayOnly: true, levels: [0], label: () => 'Volume Delta', format: compactFmt,
  calc: (b) => {
    const values = b.map((x) => orderFlow.bar(x.time)?.delta ?? NaN);
    return [{ name: 'Delta', color: UP, values, hist: true, colors: values.map((v) => (v >= 0 ? UP : DOWN)) }];
  } },
  cvd: { title: 'Cumulative Volume Delta (order flow)', pane: true, params: [], intradayOnly: true, levels: [0], label: () => 'CVD', format: compactFmt,
  calc: (b, _p, c) => {
    // resets each session, like VWAP (a gap of 45 min or more, or a new day)
    const values: number[] = [];
    let sum = 0, lastReset = -Infinity;
    for (let i = 0; i < b.length; i++) {
      const prev = b[i - 1];
      const gap = prev ? b[i].time - prev.time : Infinity;
      const newDay = prev ? Math.floor(b[i].time / 86400) !== Math.floor(prev.time / 86400) : true;
      if (gap >= 45 * 60 || (newDay && b[i].time - lastReset > 20 * 3600)) { sum = 0; lastReset = b[i].time; }
      const d = orderFlow.bar(b[i].time)?.delta;
      if (d === undefined) { values.push(NaN); continue; }
      sum += d;
      values.push(sum);
    }
    return [{ name: 'CVD', color: c, values }];
  } },
};
export const DEFS = BASE_DEFS as Record<Kind, Def>;
const isHour = (name: string) => /hour/i.test(name);
/** Params named with a trailing '?' are on/off switches (1/0), shown as a checkbox. */
const isFlag = (name: string) => name.endsWith('?');
const VP_OUTS = (c: string): Output[] => [
  { name: 'Profile', color: '#5d6b8a', values: [] }, { name: 'Value area', color: c, values: [] },
  { name: 'POC', color: '#ffd54f', values: [] }, { name: 'VAH', color: '#26c6da', values: [] }, { name: 'VAL', color: '#ef6c9c', values: [] }];
Object.assign(DEFS, {
  prev: { title: 'Previous session O/H/L/C', pane: false, params: [['Sessions to show', 1], ['Show labels?', 1]],
    label: (p: number[]) => `Prev session${(p[0] ?? 1) > 1 ? ` x${p[0]}` : ''}`, calc: (b: Bar[], p: number[]) => {
      const r = prevSession(b);
      const breaks = sessionStarts(b);
      // only the last N sessions carry their previous-session levels (N = 1: today's session only)
      const starts: number[] = [];
      breaks.forEach((x, i) => { if (x) starts.push(i); });
      const n = Math.max(1, Math.round(p[0] ?? 1));
      const from = starts.length ? starts[Math.max(0, starts.length - n)] : 0;
      const ends = starts.filter((i) => i > from).map((i) => i - 1).concat(b.length ? [b.length - 1] : []);
      const keep = (v: number[]) => v.map((x, i) => (i < from ? NaN : x));
      const labels = (p[1] ?? 1) > 0;
      const line = (name: string, title: string, color: string, v: number[]) => {
        const values = keep(v);
        return { name, title, color, values, step: true, dashed: true, breaks,
          tags: labels ? ends.filter((i) => !Number.isNaN(values[i])).map((i) => ({ i, text: title })) : undefined };
      };
      return [line('Open', 'PDO', '#9e9e9e', r.o), line('High', 'PDH', '#4caf50', r.h),
        line('Low', 'PDL', '#f44336', r.l), line('Close', 'PDC', '#ffb74d', r.c)];
    } },
  asia: { title: 'Asia session High/Low', pane: false, intradayOnly: true, params: [['Start hour (your time)', 0], ['End hour (your time)', 8]],
    label: (p: number[]) => `Asia ${p[0]}-${p[1]}`, calc: (b: Bar[], p: number[]) => {
      const r = windowRange(b, p[0], p[1]);
      return [{ name: 'Asia High', title: 'Asia H', color: '#00bcd4', values: r.hi, step: true, breaks: r.starts },
        { name: 'Asia Low', title: 'Asia L', color: '#ff9800', values: r.lo, step: true, breaks: r.starts }];
    } },
  vps: { title: 'Volume Profile (session)', pane: false, custom: true, params: [['Rows', 24], ['Value area %', 70]],
    label: (p: number[]) => `VP session ${p[0]} ${p[1]}%`, calc: (_b: Bar[], _p: number[], c: string) => VP_OUTS(c) },
  vpvr: { title: 'Volume Profile (visible range)', pane: false, custom: true, params: [['Rows', 24], ['Value area %', 70]],
    label: (p: number[]) => `VPVR ${p[0]} ${p[1]}%`, calc: (_b: Bar[], _p: number[], c: string) => VP_OUTS(c) },
} as Partial<Record<Kind, Def>>);
const ADD_ORDER: Kind[] = ['ema', 'sma', 'bb', 'vwap', 'prev', 'asia', 'vps', 'vpvr', 'rsi', 'macd', 'stoch', 'atr', 'delta', 'cvd'];
const PALETTE = ['#2962ff', '#ff9800', '#e040fb', '#26c6da', '#ffeb3b', '#ef5350', '#66bb6a', '#ab47bc', '#7e57c2'];
void DOWN;

const DEFAULT: StudyCfg[] = [
  { id: 'ema1', kind: 'ema', params: [9], color: '#2962ff', on: true },
  { id: 'ema2', kind: 'ema', params: [21], color: '#ff9800', on: true },
  { id: 'vwap', kind: 'vwap', params: [], color: '#e040fb', on: true },
];

function loadCfg(storeKey: string): StudyCfg[] {
  try {
    const s = localStorage.getItem(storeKey);
    if (s) return JSON.parse(s);
    const old = localStorage.getItem('indicators'); // earlier format: {kind, period}
    if (old) return (JSON.parse(old) as { id: string; kind: Kind; period?: number; color: string; on: boolean }[])
      .map((o) => ({ id: o.id, kind: o.kind, params: o.period ? [o.period] : [], color: o.color, on: o.on }));
  } catch { /* fall through */ }
  return DEFAULT.map((d) => ({ ...d }));
}

const fmt = (v: number) => (Math.abs(v) >= 0.1 || v === 0 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toPrecision(4));

interface Ctx { chart: IChartApi; getBars: () => Bar[]; isIntraday: () => boolean; wrap: HTMLElement; onChange: () => void; custom: (items: CustomItem[]) => void; storeKey?: string }

export function initStudies({ chart, getBars, isIntraday, wrap, onChange, custom, storeKey = 'studies' }: Ctx) {
  const cfgs = loadCfg(storeKey);
  // settings saved before a study gained a parameter get its default
  for (const c of cfgs) DEFS[c.kind]?.params.forEach(([, d], i) => { if (c.params[i] === undefined) c.params[i] = d; });
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
      if (def.custom) { built.set(c.id, { series: [], out: [], pane: 0 }); continue; }
      const idx = def.pane ? ++pane : 0;
      const outs = styled(c, def.calc([], c.params, c.color));
      const series = outs.map((o, j) => {
        const s = o.hist
          ? chart.addSeries(HistogramSeries, { color: o.color, priceLineVisible: false, lastValueVisible: false }, idx)
          : chart.addSeries(LineSeries, { color: o.color, lineWidth: (c.width ?? 1) as 1 | 2 | 3 | 4, priceLineVisible: false, lastValueVisible: !def.pane || j > 0 || outs.length === 1,
            crosshairMarkerVisible: false, lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid,
            lineType: o.step ? LineType.WithSteps : LineType.Simple, title: o.title ?? '' }, idx);
        if (!o.hist) (s as ISeriesApi<'Line'>).attachPrimitive(tagLabels(chart, s, () => built.get(c.id)?.out[j]));
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
    const items: CustomItem[] = [];
    for (const c of visible()) {
      const b = built.get(c.id);
      if (!b) continue;
      if (DEFS[c.kind].custom) {
        items.push({ cfg: c, outs: styled(c, DEFS[c.kind].calc([], c.params, c.color)).map((o) => ({ name: o.name, color: o.color, on: !c.hidden?.includes(o.name) })) });
        continue;
      }
      b.out = styled(c, DEFS[c.kind].calc(bars, c.params, c.color)).map((o) => (c.hidden?.includes(o.name) ? { ...o, off: true } : o));
      b.out.forEach((o, j) => {
        const data = [];
        for (let i = 0; i < bars.length; i++) {
          if (Number.isNaN(o.values[i])) continue;
          const pt: { time: UTCTimestamp; value: number; color?: string } = { time: bars[i].time as UTCTimestamp, value: o.values[i] };
          if (o.colors) pt.color = o.colors[i];
          else if (o.breaks?.[i]) pt.color = 'rgba(0,0,0,0)'; // hide the joint where a new level starts
          else if (o.breaks) pt.color = o.color;
          data.push(pt);
        }
        if (!o.hist) b.series[j].applyOptions({ color: o.color, lineWidth: (c.width ?? 1) as 1 | 2 | 3 | 4 });
        b.series[j].applyOptions({ visible: !o.off });
        b.series[j].setData(data);
      });
    }
    custom(items);
  }

  function indexAt(time?: number) {
    const bars = getBars();
    if (!bars.length) return -1;
    if (time === undefined) return bars.length - 1;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].time <= time) lo = m; else hi = m - 1; }
    return lo;
  }
  const valuesHtml = (b: { out: Output[] }, i: number, f: (v: number) => string = fmt) => b.out.filter((o) => !o.off)
    .map((o) => `<span style="color:${o.hist ? (o.colors?.[i] ?? o.color) : o.color}">${i >= 0 && !Number.isNaN(o.values[i]) ? f(o.values[i]) : '–'}</span>`).join(' ');

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
      div.innerHTML = `<span class="name">${DEFS[c.kind].label(c.params)}</span> ${valuesHtml(built.get(c.id)!, i, DEFS[c.kind].format)}`;
    });
  }

  // ---------- menu ----------
  function changed() {
    try { localStorage.setItem(storeKey, JSON.stringify(cfgs)); } catch { /* ignore */ }
    compute();
    onChange();
  }
  /** Settings dialog: lengths, colour of each line and line width. */
  function openSettings(c: StudyCfg, done: () => void) {
    const def = DEFS[c.kind];
    const outs = styled(c, def.calc([], c.params, c.color)).filter((o) => !o.hist);
    const dlg = document.createElement('dialog');
    dlg.className = 'study-dlg';
    dlg.innerHTML = `<form method="dialog"><h3></h3>
      ${def.params.map(([n], i) => (isFlag(n)
        ? `<label class="sd-flag"><input type="checkbox" data-p="${i}" ${c.params[i] ? 'checked' : ''} /> ${n.slice(0, -1)}</label>`
        : `<label>${n}<input type="number" step="any" min="0" data-p="${i}" value="${c.params[i]}" /></label>`)).join('')}
      <div class="sd-colors">${outs.map((o) => `<label class="sd-color">${outs.length > 1 ? `<input type="checkbox" data-v="${o.name}" ${c.hidden?.includes(o.name) ? '' : 'checked'} title="Show this line" />` : ''}<input type="color" data-o="${o.name}" value="${o.color}" /><span>${o.name}</span></label>`).join('')}</div>
      <label>Line width <select data-w>${[1, 2, 3, 4].map((w) => `<option ${w === (c.width ?? 1) ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
      <div class="dlg-btns"><button type="button" data-reset>Defaults</button><span class="spacer"></span><button value="cancel">Cancel</button><button value="ok" class="primary">OK</button></div></form>`;
    dlg.querySelector('h3')!.textContent = def.title;
    document.body.appendChild(dlg);
    dlg.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => {
      def.params.forEach(([n, d], i) => {
        const inp = dlg.querySelector<HTMLInputElement>(`[data-p="${i}"]`)!;
        if (isFlag(n)) inp.checked = !!d; else inp.value = String(d);
      });
      const base = def.calc([], def.params.map((p) => p[1]), c.color).filter((o) => !o.hist);
      base.forEach((o) => (dlg.querySelector<HTMLInputElement>(`[data-o="${o.name}"]`)!.value = o.color));
      dlg.querySelector<HTMLSelectElement>('[data-w]')!.value = '1';
      dlg.querySelectorAll<HTMLInputElement>('[data-v]').forEach((x) => (x.checked = true));
    };
    dlg.addEventListener('close', () => {
      if (dlg.returnValue === 'ok') {
        const v = def.params.map(([n], i) => {
          const inp = dlg.querySelector<HTMLInputElement>(`[data-p="${i}"]`)!;
          return isFlag(n) ? (inp.checked ? 1 : 0) : Number(inp.value);
        });
        const ok = v.every((x, i) => Number.isFinite(x) && (isFlag(def.params[i][0]) || (isHour(def.params[i][0]) ? x >= 0 && x <= 24 : x > 0)));
        if (ok) c.params = v.map((x, i) => (def.params[i][0] === 'StdDev' || isHour(def.params[i][0]) ? x : Math.round(x)));
        c.hidden = [...dlg.querySelectorAll<HTMLInputElement>('[data-v]')].filter((x) => !x.checked).map((x) => x.dataset.v!);
        const colors: Record<string, string> = {};
        dlg.querySelectorAll<HTMLInputElement>('[data-o]').forEach((inp) => (colors[inp.dataset.o!] = inp.value));
        c.colors = colors;
        const base = def.calc([], c.params, c.color).filter((o) => !o.hist);
        const main = base.find((o) => o.color === c.color) ?? base[0]; // the line drawn in the study's own colour
        if (main) c.color = colors[main.name] ?? c.color; // legend + menu swatch follow it
        c.width = Number(dlg.querySelector<HTMLSelectElement>('[data-w]')!.value);
        c.on = true;
        builtSig = ''; // rebuild series so width/colours apply everywhere
        done();
      }
      dlg.remove();
    });
    dlg.showModal();
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
      {
        const ed = document.createElement('span');
        ed.className = 'mini'; ed.textContent = 'settings';
        ed.onclick = (e) => { e.stopPropagation(); openSettings(c, () => { changed(); renderMenu(menu); }); };
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
    // ----- templates (shared by all charts) -----
    const th = document.createElement('div');
    th.className = 'hint'; th.textContent = 'Templates';
    menu.appendChild(th);
    const saveBtn = document.createElement('button');
    saveBtn.innerHTML = `${icon('plus', 14)}<span>Save indicators as template…</span>`;
    saveBtn.onclick = async (e) => {
      e.stopPropagation();
      const name = await askName('Template name');
      if (!name) return;
      await updateLibrary((l) => { l.indicatorTemplates[name] = JSON.parse(JSON.stringify(cfgs)); });
      renderMenu(menu);
    };
    menu.appendChild(saveBtn);
    for (const [name, list] of Object.entries(lib().indicatorTemplates)) {
      const b = document.createElement('button');
      b.innerHTML = '<span></span><span class="spacer"></span>';
      (b.children[0] as HTMLElement).textContent = name;
      b.title = 'Replace this chart\'s indicators with this template';
      b.onclick = (e) => { e.stopPropagation(); setAll(list as StudyCfg[]); renderMenu(menu); };
      const del = document.createElement('span');
      del.className = 'mini'; del.textContent = '×'; del.title = 'Delete template';
      del.onclick = async (e) => { e.stopPropagation(); await updateLibrary((l) => { delete l.indicatorTemplates[name]; }); renderMenu(menu); };
      b.appendChild(del);
      menu.appendChild(b);
    }
  }
  function setAll(list: StudyCfg[]) {
    cfgs.splice(0, cfgs.length, ...JSON.parse(JSON.stringify(list)).filter((c: StudyCfg) => DEFS[c.kind]));
    builtSig = '';
    changed();
  }

  /** True when a visible indicator needs order-flow (footprint) data. */
  const needsFlow = () => visible().some((c) => FLOW_KINDS.has(c.kind));
  return { compute, overlayLegend, paneLegends, renderMenu, needsFlow, setAll };
}

/** Text labels on a line (e.g. "PDH"), sitting just above the line at the end of each segment. */
function tagLabels(chart: IChartApi, series: ISeriesApi<'Line' | 'Histogram'>, out: () => Output | undefined): ISeriesPrimitive<Time> {
  const renderer: IPrimitivePaneRenderer = {
    draw: (target) => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const o = out();
      if (!o?.tags?.length || o.off) return;
      ctx.save();
      ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = o.color;
      for (const t of o.tags) {
        const x = chart.timeScale().logicalToCoordinate(t.i as never);
        const y = series.priceToCoordinate(o.values[t.i]);
        if (x === null || y === null || x < -40 || x > mediaSize.width + 80) continue;
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(t.text, x, y - 2);
      }
      ctx.restore();
    }),
  };
  return { paneViews: () => [{ renderer: () => renderer, zOrder: () => 'top' }], updateAllViews: () => {} };
}
