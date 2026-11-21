/**
 * Colour picker in TradingView's style: a swatch that opens a popover with a preset grid (greys, brights,
 * then tints and shades), your custom colours, a "+" for any colour, and an opacity slider.
 *
 * Use it as <color-swatch data-...></color-swatch>. Like an <input>, it has `.value` and fires `input`
 * while you pick and `change` when the popover closes. Values are "#rrggbb", or "rgba(r,g,b,a)" below 100%.
 */
const GREYS = ['#ffffff', '#d1d4dc', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000'];
const BRIGHT = ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'];
const MIX: [string, number][] = [['#ffffff', 0.8], ['#ffffff', 0.6], ['#ffffff', 0.4], ['#ffffff', 0.15], ['#000000', 0.25], ['#000000', 0.45]];
const CUSTOM_KEY = 'customColors';

type RGBA = [number, number, number, number];

export function parseColor(s: string): RGBA {
  s = (s || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1].split('').map((c) => parseInt(c + c, 16)), 1] as RGBA;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1];
  }
  return [41, 98, 255, 1];
}
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
export function formatColor([r, g, b, a]: RGBA): string {
  return a >= 0.995 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(2)})`;
}
/** The colour at `a` times its own opacity, e.g. a fill made from a line colour. */
export function fade(c: string, a: number): string {
  const [r, g, b, o] = parseColor(c);
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+(a * o).toFixed(3)})`;
}
function mix(c: string, to: string, t: number) {
  const a = parseColor(c), b = parseColor(to);
  return formatColor([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1]);
}
const ROWS = [GREYS, BRIGHT, ...MIX.map(([to, t]) => BRIGHT.map((c) => mix(c, to, t)))];

function customs(): string[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; }
}
function addCustom(c: string) {
  const list = [c, ...customs().filter((x) => x !== c)].slice(0, 10);
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// ---------- the popover (one, shared) ----------
let pop: HTMLDivElement | null = null;
let owner: ColorSwatch | null = null;

function closePopover() {
  if (!pop || !owner) return;
  const o = owner;
  owner = null;
  try { pop.hidePopover?.(); } catch { /* not shown as popover */ }
  pop.hidden = true;
  o.dispatchEvent(new Event('change', { bubbles: true }));
}

function openPopover(sw: ColorSwatch) {
  if (owner === sw) { closePopover(); return; }
  closePopover();
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'cp-pop';
    pop.setAttribute('popover', 'manual');
    document.body.appendChild(pop);
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (owner && !pop!.contains(t) && !owner.contains(t)) closePopover();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && owner) { e.stopPropagation(); e.preventDefault(); closePopover(); } }, true);
  }
  owner = sw;
  const p = pop;
  // inside an open modal dialog everything else is inert, so the popover has to live in that dialog
  const host = sw.closest('dialog') ?? document.body;
  if (p.parentElement !== host) host.appendChild(p);
  let [r, g, b, a] = parseColor(sw.value);
  const cur = () => formatColor([r, g, b, 1]).toLowerCase();
  const cell = (c: string) => `<button type="button" class="cp-cell" data-c="${c}" style="background:${c}" title="${c}"></button>`;
  p.innerHTML = `
    ${ROWS.slice(0, 2).map((row) => `<div class="cp-row">${row.map(cell).join('')}</div>`).join('')}
    <div class="cp-gap"></div>
    ${ROWS.slice(2).map((row) => `<div class="cp-row">${row.map(cell).join('')}</div>`).join('')}
    <div class="cp-sep"></div>
    <div class="cp-row cp-custom">${customs().map(cell).join('')}<button type="button" class="cp-add" title="Custom colour">+</button><input type="color" class="cp-native" /></div>
    <div class="cp-label">Opacity</div>
    <div class="cp-op"><input type="range" min="0" max="100" class="cp-range" /><span class="cp-pct"><input type="number" min="0" max="100" class="cp-num" />%</span></div>`;
  const range = p.querySelector<HTMLInputElement>('.cp-range')!, num = p.querySelector<HTMLInputElement>('.cp-num')!;
  const native = p.querySelector<HTMLInputElement>('.cp-native')!;
  const paint = () => {
    p.querySelectorAll<HTMLElement>('.cp-cell').forEach((x) => x.classList.toggle('on', x.dataset.c!.toLowerCase() === cur()));
    range.value = num.value = String(Math.round(a * 100));
    range.style.setProperty('--cp-c', cur());
  };
  const emit = () => { sw.value = formatColor([r, g, b, a]); sw.dispatchEvent(new Event('input', { bubbles: true })); paint(); };
  p.querySelectorAll<HTMLButtonElement>('.cp-cell').forEach((x) => (x.onclick = () => { [r, g, b] = parseColor(x.dataset.c!); emit(); }));
  p.querySelector<HTMLButtonElement>('.cp-add')!.onclick = () => { native.value = cur(); native.click(); };
  native.oninput = () => { [r, g, b] = parseColor(native.value); emit(); };
  native.onchange = () => { addCustom(native.value.toLowerCase()); };
  range.oninput = () => { a = Number(range.value) / 100; emit(); };
  num.oninput = () => { const v = Number(num.value); if (Number.isFinite(v)) { a = Math.max(0, Math.min(100, v)) / 100; sw.value = formatColor([r, g, b, a]); sw.dispatchEvent(new Event('input', { bubbles: true })); range.value = String(Math.round(a * 100)); } };
  paint();
  p.hidden = false;
  try { p.showPopover?.(); } catch { /* old browser: falls back to fixed positioning */ }
  // place under the swatch, kept on screen
  const rc = sw.getBoundingClientRect();
  const w = p.offsetWidth, h = p.offsetHeight;
  let left = rc.left, top = rc.bottom + 6;
  if (left + w > innerWidth - 8) left = innerWidth - 8 - w;
  if (top + h > innerHeight - 8) top = Math.max(8, rc.top - 6 - h);
  p.style.left = `${Math.max(8, left)}px`;
  p.style.top = `${top}px`;
}

export class ColorSwatch extends HTMLElement {
  private v = '#2962ff';
  connectedCallback() {
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    if (!this.title) this.title = 'Colour';
    if (this.hasAttribute('value')) this.v = this.getAttribute('value')!;
    this.paint();
    this.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openPopover(this); };
    this.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPopover(this); } };
  }
  get value() { return this.v; }
  set value(c: string) { this.v = c; this.paint(); }
  private paint() { this.style.setProperty('--sw', this.v); }
}
if (!customElements.get('color-swatch')) customElements.define('color-swatch', ColorSwatch);
