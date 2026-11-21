import { fade } from './colorpick';
/** Chart appearance settings (colours, grid, volume), saved in localStorage. */
export interface ChartColors {
  up: string; down: string; wickUp: string; wickDown: string;
  border: boolean; borderUp: string; borderDown: string;
  bg: string; grid: string; gridOn: boolean; text: string;
  volume: boolean; volUp: string; volDown: string; line: string;
}
export const DEFAULT_COLORS: ChartColors = {
  up: '#6ab86a', down: '#a43bc7', wickUp: '#6ab86a', wickDown: '#a43bc7',
  border: false, borderUp: '#6ab86a', borderDown: '#a43bc7',
  bg: '#000000', grid: '#0e0e0e', gridOn: true, text: '#dbdbdb',
  volume: true, volUp: '#26786e', volDown: '#8c302c', line: '#2962ff',
};

export function loadColors(): ChartColors {
  try { return { ...DEFAULT_COLORS, ...JSON.parse(localStorage.getItem('chartColors') || '{}') }; } catch { return { ...DEFAULT_COLORS }; }
}
export const withAlpha = (c: string, a: number) => fade(c, a);

const ROWS: [string, [keyof ChartColors, string][]][] = [
  ['Candles', [['up', 'Body up'], ['down', 'Body down'], ['wickUp', 'Wick up'], ['wickDown', 'Wick down']]],
  ['Borders', [['border', 'Show borders'], ['borderUp', 'Border up'], ['borderDown', 'Border down']]],
  ['Line / area', [['line', 'Line colour']]],
  ['Canvas', [['bg', 'Background'], ['gridOn', 'Grid lines'], ['grid', 'Grid colour'], ['text', 'Scale text']]],
  ['Volume', [['volume', 'Show volume'], ['volUp', 'Volume up'], ['volDown', 'Volume down']]],
];

/** Opens the settings dialog. `apply` is called live while editing so changes preview on the chart. */
export function openChartSettings(current: ChartColors, apply: (c: ChartColors) => void) {
  const before = { ...current };
  const work = { ...current };
  const dlg = document.createElement('dialog');
  dlg.className = 'settings-dlg';
  dlg.innerHTML = `<form method="dialog"><h3>Chart settings</h3>${ROWS.map(([title, items]) => `
    <div class="cs-group"><div class="cs-title">${title}</div><div class="cs-grid">${items.map(([k, label]) =>
      typeof DEFAULT_COLORS[k] === 'boolean'
        ? `<label class="cs-item"><input type="checkbox" data-k="${k}" /><span>${label}</span></label>`
        : `<label class="cs-item"><color-swatch data-k="${k}"></color-swatch><span>${label}</span></label>`).join('')}</div></div>`).join('')}
    <div class="dlg-btns"><button type="button" data-reset>Defaults</button><span class="spacer"></span><button value="cancel">Cancel</button><button value="ok" class="primary">OK</button></div></form>`;
  document.body.appendChild(dlg);
  const fill = () => dlg.querySelectorAll<HTMLInputElement>('[data-k]').forEach((inp) => {
    const v = work[inp.dataset.k as keyof ChartColors];
    if (inp.type === 'checkbox') inp.checked = v as boolean; else inp.value = v as string;
  });
  fill();
  dlg.addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement;
    const k = inp.dataset.k as keyof ChartColors;
    if (!k) return;
    (work as unknown as Record<string, string | boolean>)[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
    apply({ ...work });
  });
  dlg.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => { Object.assign(work, DEFAULT_COLORS); fill(); apply({ ...work }); };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'ok') {
      try { localStorage.setItem('chartColors', JSON.stringify(work)); } catch { /* ignore */ }
      apply({ ...work });
    } else apply(before);
    dlg.remove();
  });
  dlg.showModal();
}
