import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Time } from 'lightweight-charts';
import type { FpBar } from './footprint';
import { sessionStarts, type Bar } from './indicators';
import type { CustomItem } from './studies';

/**
 * Volume profiles: volume traded at each price over a session (one profile per session, drawn from the
 * session's first bar) or over the bars on screen (one profile on the right edge), with the point of
 * control (POC) and the value area high/low (VAH/VAL) holding the chosen share of volume (70% default).
 *
 * Where order-flow data is on (footprint or delta indicators) the exact traded volume per price is used.
 * Otherwise each bar's volume is spread evenly over its high-low range, as TradingView does from bars.
 */
type Draw = Parameters<IPrimitivePaneRenderer['draw']>[0];
interface Profile { lo: number; step: number; vol: number[]; poc: number; vah: number; val: number; max: number; from: number; to: number }

interface Ctx {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  getBars: () => Bar[];
  flow: (t: number) => FpBar | undefined;
}

export function build(bars: Bar[], from: number, to: number, rows: number, vaPct: number, flow: Ctx['flow']): Profile | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i <= to; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); }
  if (!(hi >= lo)) return null;
  if (hi === lo) hi = lo + 1e-9;
  const step = (hi - lo) / rows;
  const vol = new Array<number>(rows).fill(0);
  const row = (p: number) => Math.min(rows - 1, Math.max(0, Math.floor((p - lo) / step)));
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const f = flow(b.time);
    if (f && f.levels.size) {
      for (const [p, [s, bu]] of f.levels) vol[row(p)] += s + bu;
      continue;
    }
    const v = Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0;
    if (!v) continue;
    if (b.high <= b.low) { vol[row(b.close)] += v; continue; }
    const r0 = row(b.low), r1 = row(b.high);
    for (let r = r0; r <= r1; r++) {
      const a = Math.max(b.low, lo + r * step), z = Math.min(b.high, lo + (r + 1) * step);
      if (z > a) vol[r] += (v * (z - a)) / (b.high - b.low);
    }
  }
  const total = vol.reduce((a, x) => a + x, 0);
  if (!total) return null;
  let poc = 0;
  vol.forEach((x, r) => { if (x > vol[poc]) poc = r; });
  // value area: grow from the POC, adding the bigger neighbouring row each time
  let up = poc, dn = poc, sum = vol[poc];
  while (sum < (total * vaPct) / 100 && (up < rows - 1 || dn > 0)) {
    const a = up < rows - 1 ? vol[up + 1] : -1, b = dn > 0 ? vol[dn - 1] : -1;
    if (a >= b) sum += vol[++up]; else sum += vol[--dn];
  }
  return { lo, step, vol, poc, vah: up, val: dn, max: vol[poc], from, to };
}

export function initProfiles({ chart, candles, getBars, flow }: Ctx) {
  let items: CustomItem[] = [];
  let requestUpdate: (() => void) | null = null;
  let sessCache: { bars: Bar[]; len: number; key: string; list: Profile[] } | null = null;
  let flowVersion = 0;

  function sessions(bars: Bar[], rows: number, va: number): Profile[] {
    const key = `${rows}|${va}|${flowVersion}`;
    if (sessCache && sessCache.bars === bars && sessCache.len === bars.length && sessCache.key === key) return sessCache.list;
    const st = sessionStarts(bars);
    const list: Profile[] = [];
    let s = 0;
    for (let i = 1; i <= bars.length; i++) {
      if (i === bars.length || st[i]) {
        const p = build(bars, s, i - 1, rows, va, flow);
        if (p) list.push(p);
        s = i;
      }
    }
    sessCache = { bars, len: bars.length, key, list };
    return list;
  }

  function draw(target: Draw) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const bars = getBars();
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!bars.length || !range) return;
      const ts = chart.timeScale();
      const spacing = ts.options().barSpacing;
      const xOf = (i: number) => ts.logicalToCoordinate(i as never);
      for (const it of items) {
        const rows = Math.max(4, Math.min(400, it.cfg.params[0] || 24));
        const va = Math.max(1, Math.min(100, it.cfg.params[1] || 70));
        const col = Object.fromEntries(it.outs.map((o) => [o.name, o]));
        const lw = it.cfg.width ?? 1;
        if (it.cfg.kind === 'vpvr') {
          const from = Math.max(0, Math.ceil(range.from)), to = Math.min(bars.length - 1, Math.floor(range.to));
          if (to < from) continue;
          const p = build(bars, from, to, rows, va, flow);
          if (!p) continue;
          const right = mediaSize.width, width = mediaSize.width * 0.28;
          paint(ctx, p, right, -width, 0, right, col, lw);
        } else {
          for (const p of sessions(bars, rows, va)) {
            if (p.to < range.from - 1 || p.from > range.to + 1) continue;
            const x0 = (xOf(p.from) ?? 0) - spacing / 2, x1 = (xOf(p.to) ?? mediaSize.width) + spacing / 2;
            paint(ctx, p, x0, (x1 - x0) * 0.7, x0, x1, col, lw);
          }
        }
      }
    });
  }

  /** Histogram from x (towards +w or -w), lines from lx0 to lx1. */
  function paint(ctx: CanvasRenderingContext2D, p: Profile, x: number, w: number, lx0: number, lx1: number,
    col: Record<string, { color: string; on: boolean }>, lw: number) {
    const y = (v: number) => candles.priceToCoordinate(v);
    if (col.Profile?.on || col['Value area']?.on) {
      for (let r = 0; r < p.vol.length; r++) {
        if (!p.vol[r]) continue;
        const inVa = r >= p.val && r <= p.vah;
        const o = inVa ? col['Value area'] : col.Profile;
        if (!o?.on) continue;
        const top = y(p.lo + (r + 1) * p.step), bot = y(p.lo + r * p.step);
        if (top === null || bot === null) continue;
        const len = (w * p.vol[r]) / p.max;
        ctx.fillStyle = alpha(o.color, inVa ? 0.5 : 0.3);
        ctx.fillRect(Math.min(x, x + len), top + 0.5, Math.abs(len), Math.max(1, bot - top - 1));
      }
    }
    const line = (name: string, price: number, dash: number[]) => {
      const o = col[name];
      const yy = y(price);
      if (!o?.on || yy === null) return;
      ctx.strokeStyle = o.color; ctx.lineWidth = lw; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(lx0, Math.round(yy) + 0.5); ctx.lineTo(lx1, Math.round(yy) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    };
    line('POC', p.lo + (p.poc + 0.5) * p.step, []);
    line('VAH', p.lo + (p.vah + 1) * p.step, [4, 3]);
    line('VAL', p.lo + p.val * p.step, [4, 3]);
  }

  const renderer: IPrimitivePaneRenderer = { draw };
  const view: IPrimitivePaneView = { renderer: () => (items.length ? renderer : null), zOrder: () => 'bottom' };
  const primitive: ISeriesPrimitive<Time> = {
    attached: (p) => { requestUpdate = p.requestUpdate; },
    detached: () => { requestUpdate = null; },
    paneViews: () => [view],
    updateAllViews: () => {},
  };
  candles.attachPrimitive(primitive);
  return {
    set(list: CustomItem[]) { items = list; requestUpdate?.(); },
    flowChanged() { flowVersion++; requestUpdate?.(); },
  };
}

function alpha(hex: string, a: number) {
  if (!hex.startsWith('#')) return hex;
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
