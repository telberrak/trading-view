import { LineStyle, type IPriceLine, type ISeriesApi } from 'lightweight-charts';
import { avatar } from './icons';
import { shortName } from './search';
import type { PositionOrder } from './drawings';

/**
 * Buy/Sell through IBKR. Every order goes through a review screen showing the account (LIVE or PAPER)
 * before it is sent. Also: positions, open orders and fills panel, and their lines on the chart.
 */
interface OrderRow { orderId: number; account: string; symbol: string; secType: string; localSymbol: string; action: string; qty: number;
  type: string; lmtPrice: number | null; auxPrice: number | null; tif: string; status: string; filled: number | null; remaining: number | null;
  avgFillPrice: number | null; log: string[] }
interface Position { account: string; symbol: string; secType: string; localSymbol: string; position: number; avgPrice: number }
interface Fill { symbol: string; secType?: string; side: string; qty: number; price: number; time: number | null }
interface Account { accounts: string[]; paper: boolean; connected: boolean; orders: OrderRow[]; positions: Position[]; fills: Fill[] }

interface Ctx { getKey: () => string; getLast: () => number | null; candles: ISeriesApi<'Candlestick'>; onPick: (k: string) => void }

const $ = (id: string) => document.getElementById(id)!;
const fmt = (v: number | null | undefined) => (v == null ? '–' : Math.abs(v) >= 0.1 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toPrecision(4));
const ACTIVE = new Set(['PendingSubmit', 'PreSubmitted', 'Submitted', 'ApiPending', 'PendingCancel']);
const TYPE_NAME: Record<string, string> = { MKT: 'Market', LMT: 'Limit', STP: 'Stop', 'STP LMT': 'Stop limit' };

function parseKey(k: string) { const [sec, sym] = k.split(':'); return { sec: sec === 'CRYPTO' ? 'CRYPTO' : sec, sym }; }

export function initTrading(ctx: Ctx) {
  let acct: Account = { accounts: [], paper: false, connected: false, orders: [], positions: [], fills: [] };
  let lines: IPriceLine[] = [];
  const qtyStore = (k: string) => `qty:${parseKey(k).sec}`;

  // ---------- chart buttons ----------
  const bar = document.createElement('div');
  bar.id = 'trade-bar';
  bar.innerHTML = `<button class="sell"><small>SELL</small><b>–</b></button><input type="number" min="0" step="any" title="Quantity" /><button class="buy"><small>BUY</small><b>–</b></button>`;
  $('chart-wrap').appendChild(bar);
  const qtyIn = bar.querySelector('input')!;
  const [sellBtn, buyBtn] = [bar.querySelector<HTMLButtonElement>('.sell')!, bar.querySelector<HTMLButtonElement>('.buy')!];
  sellBtn.onclick = () => openTicket('SELL');
  buyBtn.onclick = () => openTicket('BUY');
  qtyIn.onchange = () => { try { localStorage.setItem(qtyStore(ctx.getKey()), qtyIn.value); } catch { /* ignore */ } };
  function syncQty() {
    const k = ctx.getKey();
    let v: string | null = null;
    try { v = localStorage.getItem(qtyStore(k)); } catch { /* ignore */ }
    qtyIn.value = v ?? (parseKey(k).sec === 'STK' ? '1' : parseKey(k).sec === 'CRYPTO' ? '0.001' : '1');
  }
  function tickPrices() {
    const last = ctx.getLast();
    sellBtn.querySelector('b')!.textContent = fmt(last);
    buyBtn.querySelector('b')!.textContent = fmt(last);
  }

  // ---------- ticket + review ----------
  const dlg = document.createElement('dialog');
  dlg.id = 'order-dlg';
  document.body.appendChild(dlg);
  let side: 'BUY' | 'SELL' = 'BUY';
  function openTicket(s: 'BUY' | 'SELL', price?: number) {
    side = s;
    const k = ctx.getKey();
    const { sec } = parseKey(k);
    const last = ctx.getLast();
    dlg.innerHTML = `
      <form id="ot-form">
        <div class="ot-sides"><button type="button" data-s="BUY">Buy</button><button type="button" data-s="SELL">Sell</button></div>
        <h3 class="ot-title"></h3>
        <label>Order type <select id="ot-type"><option value="MKT">Market</option><option value="LMT">Limit</option><option value="STP">Stop</option><option value="STP LMT">Stop limit</option></select></label>
        <label>Quantity${sec === 'FUT' ? ' (contracts)' : ''} <input id="ot-qty" type="number" min="0" step="any" required /></label>
        <label class="ot-lmt">Limit price <input id="ot-lmt" type="number" step="any" /></label>
        <label class="ot-stp">Stop price <input id="ot-stp" type="number" step="any" /></label>
        <label>Time in force <select id="ot-tif"><option>DAY</option><option>GTC</option></select></label>
        ${sec === 'STK' ? '<label class="ot-check"><input id="ot-rth" type="checkbox" /> Allow outside regular trading hours</label>' : ''}
        ${acct.accounts.length > 1 ? `<label>Account <select id="ot-acct">${acct.accounts.map((a) => `<option>${a}</option>`).join('')}</select></label>` : ''}
        <div id="ot-err" class="err"></div>
        <div class="dlg-btns"><button type="button" id="ot-cancel">Cancel</button><button type="submit" class="primary" id="ot-next">Review order</button></div>
      </form>`;
    const f = (id: string) => dlg.querySelector<HTMLInputElement>(`#${id}`)!;
    f('ot-qty').value = qtyIn.value;
    const typeSel = dlg.querySelector<HTMLSelectElement>('#ot-type')!;
    if (price != null) { typeSel.value = (side === 'BUY') === (price < (last ?? price)) ? 'LMT' : 'STP'; }
    const p0 = price ?? last;
    if (p0 != null) { f('ot-lmt').value = String(+p0.toPrecision(8)); f('ot-stp').value = String(+p0.toPrecision(8)); }
    const sync = () => {
      const t = typeSel.value;
      dlg.querySelector<HTMLElement>('.ot-lmt')!.hidden = !t.includes('LMT');
      dlg.querySelector<HTMLElement>('.ot-stp')!.hidden = !t.startsWith('STP');
      dlg.querySelectorAll<HTMLElement>('.ot-sides button').forEach((b) => b.classList.toggle('on', b.dataset.s === side));
      dlg.querySelector('.ot-title')!.textContent = `${side === 'BUY' ? 'Buy' : 'Sell'} ${shortName(k)}`;
      const nx = dlg.querySelector<HTMLElement>('#ot-next')!;
      nx.className = `primary ${side === 'BUY' ? 'buy' : 'sell'}`;
    };
    typeSel.onchange = sync;
    dlg.querySelectorAll<HTMLButtonElement>('.ot-sides button').forEach((b) => (b.onclick = () => { side = b.dataset.s as 'BUY' | 'SELL'; sync(); }));
    sync();
    $('ot-cancel').onclick = () => dlg.close();
    (dlg.querySelector('#ot-form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      const t = typeSel.value;
      const body = {
        key: k, action: side, qty: Number(f('ot-qty').value), type: t,
        lmtPrice: t.includes('LMT') ? Number(f('ot-lmt').value) : null,
        auxPrice: t.startsWith('STP') ? Number(f('ot-stp').value) : null,
        tif: dlg.querySelector<HTMLSelectElement>('#ot-tif')!.value,
        outsideRth: dlg.querySelector<HTMLInputElement>('#ot-rth')?.checked ?? false,
        account: dlg.querySelector<HTMLSelectElement>('#ot-acct')?.value ?? acct.accounts[0] ?? '',
      };
      const err = $('ot-err');
      if (!(body.qty > 0)) { err.textContent = 'Enter a quantity above zero.'; return; }
      if (body.lmtPrice !== null && !(body.lmtPrice > 0)) { err.textContent = 'Enter a limit price.'; return; }
      if (body.auxPrice !== null && !(body.auxPrice > 0)) { err.textContent = 'Enter a stop price.'; return; }
      qtyIn.value = String(body.qty); qtyIn.onchange?.(new Event('change'));
      review(body);
    };
    if (!dlg.open) dlg.showModal();
    f('ot-qty').focus();
  }

  /** From a long/short position drawing: entry (market, or limit at the drawn entry) with a take-profit and a stop-loss. */
  function openPosition(o: PositionOrder) {
    const k = ctx.getKey();
    const last = ctx.getLast();
    const action = o.long ? 'BUY' : 'SELL';
    const ok = (ref: number) => (o.long ? o.stop < ref && ref < o.target : o.target < ref && ref < o.stop);
    let problem = '';
    if (!ok(o.entry)) problem = o.long ? 'For a long, the stop must be below the entry and the target above it.' : 'For a short, the stop must be above the entry and the target below it.';
    else if (o.type === 'MKT' && last != null && !ok(last)) problem = `The price is ${fmt(last)}, already past the ${(o.long ? last <= o.stop : last >= o.stop) ? 'stop' : 'target'}. Move the drawing or use Limit.`;
    const body = {
      key: k, action, qty: Number(qtyIn.value), type: o.type, lmtPrice: o.type === 'LMT' ? o.entry : null, auxPrice: null,
      tif: 'DAY', outsideRth: false, account: acct.accounts[0] ?? '', takeProfit: o.target, stopLoss: o.stop,
    };
    review(body, problem);
  }

  function review(body: { key: string; action: string; qty: number; type: string; lmtPrice: number | null; auxPrice: number | null; tif: string; outsideRth: boolean; account: string; takeProfit?: number; stopLoss?: number }, problem = '') {
    const bracket = body.takeProfit != null && body.stopLoss != null;
    const { sec } = parseKey(body.key);
    const px = body.lmtPrice ?? body.auxPrice ?? ctx.getLast();
    const est = px != null && sec !== 'FUT' ? `≈ ${fmt(px * body.qty)} USD` : sec === 'FUT' ? 'Futures: margin per contract applies' : '';
    const priceTxt = body.type === 'MKT' ? 'at market' : body.type === 'LMT' ? `limit ${fmt(body.lmtPrice)}` : body.type === 'STP' ? `stop ${fmt(body.auxPrice)}` : `stop ${fmt(body.auxPrice)}, limit ${fmt(body.lmtPrice)}`;
    const live = !acct.paper;
    dlg.innerHTML = `
      <div class="ot-review">
        <div class="ot-acct ${live ? 'live' : 'paper'}">${live ? 'LIVE ACCOUNT' : 'PAPER ACCOUNT'} · ${body.account || '?'}</div>
        <h3>Confirm order</h3>
        <div class="ot-sum"><span class="side ${body.action === 'BUY' ? 'buy' : 'sell'}">${body.action}</span> <b>${body.qty}</b> ${avatar(shortName(body.key), 16)} <b>${shortName(body.key)}</b></div>
        <div class="ot-line">${TYPE_NAME[body.type]} order, ${priceTxt}, ${body.tif}${body.outsideRth ? ', outside RTH allowed' : ''}</div>
        ${bracket ? `<div class="ot-legs"><span>Entry</span><b>${body.type === 'MKT' ? `Market (now ${fmt(ctx.getLast())})` : `Limit ${fmt(body.lmtPrice)}`}</b>
          <span>Target</span><b class="up">Limit ${fmt(body.takeProfit)}</b><span>Stop</span><b class="down">Stop ${fmt(body.stopLoss)}</b>
          <span>Quantity</span><input id="ot-bqty" type="number" min="0" step="any" value="${body.qty}" />
          <span>Time in force</span><select id="ot-btif"><option>DAY</option><option>GTC</option></select></div>
          <div class="ot-line muted">Target and stop are sent with the entry and cancel each other when one fills.</div>` : ''}
        <div class="ot-line muted">${est}</div>
        ${live ? '<div class="ot-warn">This sends a real order to IBKR with real money.</div>' : ''}
        <div id="ot-err" class="err"></div>
        <div class="dlg-btns"><button type="button" id="ot-back">Back</button><button type="button" id="ot-send" class="primary ${body.action === 'BUY' ? 'buy' : 'sell'}">Send ${body.action} order</button></div>
      </div>`;
    $('ot-back').onclick = () => (bracket ? dlg.close() : openTicket(body.action as 'BUY' | 'SELL'));
    const send = $('ot-send') as HTMLButtonElement;
    if (bracket) $('ot-back').textContent = 'Cancel';
    if (problem) { $('ot-err').textContent = problem; send.disabled = true; }
    if (!dlg.open) dlg.showModal();
    dlg.querySelector<HTMLInputElement>('#ot-bqty')?.addEventListener('input', (e) => (dlg.querySelector('.ot-sum b')!.textContent = (e.target as HTMLInputElement).value));
    send.focus();
    send.onclick = async () => {
      if (bracket) {
        body.qty = Number(dlg.querySelector<HTMLInputElement>('#ot-bqty')!.value);
        body.tif = dlg.querySelector<HTMLSelectElement>('#ot-btif')!.value;
        if (!(body.qty > 0)) { $('ot-err').textContent = 'Enter a quantity above zero.'; return; }
        qtyIn.value = String(body.qty); qtyIn.onchange?.(new Event('change'));
      }
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        const r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, confirmed: true }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Order rejected');
        dlg.close();
        toast(`${body.action} ${body.qty} ${shortName(body.key)} sent`, `${TYPE_NAME[body.type]}${bracket ? ' + target + stop' : ''} · order #${j.orderId} · ${j.status}`, body.action === 'BUY');
        refresh();
      } catch (e) {
        $('ot-err').textContent = (e as Error).message;
        send.disabled = false;
        send.textContent = `Send ${body.action} order`;
      }
    };
  }

  // ---------- panel ----------
  function render() {
    const badge = $('tr-acct');
    badge.textContent = acct.accounts.length ? `${acct.paper ? 'PAPER' : 'LIVE'} · ${acct.accounts.join(', ')}` : 'not connected';
    badge.className = `tr-acct ${acct.paper ? 'paper' : 'live'}`;
    const rows: string[] = [];
    rows.push('<div class="tr-h">Positions</div>');
    if (!acct.positions.length) rows.push('<div class="empty">No open positions</div>');
    for (const p of acct.positions) {
      const mine = matches(p.secType, p.symbol);
      const last = mine ? ctx.getLast() : null;
      const pnl = last != null && p.secType !== 'FUT' ? (last - p.avgPrice) * p.position : null;
      rows.push(`<div class="tr-row" data-sym="${p.secType}:${p.symbol}"><span class="tr-sym">${p.localSymbol || p.symbol}</span>
        <span class="${p.position > 0 ? 'up' : 'down'}">${p.position > 0 ? '+' : ''}${p.position}</span><span class="n">@ ${fmt(p.avgPrice)}</span>
        <span class="n ${pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}">${pnl == null ? '' : `${pnl >= 0 ? '+' : ''}${fmt(pnl)}`}</span></div>`);
    }
    const open = acct.orders.filter((o) => ACTIVE.has(o.status));
    rows.push('<div class="tr-h">Working orders</div>');
    if (!open.length) rows.push('<div class="empty">None</div>');
    for (const o of open) {
      const px = o.type === 'MKT' ? 'MKT' : `${o.type} ${fmt(o.lmtPrice ?? o.auxPrice)}`;
      rows.push(`<div class="tr-row"><span class="tr-sym">${o.localSymbol || o.symbol}</span><span class="${o.action === 'BUY' ? 'up' : 'down'}">${o.action} ${o.remaining ?? o.qty}</span>
        <span class="n">${px}</span><span class="n muted">${o.status}</span><button class="al-btn" data-cancel="${o.orderId}" title="Cancel order">×</button></div>`);
    }
    rows.push('<div class="tr-h">Fills today</div>');
    if (!acct.fills.length) rows.push('<div class="empty">None</div>');
    for (const f of acct.fills.slice(0, 15)) {
      const t = f.time ? new Date(f.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      rows.push(`<div class="tr-row"><span class="tr-sym">${f.symbol}</span><span class="${f.side === 'BOT' ? 'up' : 'down'}">${f.side === 'BOT' ? 'BUY' : 'SELL'} ${f.qty}</span><span class="n">@ ${fmt(f.price)}</span><span class="n muted">${t}</span></div>`);
    }
    $('trade-rows').innerHTML = rows.join('');
    $('trade-rows').querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      const r = await fetch(`/api/orders/${b.dataset.cancel}`, { method: 'DELETE' });
      if (!r.ok) toast('Cancel failed', (await r.json()).error ?? '', false);
      refresh();
    }));
    $('rail-tr').dataset.badge = open.length ? String(open.length) : '';
    refreshLines();
  }
  function matches(secType: string, symbol: string) { const { sec, sym } = parseKey(ctx.getKey()); return secType === sec && symbol === sym; }

  function refreshLines() {
    lines.forEach((l) => ctx.candles.removePriceLine(l));
    lines = [];
    for (const p of acct.positions.filter((x) => matches(x.secType, x.symbol))) {
      lines.push(ctx.candles.createPriceLine({ price: p.avgPrice, color: p.position > 0 ? '#22ab94' : '#f23645', lineWidth: 1, lineStyle: LineStyle.Solid,
        axisLabelVisible: true, title: `Pos ${p.position > 0 ? '+' : ''}${p.position}` }));
    }
    for (const o of acct.orders.filter((x) => ACTIVE.has(x.status) && matches(x.secType, x.symbol))) {
      const price = o.lmtPrice ?? o.auxPrice;
      if (price == null) continue;
      lines.push(ctx.candles.createPriceLine({ price, color: o.action === 'BUY' ? '#2962ff' : '#f23645', lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: `${o.action} ${o.type} ${o.remaining ?? o.qty}` }));
    }
  }

  // ---------- data ----------
  async function refresh() {
    try {
      const r = await fetch('/api/account');
      if (r.ok) { acct = await r.json(); render(); }
    } catch { /* server restarting */ }
  }
  function toast(title: string, body: string, good: boolean) {
    const t = document.createElement('div');
    t.className = `toast ${good ? 'buy' : 'sell'}`;
    t.innerHTML = '<div class="toast-head"><b></b><span class="spacer"></span><button title="Close">×</button></div><div class="toast-body"></div>';
    t.querySelector('b')!.textContent = title;
    t.querySelector('.toast-body')!.textContent = body;
    t.onclick = () => t.remove();
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 8000);
  }
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'orders') { acct.orders = m.orders; render(); }
      else if (m.type === 'positions') { acct.positions = m.positions; render(); }
      else if (m.type === 'fill') {
        const f = m.fill as Fill;
        toast(`Filled: ${f.side === 'BOT' ? 'BUY' : 'SELL'} ${f.qty} ${f.symbol}`, `@ ${fmt(f.price)}`, f.side === 'BOT');
        refresh();
      }
    };
    ws.onclose = () => setTimeout(connect, 3000);
  }

  // Shift+B / Shift+S open the ticket like TradingView's trading panel shortcuts.
  window.addEventListener('keydown', (e) => {
    if (document.activeElement instanceof HTMLInputElement || dlg.open || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'B') { e.preventDefault(); openTicket('BUY'); }
    if (e.key === 'S') { e.preventDefault(); openTicket('SELL'); }
  });

  syncQty();
  connect();
  refresh();
  setInterval(tickPrices, 500);
  setInterval(() => { if (!$('trading').classList.contains('hidden')) render(); }, 2000); // P&L on the current symbol
  return {
    symbolChanged() { syncQty(); tickPrices(); refreshLines(); render(); },
    refresh,
    openPosition,
  };
}
