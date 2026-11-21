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

/**
 * Session VWAP. Resets at the start of each trading session: after a gap of 45+ minutes
 * (stock open, the CME daily break) or, for markets that never pause (crypto), at local midnight.
 */
export function vwap(bars: Bar[]): Point[] {
  const out: Point[] = [];
  let pv = 0;
  let vol = 0;
  let lastReset = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const gap = prev ? b.time - prev.time : Infinity;
    const newDay = prev ? Math.floor(b.time / 86400) !== Math.floor(prev.time / 86400) : true;
    if (gap >= 45 * 60 || (newDay && b.time - lastReset > 20 * 3600)) {
      pv = 0;
      vol = 0;
      lastReset = b.time;
    }
    const v = Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0;
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * v;
    vol += v;
    out.push({ time: b.time, value: vol > 0 ? pv / vol : tp });
  }
  return out;
}

// ---------- helpers on plain number arrays (NaN = not enough data yet) ----------
export function smaArr(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < v.length; i++) {
    if (Number.isNaN(v[i])) { sum = 0; cnt = 0; continue; }
    sum += v[i]; cnt++;
    if (cnt > n) { sum -= v[i - n]; cnt = n; }
    if (cnt === n) out[i] = sum / n;
  }
  return out;
}
export function emaArr(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  const k = 2 / (n + 1);
  let start = v.findIndex((x) => !Number.isNaN(x));
  if (start < 0 || v.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += v[i];
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
/** Wilder's smoothing (RMA), used by RSI and ATR. */
export function rmaArr(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  const start = v.findIndex((x) => !Number.isNaN(x));
  if (start < 0 || v.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += v[i];
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < v.length; i++) { prev = (prev * (n - 1) + v[i]) / n; out[i] = prev; }
  return out;
}
export function toPoints(bars: Bar[], v: number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < bars.length; i++) if (!Number.isNaN(v[i])) out.push({ time: bars[i].time, value: v[i] });
  return out;
}

export function rsi(bars: Bar[], n: number): number[] {
  const up = bars.map((b, i) => (i ? Math.max(b.close - bars[i - 1].close, 0) : NaN));
  const dn = bars.map((b, i) => (i ? Math.max(bars[i - 1].close - b.close, 0) : NaN));
  const au = rmaArr(up, n), ad = rmaArr(dn, n);
  return au.map((u, i) => (Number.isNaN(u) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
}
export function macd(bars: Bar[], fast: number, slow: number, signal: number) {
  const c = bars.map((b) => b.close);
  const f = emaArr(c, fast), s = emaArr(c, slow);
  const line = f.map((x, i) => x - s[i]);
  const sig = emaArr(line, signal);
  return { line, signal: sig, hist: line.map((x, i) => x - sig[i]) };
}
export function bollinger(bars: Bar[], n: number, mult: number) {
  const c = bars.map((b) => b.close);
  const mid = smaArr(c, n);
  const sd = mid.map((m, i) => {
    if (Number.isNaN(m)) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (c[j] - m) ** 2;
    return Math.sqrt(s / n);
  });
  return { mid, upper: mid.map((m, i) => m + mult * sd[i]), lower: mid.map((m, i) => m - mult * sd[i]) };
}
export function atr(bars: Bar[], n: number): number[] {
  const tr = bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low));
  return rmaArr(tr, n);
}
export function stochastic(bars: Bar[], n: number, smoothK: number, smoothD: number) {
  const raw = bars.map((b, i) => {
    if (i < n - 1) return NaN;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
    return hi === lo ? 50 : ((b.close - lo) / (hi - lo)) * 100;
  });
  const k = smaArr(raw, smoothK);
  return { k, d: smaArr(k, smoothD) };
}

/**
 * Session boundaries, the same rule VWAP uses: a new session starts after a gap of 45 minutes or more
 * (overnight for stocks, the daily break for futures), or on a new day if the last start was over 20 h ago.
 * On daily and longer charts every bar is its own session.
 */
export function sessionStarts(bars: Bar[]): boolean[] {
  const out: boolean[] = [];
  let lastReset = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const prev = bars[i - 1];
    const gap = prev ? bars[i].time - prev.time : Infinity;
    const newDay = prev ? Math.floor(bars[i].time / 86400) !== Math.floor(prev.time / 86400) : true;
    const start = gap >= 45 * 60 || (newDay && bars[i].time - lastReset > 20 * 3600);
    if (start) lastReset = bars[i].time;
    out.push(start);
  }
  return out;
}

/** Previous session's open, high, low and close, held flat through the current session. */
export function prevSession(bars: Bar[]) {
  const st = sessionStarts(bars);
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  type S = { o: number; h: number; l: number; c: number };
  let cur: S | null = null;
  let prev: S | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (st[i]) { prev = cur; cur = { o: b.open, h: b.high, l: b.low, c: b.close }; }
    else if (cur) { cur.h = Math.max(cur.h, b.high); cur.l = Math.min(cur.l, b.low); cur.c = b.close; }
    o.push(prev ? prev.o : NaN); h.push(prev ? prev.h : NaN); l.push(prev ? prev.l : NaN); c.push(prev ? prev.c : NaN);
  }
  return { o, h, l, c };
}

/**
 * High and low of a time window each day (chart time = your local time), e.g. the Asia session.
 * During the window the lines follow the developing range; afterwards they hold until the next window.
 */
export function windowRange(bars: Bar[], startH: number, endH: number) {
  const hi: number[] = [], lo: number[] = [], starts: boolean[] = [];
  const inWin = (t: number) => {
    const h = (((t % 86400) + 86400) % 86400) / 3600;
    return startH <= endH ? h >= startH && h < endH : h >= startH || h < endH;
  };
  let H = NaN, L = NaN, was = false;
  for (const b of bars) {
    const now = inWin(b.time);
    if (now && !was) { H = b.high; L = b.low; } else if (now) { H = Math.max(H, b.high); L = Math.min(L, b.low); }
    starts.push(now && !was);
    was = now;
    hi.push(H); lo.push(L);
  }
  return { hi, lo, starts };
}
