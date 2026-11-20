import { attachSearch, shortName } from './search';

interface WatchList { name: string; symbols: string[] }
interface Data { active: number; lists: WatchList[] }
interface Quote { last: number | null; change: number | null; changePct: number | null }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number | null | undefined, d = 2) => (v == null ? '–' : Math.abs(v) < 1 && v !== 0 ? v.toPrecision(4) : v.toFixed(d));

export function initWatchlist(onPick: (key: string) => void) {
  let data: Data = { active: 0, lists: [{ name: 'Watchlist', symbols: [] }] };
  let activeKey = '';
  const quotes = new Map<string, Quote>();
  const list = () => data.lists[data.active];

  // ---------- persistence ----------
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      fetch('/api/watchlists', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .catch(() => undefined);
    }, 300);
  }
  async function loadData() {
    try {
      const r = await fetch('/api/watchlists');
      if (r.ok) data = await r.json();
    } catch { /* keep default */ }
    render();
    sendSymbols();
  }

  // ---------- quotes socket ----------
  let ws: WebSocket | null = null;
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/quotes`);
    ws.onopen = sendSymbols;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type !== 'quotes') return;
      for (const [k, q] of Object.entries(m.data as Record<string, Quote>)) {
        const prev = quotes.get(k);
        quotes.set(k, q);
        updateRow(k, prev?.last ?? null);
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
  }
  function sendSymbols() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'symbols', keys: list()?.symbols ?? [] }));
  }

  // ---------- rendering ----------
  const rows = $('wl-rows');
  const select = $<HTMLSelectElement>('wl-select');
  function render() {
    select.innerHTML = '';
    data.lists.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${l.name} (${l.symbols.length})`;
      select.appendChild(o);
    });
    select.value = String(data.active);
    rows.innerHTML = '';
    for (const k of list()?.symbols ?? []) {
      const row = document.createElement('div');
      row.className = 'wl-row' + (k === activeKey ? ' active' : '');
      row.dataset.key = k;
      row.draggable = true;
      row.innerHTML = '<span class="s"></span><span class="n last"></span><span class="n chg"></span><span class="n pct"></span><button class="x" title="Remove">×</button>';
      (row.querySelector('.s') as HTMLElement).textContent = shortName(k);
      row.title = k;
      row.onclick = (e) => { if (!(e.target as HTMLElement).classList.contains('x')) onPick(k); };
      (row.querySelector('.x') as HTMLElement).onclick = () => remove(k);
      row.ondragstart = (e) => e.dataTransfer?.setData('text/plain', k);
      row.ondragover = (e) => e.preventDefault();
      row.ondrop = (e) => { e.preventDefault(); move(e.dataTransfer?.getData('text/plain') ?? '', k); };
      rows.appendChild(row);
      updateRow(k, null);
    }
  }
  function updateRow(k: string, prevLast: number | null) {
    const row = rows.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`);
    if (!row) return;
    const q = quotes.get(k);
    const dir = q?.change == null ? '' : q.change >= 0 ? 'up' : 'down';
    row.querySelector('.last')!.textContent = fmt(q?.last);
    const chg = row.querySelector('.chg')!, pct = row.querySelector('.pct')!;
    chg.textContent = q?.change == null ? '–' : (q.change >= 0 ? '+' : '') + q.change.toFixed(2);
    pct.textContent = q?.changePct == null ? '–' : (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%';
    chg.className = `n chg ${dir}`;
    pct.className = `n pct ${dir}`;
    if (prevLast != null && q?.last != null && q.last !== prevLast) {
      const last = row.querySelector('.last')!;
      last.classList.remove('flash-up', 'flash-down');
      void (last as HTMLElement).offsetWidth;
      last.classList.add(q.last > prevLast ? 'flash-up' : 'flash-down');
    }
  }

  // ---------- edits ----------
  function changed() { render(); sendSymbols(); persist(); }
  function add(k: string) {
    k = k.toUpperCase();
    if (!list().symbols.includes(k)) list().symbols.push(k);
    changed();
    onPick(k);
  }
  function remove(k: string) { list().symbols = list().symbols.filter((s) => s !== k); changed(); }
  function move(from: string, to: string) {
    const s = list().symbols;
    const i = s.indexOf(from), j = s.indexOf(to);
    if (i < 0 || j < 0 || i === j) return;
    s.splice(j, 0, ...s.splice(i, 1));
    changed();
  }

  select.onchange = () => { data.active = Number(select.value); changed(); };
  $('wl-new').onclick = () => {
    const name = window.prompt('New watchlist name');
    if (name) { data.lists.push({ name, symbols: [] }); data.active = data.lists.length - 1; changed(); }
  };
  $('wl-rename').onclick = () => {
    const name = window.prompt('Rename watchlist', list().name);
    if (name) { list().name = name; changed(); }
  };
  $('wl-delete').onclick = () => {
    if (data.lists.length > 1 && window.confirm(`Delete "${list().name}"?`)) {
      data.lists.splice(data.active, 1);
      data.active = 0;
      changed();
    }
  };
  const file = $<HTMLInputElement>('wl-file');
  $('wl-import').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    const r = await fetch('/api/watchlists/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name.replace(/\.[^.]+$/, ''), text: await f.text() }),
    });
    const body = await r.json();
    if (r.ok) { data = body; render(); sendSymbols(); } else window.alert(body.error ?? 'Import failed');
    file.value = '';
  };
  attachSearch($<HTMLInputElement>('wl-add'), $<HTMLUListElement>('wl-results'), add);

  // Up/Down arrows step through the watchlist like TradingView
  window.addEventListener('keydown', (e) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const s = list().symbols;
    if (!s.length) return;
    const i = s.indexOf(activeKey);
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, s.length - 1) : Math.max(i - 1, 0);
    if (s[next] && s[next] !== activeKey) onPick(s[next]);
    e.preventDefault();
  });

  loadData();
  connect();

  return {
    setActive(k: string) {
      activeKey = k;
      rows.querySelectorAll<HTMLElement>('.wl-row').forEach((r) => r.classList.toggle('active', r.dataset.key === k));
    },
    resubscribe: sendSymbols,
  };
}
