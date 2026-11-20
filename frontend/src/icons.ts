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
  play: '<path d="M8 5.5v13l10-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  step: '<path d="M6 5.5v13l9-6.5zM18 5v14" fill="currentColor"/>',
  ray: '<path d="M5 19L21 3"/><circle cx="5" cy="19" r="1.6"/><circle cx="11" cy="13" r="1.6"/>',
  vline: '<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  fib: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M5 19L19 5" stroke-dasharray="2 2"/>',
  channel: '<path d="M3 15L15 4M9 20L21 9"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  ruler: '<rect x="2.5" y="8" width="19" height="8" rx="1" transform="rotate(-30 12 12)"/><path d="M8 10.5l1 1.7M11 8.8l1.5 2.5M14 7l1 1.7"/>',
  magnet: '<path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  'ct-candles': '<path d="M8 3v3M8 16v5M16 5v4M16 15v4"/><rect x="5.5" y="6" width="5" height="10" fill="currentColor"/><rect x="13.5" y="9" width="5" height="6" fill="currentColor"/>',
  'ct-hollow': '<path d="M8 3v3M8 16v5M16 5v4M16 15v4"/><rect x="5.5" y="6" width="5" height="10"/><rect x="13.5" y="9" width="5" height="6" fill="currentColor"/>',
  'ct-ha': '<path d="M8 4v3M8 15v4M16 6v3M16 15v3"/><rect x="5.5" y="7" width="5" height="8"/><rect x="13.5" y="9" width="5" height="6"/><path d="M5.5 11h5"/>',
  'ct-bars': '<path d="M8 4v16M5 8h3M8 16h3M16 6v12M13 15h3M16 9h3"/>',
  'ct-line': '<path d="M3 17l5-6 4 3 5-7 4 4"/>',
  'ct-area': '<path d="M3 17l5-6 4 3 5-7 4 4v8H3z" fill="currentColor" fill-opacity=".25"/><path d="M3 17l5-6 4 3 5-7 4 4"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2M6 6l9-3 1 3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  pin: '<path d="M14 3l7 7-3 1-4 4 1 4-2 2-4-4-5 5M9 13l-4-4 2-2 4 1 4-4 1-3"/>',
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
