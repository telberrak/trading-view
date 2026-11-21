import type { IChartApi, IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, Time } from 'lightweight-charts';
import { fade } from './colorpick';
import { compact, type FpBar } from './footprint';
import type { Bar } from './indicators';
import type { CustomItem } from './studies';

/**
 * Price bubbles: for each bar, the volume bought (at the ask) and sold (at the bid) at each price, drawn as
 * a green or red circle at that price when it reaches the minimum size. Bigger volume, bigger bubble.
 * Uses the order-flow (tick-by-tick) data, so it shows on intraday charts where that data exists.
 */
interface Ctx { chart: IChartApi; candles: ISeriesApi<'Candlestick'>; getBars: () => Bar[]; flow: (t: number) => FpBar | undefined }

export function initBubbles({ chart, candles, getBars, flow }: Ctx) {
  let items: CustomItem[] = [];
  let requestUpdate: (() => void) | null = null;

  const renderer: IPrimitivePaneRenderer = {
    draw: (target) => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const bars = getBars();
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!bars.length || !range) return;
      const from = Math.max(0, Math.floor(range.from) - 1), to = Math.min(bars.length - 1, Math.ceil(range.to) + 1);
      for (const it of items) {
        const min = Math.max(1, it.cfg.params[0] || 100);
        const maxR = Math.max(6, Math.min(80, it.cfg.params[1] || 28));
        const col = Object.fromEntries(it.outs.map((o) => [o.name, o]));
        const list: { x: number; y: number; v: number; c: string }[] = [];
        let top = 0;
        for (let i = from; i <= to; i++) {
          const f = flow(bars[i].time);
          if (!f) continue;
          const x = chart.timeScale().logicalToCoordinate(i as never);
          if (x === null || x < -maxR || x > mediaSize.width + maxR) continue;
          for (const [p, [s, bu]] of f.levels) {
            const add = (v: number, name: string) => {
              const o = col[name];
              if (v < min || !o?.on) return;
              const y = candles.priceToCoordinate(p);
              if (y === null) return;
              list.push({ x, y, v, c: o.color });
              top = Math.max(top, v);
            };
            add(bu, 'Buys');
            add(s, 'Sells');
          }
        }
        if (!list.length) continue;
        const minR = Math.min(5, maxR);
        list.sort((a, b) => b.v - a.v); // big ones underneath
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const b of list) {
          const r = minR + (maxR - minR) * Math.sqrt(top > min ? (b.v - min) / (top - min) : 1);
          ctx.beginPath();
          ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
          ctx.fillStyle = fade(b.c, 0.45);
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = b.c;
          ctx.stroke();
          if (r >= 11) {
            ctx.font = `${Math.min(12, Math.round(r * 0.6))}px -apple-system, "Segoe UI", Roboto, sans-serif`;
            ctx.fillStyle = '#fff';
            ctx.fillText(compact(b.v), b.x, b.y);
          }
        }
        ctx.restore();
      }
    }),
  };
  const primitive: ISeriesPrimitive<Time> = {
    attached: (p) => { requestUpdate = p.requestUpdate; },
    detached: () => { requestUpdate = null; },
    paneViews: () => [{ renderer: () => (items.length ? renderer : null), zOrder: () => 'top' }],
    updateAllViews: () => {},
  };
  candles.attachPrimitive(primitive);
  return {
    set(list: CustomItem[]) { items = list.filter((i) => i.cfg.kind === 'bubbles'); requestUpdate?.(); },
    redraw() { requestUpdate?.(); },
  };
}
