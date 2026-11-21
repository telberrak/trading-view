/**
 * Resizable right sidebar: drag its left edge to change the width, and drag the bars between
 * watchlist / details / trading / alerts to change their heights. Sizes are remembered.
 */
const SECTIONS = ['watchlist', 'details', 'trading', 'alerts'];
const MIN_H = 70;
const DEFAULT_H: Record<string, number> = { details: 330, trading: 240, alerts: 200 };

function load<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export function initSideLayout() {
  const side = document.getElementById('side')!;
  const sizes: Record<string, number> = load('sideSizes', {});

  // ---------- width ----------
  const vsplit = document.createElement('div');
  vsplit.id = 'side-split';
  vsplit.title = 'Drag to resize';
  side.parentElement!.insertBefore(vsplit, side);
  const width = load('sideWidth', 350);
  side.style.width = `${width}px`;
  drag(vsplit, 'col-resize', () => side.offsetWidth, (start, dx) => {
    const w = Math.max(240, Math.min(window.innerWidth * 0.6, start - dx));
    side.style.width = `${w}px`;
    return w;
  }, (w) => save('sideWidth', Math.round(w)));
  vsplit.ondblclick = () => { side.style.width = '350px'; save('sideWidth', 350); };

  // ---------- heights ----------
  function layout() {
    side.querySelectorAll('.split-h').forEach((s) => s.remove());
    vsplit.hidden = side.classList.contains('hidden');
    const vis = SECTIONS.map((id) => document.getElementById(id)!).filter((s) => !s.classList.contains('hidden'));
    vis.forEach((sec, i) => {
      // The top visible panel takes the leftover space; the others keep their dragged size but may
      // shrink when another panel opens, so the top one never collapses.
      sec.style.minHeight = i === 0 ? '110px' : '0';
      if (i === 0) { sec.style.flex = '1 1 0'; return; }
      const h = sizes[sec.id] ?? DEFAULT_H[sec.id];
      sec.style.flex = `0 1 ${h}px`;
      const bar = document.createElement('div');
      bar.className = 'split-h';
      bar.title = 'Drag to resize';
      side.insertBefore(bar, sec);
      const above = vis[i - 1];
      drag(bar, 'row-resize', () => [above.offsetHeight, sec.offsetHeight], ([ha, hb], _dx, dy) => {
        const total = ha + hb;
        const nb = Math.max(MIN_H, Math.min(total - MIN_H, hb - dy));
        sec.style.flex = `0 1 ${nb}px`;
        if (i - 1 > 0) above.style.flex = `0 1 ${total - nb}px`; // the top panel keeps flexing
        return [total - nb, nb];
      }, ([na, nb]) => {
        sizes[sec.id] = Math.round(nb);
        if (i - 1 > 0) sizes[above.id] = Math.round(na);
        save('sideSizes', sizes);
      });
      bar.ondblclick = () => { delete sizes[sec.id]; save('sideSizes', sizes); layout(); };
    });
  }
  layout();
  return { layout };
}

function drag<S, R>(handle: HTMLElement, cursor: string, start: () => S, move: (s: S, dx: number, dy: number) => R, end: (r: R) => void) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const s = start();
    const x0 = e.clientX, y0 = e.clientY;
    let last: R | undefined;
    document.body.style.cursor = cursor;
    document.body.classList.add('resizing');
    handle.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const mv = (ev: PointerEvent) => { last = move(s, ev.clientX - x0, ev.clientY - y0); };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      document.body.style.cursor = '';
      document.body.classList.remove('resizing');
      handle.classList.remove('dragging');
      if (last !== undefined) end(last);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  });
}
