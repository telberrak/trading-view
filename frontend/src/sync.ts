/**
 * Multi-chart plumbing. Extra charts in a layout are the same app in an iframe (`?embed=N`), each with its
 * own data socket and saved state; they talk to each other over a BroadcastChannel.
 */
export const CHART_ID = Number(new URLSearchParams(location.search).get('embed') || 0);
export const EMBED = CHART_ID > 0;
/** Prefix for per-chart saved state (symbol, timeframe, chart type, indicators). */
export const PREFIX = EMBED ? `c${CHART_ID}:` : '';

export interface SyncOpts { symbol: boolean; interval: boolean; crosshair: boolean }
export function syncOpts(): SyncOpts {
  try { return { symbol: false, interval: false, crosshair: true, ...JSON.parse(localStorage.getItem('layoutSync') || '{}') }; } catch { return { symbol: false, interval: false, crosshair: true }; }
}
export function saveSyncOpts(o: SyncOpts) { try { localStorage.setItem('layoutSync', JSON.stringify(o)); } catch { /* ignore */ } }

export type BusMsg =
  | { type: 'symbol'; from: number; key: string }
  | { type: 'tf'; from: number; tf: string }
  | { type: 'xhair'; from: number; time: number | null }
  | { type: 'focus'; from: number }
  | { type: 'setSymbol'; from: number; to: number; key: string }
  | { type: 'reload'; from: number };
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tv-charts') : null;
export function post(m: BusMsg) { channel?.postMessage(m); }
export function listen(fn: (m: BusMsg) => void) {
  if (channel) channel.addEventListener('message', (e) => { const m = e.data as BusMsg; if (m && m.from !== CHART_ID) fn(m); });
}
