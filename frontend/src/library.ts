/** Saved layouts, indicator templates and chart style templates (stored by the backend in data/library.json). */
export interface Library {
  layouts: Record<string, SavedLayout>;
  indicatorTemplates: Record<string, unknown[]>;
  chartTemplates: Record<string, { colors: unknown; chartType: string }>;
}
export interface SavedLayout { layout: string; sync: unknown; charts: Record<string, string | null>[] }

let cache: Library = { layouts: {}, indicatorTemplates: {}, chartTemplates: {} };
const subs: (() => void)[] = [];
export const lib = () => cache;
export function onLibrary(f: () => void) { subs.push(f); }

export async function loadLibrary(): Promise<Library> {
  try { cache = await (await fetch('/api/library')).json(); } catch { /* keep cache */ }
  subs.forEach((f) => f());
  return cache;
}
export async function updateLibrary(change: (l: Library) => void) {
  await loadLibrary(); // another chart may have saved since
  change(cache);
  try {
    cache = await (await fetch('/api/library', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cache) })).json();
  } catch { /* ignore */ }
  subs.forEach((f) => f());
}

/** Ask for a name (pre-filled), or null if cancelled. */
export function askName(title: string, initial = ''): string | null {
  const n = window.prompt(title, initial);
  return n && n.trim() ? n.trim().slice(0, 60) : null;
}
