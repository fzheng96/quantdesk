/**
 * Performance metrics for daily return and equity series, ported from
 * quantdesk/metrics.py. Every function is pure and deterministic; NaN
 * observations are dropped before computing. Annualization assumes the series
 * is sampled `periodsPerYear` times per year (252 by default, the trading-day
 * convention), which ignores calendar gaps and the fact that real returns are
 * not i.i.d. normal: treat annualized figures as comparable summaries, not
 * forecasts.
 */

import type { SummaryMetrics } from "./types";

export const TRADING_DAYS_PER_YEAR = 252;

/** Drop NaNs and reject empty input, which has no meaningful statistics. */
function clean(values: number[], funcName: string): number[] {
  const cleaned = values.filter((v) => !Number.isNaN(v));
  if (cleaned.length === 0) {
    throw new Error(`${funcName} requires at least one non-NaN observation`);
  }
  return cleaned;
}

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/** Sample standard deviation (ddof = 1); NaN for fewer than two observations. */
function sampleStd(values: number[]): number {
  if (values.length < 2) {
    return Number.NaN;
  }
  const m = mean(values);
  let ss = 0;
  for (const v of values) {
    const d = v - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * Compound annual growth rate of a periodic return series. Elapsed time is
 * observation count over `periodsPerYear`, not calendar dates. If compounding
 * wipes out the capital (total growth factor <= 0), -1.0 is returned, meaning
 * a total loss; the true annualized figure is undefined in that case.
 */
export function cagr(returns: number[], periodsPerYear: number = TRADING_DAYS_PER_YEAR): number {
  const r = clean(returns, "cagr");
  let total = 1.0;
  for (const v of r) {
    total *= 1.0 + v;
  }
  if (total <= 0.0) {
    return -1.0;
  }
  const years = r.length / periodsPerYear;
  return Math.pow(total, 1.0 / years) - 1.0;
}

/**
 * Annualized volatility: sample standard deviation scaled by
 * sqrt(periodsPerYear). NaN for a single observation, where a sample standard
 * deviation is undefined.
 */
export function annVol(returns: number[], periodsPerYear: number = TRADING_DAYS_PER_YEAR): number {
  const r = clean(returns, "annVol");
  return sampleStd(r) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized Sharpe ratio with a zero risk-free rate: mean over sample
 * standard deviation, scaled by sqrt(periodsPerYear). A constant series has
 * zero volatility by definition, so the ratio is +Infinity for a positive
 * mean, -Infinity for a negative mean, and NaN when the mean is also zero.
 * The constant case is detected explicitly because the computed deviation of
 * n identical floats can come back as rounding noise instead of exactly zero.
 */
export function sharpe(returns: number[], periodsPerYear: number = TRADING_DAYS_PER_YEAR): number {
  const r = clean(returns, "sharpe");
  const m = mean(r);
  const constant = r.every((v) => v === r[0]);
  const std = constant ? 0.0 : sampleStd(r);
  if (Number.isNaN(std)) {
    return Number.NaN;
  }
  if (std === 0.0) {
    if (m > 0.0) {
      return Number.POSITIVE_INFINITY;
    }
    if (m < 0.0) {
      return Number.NEGATIVE_INFINITY;
    }
    return Number.NaN;
  }
  return (m / std) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized Sortino ratio with a zero target return. The downside deviation
 * is sqrt(mean(min(r, 0)^2)) over ALL observations, not just the losing ones;
 * this full-sample convention yields a lower (more conservative) downside
 * deviation than averaging over losing periods only, so do not compare this
 * number against Sortino ratios computed under a different convention. A
 * series with no negative returns gives +Infinity for a positive mean and NaN
 * otherwise.
 */
export function sortino(returns: number[], periodsPerYear: number = TRADING_DAYS_PER_YEAR): number {
  const r = clean(returns, "sortino");
  const m = mean(r);
  let ss = 0;
  for (const v of r) {
    const d = v < 0 ? v : 0;
    ss += d * d;
  }
  const downsideDev = Math.sqrt(ss / r.length);
  if (downsideDev === 0.0) {
    return m > 0.0 ? Number.POSITIVE_INFINITY : Number.NaN;
  }
  return (m / downsideDev) * Math.sqrt(periodsPerYear);
}

/**
 * Worst peak-to-trough decline of an equity curve. `depth` is the positive
 * fraction lost from the peak. `durationDays` covers peak to trough in
 * calendar days only; it says nothing about recovery.
 */
export interface MaxDrawdown {
  depth: number;
  peak: string;
  trough: string;
  durationDays: number;
}

/** Index of the first minimum (ties keep the earliest, like idxmin). */
function firstMinIndex(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[best]!) {
      best = i;
    }
  }
  return best;
}

/** Index of the first maximum within values[0..end], ties keep the earliest. */
function firstMaxIndex(values: number[], end: number): number {
  let best = 0;
  for (let i = 1; i <= end; i++) {
    if (values[i]! > values[best]!) {
      best = i;
    }
  }
  return best;
}

/** Running-peak drawdown series of an equity curve: equity / cummax - 1. */
function drawdownSeries(equity: number[]): number[] {
  const out = new Array<number>(equity.length);
  let runMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!;
    if (v > runMax) {
      runMax = v;
    }
    out[i] = v / runMax - 1.0;
  }
  return out;
}

/**
 * Locate the maximum drawdown of an equity curve. Expects a strictly positive
 * series; NaN observations are dropped together with their dates. If the
 * curve never declines, depth is 0.0 and peak/trough both point at the first
 * observation. Ties are broken by the earliest trough and the earliest peak
 * preceding it. Duration is calendar days between the two dates.
 */
export function maxDrawdown(equity: number[], dates: string[]): MaxDrawdown {
  if (equity.length !== dates.length) {
    throw new Error("maxDrawdown requires equity and dates of equal length");
  }
  const eq: number[] = [];
  const ds: string[] = [];
  for (let i = 0; i < equity.length; i++) {
    if (!Number.isNaN(equity[i]!)) {
      eq.push(equity[i]!);
      ds.push(dates[i]!);
    }
  }
  if (eq.length === 0) {
    throw new Error("maxDrawdown requires at least one non-NaN observation");
  }
  const dd = drawdownSeries(eq);
  const troughIdx = firstMinIndex(dd);
  const depth = -dd[troughIdx]!;
  const peakIdx = firstMaxIndex(eq, troughIdx);
  return {
    depth,
    peak: ds[peakIdx]!,
    trough: ds[troughIdx]!,
    durationDays: dateDiffDays(ds[peakIdx]!, ds[troughIdx]!),
  };
}

/** Calendar days from one ISO "YYYY-MM-DD" date to another. */
function dateDiffDays(from: string, to: string): number {
  return Math.round((parseDateUTC(to) - parseDateUTC(from)) / 86_400_000);
}

function parseDateUTC(iso: string): number {
  const parts = iso.split("-");
  if (parts.length !== 3) {
    throw new Error(`expected an ISO YYYY-MM-DD date, got "${iso}"`);
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`expected an ISO YYYY-MM-DD date, got "${iso}"`);
  }
  return Date.UTC(y, m - 1, d);
}

/**
 * Calmar ratio: CAGR divided by maximum drawdown depth, the equity curve
 * rebuilt by compounding the return series. A series that never draws down
 * gives +Infinity for positive growth and NaN for zero growth. The ratio is
 * driven entirely by the single worst episode, so it is noisy on short
 * histories.
 */
export function calmar(returns: number[], periodsPerYear: number = TRADING_DAYS_PER_YEAR): number {
  const r = clean(returns, "calmar");
  const growth = cagr(r, periodsPerYear);
  const equity = new Array<number>(r.length);
  let acc = 1.0;
  for (let i = 0; i < r.length; i++) {
    acc *= 1.0 + r[i]!;
    equity[i] = acc;
  }
  const dd = drawdownSeries(equity);
  const depth = -dd[firstMinIndex(dd)]!;
  if (depth === 0.0) {
    return growth > 0.0 ? Number.POSITIVE_INFINITY : Number.NaN;
  }
  return growth / depth;
}

/**
 * Fraction of winning periods: wins / (wins + losses). Zero-return periods
 * are excluded from both sides so stretches with no position do not distort
 * the rate; NaN when every period is zero. A high hit rate does not imply
 * profitability if losses run larger than gains.
 */
export function hitRate(returns: number[]): number {
  const r = clean(returns, "hitRate");
  let wins = 0;
  let losses = 0;
  for (const v of r) {
    if (v > 0.0) {
      wins += 1;
    } else if (v < 0.0) {
      losses += 1;
    }
  }
  const total = wins + losses;
  if (total === 0) {
    return Number.NaN;
  }
  return wins / total;
}

/** The standard scalar metrics block for a net return series and its equity curve. */
export function summaryMetrics(
  netReturns: number[],
  equity: number[],
  dates: string[],
): SummaryMetrics {
  const dd = maxDrawdown(equity, dates);
  return {
    cagr: cagr(netReturns),
    annVol: annVol(netReturns),
    sharpe: sharpe(netReturns),
    sortino: sortino(netReturns),
    maxDrawdown: dd.depth,
    maxDrawdownPeak: dd.peak,
    maxDrawdownTrough: dd.trough,
    maxDrawdownDays: dd.durationDays,
    calmar: calmar(netReturns),
    hitRate: hitRate(netReturns),
  };
}
