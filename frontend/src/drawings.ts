import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { Bar } from './indicators';
import type { ColorSwatch } from './colorpick';

/**
 * Drawing tools rendered on an SVG layer over the price pane. Points are stored as (time, price), so
 * drawings stay put across zoom, scroll and timeframe changes, including points in the empty space to
 * the right of the last bar. Saved per symbol in localStorage.
 */
interface Pt { t: number; p: number }
/** A long/short position drawing turned into an order: entry, take-profit target and stop. */
export interface PositionOrder { long: boolean; entry: number; target: number; stop: number; type: 'MKT' | 'LMT' }
interface Drawing { id: string; kind: string; pts: Pt[]; text?: string; color: string; width?: number }

/** What a tool's draw function gets: screen coordinates of its points plus small SVG helpers. */
interface R {
  d: Drawing; X: number[]; Y: number[]; W: number; H: number; preview: boolean;
  line(x1: number, y1: number, x2: number, y2: number, a?: Attrs): void;
  poly(pts: number[][], a?: Attrs, closed?: boolean): void;
  text(x: number, y: number, s: string, a?: Attrs): SVGElement;
  label(x: number, y: number, s: string, bg: string, a?: { anchor?: 'start' | 'middle' | 'end'; fg?: string; hitbox?: boolean }): void;
  hit(pts: number[][], closed?: boolean): void;
  hitBox(x: number, y: number, w: number, h: number): void;
  ext(x1: number, y1: number, x2: number, y2: number, back: boolean, fwd: boolean): number[];
  xAtL(l: number): number | null; lOf(t: number): number | null; yOf(p: number): number | null;
  fmt(p: number): string; sw: number; c: string;
}
type Attrs = Record<string, string | number>;
interface ToolDef { name: string; n: number; color: string; icon: string; key?: string; text?: boolean; draw?: (r: R) => void }

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86', '#2962ff', '#e91e63', '#9c27b0'];
const NS = 'http://www.w3.org/2000/svg';
const GREEN = '#089981', RED = '#f23645', BLUE = '#2962ff';

// ---------- tool definitions ----------
const pct = (a: number, b: number) => `${b - a >= 0 ? '+' : ''}${(((b - a) / a) * 100).toFixed(2)}%`;
function drawFibLevels(r: R, levels: number[], priceAt: (lv: number) => number, x1: number, x2: number) {
  levels.forEach((lv, i) => {
    const yy = r.yOf(priceAt(lv));
    if (yy == null) return;
    r.line(x1, yy, x2, yy, { stroke: FIB_COLORS[i % FIB_COLORS.length], 'stroke-width': 1 });
    r.text(x1 + 4, yy - 3, `${lv} (${r.fmt(priceAt(lv))})`, { fill: FIB_COLORS[i % FIB_COLORS.length], 'font-size': 11 });
  });
}
function pathWithLabels(r: R, names: string[]) {
  const pts = r.X.map((x, i) => [x, r.Y[i]]);
  r.poly(pts, { stroke: r.c, 'stroke-width': r.sw, fill: 'none' });
  r.hit(pts);
  r.X.forEach((x, i) => {
    if (!names[i]) return;
    const up = i > 0 && r.Y[i] < r.Y[i - 1] || (i === 0 && r.Y[1] !== undefined && r.Y[0] < r.Y[1]);
    r.label(x, up ? r.Y[i] - 16 : r.Y[i] + 6, names[i], r.c, { anchor: 'middle' });
  });
}
function ratioLabel(r: R, i: number, j: number, text: string) {
  if (r.X[j] === undefined) return;
  r.line(r.X[i], r.Y[i], r.X[j], r.Y[j], { stroke: r.c, 'stroke-dasharray': '4 4', 'stroke-width': 1 });
  r.text((r.X[i] + r.X[j]) / 2, (r.Y[i] + r.Y[j]) / 2 - 4, text, { fill: r.c, 'font-size': 11, 'text-anchor': 'middle' });
}
const retr = (d: Drawing, a: number, b: number, c: number) => {
  const p = d.pts;
  if (!p[c]) return '';
  const den = Math.abs(p[b].p - p[a].p);
  return den ? (Math.abs(p[c].p - p[b].p) / den).toFixed(3) : '';
};
function positionTool(r: R, long: boolean) {
  const { X, Y, d } = r;
  const entry = d.pts[0].p;
  const tgt = d.pts[1]?.p ?? entry, stp = d.pts[2]?.p ?? entry;
  const x1 = X[0], x2 = Math.max(...X, X[0] + 120);
  const yT = Y[1] ?? Y[0], yS = Y[2] ?? Y[0];
  r.poly([[x1, Y[0]], [x2, Y[0]], [x2, yT], [x1, yT]], { fill: GREEN, 'fill-opacity': 0.2, stroke: 'none' }, true);
  r.poly([[x1, Y[0]], [x2, Y[0]], [x2, yS], [x1, yS]], { fill: RED, 'fill-opacity': 0.2, stroke: 'none' }, true);
  r.line(x1, Y[0], x2, Y[0], { stroke: '#9e9e9e', 'stroke-width': 1 });
  r.hitBox(x1, Math.min(yT, yS), x2 - x1, Math.abs(yT - yS));
  const risk = Math.abs(entry - stp), reward = Math.abs(tgt - entry);
  r.label(x1 + 4, yT + (long ? -18 : 4), `Target ${r.fmt(tgt)} (${pct(entry, tgt)})`, GREEN);
  r.label(x1 + 4, yS + (long ? 4 : -18), `Stop ${r.fmt(stp)} (${pct(entry, stp)})`, RED);
  r.label(x1 + 4, Y[0] + (long ? 4 : -18), `${long ? 'Long' : 'Short'} @ ${r.fmt(entry)}${risk ? `  R:R ${(reward / risk).toFixed(2)}` : ''}`, '#454545');
}
function barsAndTime(r: R, a: number, b: number) {
  const la = r.lOf(r.d.pts[a].t) ?? 0, lb = r.lOf(r.d.pts[b].t) ?? 0;
  const secs = Math.abs(r.d.pts[b].t - r.d.pts[a].t);
  const dur = secs >= 86400 ? `${Math.round(secs / 86400)}d` : secs >= 3600 ? `${(secs / 3600).toFixed(1).replace('.0', '')}h` : `${Math.round(secs / 60)}m`;
  return `${Math.round(lb - la)} bars, ${dur}`;
}
function arrowHead(r: R, x1: number, y1: number, x2: number, y2: number, size = 10) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  r.poly([[x2 - size * Math.cos(a - 0.4), y2 - size * Math.sin(a - 0.4)], [x2, y2], [x2 - size * Math.cos(a + 0.4), y2 - size * Math.sin(a + 0.4)]],
    { stroke: r.c, 'stroke-width': r.sw, fill: 'none' });
}
const L = (r: R, a: number[]) => { r.line(a[0], a[1], a[2], a[3]); r.hit([[a[0], a[1]], [a[2], a[3]]]); };

const TOOLS: Record<string, ToolDef> = {
  cross: { name: 'Crosshair', n: 0, color: '', icon: '<path d="M12 4v16M4 12h16"/>' },
  // lines
  trend: { name: 'Trend line', n: 2, color: BLUE, key: 'KeyT', icon: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
    draw: (r) => L(r, [r.X[0], r.Y[0], r.X[1] ?? r.X[0], r.Y[1] ?? r.Y[0]]) },
  ray: { name: 'Ray', n: 2, color: BLUE, icon: '<path d="M5 19L21 3"/><circle cx="5" cy="19" r="1.6"/><circle cx="11" cy="13" r="1.6"/>',
    draw: (r) => L(r, r.ext(r.X[0], r.Y[0], r.X[1] ?? r.X[0], r.Y[1] ?? r.Y[0], false, true)) },
  extended: { name: 'Extended line', n: 2, color: BLUE, icon: '<path d="M2 22L22 2"/><circle cx="8" cy="16" r="1.6"/><circle cx="16" cy="8" r="1.6"/>',
    draw: (r) => L(r, r.ext(r.X[0], r.Y[0], r.X[1] ?? r.X[0], r.Y[1] ?? r.Y[0], true, true)) },
  info: { name: 'Info line', n: 2, color: BLUE, icon: '<path d="M4 18L16 8"/><rect x="13" y="13" width="8" height="6" rx="1"/>',
    draw: (r) => {
      const x2 = r.X[1] ?? r.X[0], y2 = r.Y[1] ?? r.Y[0];
      L(r, [r.X[0], r.Y[0], x2, y2]);
      if (!r.d.pts[1]) return;
      const [a, b] = r.d.pts;
      const ang = (-Math.atan2(y2 - r.Y[0], x2 - r.X[0]) * 180) / Math.PI;
      r.label(x2 + 8, y2 - 30, `${b.p - a.p >= 0 ? '+' : ''}${r.fmt(b.p - a.p)} (${pct(a.p, b.p)})`, '#2a2e39');
      r.label(x2 + 8, y2 - 12, `${barsAndTime(r, 0, 1)}, ${ang.toFixed(1)}°`, '#2a2e39');
    } },
  arrow: { name: 'Arrow', n: 2, color: BLUE, icon: '<path d="M5 19L19 5M11 5h8v8"/>',
    draw: (r) => { const x2 = r.X[1] ?? r.X[0], y2 = r.Y[1] ?? r.Y[0]; L(r, [r.X[0], r.Y[0], x2, y2]); arrowHead(r, r.X[0], r.Y[0], x2, y2, 12); } },
  hline: { name: 'Horizontal line', n: 1, color: '#b84fd6', key: 'KeyH', icon: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>',
    draw: (r) => { L(r, [0, r.Y[0], r.W, r.Y[0]]); r.label(r.W - 4, r.Y[0] - 9, r.fmt(r.d.pts[0].p), r.c, { anchor: 'end' }); } },
  hray: { name: 'Horizontal ray', n: 1, color: '#b84fd6', key: 'KeyJ', icon: '<path d="M6 12h15"/><circle cx="6" cy="12" r="1.6"/>',
    draw: (r) => { L(r, [r.X[0], r.Y[0], r.W, r.Y[0]]); r.label(r.W - 4, r.Y[0] - 9, r.fmt(r.d.pts[0].p), r.c, { anchor: 'end' }); } },
  vline: { name: 'Vertical line', n: 1, color: '#b84fd6', key: 'KeyV', icon: '<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6"/>',
    draw: (r) => L(r, [r.X[0], 0, r.X[0], r.H]) },
  crossline: { name: 'Cross line', n: 1, color: '#b84fd6', key: 'KeyC', icon: '<path d="M12 3v18M3 12h18"/>',
    draw: (r) => { L(r, [0, r.Y[0], r.W, r.Y[0]]); L(r, [r.X[0], 0, r.X[0], r.H]); } },
  channel: { name: 'Parallel channel', n: 3, color: '#26a69a', icon: '<path d="M3 15L15 4M9 20L21 9"/>',
    draw: (r) => {
      const { X, Y } = r;
      if (X.length < 2) return;
      const off = X.length > 2 ? Y[2] - (Y[0] + (Y[1] - Y[0]) * ((X[2] - X[0]) / ((X[1] - X[0]) || 1))) : 0;
      r.poly([[X[0], Y[0]], [X[1], Y[1]], [X[1], Y[1] + off], [X[0], Y[0] + off]], { fill: r.c, 'fill-opacity': 0.12, stroke: 'none' }, true);
      L(r, [X[0], Y[0], X[1], Y[1]]); L(r, [X[0], Y[0] + off, X[1], Y[1] + off]);
      r.line(X[0], Y[0] + off / 2, X[1], Y[1] + off / 2, { 'stroke-dasharray': '4 4', 'stroke-width': 1 });
    } },
  // fib, pitchfork, gann
  fib: { name: 'Fib retracement', n: 2, color: '#8c8c8c', key: 'KeyF', icon: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>',
    draw: (r) => {
      if (r.X.length < 2) return;
      const [a, b] = r.d.pts;
      const x1 = Math.min(r.X[0], r.X[1]), x2 = Math.max(r.X[0], r.X[1]);
      drawFibLevels(r, FIB_LEVELS, (lv) => b.p + (a.p - b.p) * lv, x1, x2);
      r.line(r.X[0], r.Y[0], r.X[1], r.Y[1], { stroke: '#787b86', 'stroke-dasharray': '4 4', 'stroke-width': 1 });
      r.hit([[x1, r.Y[0]], [x2, r.Y[0]], [x2, r.Y[1]], [x1, r.Y[1]]], true);
    } },
  fibext: { name: 'Trend-based Fib extension', n: 3, color: '#8c8c8c', icon: '<path d="M3 4h18M3 9h18M3 14h18M3 20h18"/><path d="M4 18l5-8 4 5" stroke-dasharray="2 2"/>',
    draw: (r) => {
      const { X, Y, d } = r;
      r.poly(X.map((x, i) => [x, Y[i]]), { stroke: '#787b86', 'stroke-dasharray': '4 4', 'stroke-width': 1, fill: 'none' });
      if (X.length < 3) return;
      const move = d.pts[1].p - d.pts[0].p;
      const x1 = X[2], x2 = Math.max(X[2] + Math.abs(X[1] - X[0]), X[2] + 100);
      drawFibLevels(r, [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618], (lv) => d.pts[2].p + move * lv, x1, x2);
      r.hit(X.map((x, i) => [x, Y[i]]));
      r.hit([[x1, Y[2]], [x2, Y[2]]]);
    } },
  fibchannel: { name: 'Fib channel', n: 3, color: '#8c8c8c', icon: '<path d="M3 14L14 3M5 18L18 5M8 21L21 8" />',
    draw: (r) => {
      const { X, Y } = r;
      if (X.length < 2) return;
      const off = X.length > 2 ? Y[2] - (Y[0] + (Y[1] - Y[0]) * ((X[2] - X[0]) / ((X[1] - X[0]) || 1))) : 0;
      [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618].forEach((lv, i) => {
        const e = r.ext(X[0], Y[0] + off * lv, X[1], Y[1] + off * lv, false, true);
        r.line(e[0], e[1], e[2], e[3], { stroke: FIB_COLORS[i % FIB_COLORS.length], 'stroke-width': 1 });
        r.text(X[0] - 4, Y[0] + off * lv + 4, String(lv), { fill: FIB_COLORS[i % FIB_COLORS.length], 'font-size': 11, 'text-anchor': 'end' });
      });
      r.hit([[X[0], Y[0]], [X[1], Y[1]]]); r.hit([[X[0], Y[0] + off], [X[1], Y[1] + off]]);
    } },
  fibtime: { name: 'Fib time zones', n: 2, color: '#8c8c8c', icon: '<path d="M3 3v18M5 3v18M8 3v18M13 3v18M21 3v18"/>',
    draw: (r) => {
      if (r.X.length < 2) return;
      const l0 = r.lOf(r.d.pts[0].t), l1 = r.lOf(r.d.pts[1].t);
      if (l0 == null || l1 == null) return;
      [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89].forEach((k, i) => {
        const xx = r.xAtL(l0 + (l1 - l0) * k);
        if (xx == null || xx < -50 || xx > r.W + 50) return;
        r.line(xx, 0, xx, r.H, { stroke: FIB_COLORS[i % FIB_COLORS.length], 'stroke-width': 1 });
        r.text(xx + 3, r.H - 6, String(k), { fill: FIB_COLORS[i % FIB_COLORS.length], 'font-size': 11 });
        if (i < 2) r.hit([[xx, 0], [xx, r.H]]);
      });
    } },
  fibfan: { name: 'Fib speed fan', n: 2, color: '#8c8c8c', icon: '<path d="M3 21L21 3M3 21L21 9M3 21L21 15M3 21L21 21"/>',
    draw: (r) => {
      if (r.X.length < 2) return;
      const { X, Y } = r;
      [0, 0.382, 0.5, 0.618, 1].forEach((lv, i) => {
        const e = r.ext(X[0], Y[0], X[1], Y[1] + (Y[0] - Y[1]) * lv, false, true);
        r.line(e[0], e[1], e[2], e[3], { stroke: FIB_COLORS[(i + 1) % FIB_COLORS.length], 'stroke-width': 1 });
        r.text(X[1] + 4, Y[1] + (Y[0] - Y[1]) * lv - 3, String(lv), { fill: FIB_COLORS[(i + 1) % FIB_COLORS.length], 'font-size': 11 });
      });
      r.poly([[X[0], Y[0]], [X[1], Y[0]], [X[1], Y[1]], [X[0], Y[1]]], { stroke: '#555', 'stroke-width': 1, fill: 'none', 'stroke-dasharray': '3 3' }, true);
      r.hit([[X[0], Y[0]], [X[1], Y[1]]]);
    } },
  pitchfork: { name: 'Pitchfork', n: 3, color: '#ff5252', icon: '<path d="M4 12h6M10 12l10-7M10 12l10 7M10 12h11"/>',
    draw: (r) => {
      const { X, Y } = r;
      if (X.length < 2) { return; }
      if (X.length < 3) { L(r, [X[0], Y[0], X[1], Y[1]]); return; }
      const mx = (X[1] + X[2]) / 2, my = (Y[1] + Y[2]) / 2;
      const dx = mx - X[0], dy = my - Y[0];
      const far = (x: number, yv: number) => r.ext(x, yv, x + dx, yv + dy, false, true);
      const m = far(X[0], Y[0]), a = far(X[1], Y[1]), b = far(X[2], Y[2]);
      r.poly([[a[0], a[1]], [a[2], a[3]], [b[2], b[3]], [b[0], b[1]]], { fill: r.c, 'fill-opacity': 0.08, stroke: 'none' }, true);
      L(r, m); L(r, a); L(r, b);
      r.line(X[1], Y[1], X[2], Y[2], { 'stroke-width': 1 });
    } },
  gannfan: { name: 'Gann fan', n: 2, color: '#26a69a', icon: '<path d="M3 21L21 3M3 21L21 11M3 21L13 3M3 21L21 17M3 21L7 3"/>',
    draw: (r) => {
      if (r.X.length < 2) return;
      const { X, Y } = r;
      const dx = X[1] - X[0], dy = Y[1] - Y[0];
      ([[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]] as const).forEach(([a, b], i) => {
        const e = r.ext(X[0], Y[0], X[0] + dx * a, Y[0] + dy * b, false, true);
        r.line(e[0], e[1], e[2], e[3], { stroke: FIB_COLORS[(i + 1) % FIB_COLORS.length], 'stroke-width': a === b ? 1.5 : 1 });
        r.text(X[0] + dx * a + 3, Y[0] + dy * b - 3, `${a}x${b}`, { fill: FIB_COLORS[(i + 1) % FIB_COLORS.length], 'font-size': 10 });
      });
      r.hit([[X[0], Y[0]], [X[1], Y[1]]]);
    } },
  gannbox: { name: 'Gann box', n: 2, color: '#ff9800', icon: '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    draw: (r) => {
      if (r.X.length < 2) return;
      const { X, Y } = r;
      const lv = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
      lv.forEach((k, i) => {
        const yy = Y[0] + (Y[1] - Y[0]) * k, xx = X[0] + (X[1] - X[0]) * k;
        r.line(X[0], yy, X[1], yy, { stroke: FIB_COLORS[i], 'stroke-width': 1 });
        r.line(xx, Y[0], xx, Y[1], { stroke: FIB_COLORS[i], 'stroke-width': 1 });
        r.text(X[0] - 4, yy + 4, String(k), { fill: FIB_COLORS[i], 'font-size': 10, 'text-anchor': 'end' });
      });
      r.line(X[0], Y[0], X[1], Y[1], { 'stroke-dasharray': '4 4', 'stroke-width': 1 });
      r.hit([[X[0], Y[0]], [X[1], Y[0]], [X[1], Y[1]], [X[0], Y[1]]], true);
    } },
  // patterns
  xabcd: { name: 'XABCD pattern', n: 5, color: '#2962ff', icon: '<path d="M3 18L8 6l4 9 4-8 5 11"/>',
    draw: (r) => {
      const { X, Y } = r;
      const P = (i: number) => [X[i], Y[i]];
      if (X.length >= 3) r.poly([P(0), P(1), P(2)], { fill: r.c, 'fill-opacity': 0.15, stroke: 'none' }, true);
      if (X.length >= 5) r.poly([P(2), P(3), P(4)], { fill: r.c, 'fill-opacity': 0.15, stroke: 'none' }, true);
      ratioLabel(r, 0, 2, retr(r.d, 0, 1, 2)); ratioLabel(r, 1, 3, retr(r.d, 1, 2, 3));
      ratioLabel(r, 2, 4, retr(r.d, 2, 3, 4)); ratioLabel(r, 0, 4, X[4] !== undefined ? (Math.abs(r.d.pts[4].p - r.d.pts[1].p) / (Math.abs(r.d.pts[1].p - r.d.pts[0].p) || 1)).toFixed(3) : '');
      pathWithLabels(r, ['X', 'A', 'B', 'C', 'D']);
    } },
  abcd: { name: 'ABCD pattern', n: 4, color: '#26a69a', icon: '<path d="M3 18L9 6l5 8 7-10"/>',
    draw: (r) => { ratioLabel(r, 0, 2, retr(r.d, 0, 1, 2)); ratioLabel(r, 1, 3, retr(r.d, 1, 2, 3)); pathWithLabels(r, ['A', 'B', 'C', 'D']); } },
  trianglepat: { name: 'Triangle pattern', n: 4, color: '#ff9800', icon: '<path d="M3 4l6 14 5-10 4 7"/><path d="M3 4l18 8M9 18l12-6" stroke-dasharray="2 2"/>',
    draw: (r) => {
      const { X, Y } = r;
      if (X.length >= 3) { const e = r.ext(X[0], Y[0], X[2], Y[2], false, true); r.line(e[0], e[1], e[2], e[3], { 'stroke-dasharray': '4 4', 'stroke-width': 1 }); }
      if (X.length >= 4) { const e = r.ext(X[1], Y[1], X[3], Y[3], false, true); r.line(e[0], e[1], e[2], e[3], { 'stroke-dasharray': '4 4', 'stroke-width': 1 }); }
      pathWithLabels(r, ['A', 'B', 'C', 'D']);
    } },
  hs: { name: 'Head and shoulders', n: 7, color: '#2962ff', icon: '<path d="M2 18l4-8 3 4 3-10 3 10 3-4 4 8"/>',
    draw: (r) => {
      const { X, Y } = r;
      if (X.length >= 5) { const e = r.ext(X[2], Y[2], X[4], Y[4], true, true); r.line(e[0], e[1], e[2], e[3], { 'stroke-dasharray': '5 4', 'stroke-width': 1 }); }
      if (X.length >= 3) r.poly(X.slice(0, 3).map((x, i) => [x, Y[i]]), { fill: r.c, 'fill-opacity': 0.12, stroke: 'none' }, true);
      if (X.length >= 5) r.poly(X.slice(2, 5).map((x, i) => [x, Y[i + 2]]), { fill: r.c, 'fill-opacity': 0.12, stroke: 'none' }, true);
      if (X.length >= 7) r.poly(X.slice(4, 7).map((x, i) => [x, Y[i + 4]]), { fill: r.c, 'fill-opacity': 0.12, stroke: 'none' }, true);
      pathWithLabels(r, ['', 'Left shoulder', '', 'Head', '', 'Right shoulder', '']);
    } },
  elliott: { name: 'Elliott impulse wave (12345)', n: 6, color: '#3d85c6', icon: '<path d="M2 20l4-8 3 4 5-12 3 7 5-5"/>',
    draw: (r) => pathWithLabels(r, ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)']) },
  elliottabc: { name: 'Elliott correction wave (ABC)', n: 4, color: '#e69138', icon: '<path d="M3 5l6 12 4-6 8 9"/>',
    draw: (r) => pathWithLabels(r, ['(0)', '(A)', '(B)', '(C)']) },
  // measure & position
  long: { name: 'Long position (entry, target, stop)', n: 3, color: GREEN, icon: '<rect x="4" y="4" width="16" height="8" fill="currentColor" fill-opacity=".3"/><rect x="4" y="12" width="16" height="8"/><path d="M4 12h16"/>',
    draw: (r) => positionTool(r, true) },
  short: { name: 'Short position (entry, target, stop)', n: 3, color: RED, icon: '<rect x="4" y="4" width="16" height="8"/><rect x="4" y="12" width="16" height="8" fill="currentColor" fill-opacity=".3"/><path d="M4 12h16"/>',
    draw: (r) => positionTool(r, false) },
  daterange: { name: 'Date range', n: 2, color: BLUE, icon: '<path d="M4 4v16M20 4v16M6 12h12M15 9l3 3-3 3"/>',
    draw: (r) => {
      const { X, Y } = r; const x2 = X[1] ?? X[0], y2 = Y[1] ?? Y[0];
      r.poly([[X[0], Y[0]], [x2, Y[0]], [x2, y2], [X[0], y2]], { fill: r.c, 'fill-opacity': 0.15, stroke: 'none' }, true);
      const ym = (Y[0] + y2) / 2; r.line(X[0], ym, x2, ym); arrowHead(r, X[0], ym, x2, ym, 8);
      r.hitBox(Math.min(X[0], x2), Math.min(Y[0], y2), Math.abs(x2 - X[0]), Math.abs(y2 - Y[0]));
      if (r.d.pts[1]) r.label((X[0] + x2) / 2, Math.max(Y[0], y2) + 6, barsAndTime(r, 0, 1), r.c, { anchor: 'middle' });
    } },
  pricerange: { name: 'Price range', n: 2, color: BLUE, icon: '<path d="M4 4h16M4 20h16M12 6v12M9 15l3 3 3-3"/>',
    draw: (r) => {
      const { X, Y } = r; const x2 = X[1] ?? X[0], y2 = Y[1] ?? Y[0];
      r.poly([[X[0], Y[0]], [x2, Y[0]], [x2, y2], [X[0], y2]], { fill: r.c, 'fill-opacity': 0.15, stroke: 'none' }, true);
      const xm = (X[0] + x2) / 2; r.line(xm, Y[0], xm, y2); arrowHead(r, xm, Y[0], xm, y2, 8);
      r.hitBox(Math.min(X[0], x2), Math.min(Y[0], y2), Math.abs(x2 - X[0]), Math.abs(y2 - Y[0]));
      if (r.d.pts[1]) { const [a, b] = r.d.pts; r.label(xm, Math.min(Y[0], y2) - 22, `${b.p - a.p >= 0 ? '+' : ''}${r.fmt(b.p - a.p)} (${pct(a.p, b.p)})`, r.c, { anchor: 'middle' }); }
    } },
  dprange: { name: 'Date and price range', n: 2, color: BLUE, icon: '<rect x="4" y="4" width="16" height="16"/><path d="M8 16L16 8M12 8h4v4"/>',
    draw: (r) => {
      const { X, Y } = r; const x2 = X[1] ?? X[0], y2 = Y[1] ?? Y[0];
      const up = (r.d.pts[1]?.p ?? 0) >= r.d.pts[0].p; const col = up ? BLUE : RED;
      r.poly([[X[0], Y[0]], [x2, Y[0]], [x2, y2], [X[0], y2]], { fill: col, 'fill-opacity': 0.15, stroke: col }, true);
      r.hitBox(Math.min(X[0], x2), Math.min(Y[0], y2), Math.abs(x2 - X[0]), Math.abs(y2 - Y[0]));
      if (r.d.pts[1]) {
        const [a, b] = r.d.pts;
        const yb = up ? Math.min(Y[0], y2) - 40 : Math.max(Y[0], y2) + 4;
        r.label((X[0] + x2) / 2, yb, `${b.p - a.p >= 0 ? '+' : ''}${r.fmt(b.p - a.p)} (${pct(a.p, b.p)})`, col, { anchor: 'middle' });
        r.label((X[0] + x2) / 2, yb + 18, barsAndTime(r, 0, 1), col, { anchor: 'middle' });
      }
    } },
  ruler: { name: 'Measure (temporary)', n: 2, color: BLUE, icon: '<rect x="2.5" y="8" width="19" height="8" rx="1" transform="rotate(-30 12 12)"/><path d="M8 10.5l1 1.7M11 8.8l1.5 2.5M14 7l1 1.7"/>' },
  // shapes
  rect: { name: 'Rectangle', n: 2, color: '#ff9800', key: 'KeyR', icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    draw: (r) => {
      const { X, Y } = r; const x2 = X[1] ?? X[0], y2 = Y[1] ?? Y[0];
      const pts = [[X[0], Y[0]], [x2, Y[0]], [x2, y2], [X[0], y2]];
      r.poly(pts, { fill: r.c, 'fill-opacity': 0.15 }, true); r.hit(pts, true);
    } },
  ellipse: { name: 'Ellipse', n: 2, color: '#ab47bc', icon: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
    draw: (r) => {
      const { X, Y } = r; const x2 = X[1] ?? X[0], y2 = Y[1] ?? Y[0];
      const cx = (X[0] + x2) / 2, cy = (Y[0] + y2) / 2, rx = Math.abs(x2 - X[0]) / 2, ry = Math.abs(y2 - Y[0]) / 2;
      r.poly(Array.from({ length: 49 }, (_, i) => [cx + rx * Math.cos((i / 48) * 2 * Math.PI), cy + ry * Math.sin((i / 48) * 2 * Math.PI)]), { fill: r.c, 'fill-opacity': 0.15 });
      r.hit(Array.from({ length: 49 }, (_, i) => [cx + rx * Math.cos((i / 48) * 2 * Math.PI), cy + ry * Math.sin((i / 48) * 2 * Math.PI)]));
    } },
  circle: { name: 'Circle (centre, edge)', n: 2, color: '#ab47bc', icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1"/>',
    draw: (r) => {
      const { X, Y } = r; const rad = Math.hypot((X[1] ?? X[0]) - X[0], (Y[1] ?? Y[0]) - Y[0]);
      const pts = Array.from({ length: 49 }, (_, i) => [X[0] + rad * Math.cos((i / 48) * 2 * Math.PI), Y[0] + rad * Math.sin((i / 48) * 2 * Math.PI)]);
      r.poly(pts, { fill: r.c, 'fill-opacity': 0.15 }); r.hit(pts);
    } },
  triangle: { name: 'Triangle', n: 3, color: '#ff9800', icon: '<path d="M12 4l9 16H3z"/>',
    draw: (r) => { const pts = r.X.map((x, i) => [x, r.Y[i]]); r.poly(pts, { fill: r.c, 'fill-opacity': 0.15 }, true); r.hit(pts, true); } },
  brush: { name: 'Brush (drag to draw)', n: -1, color: '#ffeb3b', icon: '<path d="M4 18c3 0 3-3 6-3s4 3 7 1 3-6 3-9"/>',
    draw: (r) => { const pts = r.X.map((x, i) => [x, r.Y[i]]); r.poly(pts, { fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }); r.hit(pts); } },
  highlighter: { name: 'Highlighter (drag to draw)', n: -1, color: '#ffeb3b', icon: '<path d="M4 16c4-1 6-6 10-6s4 4 6 4" stroke-width="4" stroke-opacity=".5"/>',
    draw: (r) => {
      const pts = r.X.map((x, i) => [x, r.Y[i]]);
      r.poly(pts, { fill: 'none', 'stroke-width': Math.max(10, r.sw * 6), 'stroke-opacity': 0.35, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }); r.hit(pts);
    } },
  // annotations
  text: { name: 'Text', n: 1, color: '#dbdbdb', text: true, icon: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    draw: (r) => { const t = r.text(r.X[0], r.Y[0], r.d.text ?? '', { fill: r.c, 'font-size': 14 + (r.sw - 1.5) * 4 }); if (!r.preview) t.setAttribute('class', 'hit-text'); } },
  callout: { name: 'Callout', n: 2, color: '#2962ff', text: true, icon: '<path d="M4 5h16v10H10l-4 4v-4H4z"/>',
    draw: (r) => {
      const x2 = r.X[1] ?? r.X[0] + 40, y2 = r.Y[1] ?? r.Y[0] - 40;
      r.line(r.X[0], r.Y[0], x2, y2); r.hit([[r.X[0], r.Y[0]], [x2, y2]]);
      r.label(x2, y2 - 10, r.d.text || 'Callout', r.c, { anchor: 'middle', hitbox: true });
    } },
  pricelabel: { name: 'Price label', n: 1, color: '#2962ff', icon: '<path d="M3 12l5-6h13v12H8z"/>',
    draw: (r) => {
      const s = r.fmt(r.d.pts[0].p), w = s.length * 7 + 14;
      r.poly([[r.X[0], r.Y[0]], [r.X[0] + 8, r.Y[0] - 10], [r.X[0] + 8 + w, r.Y[0] - 10], [r.X[0] + 8 + w, r.Y[0] + 10], [r.X[0] + 8, r.Y[0] + 10]], { fill: r.c, stroke: 'none', class: r.preview ? '' : 'hit-fill' }, true);
      r.text(r.X[0] + 15, r.Y[0] + 4, s, { fill: '#fff', 'font-size': 12 });
    } },
  note: { name: 'Note', n: 1, color: '#ff9800', text: true, icon: '<path d="M5 3h14v13l-5 5H5z"/><path d="M14 21v-5h5"/>',
    draw: (r) => {
      r.poly([[r.X[0], r.Y[0]], [r.X[0] - 6, r.Y[0] - 10], [r.X[0] + 6, r.Y[0] - 10]], { fill: r.c, stroke: 'none' }, true);
      r.label(r.X[0], r.Y[0] - 30, r.d.text || 'Note', r.c, { anchor: 'middle', hitbox: true });
    } },
  arrowup: { name: 'Arrow mark up', n: 1, color: GREEN, icon: '<path d="M12 4l7 8h-4v8H9v-8H5z"/>',
    draw: (r) => {
      const { X, Y } = r;
      r.poly([[X[0], Y[0]], [X[0] + 9, Y[0] + 11], [X[0] + 4, Y[0] + 11], [X[0] + 4, Y[0] + 24], [X[0] - 4, Y[0] + 24], [X[0] - 4, Y[0] + 11], [X[0] - 9, Y[0] + 11]],
        { fill: r.c, stroke: 'none', class: r.preview ? '' : 'hit-fill' }, true);
    } },
  arrowdown: { name: 'Arrow mark down', n: 1, color: RED, icon: '<path d="M12 20l7-8h-4V4H9v8H5z"/>',
    draw: (r) => {
      const { X, Y } = r;
      r.poly([[X[0], Y[0]], [X[0] + 9, Y[0] - 11], [X[0] + 4, Y[0] - 11], [X[0] + 4, Y[0] - 24], [X[0] - 4, Y[0] - 24], [X[0] - 4, Y[0] - 11], [X[0] - 9, Y[0] - 11]],
        { fill: r.c, stroke: 'none', class: r.preview ? '' : 'hit-fill' }, true);
    } },
  flag: { name: 'Flag mark', n: 1, color: RED, icon: '<path d="M6 21V4M6 4h12l-3 4 3 4H6"/>',
    draw: (r) => {
      const { X, Y } = r;
      r.line(X[0], Y[0], X[0], Y[0] - 28, { 'stroke-width': 1.5 });
      r.poly([[X[0], Y[0] - 28], [X[0] + 18, Y[0] - 28], [X[0] + 13, Y[0] - 22], [X[0] + 18, Y[0] - 16], [X[0], Y[0] - 16]], { fill: r.c, stroke: 'none', class: r.preview ? '' : 'hit-fill' }, true);
    } },
};

const GROUPS: { id: string; title: string; tools: string[] }[] = [
  { id: 'cursor', title: 'Cursor', tools: ['cross'] },
  { id: 'lines', title: 'Lines', tools: ['trend', 'ray', 'extended', 'info', 'arrow', 'hline', 'hray', 'vline', 'crossline', 'channel'] },
  { id: 'fib', title: 'Fib, pitchfork and Gann', tools: ['fib', 'fibext', 'fibchannel', 'fibtime', 'fibfan', 'pitchfork', 'gannfan', 'gannbox'] },
  { id: 'patterns', title: 'Patterns', tools: ['xabcd', 'abcd', 'trianglepat', 'hs', 'elliott', 'elliottabc'] },
  { id: 'measure', title: 'Forecasting and measurement', tools: ['long', 'short', 'dprange', 'daterange', 'pricerange', 'ruler'] },
  { id: 'shapes', title: 'Shapes and brushes', tools: ['rect', 'ellipse', 'circle', 'triangle', 'brush', 'highlighter'] },
  { id: 'notes', title: 'Text and annotations', tools: ['text', 'callout', 'note', 'pricelabel', 'arrowup', 'arrowdown', 'flag'] },
];
const ICON = (body: string, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

interface Ctx { chart: IChartApi; candles: ISeriesApi<'Candlestick'>; getBars: () => Bar[]; wrap: HTMLElement }

export function initDrawings({ chart, candles, getBars, wrap }: Ctx) {
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'draw-layer';
  wrap.appendChild(svg);

  let tool = 'cross';
  let key = '';
  let items: Drawing[] = [];
  let pending: Pt[] = [];
  let hover: Pt | null = null;
  let ruler: Pt[] | null = null;
  let selected: string | null = null;
  let hidden = false;
  let locked = false;
  let magnet = false;
  let stayInDrawing = false;
  const undo: string[] = [];
  const redo: string[] = [];

  // ---------- coordinates ----------
  const ts = () => chart.timeScale();
  function interval(bars: Bar[]) { return bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : 60; }
  function logicalFromTime(t: number): number | null {
    const bars = getBars();
    if (!bars.length) return null;
    const n = bars.length;
    if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / interval(bars);
    if (t <= bars[0].time) return (t - bars[0].time) / interval(bars);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].time <= t) lo = mid; else hi = mid; }
    return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }
  function timeFromLogical(l: number): number {
    const bars = getBars();
    const n = bars.length;
    if (l >= n - 1) return bars[n - 1].time + (l - (n - 1)) * interval(bars);
    if (l <= 0) return bars[0].time + l * interval(bars);
    const i = Math.floor(l);
    return bars[i].time + (l - i) * (bars[i + 1].time - bars[i].time);
  }
  // The chart maps fractional logical indexes past the last bar to 0, so interpolate between whole ones ourselves.
  const xAt = (l: number) => {
    const a = Math.floor(l);
    const ca = ts().logicalToCoordinate(a as Logical);
    if (ca == null) return null;
    if (l === a) return ca;
    const cb = ts().logicalToCoordinate((a + 1) as Logical);
    return cb == null ? ca : ca + (l - a) * (cb - ca);
  };
  const x = (t: number) => { const l = logicalFromTime(t); return l == null ? null : xAt(l); };
  const y = (p: number) => candles.priceToCoordinate(p);
  function ptFromXY(px: number, py: number, snap = magnet): Pt | null {
    const bars = getBars();
    const l = ts().coordinateToLogical(px);
    const p = candles.coordinateToPrice(py);
    if (l == null || p == null || !bars.length) return null;
    let t = timeFromLogical(Math.round(l));
    let price: number = p;
    if (snap && Math.round(l) <= bars.length - 1 && Math.round(l) >= 0) {
      const b = bars[Math.round(l)];
      t = b.time;
      price = [b.open, b.high, b.low, b.close].reduce((a, c) => (Math.abs(c - p) < Math.abs(a - p) ? c : a));
    }
    return { t, p: price };
  }

  // ---------- persistence + history ----------
  const storeKey = () => `drawings:${key}`;
  function load() {
    try { items = JSON.parse(localStorage.getItem(storeKey()) || '[]'); } catch { items = []; }
  }
  function save() { try { localStorage.setItem(storeKey(), JSON.stringify(items)); } catch { /* ignore */ } }
  function commit(mutate: () => void) {
    undo.push(JSON.stringify(items));
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    mutate();
    save();
    render();
  }
  function doUndo() { if (!undo.length) return; redo.push(JSON.stringify(items)); items = JSON.parse(undo.pop()!); selected = null; save(); render(); }
  function doRedo() { if (!redo.length) return; undo.push(JSON.stringify(items)); items = JSON.parse(redo.pop()!); selected = null; save(); render(); }

  // ---------- rendering ----------
  function el(tag: string, attrs: Attrs, parent: Element = svg) {
    const e = document.createElementNS(NS, tag) as SVGElement;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  }
  const fmtP = (p: number) => (Math.abs(p) >= 1 ? p.toFixed(2) : p.toPrecision(4));
  /** Extend the segment (x1,y1)-(x2,y2) backwards and/or forwards to the pane edges. */
  function ext(x1: number, y1: number, x2: number, y2: number, back: boolean, fwd: boolean): number[] {
    const W = ts().width(), H = chart.paneSize().height;
    const dx = x2 - x1, dy = y2 - y1;
    if (!dx && !dy) return [x1, y1, x2, y2];
    const big = (W + H) * 4 / Math.hypot(dx, dy);
    return [back ? x1 - dx * big : x1, back ? y1 - dy * big : y1, fwd ? x2 + dx * big : x2, fwd ? y2 + dy * big : y2];
  }
  function drawOne(d: Drawing, g: Element, preview = false) {
    const def = TOOLS[d.kind];
    if (!def?.draw) return;
    const xs = d.pts.map((p) => x(p.t)), ys = d.pts.map((p) => y(p.p));
    if (xs.some((v) => v == null) || ys.some((v) => v == null)) return;
    const sw = d.width ?? 1.5;
    const r: R = {
      d, X: xs as number[], Y: ys as number[], W: ts().width(), H: chart.paneSize().height, preview, sw, c: d.color,
      line: (x1, y1, x2, y2, a = {}) => { el('line', { x1, y1, x2, y2, stroke: d.color, 'stroke-width': sw, ...a }, g); },
      poly: (pts, a = {}, closed = false) => { el(closed ? 'polygon' : 'polyline', { points: pts.map((p) => p.join(',')).join(' '), stroke: d.color, 'stroke-width': sw, fill: 'none', ...a }, g); },
      text: (tx, ty, s, a = {}) => { const t = el('text', { x: tx, y: ty, fill: d.color, 'font-size': 12, ...a }, g); t.textContent = s; return t; },
      label: (lx, ly, s, bg, o = {}) => {
        const w = s.length * 6.6 + 12, h = 18;
        const left = o.anchor === 'middle' ? lx - w / 2 : o.anchor === 'end' ? lx - w : lx;
        el('rect', { x: left, y: ly, width: w, height: h, rx: 3, fill: bg, class: o.hitbox && !preview ? 'hit-fill' : '' }, g);
        const t = el('text', { x: left + w / 2, y: ly + 13, fill: o.fg ?? '#fff', 'font-size': 11.5, 'text-anchor': 'middle' }, g);
        t.textContent = s;
      },
      hit: (pts, closed = false) => { if (!preview) el(closed ? 'polygon' : 'polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'hit' }, g); },
      hitBox: (bx, by, bw, bh) => { if (!preview) el('rect', { x: bx, y: by, width: Math.max(bw, 4), height: Math.max(bh, 4), class: 'hit-fill', fill: 'transparent' }, g); },
      ext, xAtL: xAt, lOf: logicalFromTime, yOf: y, fmt: fmtP,
    };
    def.draw(r);
    if (!preview && d.id === selected && !locked && def.n !== -1) {
      d.pts.forEach((_, i) => el('circle', { cx: r.X[i], cy: r.Y[i], r: 5, class: 'handle', 'data-i': i, 'data-id': d.id }, g));
    }
  }
  function render() {
    svg.style.height = `${chart.paneSize().height}px`;
    svg.textContent = '';
    if (hidden && !ruler) { editBar(); return; }
    if (!hidden) {
      for (const d of items) {
        const g = el('g', { 'data-id': d.id, class: d.id === selected ? 'sel' : '' });
        drawOne(d, g);
      }
      if (pending.length && tool !== 'ruler' && tool !== 'cross' && TOOLS[tool]) {
        const pts = TOOLS[tool].n === -1 ? pending : hover ? [...pending, hover] : pending;
        drawOne({ id: '_', kind: tool, pts, color: TOOLS[tool].color, text: TOOLS[tool].text ? '…' : undefined }, el('g', {}), true);
      }
    }
    const r = ruler ?? (tool === 'ruler' && pending.length && hover ? [pending[0], hover] : null);
    if (r && r.length === 2) drawOne({ id: '_r', kind: 'dprange', pts: r, color: BLUE }, el('g', {}), true);
    editBar();
  }

  // ---------- placing ----------
  // Native clicks rather than chart.subscribeClick: the chart swallows a quick second click as a double-click.
  let downAt: { x: number; y: number } | null = null;
  const local = (e: { clientX: number; clientY: number }) => { const r = wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const inPane = (px: number, py: number) => px >= 0 && py >= 0 && px <= ts().width() && py <= chart.paneSize().height;
  wrap.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
    // Freehand tools: take over the drag so the chart doesn't scroll.
    if (TOOLS[tool]?.n === -1 && !(e.target as Element).closest('#legend, #trade-bar, #replay-bar, #draw-edit')) {
      const [px, py] = local(e);
      if (!inPane(px, py)) return;
      e.stopPropagation(); e.preventDefault();
      const first = ptFromXY(px, py, false);
      if (!first) return;
      pending = [first];
      const mv = (ev: PointerEvent) => { const [qx, qy] = local(ev); const p = ptFromXY(qx, qy, false); if (p) { pending.push(p); render(); } };
      const up = () => {
        window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', up, true);
        if (pending.length > 1) finish({ id: newId(), kind: tool, pts: thin(pending), color: TOOLS[tool].color, width: tool === 'brush' ? 2 : 1.5 });
        pending = []; render();
      };
      window.addEventListener('pointermove', mv, true); window.addEventListener('pointerup', up, true);
    }
  }, true);
  wrap.addEventListener('mousedown', (e) => { if (TOOLS[tool]?.n === -1) { const [px, py] = local(e); if (inPane(px, py)) e.stopPropagation(); } }, true);
  wrap.addEventListener('click', (e) => {
    if (tool === 'cross' || TOOLS[tool]?.n === -1 || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    if ((e.target as Element).closest('#legend, #replay-bar, #notice, #trade-bar, #draw-edit')) return;
    const [px, py] = local(e);
    if (!inPane(px, py)) return;
    placeAt(px, py);
  });
  const newId = () => Math.random().toString(36).slice(2, 10);
  /** Keep every 3rd point of a long freehand stroke. */
  const thin = (pts: Pt[]) => pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1);
  function finish(d: Drawing) {
    commit(() => items.push(d));
    selected = d.id;
    if (!stayInDrawing) setTool('cross');
  }
  function placeAt(px: number, py: number) {
    const pt = ptFromXY(px, py);
    if (!pt) return;
    if (tool === 'ruler') {
      if (ruler) { ruler = null; pending = []; }
      pending.push(pt);
      if (pending.length === 2) { ruler = [...pending]; pending = []; }
      render();
      return;
    }
    pending.push(pt);
    const def = TOOLS[tool];
    if (pending.length >= def.n) {
      const d: Drawing = { id: newId(), kind: tool, pts: pending, color: def.color };
      pending = [];
      if (def.text) {
        const t = window.prompt(def.name, '');
        if (!t) { render(); return; }
        d.text = t;
      }
      finish(d);
    }
    render();
  }
  chart.subscribeCrosshairMove((param) => {
    if (tool === 'cross' || !param.point) { if (ruler || pending.length) render(); return; }
    if (TOOLS[tool]?.n === -1) return;
    hover = ptFromXY(param.point.x, param.point.y);
    render();
  });
  ts().subscribeVisibleLogicalRangeChange(() => render());
  new ResizeObserver(() => render()).observe(wrap);

  // ---------- select, drag, edit, delete ----------
  svg.addEventListener('pointerdown', (e) => {
    if (tool !== 'cross') return; // while drawing, clicks place points even on top of other drawings
    const target = e.target as Element;
    const handle = target.closest('.handle');
    const g = target.closest('g[data-id]');
    if (!g) return;
    const id = g.getAttribute('data-id')!;
    e.preventDefault();
    e.stopPropagation();
    selected = id;
    render();
    if (locked) return;
    const d = items.find((i) => i.id === id)!;
    const before = JSON.stringify(items);
    const start = { x: e.clientX, y: e.clientY };
    const orig = d.pts.map((p) => ({ ...p }));
    const idx = handle ? Number(handle.getAttribute('data-i')) : -1;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      if (idx >= 0) {
        const [px, py] = local(ev);
        const p = ptFromXY(px, py);
        if (p) d.pts[idx] = p;
      } else {
        d.pts = orig.map((p) => {
          const px = (x(p.t) ?? 0) + ev.clientX - start.x, py = (y(p.p) ?? 0) + ev.clientY - start.y;
          return ptFromXY(px, py, false) ?? p;
        });
      }
      render();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) { undo.push(before); redo.length = 0; save(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  svg.addEventListener('dblclick', (e) => {
    const g = (e.target as Element).closest('g[data-id]');
    const d = g && items.find((i) => i.id === g.getAttribute('data-id'));
    if (d && TOOLS[d.kind]?.text && !locked) editText(d);
  });
  function editText(d: Drawing) {
    const t = window.prompt('Text', d.text ?? '');
    if (t != null && t !== d.text) commit(() => (d.text = t));
  }
  wrap.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element).closest('#draw-layer g[data-id], #draw-edit') && selected) { selected = null; render(); }
  }, true);
  window.addEventListener('keydown', (e) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement || document.querySelector('dialog[open]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !locked) {
      e.preventDefault();
      const id = selected;
      selected = null;
      commit(() => (items = items.filter((i) => i.id !== id)));
    }
    if (e.key === 'Escape') { setTool('cross'); ruler = null; selected = null; render(); }
    if (e.altKey && !mod) {
      const hit = Object.entries(TOOLS).find(([, d]) => d.key === e.code);
      if (hit) { e.preventDefault(); setTool(hit[0]); }
    }
  });

  // Floating bar for the selected drawing: colour, width, text, delete.
  const bar = document.createElement('div');
  bar.id = 'draw-edit';
  bar.hidden = true;
  bar.innerHTML = `<color-swatch title="Colour"></color-swatch><select title="Line width">${[1, 1.5, 2, 3, 4].map((w) => `<option value="${w}">${w}px</option>`).join('')}</select>
    <span class="de-order"><button data-a="mkt" title="Send this position as a market order with its stop and target">Market</button><button data-a="lmt" title="Send this position as a limit order at the entry, with its stop and target">Limit</button></span>
    <button data-a="text" title="Edit text">Aa</button><button data-a="clone" title="Clone">⧉</button><button data-a="del" title="Delete (Del)">${ICON('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>', 16)}</button>`;
  wrap.appendChild(bar);
  const colorIn = bar.querySelector<ColorSwatch>('color-swatch')!, widthIn = bar.querySelector('select')!;
  const sel = () => items.find((i) => i.id === selected);
  colorIn.oninput = () => { const d = sel(); if (d) { d.color = colorIn.value; render(); } };
  colorIn.onchange = () => { const d = sel(); if (d) { const c = colorIn.value; undo.push(JSON.stringify(items)); d.color = c; save(); } };
  widthIn.onchange = () => { const d = sel(); if (d) commit(() => (d.width = Number(widthIn.value))); };
  bar.querySelector<HTMLButtonElement>('[data-a=text]')!.onclick = () => { const d = sel(); if (d) editText(d); };
  bar.querySelector<HTMLButtonElement>('[data-a=clone]')!.onclick = () => {
    const d = sel(); if (!d) return;
    const step = interval(getBars()) * 5;
    const c: Drawing = { ...JSON.parse(JSON.stringify(d)), id: newId() };
    c.pts = c.pts.map((p) => ({ t: p.t + step, p: p.p }));
    commit(() => items.push(c)); selected = c.id; render();
  };
  let onOrder: ((o: PositionOrder) => void) | null = null;
  bar.querySelectorAll<HTMLButtonElement>('[data-a=mkt], [data-a=lmt]').forEach((b) => (b.onclick = () => {
    const d = sel();
    if (!d || d.pts.length < 3 || !onOrder) return;
    onOrder({ long: d.kind === 'long', entry: d.pts[0].p, target: d.pts[1].p, stop: d.pts[2].p, type: b.dataset.a === 'mkt' ? 'MKT' : 'LMT' });
  }));
  bar.querySelector<HTMLButtonElement>('[data-a=del]')!.onclick = () => { const id = selected; selected = null; commit(() => (items = items.filter((i) => i.id !== id))); };
  function editBar() {
    const d = sel();
    bar.hidden = !d || locked || hidden;
    if (!d || bar.hidden) return;
    colorIn.value = d.color || '#2962ff';
    widthIn.value = String(d.width ?? 1.5);
    bar.querySelector<HTMLElement>('[data-a=text]')!.hidden = !TOOLS[d.kind]?.text;
    bar.querySelector<HTMLElement>('.de-order')!.hidden = !onOrder || (d.kind !== 'long' && d.kind !== 'short');
  }

  // ---------- toolbar: groups with flyouts ----------
  const host = document.getElementById('tool-groups')!;
  const groupPick: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem('toolGroupPick') || '{}'); } catch { return {}; } })();
  const flyout = document.createElement('div');
  flyout.id = 'tool-flyout';
  flyout.hidden = true;
  document.body.appendChild(flyout);
  document.addEventListener('pointerdown', (e) => { if (!(e.target as Element).closest('#tool-flyout, .tg-more')) flyout.hidden = true; });
  const groupBtns: { g: (typeof GROUPS)[number]; btn: HTMLButtonElement }[] = [];
  for (const g of GROUPS) {
    const btn = document.createElement('button');
    btn.className = 'tg';
    const cur = () => groupPick[g.id] && g.tools.includes(groupPick[g.id]) ? groupPick[g.id] : g.tools[0];
    btn.onclick = () => setTool(tool === cur() && tool !== 'cross' ? 'cross' : cur());
    btn.oncontextmenu = (e) => { e.preventDefault(); openFlyout(g, btn); };
    if (g.tools.length > 1) {
      const more = document.createElement('span');
      more.className = 'tg-more';
      more.title = `More ${g.title.toLowerCase()}`;
      more.onclick = (e) => { e.stopPropagation(); if (!flyout.hidden && flyout.dataset.g === g.id) flyout.hidden = true; else openFlyout(g, btn); };
      btn.appendChild(more);
    }
    host.appendChild(btn);
    groupBtns.push({ g, btn });
  }
  function openFlyout(g: (typeof GROUPS)[number], btn: HTMLElement) {
    const r = btn.getBoundingClientRect();
    flyout.dataset.g = g.id;
    flyout.innerHTML = `<div class="tf-title">${g.title}</div>` + g.tools.map((t) => {
      const k = TOOLS[t].key ? `<span class="tf-key">⌥${TOOLS[t].key!.slice(3)}</span>` : '';
      return `<button data-t="${t}" class="${t === tool ? 'on' : ''}">${ICON(TOOLS[t].icon, 18)}<span>${TOOLS[t].name}</span>${k}</button>`;
    }).join('');
    flyout.style.left = `${r.right + 4}px`;
    flyout.style.top = `${Math.min(r.top, window.innerHeight - 40 - g.tools.length * 32)}px`;
    flyout.hidden = false;
    flyout.querySelectorAll<HTMLButtonElement>('button[data-t]').forEach((b) => (b.onclick = () => {
      groupPick[g.id] = b.dataset.t!;
      try { localStorage.setItem('toolGroupPick', JSON.stringify(groupPick)); } catch { /* ignore */ }
      flyout.hidden = true;
      setTool(b.dataset.t!);
    }));
  }
  function paintGroups() {
    for (const { g, btn } of groupBtns) {
      const has = g.tools.includes(tool);
      if (has && tool !== 'cross') groupPick[g.id] = tool;
      const shown = groupPick[g.id] && g.tools.includes(groupPick[g.id]) ? groupPick[g.id] : g.tools[0];
      const more = btn.querySelector('.tg-more');
      btn.innerHTML = ICON(TOOLS[shown].icon);
      if (more) btn.appendChild(more);
      btn.title = TOOLS[shown].name + (g.tools.length > 1 ? ' (right-click or the corner arrow for more)' : '');
      btn.classList.toggle('active', has);
    }
  }
  function setTool(t: string) {
    tool = t;
    pending = [];
    hover = null;
    if (t !== 'ruler') ruler = null;
    paintGroups();
    wrap.classList.toggle('drawing', t !== 'cross');
    render();
  }
  paintGroups();
  const toggle = (id: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = document.getElementById(id)!;
    b.onclick = () => { set(!get()); b.classList.toggle('active', get()); render(); };
  };
  toggle('draw-magnet', () => magnet, (v) => (magnet = v));
  toggle('draw-stay', () => stayInDrawing, (v) => (stayInDrawing = v));
  toggle('draw-lock', () => locked, (v) => { locked = v; if (v) selected = null; });
  toggle('draw-hide', () => hidden, (v) => (hidden = v));
  document.getElementById('draw-clear')!.onclick = () => { if (items.length) commit(() => (items = [])); };
  document.getElementById('undo-btn')!.onclick = doUndo;
  document.getElementById('redo-btn')!.onclick = doRedo;

  return {
    /** Load drawings for a symbol (call when the symbol changes). */
    show(k: string) {
      if (k !== key) { key = k; load(); undo.length = 0; redo.length = 0; selected = null; }
      render();
    },
    refresh: render,
    clear() { svg.textContent = ''; },
    /** Lets long/short position drawings send their trade (Market / Limit buttons on the selection bar). */
    onPositionOrder(fn: (o: PositionOrder) => void) { onOrder = fn; },
  };
}
