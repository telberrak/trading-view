import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Time,
} from 'lightweight-charts';
import type { Bar } from './indicators';

/**
 * Footprint (order flow). The server sends 1-minute footprints: for each minute, the sell and buy volume
 * traded at each price. Here they are grouped into the chart's bars and drawn on the price pane as
 * "sell x buy" cells per price, with imbalances, the point of control (POC) and the bar's delta.
 * The same numbers feed the Volume Delta and Cumulative Volume Delta indicators.
 */
export type Level = [number, number, number]; // price, sell, buy
export interface FpBar { levels: Map<number, [number, number]>; sell: number; buy: number; delta: number }
type Draw = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface FpColors { up: string; down: string; wickUp: string; wickDown: string; text: string }

const IMBALANCE = 3; // buy at a price vs sell one tick lower (and the reverse), TradingView's default 300%
const MIN_ROW = 13; // px: rows are merged until a cell is at least this tall

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (Number.isInteger(v)) return String(v);
  return a >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/\.?0+$/, '');
}

interface Ctx {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  getBars: () => Bar[];
  shift: (t: number) => number;
  barSeconds: () => number | null;
  colors: () => FpColors;
  onData: () => void;
}

export function initFootprint({ chart, candles, getBars, shift, barSeconds, colors, onData }: Ctx) {
  const mins = new Map<number, Level[]>(); // raw (UTC) minute start -> levels
  let tick = 0.01;
  let shown = false; // footprint chart type active
  let cache: Map<number, FpBar> | null = null; // bar time (chart time) -> footprint
  let cacheBars: Bar[] | null = null;
  let cacheLen = 0;
  let requestUpdate: (() => void) | null = null;

  /** Group minutes into the chart's bars. Bar i covers [time_i, min(time_i+1, time_i + bar length)). */
  function byBar(): Map<number, FpBar> {
    const bars = getBars();
    if (cache && cacheBars === bars && cacheLen === bars.length) return cache;
    const out = new Map<number, FpBar>();
    const sec = barSeconds();
    if (sec && bars.length && mins.size) {
      for (const [m, levels] of mins) {
        const t = shift(m);
        let lo = 0, hi = bars.length - 1;
        if (t < bars[0].time) continue;
        while (lo < hi) { const k = (lo + hi + 1) >> 1; if (bars[k].time <= t) lo = k; else hi = k - 1; }
        const b = bars[lo];
        const end = Math.min(bars[lo + 1]?.time ?? Infinity, b.time + sec);
        if (t >= end) continue; // outside the chart's session (e.g. extended hours on an RTH chart)
        let fb = out.get(b.time);
        if (!fb) { fb = { levels: new Map(), sell: 0, buy: 0, delta: 0 }; out.set(b.time, fb); }
        for (const [p, s, bu] of levels) {
          const c = fb.levels.get(p);
          if (c) { c[0] += s; c[1] += bu; } else fb.levels.set(p, [s, bu]);
          fb.sell += s; fb.buy += bu;
        }
      }
      for (const fb of out.values()) fb.delta = fb.buy - fb.sell;
    }
    cache = out; cacheBars = bars; cacheLen = bars.length;
    return out;
  }
  function invalidate() { cache = null; onData(); requestUpdate?.(); }

  // ---------- server messages ----------
  function reset() { mins.clear(); invalidate(); }
  function snapshot(m: { tick: number; mins: [number, Level[]][] }) {
    mins.clear();
    tick = m.tick || tick;
    for (const [t, lv] of m.mins) mins.set(t, lv);
    invalidate();
  }
  function patch(m: { mins: [number, Level[]][] }) {
    for (const [t, lv] of m.mins) mins.set(t, lv);
    if (m.mins.length) invalidate();
  }
  const has = () => mins.size > 0;

  // ---------- drawing ----------
  function draw(target: Draw) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const bars = getBars();
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!bars.length || !range) return;
      const fp = byBar();
      const c = colors();
      const spacing = chart.timeScale().options().barSpacing;
      const from = Math.max(0, Math.floor(range.from) - 1), to = Math.min(bars.length - 1, Math.ceil(range.to) + 1);
      const y = (p: number) => candles.priceToCoordinate(p);
      const y0 = y(0), y1 = y(tick);
      const rowPx = y0 !== null && y1 !== null ? Math.abs(y0 - y1) : 0;
      const merge = rowPx > 0 ? Math.max(1, Math.ceil(MIN_ROW / rowPx)) : 1;
      const step = tick * merge;
      const cellH = rowPx * merge;
      const detailed = spacing >= 46 && cellH >= 10;
      ctx.save();
      ctx.textBaseline = 'middle';
      for (let i = from; i <= to; i++) {
        const b = bars[i];
        const x = chart.timeScale().logicalToCoordinate(i as never);
        if (x === null || x < -spacing || x > mediaSize.width + spacing) continue;
        const f = fp.get(b.time);
        const up = b.close >= b.open;
        const yo = y(b.open), yc = y(b.close), yh = y(b.high), yl = y(b.low);
        if (yo === null || yc === null || yh === null || yl === null) continue;
        if (!detailed || !f) {
          // plain candle (zoomed out, or no order flow for this bar)
          if (!shown) continue;
          const w = Math.max(1, Math.min(spacing * 0.7, spacing - 2));
          ctx.fillStyle = up ? c.wickUp : c.wickDown;
          ctx.fillRect(Math.round(x) - 0.5, yh, 1, Math.max(1, yl - yh));
          ctx.fillStyle = up ? c.up : c.down;
          ctx.fillRect(x - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
          if (f && spacing >= 22) deltaLabel(ctx, x, yl + 4, f, spacing >= 34);
          continue;
        }
        if (!shown) continue;
        // merged rows
        const rows = new Map<number, [number, number]>();
        for (const [p, [s, bu]] of f.levels) {
          const k = Math.round(Math.floor(p / step + 1e-9) * step * 1e8) / 1e8;
          const r = rows.get(k);
          if (r) { r[0] += s; r[1] += bu; } else rows.set(k, [s, bu]);
        }
        let max = 0, poc = NaN, pocV = -1;
        for (const [p, [s, bu]] of rows) { max = Math.max(max, s, bu); if (s + bu > pocV) { pocV = s + bu; poc = p; } }
        const slot = Math.min(spacing * 0.92, 190); // wider cells only spread the numbers apart
        const left = x - slot / 2;
        const candleW = 5;
        // thin candle on the left edge
        const cx = left + candleW / 2;
        ctx.fillStyle = up ? c.wickUp : c.wickDown;
        ctx.fillRect(cx - 0.5, yh, 1, Math.max(1, yl - yh));
        ctx.fillStyle = up ? c.up : c.down;
        ctx.fillRect(left, Math.min(yo, yc), candleW, Math.max(1, Math.abs(yc - yo)));
        const cl = left + candleW + 2, cw = slot - candleW - 2, half = cw / 2;
        const font = Math.max(9, Math.min(12, cellH - 3));
        ctx.font = `${font}px -apple-system, "Segoe UI", Roboto, sans-serif`;
        const showText = ctx.measureText('8888').width < half - 4;
        for (const [p, [s, bu]] of rows) {
          const top = y(p + step), bot = y(p);
          if (top === null || bot === null) continue;
          const h = Math.max(1, bot - top - 1);
          ctx.fillStyle = rgba(c.down, 0.12 + 0.68 * (max ? s / max : 0));
          ctx.fillRect(cl, top, half - 0.5, h);
          ctx.fillStyle = rgba(c.up, 0.12 + 0.68 * (max ? bu / max : 0));
          ctx.fillRect(cl + half + 0.5, top, half - 0.5, h);
          if (p === poc) {
            ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 1;
            ctx.strokeRect(cl + 0.5, top + 0.5, cw - 1, h - 1);
          }
          if (showText) {
            const below = rows.get(Math.round((p - step) * 1e8) / 1e8);
            const above = rows.get(Math.round((p + step) * 1e8) / 1e8);
            // diagonal comparison, as TradingView does: buyers at a price vs sellers one row lower
            const buyImb = bu > 0 && below !== undefined && bu >= IMBALANCE * Math.max(below[0], 1);
            const sellImb = s > 0 && above !== undefined && s >= IMBALANCE * Math.max(above[1], 1);
            const mid = top + h / 2;
            ctx.textAlign = 'right';
            ctx.font = `${sellImb ? 'bold ' : ''}${font}px -apple-system, "Segoe UI", Roboto, sans-serif`;
            ctx.fillStyle = sellImb ? '#ff6b81' : c.text;
            ctx.fillText(compact(s), cl + half - 3, mid);
            ctx.textAlign = 'left';
            ctx.font = `${buyImb ? 'bold ' : ''}${font}px -apple-system, "Segoe UI", Roboto, sans-serif`;
            ctx.fillStyle = buyImb ? '#5ce1a6' : c.text;
            ctx.fillText(compact(bu), cl + half + 3, mid);
          }
        }
        const lowRow = y(Math.floor(b.low / step + 1e-9) * step);
        deltaLabel(ctx, x, (lowRow ?? yl) + 4, f, true);
      }
      ctx.restore();
    });
  }
  function deltaLabel(ctx: CanvasRenderingContext2D, x: number, top: number, f: FpBar, withVol: boolean) {
    ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = f.delta >= 0 ? '#5ce1a6' : '#ff6b81';
    ctx.fillText(`${f.delta > 0 ? '+' : ''}${compact(f.delta)}`, x, top);
    if (withVol) { ctx.fillStyle = '#8a8a8a'; ctx.fillText(compact(f.buy + f.sell), x, top + 12); }
    ctx.textBaseline = 'middle';
  }

  const renderer: IPrimitivePaneRenderer = { draw };
  const view: IPrimitivePaneView = { renderer: () => (shown ? renderer : null), zOrder: () => 'normal' };
  const primitive: ISeriesPrimitive<Time> = {
    attached: (p) => { requestUpdate = p.requestUpdate; },
    detached: () => { requestUpdate = null; },
    paneViews: () => [view],
    updateAllViews: () => {},
  };
  candles.attachPrimitive(primitive);

  return {
    snapshot, patch, reset, has,
    setShown(v: boolean) { shown = v; requestUpdate?.(); },
    /** Delta of the bar at chart time t, or undefined where there is no order-flow data. */
    bar: (t: number) => byBar().get(t),
    redraw: () => requestUpdate?.(),
  };
}

function rgba(hex: string, a: number) {
  if (!hex.startsWith('#')) return hex;
  const n = parseInt(hex.length === 4 ? hex.slice(1).split('').map((x) => x + x).join('') : hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}
