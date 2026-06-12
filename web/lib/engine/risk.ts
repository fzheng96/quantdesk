/**
 * Risk overlays applied to strategy weights, ported from quantdesk/risk.py.
 *
 * Every function is a pure transformation: weights and prices go in, adjusted
 * weights come out. The overlays respect the engine convention (a weight
 * decided at the close of day t earns day t + 1 returns), and volatility
 * targeting additionally lags its estimate by one day so that no multiplier
 * depends on the return of the day it is applied to.
 */

import { type Matrix, colCount, pctChange, rollingStdVec } from "./frame";
import { TRADING_DAYS_PER_YEAR } from "./metrics";

/**
 * Scale daily weights so the strategy targets a constant annualized
 * volatility. The strategy's gross daily returns are reconstructed under the
 * engine convention (weights shifted one day before earning returns).
 * Realized volatility is the rolling `lookback`-day sample standard deviation
 * of those gross returns, annualized with sqrt(252). The multiplier for day t
 * is `targetAnnualVol` divided by the realized volatility measured through
 * day t - 1; that extra one-day lag guarantees the multiplier never uses the
 * return of the day it is applied to. Multipliers are clipped at
 * `maxLeverage`. During warm-up, before a full lookback window of returns
 * exists, weights pass through scaled by min(1, maxLeverage).
 *
 * Limitations stated honestly: the estimate is backward looking, so the
 * overlay reacts to volatility spikes only after they have begun, and it
 * raises exposure in calm markets — exactly when crowded strategies are most
 * vulnerable to a regime change. Volatility is measured on the unscaled
 * strategy in a single pass, so the scaled strategy hits the target only
 * approximately.
 */
export function volTarget(
  weights: Matrix,
  closes: Matrix,
  targetAnnualVol = 0.10,
  lookback = 20,
  maxLeverage = 1.0,
): Matrix {
  if (targetAnnualVol <= 0) {
    throw new Error("targetAnnualVol must be positive");
  }
  if (lookback < 2) {
    throw new Error("lookback must be at least 2 to compute a standard deviation");
  }
  if (maxLeverage <= 0) {
    throw new Error("maxLeverage must be positive");
  }
  const n = closes.length;
  const c = colCount(closes);
  if (weights.length !== n || colCount(weights) !== c) {
    throw new Error("weights and closes must share the same shape");
  }

  // Gross daily returns of the unscaled strategy. Missing returns contribute
  // nothing (the reference engine's row sum skips NaN terms), and a missing
  // weight counts as flat.
  const rets = pctChange(closes);
  const gross = new Array<number>(n).fill(0.0);
  for (let t = 1; t < n; t++) {
    const r = rets[t]!;
    const w = weights[t - 1]!;
    let sum = 0.0;
    for (let j = 0; j < c; j++) {
      const ret = r[j]!;
      if (!Number.isNaN(ret)) {
        const wj = w[j]!;
        sum += (Number.isNaN(wj) ? 0.0 : wj) * ret;
      }
    }
    gross[t] = sum;
  }

  const rollStd = rollingStdVec(gross, lookback);
  const sqrtYear = Math.sqrt(TRADING_DAYS_PER_YEAR);
  const warmupScale = Math.min(1.0, maxLeverage);
  const out: Matrix = new Array<number[]>(n);
  for (let t = 0; t < n; t++) {
    // The one-row lag keeps the multiplier for day t a function of returns
    // through day t - 1 only. Where realized volatility is exactly zero the
    // raw ratio is infinite and the clip maps it to maxLeverage.
    const realizedPrev = t >= 1 ? rollStd[t - 1]! * sqrtYear : Number.NaN;
    const raw = targetAnnualVol / realizedPrev;
    const scale = Number.isNaN(raw) ? warmupScale : Math.min(raw, maxLeverage);
    const src = weights[t]!;
    const dst = new Array<number>(c);
    for (let j = 0; j < c; j++) {
      dst[j] = src[j]! * scale;
    }
    out[t] = dst;
  }
  return out;
}

/**
 * Cap each position's absolute weight, then enforce gross exposure of at most
 * 1. Each weight is clipped into [-maxWeight, maxWeight]; if a row's gross
 * exposure (sum of absolute weights) still exceeds 1.0 after clipping, the
 * whole row is scaled down proportionally. Renormalization only ever moves
 * weights downward: exposure removed by the cap is not redistributed, and
 * rows are never scaled up, so every output weight is at most as large in
 * magnitude as its input.
 */
export function capWeights(weights: Matrix, maxWeight = 0.25): Matrix {
  if (maxWeight <= 0) {
    throw new Error("maxWeight must be positive");
  }
  const out: Matrix = new Array<number[]>(weights.length);
  for (let t = 0; t < weights.length; t++) {
    const src = weights[t]!;
    const capped = new Array<number>(src.length);
    let grossExposure = 0.0;
    for (let j = 0; j < src.length; j++) {
      const v = Math.min(Math.max(src[j]!, -maxWeight), maxWeight);
      capped[j] = v;
      grossExposure += Math.abs(v);
    }
    if (grossExposure > 1.0) {
      const factor = 1.0 / grossExposure;
      for (let j = 0; j < capped.length; j++) {
        capped[j] = capped[j]! * factor;
      }
    }
    out[t] = capped;
  }
  return out;
}
