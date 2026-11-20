export interface SearchItem { key: string; symbol: string; description: string; type: string }

/** IBKR symbol search dropdown attached to an input. Enter on a typed key (e.g. FUT:ES:CME) uses it as-is. */
export function attachSearch(input: HTMLInputElement, results: HTMLUListElement, onChoose: (key: string) => void) {
  let timer = 0;
  let items: SearchItem[] = [];
  let sel = 0;

  const choose = (k: string) => { results.hidden = true; input.blur(); onChoose(k); };
  const render = () => {
    results.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = i === sel ? 'sel' : '';
      li.innerHTML = `<span class="sym"></span><span class="desc"></span><span class="kind"></span>`;
      (li.children[0] as HTMLElement).textContent = it.symbol;
      (li.children[1] as HTMLElement).textContent = it.description;
      (li.children[2] as HTMLElement).textContent = it.type;
      li.onmousedown = () => choose(it.key);
      results.appendChild(li);
    });
    results.hidden = items.length === 0;
  };

  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q || q.includes(':')) { items = []; render(); return; }
    timer = window.setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        items = r.ok ? await r.json() : [];
      } catch { items = []; }
      sel = 0;
      render();
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      const q = input.value.trim().toUpperCase();
      if (!q) return;
      choose(q.includes(':') || !items.length ? q : items[sel].key);
    } else if (e.key === 'Escape') { results.hidden = true; input.blur(); }
    e.stopPropagation();
  });
}

/** Short TradingView-style name for a contract key. */
export function shortName(key: string): string {
  const p = key.split(':');
  if (p.length === 1) return p[0];
  const [sec, sym, , cur] = p;
  if (sec === 'FUT') return `${sym}1!`;
  if (sec === 'CRYPTO') return `${sym}${cur || 'USD'}`;
  return sym;
}
