/**
 * Data providers screen: switch providers on, enter keys (kept by the local server only), test them, and pick
 * the default provider for each instrument type. Plus the chart's "data source" chip to override one symbol.
 */
interface Field { name: string; label: string; secret?: boolean; options?: string[]; placeholder?: string }
interface Routing { defaults: Record<string, string>; overrides: Record<string, string>; types: Record<string, string[]>; titles: Record<string, string> }
interface Cfg { providers: Record<string, Record<string, string | boolean>>; fields: Record<string, Field[]>; routing: Routing }
export interface Sources { ident: string | null; kind?: string; using: string; options: { id: string; title: string }[]; override?: string | null }

const ABOUT: Record<string, { title: string; what: string; link: string }> = {
  binance: { title: 'Binance', what: 'Crypto spot prices, live. Public market data: no account or key needed.', link: 'https://www.binance.com/en/binance-api' },
  oanda: { title: 'OANDA', what: 'Forex, metals and index CFDs from your OANDA account. Token: OANDA hub › Manage API Access.', link: 'https://developer.oanda.com/rest-live-v20/introduction/' },
  ig: { title: 'IG', what: 'CFDs and spread bets from your IG account. API key: My IG › Settings › API keys. History is limited by IG to 10,000 price points a week, so charts load about 500 bars.', link: 'https://labs.ig.com/rest-trading-api-guide' },
  polygon: { title: 'Polygon', what: 'US stocks. The free plan gives end-of-day data and 5 calls a minute; paid plans add delayed or real-time intraday.', link: 'https://polygon.io/pricing' },
  tradovate: { title: 'Tradovate / NinjaTrader', what: 'CME futures, live, from your Tradovate account; NinjaTrader futures accounts run on Tradovate, so the same login works if your NinjaTrader account is on that platform. Needs Tradovate\'s API Access add-on and CME data on the account. API key: Tradovate › Application Settings › API Access › Generate API Key. Can also take orders for its charts.', link: 'https://api.tradovate.com/' },
  databento: { title: 'Databento', what: 'CME futures history (ohlcv), paid per use from your credit. Charts refresh once a minute; real-time needs their live feed, not added yet.', link: 'https://databento.com/pricing' },
};
const TYPE_NAMES: Record<string, string> = { stock: 'Stocks', futures: 'Futures', forex: 'Forex', crypto: 'Crypto' };

export function openProviders(onSaved: () => void) {
  const dlg = document.createElement('dialog');
  dlg.className = 'study-dlg prov-dlg';
  document.body.appendChild(dlg);
  let cfg: Cfg;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  async function load() {
    cfg = await (await fetch('/api/providers')).json();
    render();
  }
  function render() {
    const r = cfg.routing;
    dlg.innerHTML = `<form method="dialog"><h3>Data providers</h3>
      <div class="pv-sec">Default provider for each type</div>
      <div class="pv-defaults">${Object.entries(r.types).map(([t, opts]) => `<label>${TYPE_NAMES[t] ?? t}<select data-def="${t}">${opts.map((o) =>
        `<option value="${o}" ${r.defaults[t] === o ? 'selected' : ''} ${o !== 'ibkr' && !cfg.providers[o]?.enabled ? 'disabled' : ''}>${r.titles[o]}${o !== 'ibkr' && !cfg.providers[o]?.enabled ? ' (off)' : ''}</option>`).join('')}</select></label>`).join('')}</div>
      <div class="pv-hint">A symbol you open loads from its type's default provider; one that is off or has no key yet falls back to IBKR. To use another provider for one symbol, click the source name next to the chart title.</div>
      <div class="pv-sec">Providers</div>
      ${Object.keys(ABOUT).map((name) => {
        const p = cfg.providers[name] ?? {};
        const a = ABOUT[name];
        return `<div class="pv-card" data-p="${name}">
          <div class="pv-head"><label class="pv-on"><input type="checkbox" data-on ${p.enabled ? 'checked' : ''}/> <b>${a.title}</b></label>
            <span class="spacer"></span><span class="pv-status">${esc(String(p.status || ''))}</span><button type="button" data-test>Test</button></div>
          <div class="pv-what">${a.what} <a href="${a.link}" target="_blank" rel="noreferrer">Docs</a></div>
          ${(cfg.fields[name] ?? []).map((f) => f.options
            ? `<label>${f.label}<select data-f="${f.name}">${f.options.map((o) => `<option ${p[f.name] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`
            : `<label>${f.label}<input data-f="${f.name}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" placeholder="${esc(f.placeholder ?? (f.secret && p[f.name] ? 'saved; type to replace' : ''))}" value="${f.secret ? '' : esc(String(p[f.name] ?? ''))}"/></label>`).join('')}
        </div>`;
      }).join('')}
      <div class="pv-card"><div class="pv-head"><b>Rithmic</b><span class="spacer"></span><span class="pv-status">Not available yet</span></div>
        <div class="pv-what">Rithmic's API (R | Protocol) is only opened to apps after you sign their API agreement and the app passes their conformance test,
          and the login comes from a futures broker or prop firm that clears through Rithmic. Once you have those, it can be added here.</div></div>
      <div class="pv-hint">Keys and passwords are stored only on this computer (in the app's data folder) and are never shown again or sent anywhere except to that provider.</div>
      <div class="dlg-btns"><span class="spacer"></span><button type="button" data-cancel>Close</button><button value="ok" class="primary">Save</button></div></form>`;
    dlg.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => dlg.close('cancel');
    dlg.querySelectorAll<HTMLButtonElement>('[data-test]').forEach((b) => (b.onclick = async () => {
      const card = b.closest<HTMLElement>('.pv-card')!;
      const st = card.querySelector<HTMLElement>('.pv-status')!;
      card.querySelector<HTMLInputElement>('[data-on]')!.checked = true; // testing means you want it on
      st.textContent = 'Saving and testing…';
      await save();
      const res = await fetch(`/api/providers/${card.dataset.p}/test`, { method: 'POST' });
      const j = await res.json();
      st.textContent = j.ok ? `✓ ${j.message}` : `✗ ${j.error}`;
      st.className = `pv-status ${j.ok ? 'ok' : 'bad'}`;
    }));
  }
  function collect() {
    const providers: Record<string, Record<string, string | boolean>> = {};
    dlg.querySelectorAll<HTMLElement>('.pv-card[data-p]').forEach((card) => {
      const v: Record<string, string | boolean> = { enabled: card.querySelector<HTMLInputElement>('[data-on]')!.checked };
      card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((i) => {
        const secret = i instanceof HTMLInputElement && i.type === 'password';
        if (secret && !i.value) return; // keep the saved one
        if (secret) v.enabled = true; // a new key means you want to use it
        v[i.dataset.f!] = i.value;
      });
      providers[card.dataset.p!] = v;
    });
    const defaults: Record<string, string> = {};
    dlg.querySelectorAll<HTMLSelectElement>('[data-def]').forEach((s) => (defaults[s.dataset.def!] = s.value));
    return { providers, defaults };
  }
  async function save() {
    const r = await fetch('/api/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
    const fresh: Cfg = await r.json();
    // keep what is typed in the dialog, refresh the rest
    cfg = fresh;
  }
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') { await save(); onSaved(); }
    dlg.remove();
  });
  load().then(() => dlg.showModal());
}

/** Small menu under the chart title's source chip: use another provider for this symbol. */
export function openSourceMenu(anchor: HTMLElement, s: Sources, onPick: () => void) {
  document.querySelector('.src-menu')?.remove();
  if (!s.ident || s.options.length < 2) return;
  const m = document.createElement('div');
  m.className = 'menu src-menu';
  m.innerHTML = `<div class="hint">Data for this symbol from</div>${s.options.map((o) =>
    `<button data-p="${o.id}" class="${o.id === s.using ? 'on' : ''}"><span>${o.title}</span><span class="spacer"></span>${o.id === s.using ? '✓' : ''}</button>`).join('')}
    ${s.override ? '<button data-p=""><span>Use the default for this type</span></button>' : ''}`;
  const r = anchor.getBoundingClientRect();
  m.style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom + 4}px;z-index:50`;
  document.body.appendChild(m);
  m.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = async () => {
    m.remove();
    await fetch('/api/providers/override', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ident: s.ident, provider: b.dataset.p || null }) });
    onPick();
  }));
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
