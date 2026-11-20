import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { Bar } from './indicators';

/**
 * Drawing tools rendered on an SVG layer over the chart. Points are stored as (time, price), so
 * drawings stay put across zoom, scroll and timeframe changes. Saved per symbol in localStorage.
 */
type Tool = 'cross' | 'trend' | 'ray' | 'hline' | 'vline' | 'rect' | 'fib' | 'channel' | 'text' | 'ruler';
type Kind = Exclude<Tool, 'cross' | 'ruler'>;
interface Pt { t: number; p: number }
interface Drawing { id: string; kind: Kind; pts: Pt[]; text?: string; color: string }

const NEEDS: Record<Tool, number> = { cross: 0, trend: 2, ray: 2, hline: 1, vline: 1, rect: 2, fib: 2, channel: 3, text: 1, ruler: 2 };
const COLORS: Record<Kind, string> = { trend: '#2962ff', ray: '#2962ff', hline: '#b84fd6', vline: '#b84fd6', rect: '#ff9800', fib: '#8c8c8c', channel: '#26a69a', text: '#dbdbdb' };
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86'];
const NS = 'http://www.w3.org/2000/svg';

interface Ctx { chart: IChartApi; candles: ISeriesApi<'Candlestick'>; getBars: () => Bar[]; wrap: HTMLElement }

export function initDrawings({ chart, candles, getBars, wrap }: Ctx) {
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'draw-layer';
  wrap.appendChild(svg);

  let tool: Tool = 'cross';
  let key = '';
  let items: Drawing[] = [];
  let pending: Pt[] = [];
  let hover: Pt | null = null;
  let ruler: Pt[] | null = null;
  let selected: string | null = null;
  let hidden = false;
  let locked = false;
  let magnet = false;
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
  const x = (t: number) => { const l = logicalFromTime(t); return l == null ? null : ts().logicalToCoordinate(l as Logical); };
  const y = (p: number) => candles.priceToCoordinate(p);
  function ptFromXY(px: number, py: number): Pt | null {
    const bars = getBars();
    const l = ts().coordinateToLogical(px);
    const p = candles.coordinateToPrice(py);
    if (l == null || p == null || !bars.length) return null;
    let t = timeFromLogical(Math.round(l));
    let price: number = p;
    if (magnet) {
      const b = bars[Math.max(0, Math.min(bars.length - 1, Math.round(l)))];
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
  function el(tag: string, attrs: Record<string, string | number>, parent: Element = svg) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  }
  const fmtP = (p: number) => (Math.abs(p) >= 1 ? p.toFixed(2) : p.toPrecision(4));
  function lineThrough(x1: number, y1: number, x2: number, y2: number, extendRight: boolean) {
    if (!extendRight || x2 === x1) return [x1, y1, x2, y2];
    const W = ts().width();
    const k = (y2 - y1) / (x2 - x1);
    const xe = x2 > x1 ? W : 0;
    return [x1, y1, xe, y1 + k * (xe - x1)];
  }
  function drawOne(d: Drawing, g: Element, preview = false) {
    const xs = d.pts.map((p) => x(p.t)), ys = d.pts.map((p) => y(p.p));
    if (xs.some((v) => v == null) || ys.some((v) => v == null)) return;
    const X = xs as number[], Y = ys as number[];
    const W = ts().width(), H = chart.paneSize().height;
    const stroke = { stroke: d.color, 'stroke-width': 1.5, fill: 'none' };
    const hit = (pts: string) => { if (!preview) el('polyline', { points: pts, class: 'hit' }, g); };
    switch (d.kind) {
      case 'trend': case 'ray': {
        const [a, b, c, e] = lineThrough(X[0], Y[0], X[1] ?? X[0], Y[1] ?? Y[0], d.kind === 'ray');
        el('line', { x1: a, y1: b, x2: c, y2: e, ...stroke }, g); hit(`${a},${b} ${c},${e}`); break;
      }
      case 'hline':
        el('line', { x1: 0, y1: Y[0], x2: W, y2: Y[0], ...stroke }, g); hit(`0,${Y[0]} ${W},${Y[0]}`);
        el('text', { x: W - 60, y: Y[0] - 4, fill: d.color, 'font-size': 11 }, g).textContent = fmtP(d.pts[0].p); break;
      case 'vline':
        el('line', { x1: X[0], y1: 0, x2: X[0], y2: H, ...stroke }, g); hit(`${X[0]},0 ${X[0]},${H}`); break;
      case 'rect': {
        const [x1, x2] = [Math.min(X[0], X[1] ?? X[0]), Math.max(X[0], X[1] ?? X[0])];
        const [y1, y2] = [Math.min(Y[0], Y[1] ?? Y[0]), Math.max(Y[0], Y[1] ?? Y[0])];
        el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, stroke: d.color, 'stroke-width': 1.5, fill: d.color, 'fill-opacity': 0.15 }, g);
        hit(`${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2} ${x1},${y1}`); break;
      }
      case 'fib': {
        if (d.pts.length < 2) break;
        const [x1, x2] = [Math.min(X[0], X[1]), Math.max(X[0], X[1])];
        FIB.forEach((lv, i) => {
          const price = d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv;
          const yy = y(price);
          if (yy == null) return;
          el('line', { x1, y1: yy, x2, y2: yy, stroke: FIB_COLORS[i], 'stroke-width': 1 }, g);
          el('text', { x: x1 + 4, y: yy - 3, fill: FIB_COLORS[i], 'font-size': 11 }, g).textContent = `${lv} (${fmtP(price)})`;
        });
        el('line', { x1: X[0], y1: Y[0], x2: X[1], y2: Y[1], stroke: '#787b86', 'stroke-dasharray': '4 4' }, g);
        hit(`${x1},${Y[0]} ${x2},${Y[0]} ${x2},${Y[1]} ${x1},${Y[1]} ${x1},${Y[0]}`); break;
      }
      case 'channel': {
        if (d.pts.length < 2) { el('line', { x1: X[0], y1: Y[0], x2: X[0], y2: Y[0], ...stroke }, g); break; }
        const off = d.pts.length > 2 ? (Y[2] - (Y[0] + (Y[1] - Y[0]) * ((X[2] - X[0]) / ((X[1] - X[0]) || 1)))) : 0;
        el('polygon', { points: `${X[0]},${Y[0]} ${X[1]},${Y[1]} ${X[1]},${Y[1] + off} ${X[0]},${Y[0] + off}`, fill: d.color, 'fill-opacity': 0.12 }, g);
        el('line', { x1: X[0], y1: Y[0], x2: X[1], y2: Y[1], ...stroke }, g);
        el('line', { x1: X[0], y1: Y[0] + off, x2: X[1], y2: Y[1] + off, ...stroke }, g);
        el('line', { x1: X[0], y1: Y[0] + off / 2, x2: X[1], y2: Y[1] + off / 2, stroke: d.color, 'stroke-dasharray': '4 4' }, g);
        hit(`${X[0]},${Y[0]} ${X[1]},${Y[1]} ${X[1]},${Y[1] + off} ${X[0]},${Y[0] + off} ${X[0]},${Y[0]}`); break;
      }
      case 'text': {
        const t = el('text', { x: X[0], y: Y[0], fill: d.color, 'font-size': 14 }, g);
        t.textContent = d.text ?? '';
        if (!preview) t.setAttribute('class', 'hit-text'); break;
      }
    }
    if (!preview && d.id === selected && !locked) {
      d.pts.forEach((_, i) => el('circle', { cx: X[i], cy: Y[i], r: 5, class: 'handle', 'data-i': i, 'data-id': d.id }, g));
    }
  }
  function render() {
    svg.textContent = '';
    if (hidden && !ruler) return;
    if (!hidden) {
      for (const d of items) {
        const g = el('g', { 'data-id': d.id, class: d.id === selected ? 'sel' : '' });
        drawOne(d, g);
      }
      if (pending.length && hover && tool !== 'ruler' && tool !== 'cross') {
        drawOne({ id: '_', kind: tool as Kind, pts: [...pending, hover], color: COLORS[tool as Kind] }, el('g', {}), true);
      }
    }
    const r = ruler ?? (tool === 'ruler' && pending.length && hover ? [pending[0], hover] : null);
    if (r && r.length === 2) drawRuler(r);
  }
  function drawRuler([a, b]: Pt[]) {
    const xa = x(a.t), xb = x(b.t), ya = y(a.p), yb = y(b.p);
    if (xa == null || xb == null || ya == null || yb == null) return;
    const up = b.p >= a.p;
    const color = up ? '#2962ff' : '#f23645';
    el('rect', { x: Math.min(xa, xb), y: Math.min(ya, yb), width: Math.abs(xb - xa), height: Math.abs(yb - ya), fill: color, 'fill-opacity': 0.15, stroke: color });
    const bars = getBars();
    const la = logicalFromTime(a.t) ?? 0, lb = logicalFromTime(b.t) ?? 0;
    const nb = Math.round(lb - la);
    const secs = Math.abs(b.t - a.t);
    const dur = secs >= 86400 ? `${Math.round(secs / 86400)}d` : secs >= 3600 ? `${Math.round(secs / 3600)}h` : `${Math.round(secs / 60)}m`;
    const lines = [`${b.p - a.p >= 0 ? '+' : ''}${fmtP(b.p - a.p)} (${(((b.p - a.p) / a.p) * 100).toFixed(2)}%)`, `${nb} bars, ${dur}`];
    const bx = (xa + xb) / 2 - 70, by = up ? Math.min(ya, yb) - 46 : Math.max(ya, yb) + 6;
    el('rect', { x: bx, y: by, width: 140, height: 40, rx: 4, fill: color });
    lines.forEach((t, i) => (el('text', { x: bx + 70, y: by + 16 + i * 16, fill: '#fff', 'font-size': 12, 'text-anchor': 'middle' }).textContent = t));
    void bars;
  }

  // ---------- placing ----------
  // Native clicks rather than chart.subscribeClick: the chart swallows a quick second click as a double-click.
  let downAt: { x: number; y: number } | null = null;
  wrap.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }), true);
  wrap.addEventListener('click', (e) => {
    if (tool === 'cross' || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    if ((e.target as Element).closest('#legend, #replay-bar, #notice')) return;
    const r = wrap.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (px > ts().width() || py > chart.paneSize().height) return;
    placeAt(px, py);
  });
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
    if (pending.length >= NEEDS[tool]) {
      const kind = tool as Kind;
      const d: Drawing = { id: Math.random().toString(36).slice(2, 10), kind, pts: pending, color: COLORS[kind] };
      if (kind === 'text') {
        const t = window.prompt('Text');
        if (!t) { pending = []; render(); return; }
        d.text = t;
      }
      pending = [];
      commit(() => items.push(d));
      selected = d.id;
      setTool('cross');
    }
    render();
  }
  chart.subscribeCrosshairMove((param) => {
    if (tool === 'cross' || !param.point) { if (ruler || pending.length) render(); return; }
    hover = ptFromXY(param.point.x, param.point.y);
    render();
  });
  ts().subscribeVisibleLogicalRangeChange(() => render());
  new ResizeObserver(() => render()).observe(wrap);

  // ---------- select, drag, delete ----------
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
    const rect = wrap.getBoundingClientRect();
    const idx = handle ? Number(handle.getAttribute('data-i')) : -1;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      if (idx >= 0) {
        const p = ptFromXY(ev.clientX - rect.left, ev.clientY - rect.top);
        if (p) d.pts[idx] = p;
      } else {
        d.pts = orig.map((p) => {
          const px = (x(p.t) ?? 0) + ev.clientX - start.x, py = (y(p.p) ?? 0) + ev.clientY - start.y;
          return ptFromXY(px, py) ?? p;
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
  wrap.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element).closest('#draw-layer g[data-id]') && selected) { selected = null; render(); }
  }, true);
  window.addEventListener('keydown', (e) => {
    if (document.activeElement instanceof HTMLInputElement) return;
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
  });

  // ---------- toolbar ----------
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]')];
  function setTool(t: Tool) {
    tool = t;
    pending = [];
    hover = null;
    if (t !== 'ruler') ruler = null;
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    wrap.classList.toggle('drawing', t !== 'cross');
    render();
  }
  buttons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));
  const toggle = (id: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = document.getElementById(id)!;
    b.onclick = () => { set(!get()); b.classList.toggle('active', get()); render(); };
  };
  toggle('draw-magnet', () => magnet, (v) => (magnet = v));
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
  };
}
