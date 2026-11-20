// Minimal stroke icons (24x24, currentColor). Original drawings, not TradingView assets.
const P: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  cross: '<path d="M12 4v16M4 12h16"/>',
  trend: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
  hline: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  indicators: '<path d="M3 20h18"/><path d="M5 16l4-5 4 3 6-8"/>',
  alert: '<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2 2M4 5l3-2M20 5l-3-2"/>',
  replay: '<path d="M11 6l-6 6 6 6M19 6l-6 6 6 6"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2.5h3L15 7"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  list: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
};

export function icon(name: string, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ''}</svg>`;
}

/** Round avatar with up to 3 letters, colour picked from the symbol so it stays stable. */
export function avatar(sym: string, size = 18): string {
  const colors = ['#2962ff', '#e91e63', '#ff9800', '#26a69a', '#7e57c2', '#ef5350', '#29b6f6', '#8d6e63', '#43a047', '#f06292'];
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const txt = sym.replace(/[^A-Z0-9]/gi, '').slice(0, sym.length > 3 ? 1 : 3);
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${colors[h % colors.length]};font-size:${size * (txt.length > 1 ? 0.38 : 0.5)}px">${txt}</span>`;
}
