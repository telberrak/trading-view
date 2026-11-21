import { icon } from './icons';
import { listen, post, saveSyncOpts, syncOpts, type SyncOpts } from './sync';

/** Chart grid on the main page: 1, 2 side by side, 2 stacked or 4 charts, with sync options. */
export const LAYOUTS = { '1': 'One chart', '2v': 'Two side by side', '2h': 'Two stacked', '4': 'Four (2 × 2)' } as const;
export type LayoutId = keyof typeof LAYOUTS;
const COUNT: Record<LayoutId, number> = { '1': 1, '2v': 2, '2h': 2, '4': 4 };

export function initMultiChart(onLayout: () => void) {
  const grid = document.getElementById('grid')!;
  const main = document.getElementById('chart-wrap')!;
  const btn = document.getElementById('layout-btn')!;
  const menu = document.getElementById('layout-menu')!;
  let layout: LayoutId = (() => { try { return (JSON.parse(localStorage.getItem('layout') || '"1"') as LayoutId); } catch { return '1'; } })();
  if (!(layout in LAYOUTS)) layout = '1';
  let active = 0;
  const frames: HTMLIFrameElement[] = [];

  function apply() {
    const n = COUNT[layout];
    grid.className = `l${layout}`;
    while (frames.length > n - 1) frames.pop()!.remove();
    while (frames.length < n - 1) {
      const f = document.createElement('iframe');
      f.className = 'cell';
      f.src = `/?embed=${frames.length + 1}`;
      f.title = `Chart ${frames.length + 2}`;
      grid.appendChild(f);
      frames.push(f);
    }
    if (active >= n) setActive(0);
    mark();
    btn.innerHTML = icon(`layout-${layout}`);
    onLayout();
  }
  function mark() {
    const multi = frames.length > 0;
    main.classList.toggle('active', multi && active === 0);
    frames.forEach((f, i) => f.classList.toggle('active', active === i + 1));
  }
  function setActive(i: number) { active = i; mark(); }
  main.addEventListener('pointerdown', () => setActive(0), true);
  listen((m) => { if (m.type === 'focus') setActive(m.from); });

  function render() {
    const s = syncOpts();
    menu.innerHTML = '<div class="hint">Layout</div>';
    const row = document.createElement('div');
    row.className = 'lay-row';
    for (const [id, name] of Object.entries(LAYOUTS)) {
      const b = document.createElement('button');
      b.className = `lay-opt${id === layout ? ' on' : ''}`;
      b.title = name;
      b.innerHTML = icon(`layout-${id}`, 22);
      b.onclick = (e) => { e.stopPropagation(); layout = id as LayoutId; try { localStorage.setItem('layout', JSON.stringify(layout)); } catch { /* ignore */ } apply(); render(); };
      row.appendChild(b);
    }
    menu.appendChild(row);
    const h = document.createElement('div');
    h.className = 'hint'; h.textContent = 'Sync across charts';
    menu.appendChild(h);
    const opts: [keyof SyncOpts, string][] = [['symbol', 'Symbol'], ['interval', 'Interval'], ['crosshair', 'Crosshair']];
    for (const [k, name] of opts) {
      const b = document.createElement('label');
      b.className = 'chk';
      b.innerHTML = `<input type="checkbox" ${s[k] ? 'checked' : ''} /><span>${name}</span>`;
      b.querySelector('input')!.onchange = (e) => { const o = syncOpts(); o[k] = (e.target as HTMLInputElement).checked; saveSyncOpts(o); };
      menu.appendChild(b);
    }
    extra.forEach((f) => f(menu));
  }
  const extra: ((menu: HTMLElement) => void)[] = [];
  btn.onclick = (e) => { e.stopPropagation(); if (menu.hidden) render(); menu.hidden = !menu.hidden; };
  menu.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => { menu.hidden = true; });
  apply();

  return {
    /** Which chart the watchlist, screener and alerts send symbols to. */
    get active() { return active; },
    get layout() { return layout; },
    count: () => COUNT[layout],
    setLayout(l: LayoutId) { layout = l in LAYOUTS ? l : '1'; try { localStorage.setItem('layout', JSON.stringify(layout)); } catch { /* ignore */ } apply(); },
    /** Open `key` in the active chart; returns true when another chart took it. */
    route(key: string): boolean {
      if (active === 0 || !frames.length) return false;
      post({ type: 'setSymbol', from: 0, to: active, key });
      return true;
    },
    reloadFrames() { frames.forEach((f) => f.contentWindow?.location.reload()); },
    addMenuSection(f: (menu: HTMLElement) => void) { extra.push(f); },
    closeMenu() { menu.hidden = true; },
  };
}
