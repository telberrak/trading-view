import { LineStyle, type IPriceLine, type ISeriesApi } from 'lightweight-charts';
import { avatar } from './icons';
import { shortName } from './search';

export interface Alert {
  id: string; key: string; condition: 'crossing' | 'above' | 'below'; price: number; message: string;
  active: boolean; created: number; triggeredAt: number | null; lastPrice?: number;
}
interface Ctx { getKey: () => string; getLast: () => number | null; candles: ISeriesApi<'Candlestick'>; onPick: (k: string) => void }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const COND: Record<Alert['condition'], string> = { crossing: 'Crossing', above: 'Greater than', below: 'Less than' };

export function initAlerts(ctx: Ctx) {
  let alerts: Alert[] = [];
  let lines: IPriceLine[] = [];

  // ---------- events socket ----------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'alerts') { alerts = m.alerts; render(); }
      else if (m.type === 'alert') fire(m.alert as Alert, m.text as string);
    };
    ws.onclose = () => setTimeout(connect, 2000);
  }

  // ---------- firing: toast + sound + browser notification ----------
  function beep() {
    try {
      const ac = new AudioContext();
      [0, 0.18, 0.36].forEach((t) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.15, ac.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.15);
        o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.16);
      });
    } catch { /* no audio */ }
  }
  function fire(a: Alert, text: string) {
    beep();
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<div class="toast-head">${avatar(shortName(a.key))}<b></b><span class="spacer"></span><button title="Close">×</button></div><div class="toast-body"></div>`;
    (t.querySelector('b') as HTMLElement).textContent = `Alert on ${shortName(a.key)}`;
    (t.querySelector('.toast-body') as HTMLElement).textContent = text;
    (t.querySelector('button') as HTMLElement).onclick = (e) => { e.stopPropagation(); t.remove(); };
    t.onclick = () => { ctx.onPick(a.key); t.remove(); };
    $('toasts').appendChild(t);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(`Alert on ${shortName(a.key)}`, { body: text });
    }
  }

  // ---------- list panel ----------
  function render() {
    const box = $('alert-rows');
    box.innerHTML = '';
    const sorted = [...alerts].sort((x, y) => Number(y.active) - Number(x.active) || y.created - x.created);
    if (!sorted.length) box.innerHTML = '<div class="empty">No alerts yet. Press Alt+A or the Alert button to create one.</div>';
    for (const a of sorted) {
      const row = document.createElement('div');
      row.className = 'al-row' + (a.active ? '' : ' done');
      const when = a.triggeredAt ? `Triggered ${new Date(a.triggeredAt * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Active';
      row.innerHTML = `${avatar(shortName(a.key))}<div class="al-main"><div class="al-t"></div><div class="al-s"></div></div>
        <button class="al-btn restart" title="Restart">↻</button><button class="al-btn del" title="Delete">×</button>`;
      (row.querySelector('.al-t') as HTMLElement).textContent = `${shortName(a.key)} ${COND[a.condition]} ${a.price}`;
      (row.querySelector('.al-s') as HTMLElement).textContent = a.message ? `${when} · ${a.message}` : when;
      (row.querySelector('.restart') as HTMLElement).hidden = a.active;
      (row.querySelector('.restart') as HTMLElement).onclick = (e) => { e.stopPropagation(); patch(a.id, { active: true }); };
      (row.querySelector('.del') as HTMLElement).onclick = (e) => { e.stopPropagation(); del(a.id); };
      row.onclick = () => ctx.onPick(a.key);
      box.appendChild(row);
    }
    const n = alerts.filter((a) => a.active).length;
    $('rail-al').dataset.badge = n ? String(n) : '';
    refreshLines();
  }
  function refreshLines() {
    lines.forEach((l) => ctx.candles.removePriceLine(l));
    lines = alerts.filter((a) => a.active && a.key === ctx.getKey()).map((a) =>
      ctx.candles.createPriceLine({ price: a.price, color: '#f7a600', lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: 'Alert' }));
  }

  // ---------- API ----------
  const json = { 'Content-Type': 'application/json' };
  const patch = (id: string, body: object) => fetch(`/api/alerts/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) });
  const del = (id: string) => fetch(`/api/alerts/${id}`, { method: 'DELETE' });

  // ---------- create dialog ----------
  const dlg = $<HTMLDialogElement>('alert-dlg');
  function open() {
    const last = ctx.getLast();
    $('al-sym').textContent = shortName(ctx.getKey());
    $<HTMLInputElement>('al-price').value = last == null ? '' : String(Number(last.toPrecision(8)));
    $<HTMLInputElement>('al-msg').value = '';
    $('al-err').textContent = '';
    dlg.showModal();
    $<HTMLInputElement>('al-price').select();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
  $('al-cancel').onclick = () => dlg.close();
  $('al-form').onsubmit = async (e) => {
    e.preventDefault();
    const price = Number($<HTMLInputElement>('al-price').value);
    if (!(price > 0)) { $('al-err').textContent = 'Enter a price'; return; }
    const r = await fetch('/api/alerts', { method: 'POST', headers: json, body: JSON.stringify({
      key: ctx.getKey(), price, condition: $<HTMLSelectElement>('al-cond').value, message: $<HTMLInputElement>('al-msg').value,
    }) });
    if (r.ok) dlg.close(); else $('al-err').textContent = (await r.json()).error ?? 'Could not create alert';
  };
  $('alert-btn').onclick = open;
  $('al-new').onclick = open;
  window.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'a' || e.code === 'KeyA')) { e.preventDefault(); open(); } });

  connect();
  return { refreshLines, open };
}
