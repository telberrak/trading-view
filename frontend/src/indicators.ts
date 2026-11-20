export interface Bar {
  time: number; // unix seconds (already shifted for display)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Point {
  time: number;
  value: number;
}

export function ema(bars: Bar[], period: number): Point[] {
  const out: Point[] = [];
  if (bars.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  let prev = sum / period;
  out.push({ time: bars[period - 1].time, value: prev });
  for (let i = period; i < bars.length; i++) {
    prev = bars[i].close * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

/** Session VWAP, reset when the calendar day of the (display-shifted) bar changes. */
export function vwap(bars: Bar[]): Point[] {
  const out: Point[] = [];
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const d = Math.floor(b.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    vol += b.volume;
    out.push({ time: b.time, value: vol > 0 ? pv / vol : tp });
  }
  return out;
}
