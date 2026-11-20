import { avatar, icon } from './icons';
import { attachSearch, shortName } from './search';

interface WatchList { name: string; symbols: string[] } // entries starting with "###" are section headers
interface Data { active: number; lists: WatchList[] }
interface Quote { last: number | null; change: number | null; changePct: number | null; volume: number | null; prevClose: number | null;
  bid?: number | null; ask?: number | null; open?: number | null; high?: number | null; low?: number | null; high52?: number | null; low52?: number | null; avgVolume?: number | null }
interface NewsItem { time: number | null; provider: string; id: string; headline: string }
export interface Details { key: string; name: string; exchange: string; secType: string; currency: string; open: boolean | null; expiry?: string;
  industry?: string; category?: string; minTick?: number | null; multiplier?: string; localSymbol?: string }

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
  $('details').innerHTML = '<div class="d-main"></div><div class="d-news" hidden><div class="d-news-h">News</div><div class="d-news-list"></div></div>';
  const det = $('details').querySelector('.d-main') as HTMLElement; // re-rendered on every quote
  const newsBox = $('details').querySelector('.d-news') as HTMLElement; // rendered only when news changes
  function renderDetails() {
    if (!activeKey) { det.innerHTML = ''; newsBox.hidden = true; return; }
    newsBox.hidden = false;
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
      ${rangeBar("Day's range", q?.low, q?.high, q?.last)}
      ${rangeBar('52-week range', q?.low52, q?.high52, q?.last)}
      <div class="d-stats">
        <span>Prev close</span><span class="n">${price(q?.prevClose)}</span>
        <span>Open</span><span class="n">${price(q?.open)}</span>
        <span>Bid / Ask</span><span class="n">${q?.bid || q?.ask ? `${price(q?.bid)} / ${price(q?.ask)}` : '–'}</span>
        <span>Volume</span><span class="n">${vol(q?.volume) || '–'}</span>
        ${q?.avgVolume ? `<span>Avg volume</span><span class="n">${vol(q.avgVolume)}</span>` : ''}
        ${d?.secType === 'FUT' ? `<span>Contract</span><span class="n">${d.localSymbol ?? ''}</span><span>Multiplier</span><span class="n">${d.multiplier || '–'}</span><span>Tick size</span><span class="n">${d.minTick ?? '–'}</span>` : ''}
        ${d?.industry ? `<span>Sector</span><span class="n d-ind"></span>` : ''}
      </div>`;
    const ind = det.querySelector('.d-ind') as HTMLElement | null;
    if (ind && d) ind.textContent = d.category ? `${d.industry} · ${d.category}` : d.industry!;
    (det.querySelector('.sym') as HTMLElement).textContent = shortName(activeKey);
    (det.querySelector('.d-name') as HTMLElement).textContent = d ? `${d.name} · ${d.exchange}` : '';
    (det.querySelector('.d-type') as HTMLElement).textContent = d
      ? `${TYPE[d.secType] ?? d.secType}${d.secType === 'FUT' && d.expiry ? ` · front month ${d.expiry}` : ''}` : '';
  }
  function rangeBar(label: string, lo?: number | null, hi?: number | null, last?: number | null) {
    if (lo == null || hi == null || hi <= lo) return '';
    const pct = last == null ? 50 : Math.max(0, Math.min(100, ((last - lo) / (hi - lo)) * 100));
    return `<div class="d-range"><div class="d-range-h">${label}</div><div class="d-range-bar"><i style="left:${pct}%"></i></div>
      <div class="d-range-v"><span>${price(lo)}</span><span>${price(hi)}</span></div></div>`;
  }

  // ---------- news ----------
  let news: { key: string; items: NewsItem[]; providers: string[]; error?: string } | null = null;
  function renderNews() {
    const box = newsBox.querySelector('.d-news-list') as HTMLElement | null;
    if (!box) return;
    if (!news || news.key !== activeKey) { box.innerHTML = '<div class="d-news-empty">Loading…</div>'; return; }
    if (news.error) { box.innerHTML = `<div class="d-news-empty"></div>`; box.firstElementChild!.textContent = news.error; return; }
    if (!news.providers.length) { box.innerHTML = '<div class="d-news-empty">No news feeds on this IBKR account.</div>'; return; }
    if (!news.items.length) { box.innerHTML = '<div class="d-news-empty">No recent headlines for this symbol.</div>'; return; }
    box.innerHTML = '';
    for (const n of news.items.slice(0, 25)) {
      const row = document.createElement('button');
      row.className = 'd-news-row';
      const when = n.time ? new Date(n.time * 1000) : null;
      const t = when ? (Date.now() - when.getTime() < 86400e3 ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : when.toLocaleDateString([], { day: 'numeric', month: 'short' })) : '';
      row.innerHTML = '<span class="nt"></span><span class="nh"></span>';
      (row.firstElementChild as HTMLElement).textContent = `${t} · ${n.provider}`;
      (row.lastElementChild as HTMLElement).textContent = n.headline;
      row.onclick = () => openArticle(n);
      box.appendChild(row);
    }
  }
  async function loadNews(k: string) {
    try {
      const r = await fetch(`/api/news?key=${encodeURIComponent(k)}`);
      const j = await r.json();
      if (k !== activeKey) return;
      news = r.ok ? { key: k, items: j.items, providers: j.providers } : { key: k, items: [], providers: [], error: j.error };
    } catch { news = { key: k, items: [], providers: [], error: 'News unavailable' }; }
    renderNews();
  }
  const newsDlg = document.createElement('dialog');
  newsDlg.id = 'news-dlg';
  document.body.appendChild(newsDlg);
  newsDlg.addEventListener('click', (e) => { if (e.target === newsDlg) newsDlg.close(); });
  async function openArticle(n: NewsItem) {
    newsDlg.innerHTML = '<div class="nd-head"><b></b><button title="Close">×</button></div><div class="nd-meta"></div><div class="nd-body">Loading…</div>';
    (newsDlg.querySelector('b') as HTMLElement).textContent = n.headline;
    (newsDlg.querySelector('.nd-meta') as HTMLElement).textContent = `${n.provider}${n.time ? ' · ' + new Date(n.time * 1000).toLocaleString() : ''}`;
    newsDlg.querySelector('button')!.onclick = () => newsDlg.close();
    newsDlg.showModal();
    const body = newsDlg.querySelector('.nd-body') as HTMLElement;
    try {
      const r = await fetch(`/api/news/article?provider=${encodeURIComponent(n.provider)}&id=${encodeURIComponent(n.id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (j.type === 1) {
        body.innerHTML = `<a download="article.pdf" href="data:application/pdf;base64,${j.text}">Download article (PDF)</a>`;
      } else {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', ''); // provider HTML is shown without scripts
        f.srcdoc = `<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;color:#dbdbdb;background:#1e1e1e;margin:0}a{color:#6ea0ff}</style>${j.text}`;
        body.innerHTML = '';
        body.appendChild(f);
      }
    } catch (e) { body.textContent = (e as Error).message || 'Article not available'; }
  }
  setInterval(() => { if (activeKey) loadNews(activeKey); }, 5 * 60_000);

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
      renderNews();
      loadNews(k);
    },
    resubscribe() { sendSymbols(); if (activeKey) { loadDetails(activeKey); loadNews(activeKey); } },
  };
}
