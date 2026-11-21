import { avatar } from './icons';
import { compact } from './footprint';

/**
 * Screener drawer under the charts, driven by IBKR's market scanner: pick a scan (top gainers, most
 * active, near 52-week high…), a market and filters; up to 50 results. Click a row to chart it.
 */
interface Row { rank: number; symbol: string; name: string; exchange: string; key: string; last?: number | null; change?: number | null; volume?: number | null }
type Sort = { col: keyof Row; dir: 1 | -1 };
const FILTERS: [string, string][] = [
  ['priceAbove', 'Price ≥'], ['priceBelow', 'Price ≤'], ['changeAbove', 'Chg% ≥'], ['changeBelow', 'Chg% ≤'],
  ['volumeAbove', 'Volume ≥'], ['avgVolumeAbove', 'Avg vol ≥'], ['mktCapAbove', 'Mkt cap ≥ $M'], ['mktCapBelow', 'Mkt cap ≤ $M'],
];
const MARKET_NAMES: Record<string, string> = { US: 'US major', NASDAQ: 'NASDAQ', NYSE: 'NYSE', LSE: 'London (LSE)', EU: 'Europe' };

export function initScreener(onPick: (key: string) => void, onResize: () => void) {
  const box = document.getElementById('screener')!;
  const st = (() => { try { return JSON.parse(localStorage.getItem('screener') || '{}'); } catch { return {}; } })() as Record<string, string>;
  let rows: Row[] = [];
  let sort: Sort = { col: 'rank', dir: 1 };
  let timer = 0;
  let busy = false;

  box.innerHTML = `<div class="sc-resize" title="Drag to resize"></div>
    <div class="sc-bar">
      <b>Screener</b>
      <select data-f="scan" title="Scan"></select>
      <select data-f="market" title="Market"></select>
      ${FILTERS.map(([k, n]) => `<label class="sc-f">${n}<input data-f="${k}" type="number" step="any" /></label>`).join('')}
      <button class="sc-run primary">Scan</button>
      <label class="sc-auto"><input type="checkbox" data-auto /> every 60s</label>
      <span class="sc-msg"></span>
    </div>
    <div class="sc-table"><table><thead><tr>
      <th data-c="rank">#</th><th data-c="symbol">Symbol</th><th data-c="name">Name</th><th data-c="exchange">Exch</th>
      <th data-c="last" class="n">Last</th><th data-c="change" class="n">Chg %</th><th data-c="volume" class="n">Volume</th>
    </tr></thead><tbody></tbody></table></div>`;
  const q = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
  const msg = q('.sc-msg');

  fetch('/api/scanner').then((r) => r.json()).then((o: { scans: Record<string, string>; markets: string[] }) => {
    q<HTMLSelectElement>('[data-f="scan"]').innerHTML = Object.entries(o.scans).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
    q<HTMLSelectElement>('[data-f="market"]').innerHTML = o.markets.map((k) => `<option value="${k}">${MARKET_NAMES[k] ?? k}</option>`).join('');
    box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((i) => { if (st[i.dataset.f!] != null) i.value = st[i.dataset.f!]; });
  }).catch(() => { msg.textContent = 'Screener needs the backend.'; });

  function params() {
    const p: Record<string, string> = {};
    box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((i) => { if (i.value !== '') p[i.dataset.f!] = i.value; });
    try { localStorage.setItem('screener', JSON.stringify(p)); } catch { /* ignore */ }
    return p;
  }
  async function run() {
    if (busy) return;
    busy = true;
    msg.textContent = 'Scanning on IBKR…';
    try {
      const r = await fetch('/api/scanner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params()) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Scan failed');
      rows = d.rows;
      msg.textContent = `${rows.length} results · ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      render();
    } catch (e) {
      msg.textContent = (e as Error).message;
    } finally { busy = false; }
  }
  const fmt = (v: number | null | undefined, d = 2) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  function render() {
    const sorted = [...rows].sort((a, b) => {
      const x = a[sort.col], y = b[sort.col];
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
    const body = q('tbody');
    body.innerHTML = '';
    for (const r of sorted) {
      const tr = document.createElement('tr');
      const cls = r.change == null ? '' : r.change >= 0 ? 'up' : 'down';
      tr.innerHTML = `<td>${r.rank + 1}</td><td class="sym">${avatar(r.symbol, 16)}<span class="s"></span></td><td class="nm"></td><td></td>
        <td class="n">${fmt(r.last)}</td><td class="n ${cls}">${r.change == null ? '–' : `${r.change >= 0 ? '+' : ''}${fmt(r.change)}%`}</td>
        <td class="n">${r.volume == null ? '–' : compact(Math.round(r.volume))}</td>`;
      tr.children[1].querySelector(".s")!.textContent = r.symbol;
      tr.children[2].textContent = r.name;
      tr.children[3].textContent = r.exchange;
      tr.onclick = () => { body.querySelectorAll('tr').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel'); onPick(r.key); };
      body.appendChild(tr);
    }
    box.querySelectorAll<HTMLElement>('th').forEach((th) => th.classList.toggle('sorted', th.dataset.c === sort.col));
  }
  box.querySelectorAll<HTMLElement>('th').forEach((th) => (th.onclick = () => {
    const c = th.dataset.c as keyof Row;
    sort = sort.col === c ? { col: c, dir: (sort.dir * -1) as 1 | -1 } : { col: c, dir: c === 'rank' || c === 'symbol' || c === 'name' ? 1 : -1 };
    render();
  }));
  q('.sc-run').onclick = run;
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  q<HTMLInputElement>('[data-auto]').onchange = (e) => {
    clearInterval(timer);
    if ((e.target as HTMLInputElement).checked) { timer = window.setInterval(() => { if (!box.classList.contains('hidden')) run(); }, 60000); run(); }
  };
  // drag the top edge to resize
  const h0 = Number(localStorage.getItem('screenerH') || 300);
  box.style.height = `${h0}px`;
  q('.sc-resize').addEventListener('pointerdown', (e) => {
    const startY = e.clientY, startH = box.offsetHeight;
    const move = (ev: PointerEvent) => { box.style.height = `${Math.max(140, Math.min(window.innerHeight * 0.75, startH + startY - ev.clientY))}px`; onResize(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); try { localStorage.setItem('screenerH', String(box.offsetHeight)); } catch { /* ignore */ } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return { shown() { if (!rows.length) run(); } };
}
