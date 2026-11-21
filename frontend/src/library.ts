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

/** Ask for a name in a small in-app dialog (window.prompt does not exist in the desktop app). */
export function askName(title: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'study-dlg';
    dlg.innerHTML = `<form method="dialog"><h3></h3><label>Name<input type="text" maxlength="60" required /></label>
      <div class="dlg-btns"><span class="spacer"></span><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">Save</button></div></form>`;
    dlg.querySelector('h3')!.textContent = title;
    const input = dlg.querySelector('input')!;
    input.value = initial;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const v = input.value.trim();
      dlg.remove();
      resolve(dlg.returnValue === 'ok' && v ? v.slice(0, 60) : null);
    });
    dlg.showModal();
    input.select();
  });
}
