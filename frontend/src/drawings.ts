import { LineSeries, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from 'lightweight-charts';

type Tool = 'cross' | 'trend' | 'hline';
interface Saved { h: number[]; t: [number, number, number, number][] } // horizontal prices; trend lines t1,p1,t2,p2

const COLOR = '#b84fd6';

/** Simple drawing tools: horizontal lines (per symbol) and trend lines (per symbol + timeframe), saved locally. */
export function initDrawings(chart: IChartApi, candles: ISeriesApi<'Candlestick'>, wrap: HTMLElement) {
  let tool: Tool = 'cross';
  let key = '';
  let tf = '';
  let hidden = false;
  let pending: { time: number; price: number } | null = null;
  let priceLines: IPriceLine[] = [];
  let trendSeries: ISeriesApi<'Line'>[] = [];

  const storeKey = () => `draw:${key}`;
  const load = (): Saved => {
    try { return JSON.parse(localStorage.getItem(storeKey()) || '') as Saved; } catch { return { h: [], t: [] }; }
  };
  const save = (s: Saved) => { try { localStorage.setItem(storeKey(), JSON.stringify(s)); } catch { /* ignore */ } };
  // trend lines are stored per timeframe inside the same record
  const tfTrends = (s: Saved & { tt?: Record<string, Saved['t']> }) => (s.tt ??= {}, s.tt[tf] ??= [], s.tt[tf]);

  function clearVisuals() {
    priceLines.forEach((p) => candles.removePriceLine(p));
    trendSeries.forEach((s) => chart.removeSeries(s));
    priceLines = [];
    trendSeries = [];
  }
  function render() {
    clearVisuals();
    if (hidden || !key) return;
    const s = load() as Saved & { tt?: Record<string, Saved['t']> };
    for (const price of s.h ?? []) {
      priceLines.push(candles.createPriceLine({ price, color: COLOR, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' }));
    }
    for (const [t1, p1, t2, p2] of tfTrends(s)) {
      const ls = chart.addSeries(LineSeries, { color: COLOR, lineWidth: 2, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: true });
      ls.setData([{ time: t1 as UTCTimestamp, value: p1 }, { time: t2 as UTCTimestamp, value: p2 }]);
      trendSeries.push(ls);
    }
  }

  chart.subscribeClick((param: MouseEventParams) => {
    if (tool === 'cross' || !param.point || param.time === undefined) return;
    const price = candles.coordinateToPrice(param.point.y);
    if (price == null) return;
    const s = load() as Saved & { tt?: Record<string, Saved['t']> };
    s.h ??= [];
    if (tool === 'hline') {
      s.h.push(Number(price.toFixed(4)));
      save(s);
      setTool('cross');
    } else if (tool === 'trend') {
      const t = param.time as number;
      if (!pending) { pending = { time: t, price }; return; }
      if (t === pending.time) return;
      const [a, b] = t > pending.time ? [pending, { time: t, price }] : [{ time: t, price }, pending];
      tfTrends(s).push([a.time, a.price, b.time, b.price]);
      save(s);
      pending = null;
      setTool('cross');
    }
    render();
  });

  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]')];
  function setTool(t: Tool) {
    tool = t;
    pending = null;
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    wrap.classList.toggle('drawing', t !== 'cross');
  }
  buttons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTool('cross'); });

  const hideBtn = document.getElementById('draw-hide')!;
  hideBtn.onclick = () => { hidden = !hidden; hideBtn.classList.toggle('active', hidden); render(); };
  document.getElementById('draw-clear')!.onclick = () => {
    const s = load() as Saved & { tt?: Record<string, Saved['t']> };
    s.h = [];
    if (s.tt) s.tt[tf] = [];
    save(s);
    render();
  };

  return {
    /** Call after the chart's bars for a symbol/timeframe are loaded. */
    show(k: string, timeframe: string) { key = k; tf = timeframe; render(); },
    clear() { clearVisuals(); },
  };
}
