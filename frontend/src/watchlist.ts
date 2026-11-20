import { avatar, icon } from './icons';
import { attachSearch, shortName } from './search';

interface WatchList { name: string; symbols: string[] } // entries starting with "###" are section headers
interface Data { active: number; lists: WatchList[] }
interface Quote { last: number | null; change: number | null; changePct: number | null; volume: number | null; prevClose: number | null }
export interface Details { key: string; name: string; exchange: string; secType: string; currency: string; open: boolean | null; expiry?: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SEC = '###';
const isSec = (s: string) => s.startsWith(SEC);
const price = (v: number | null | undefined) =>
  v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: Math.abs(v) < 1 && v !== 0 && Math.abs(v) < 0.1 ? 4 : 2, maximumFractionDigits: Math.abs(v) < 0.1 && v !== 0 ? 4 : 2 });
const vol = (v: number | null | undefined) => {
  if (v == null) return '';
  const u: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [n, s] of u) if (v >= n) return (v / n).toFixed(2) + s;
  return String(Math.round(v));
};
const TYPE: Record<string, string> = { STK: 'Stock', FUT: 'Futures', CRYPTO: 'Crypto' };

export function initWatchlist(onPick: (key: string) => void, onDetails: (d: Details) => void) {
  let data: Data = { active: 0, lists: [{ name: 'Watchlist', symbols: [] }] };
  let activeKey = '';
  let details: Details | null = null;
  const quotes = new Map<string, Quote>();
  const collapsed = new Set<string>(JSON.parse(localStorage.getItem('wlCollapsed') || '[]'));
  const list = () => data.lists[data.active];
  const symbolsOnly = () => (list()?.symbols ?? []).filter((s) => !isSec(s));

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
        if (k === activeKey) renderDetails();
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
  }
  function sendSymbols() {
    const keys = [...new Set([...symbolsOnly(), ...(activeKey ? [activeKey] : [])])];
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'symbols', keys }));
  }

  // ---------- watchlist rendering ----------
  const rows = $('wl-rows');
  const select = $<HTMLSelectElement>('wl-select');
  function render() {
    select.innerHTML = '';
    data.lists.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = l.name;
      select.appendChild(o);
    });
    select.value = String(data.active);
    rows.innerHTML = '';
    let section = '';
    for (const k of list()?.symbols ?? []) {
      if (isSec(k)) {
        section = `${data.active}:${k}`;
        const sec = document.createElement('div');
        sec.className = 'wl-sec' + (collapsed.has(section) ? ' collapsed' : '');
        sec.dataset.key = k;
        sec.draggable = true;
        sec.innerHTML = `<span class="ico">${icon('chevron', 14)}</span><span class="t"></span><span class="spacer"></span><span class="x" title="Remove section">×</span>`;
        (sec.querySelector('.t') as HTMLElement).textContent = k.slice(SEC.length);
        const id = section;
        sec.onclick = (e) => {
          if ((e.target as HTMLElement).classList.contains('x')) { remove(k); return; }
          if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
          localStorage.setItem('wlCollapsed', JSON.stringify([...collapsed]));
          render();
        };
        dnd(sec, k);
        rows.appendChild(sec);
        continue;
      }
      if (section && collapsed.has(section)) continue;
      const row = document.createElement('div');
      row.className = 'wl-row' + (k === activeKey ? ' active' : '');
      row.dataset.key = k;
      row.draggable = true;
      row.title = k;
      row.innerHTML = `<span class="s">${avatar(shortName(k))}<span class="name"></span><span class="x" title="Remove">×</span></span>`
        + '<span class="n last"></span><span class="n pct"></span><span class="n vol"></span>';
      (row.querySelector('.name') as HTMLElement).textContent = shortName(k);
      row.onclick = (e) => { if ((e.target as HTMLElement).classList.contains('x')) remove(k); else onPick(k); };
      dnd(row, k);
      rows.appendChild(row);
      updateRow(k, null);
    }
  }
  function dnd(node: HTMLElement, k: string) {
    node.ondragstart = (e) => e.dataTransfer?.setData('text/plain', k);
    node.ondragover = (e) => e.preventDefault();
    node.ondrop = (e) => { e.preventDefault(); move(e.dataTransfer?.getData('text/plain') ?? '', k); };
  }
  function updateRow(k: string, prevLast: number | null) {
    const row = rows.querySelector<HTMLElement>(`.wl-row[data-key="${CSS.escape(k)}"]`);
    if (!row) return;
    const q = quotes.get(k);
    const dir = q?.change == null ? '' : q.change >= 0 ? 'up' : 'down';
    const last = row.querySelector('.last')!;
    last.textContent = price(q?.last);
    last.className = `n last ${dir}`;
    const pct = row.querySelector('.pct')!;
    pct.textContent = q?.changePct == null ? '–' : `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
    pct.className = `n pct ${dir}`;
    row.querySelector('.vol')!.textContent = vol(q?.volume);
    if (prevLast != null && q?.last != null && q.last !== prevLast) {
      last.classList.remove('flash-up', 'flash-down');
      void (last as HTMLElement).offsetWidth;
      last.classList.add(q.last > prevLast ? 'flash-up' : 'flash-down');
    }
  }

  // ---------- symbol details panel ----------
  const det = $('details');
  function renderDetails() {
    if (!activeKey) { det.innerHTML = ''; return; }
    const q = quotes.get(activeKey);
    const d = details?.key === activeKey ? details : null;
    const dir = q?.change == null ? '' : q.change >= 0 ? 'up' : 'down';
    const sign = (v: number) => (v >= 0 ? '+' : '');
    det.innerHTML = `
      <div class="d-head">${avatar(shortName(activeKey), 24)}<span class="sym"></span></div>
      <div class="d-name"></div>
      <div class="d-type"></div>
      <div class="d-price"><span class="big ${dir}">${price(q?.last)}</span><span class="cur">${d?.currency ?? ''}</span>
        <span class="chg ${dir}">${q?.change == null ? '' : `${sign(q.change)}${price(q.change)}&nbsp;&nbsp;${sign(q.changePct!)}${q.changePct!.toFixed(2)}%`}</span></div>
      ${d?.open == null ? '' : `<div class="d-status ${d.open ? 'open' : 'closed'}">${d.open ? 'Market open' : 'Market closed'}</div>`}
      <div class="d-stats"><span>Prev close</span><span class="n">${price(q?.prevClose)}</span>
        <span>Volume</span><span class="n">${vol(q?.volume) || '–'}</span></div>`;
    (det.querySelector('.sym') as HTMLElement).textContent = shortName(activeKey);
    (det.querySelector('.d-name') as HTMLElement).textContent = d ? `${d.name} · ${d.exchange}` : '';
    (det.querySelector('.d-type') as HTMLElement).textContent = d
      ? `${TYPE[d.secType] ?? d.secType}${d.secType === 'FUT' && d.expiry ? ` · front month ${d.expiry}` : ''}` : '';
  }
  async function loadDetails(k: string) {
    try {
      const r = await fetch(`/api/details?key=${encodeURIComponent(k)}`);
      if (!r.ok) return;
      const d = (await r.json()) as Details;
      if (d.key !== activeKey) return;
      details = d;
      renderDetails();
      onDetails(d);
    } catch { /* offline */ }
  }
  setInterval(() => { if (activeKey) loadDetails(activeKey); }, 60_000); // keep open/closed fresh

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
  const addBox = document.querySelector<HTMLElement>('.wl-search')!;
  const addInput = $<HTMLInputElement>('wl-add');
  $('wl-plus').onclick = () => { addBox.hidden = !addBox.hidden; if (!addBox.hidden) addInput.focus(); };
  attachSearch(addInput, $<HTMLUListElement>('wl-results'), (k) => { add(k); addInput.value = ''; addBox.hidden = true; });

  const menu = $('wl-menu');
  $('wl-more').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  const file = $<HTMLInputElement>('wl-file');
  menu.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
    menu.hidden = true;
    const act = b.dataset.act;
    if (act === 'section') {
      const name = window.prompt('Section name (e.g. MAJORS)');
      if (name) { list().symbols.push(SEC + name.toUpperCase()); changed(); }
    } else if (act === 'new') {
      const name = window.prompt('New watchlist name');
      if (name) { data.lists.push({ name, symbols: [] }); data.active = data.lists.length - 1; changed(); }
    } else if (act === 'rename') {
      const name = window.prompt('Rename watchlist', list().name);
      if (name) { list().name = name; changed(); }
    } else if (act === 'import') {
      file.click();
    } else if (act === 'delete') {
      if (data.lists.length > 1 && window.confirm(`Delete "${list().name}"?`)) { data.lists.splice(data.active, 1); data.active = 0; changed(); }
    }
  }));
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

  // Up/Down arrows step through the watchlist like TradingView
  window.addEventListener('keydown', (e) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const s = symbolsOnly();
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
      sendSymbols();
      renderDetails();
      loadDetails(k);
    },
    resubscribe() { sendSymbols(); if (activeKey) loadDetails(activeKey); },
  };
}
