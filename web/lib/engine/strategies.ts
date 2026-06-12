/**
 * Strategy weight generators ported from quantdesk/strategies.py.
 *
 * Shared timing convention: the weight in row t may use information up to and
 * including row t only. The backtest engine applies that weight from row
 * t + 1, so strategies must not shift their own output. All strategies are
 * long-only and keep each row's sum of absolute weights at or below 1.0; days
 * without a qualifying signal simply hold cash. Window parameters are in
 * trading days.
 */

import {
  type Matrix,
  colCount,
  filled,
  pctChange,
  rollingMeanCols,
  rollingStdCols,
} from "./frame";

/**
 * Per-asset return over the window from `lookback` days ago to `skip` days
 * ago: closes[t - skip] / closes[t - lookback] - 1. Both endpoints lie at or
 * before the current row, so the measure is free of lookahead by
 * construction. Rows without enough history are NaN.
 */
function windowReturn(closes: Matrix, lookback: number, skip: number): Matrix {
  const n = closes.length;
  const c = colCount(closes);
  const out = filled(n, c, Number.NaN);
  for (let t = lookback; t < n; t++) {
    const num = closes[t - skip]!;
    const den = closes[t - lookback]!;
    const dst = out[t]!;
    for (let j = 0; j < c; j++) {
      const a = num[j]!;
      const b = den[j]!;
      dst[j] = Number.isNaN(a) || Number.isNaN(b) ? Number.NaN : a / b - 1.0;
    }
  }
  return out;
}

/**
 * Force weight 0 wherever the asset has no price on that day. A signal built
 * purely from past prices can otherwise assign weight to an asset that is
 * missing from today's data, which a real rebalance could not trade. This
 * also guarantees the output contains no NaNs. Mutates and returns `weights`.
 */
function zeroUnpriced(weights: Matrix, closes: Matrix): Matrix {
  for (let t = 0; t < weights.length; t++) {
    const w = weights[t]!;
    const p = closes[t]!;
    for (let j = 0; j < w.length; j++) {
      if (Number.isNaN(p[j]!)) {
        w[j] = 0.0;
      }
    }
  }
  return weights;
}

/**
 * Time-series momentum: hold each asset whose own trailing return is
 * positive, at a fixed 1/N. The momentum measure for row t is the return from
 * t - lookback to t - skip; the skip gap sidesteps the well-documented
 * one-month reversal in equities.
 *
 * Known failure modes: sharp V-shaped reversals (still long after the peak,
 * flat after the bottom), choppy sideways markets where the signal flips and
 * costs compound, and parameter sensitivity. Because each asset is sized at
 * 1/N regardless of how many qualify, broad bear markets push the book toward
 * cash, which protects capital but forfeits rebounds.
 */
export function tsmomWeights(closes: Matrix, lookback = 252, skip = 21): Matrix {
  if (skip < 0) {
    throw new Error("skip must be non-negative");
  }
  if (lookback <= skip) {
    throw new Error("lookback must be greater than skip");
  }
  const momentum = windowReturn(closes, lookback, skip);
  const nAssets = Math.max(colCount(closes), 1);
  const weights = momentum.map((row) => row.map((v) => (v > 0.0 ? 1.0 / nAssets : 0.0)));
  return zeroUnpriced(weights, closes);
}

/**
 * Cross-sectional momentum: equal-weight the `topN` assets ranked by
 * skip-adjusted momentum, long only. Ranking strips out the common market
 * component that dominates single-asset returns.
 *
 * Known failure modes: momentum crashes after a market collapse (the prior
 * losers rally hardest); because this variant is long only and always fully
 * ranked, it stays invested through bear markets holding the least-bad losers
 * rather than going to cash. Turnover is high near rank boundaries, so costs
 * matter. When fewer than topN assets have enough history the remainder sits
 * in cash. Ties are broken by column order, which is arbitrary.
 */
export function xsmomWeights(closes: Matrix, lookback = 252, skip = 21, topN = 5): Matrix {
  if (skip < 0) {
    throw new Error("skip must be non-negative");
  }
  if (lookback <= skip) {
    throw new Error("lookback must be greater than skip");
  }
  if (topN < 1) {
    throw new Error("topN must be at least 1");
  }
  const momentum = windowReturn(closes, lookback, skip);
  const n = closes.length;
  const c = colCount(closes);
  const weights = filled(n, c, 0.0);
  for (let t = 0; t < n; t++) {
    const row = momentum[t]!;
    const ranked: { j: number; v: number }[] = [];
    for (let j = 0; j < c; j++) {
      const v = row[j]!;
      if (!Number.isNaN(v)) {
        ranked.push({ j, v });
      }
    }
    // Descending by momentum; Array.prototype.sort is stable, so equal values
    // keep column order, matching rank(ascending=False, method="first").
    ranked.sort((a, b) => b.v - a.v);
    const dst = weights[t]!;
    const held = Math.min(topN, ranked.length);
    for (let k = 0; k < held; k++) {
      dst[ranked[k]!.j] = 1.0 / topN;
    }
  }
  return zeroUnpriced(weights, closes);
}

/**
 * Dual moving average: hold each asset at 1/N while its fast moving average
 * exceeds its slow one. The crossover is a crude trend filter whose real
 * value is risk management — historically it has kept portfolios out of the
 * deepest drawdowns. Two parameters leave little room for overfitting.
 *
 * Known failure modes: whipsaws in range-bound markets, and structural
 * lateness — the filter gives up the start of every trend and rides every
 * peak partway down. The signal is binary and says nothing about conviction.
 */
export function dmaWeights(closes: Matrix, fast = 50, slow = 200): Matrix {
  if (fast < 1) {
    throw new Error("fast must be at least 1");
  }
  if (slow <= fast) {
    throw new Error("slow must be greater than fast");
  }
  const fastMa = rollingMeanCols(closes, fast);
  const slowMa = rollingMeanCols(closes, slow);
  const nAssets = Math.max(colCount(closes), 1);
  const weights = fastMa.map((row, t) =>
    row.map((f, j) => (f > slowMa[t]![j]! ? 1.0 / nAssets : 0.0)),
  );
  return zeroUnpriced(weights, closes);
}

/**
 * Mean reversion: buy short-term oversold assets and hold until the
 * dislocation closes. The `shortWindow` return is converted to a z-score
 * against its own trailing `zWindow` history; a position opens when the
 * z-score drops below `entryZ` and closes when it crosses above zero. Capital
 * splits equally among assets currently in a position.
 *
 * Known failure modes: catching falling knives — an extreme negative z-score
 * is sometimes real news with no mean to revert to; persistent losses in
 * trending regimes; and a single live signal receives the entire book, which
 * concentrates risk on precisely the most distressed asset. This strategy is
 * ported for parity with the reference engine and is deliberately not part of
 * the product blend (see blend.ts for the numbers behind that exclusion).
 */
export function meanrevWeights(
  closes: Matrix,
  zWindow = 60,
  shortWindow = 5,
  entryZ = -1.5,
): Matrix {
  if (zWindow < 2) {
    throw new Error("zWindow must be at least 2 to compute a standard deviation");
  }
  if (shortWindow < 1) {
    throw new Error("shortWindow must be at least 1");
  }
  if (entryZ >= 0) {
    throw new Error("entryZ must be negative; entries trigger below it and exits above zero");
  }
  const n = closes.length;
  const c = colCount(closes);
  const shortRet = pctChange(closes, shortWindow);
  const rollMean = rollingMeanCols(shortRet, zWindow);
  const rollStd = rollingStdCols(shortRet, zWindow);
  // Between the entry and exit thresholds (or while the z-score is undefined)
  // the previous state carries forward; before any state exists the position
  // is flat. NaN fails both comparisons, so it carries the state forward.
  const held = filled(n, c, 0.0);
  for (let j = 0; j < c; j++) {
    let state = 0.0;
    for (let t = 0; t < n; t++) {
      const z = (shortRet[t]![j]! - rollMean[t]![j]!) / rollStd[t]![j]!;
      if (z < entryZ) {
        state = 1.0;
      } else if (z > 0.0) {
        state = 0.0;
      }
      held[t]![j] = state;
    }
  }
  const weights = filled(n, c, 0.0);
  for (let t = 0; t < n; t++) {
    const src = held[t]!;
    let count = 0.0;
    for (let j = 0; j < c; j++) {
      count += src[j]!;
    }
    if (count > 0.0) {
      const dst = weights[t]!;
      for (let j = 0; j < c; j++) {
        dst[j] = src[j]! / count;
      }
    }
  }
  return zeroUnpriced(weights, closes);
}
