/**
 * Daily close-to-close backtest engine, ported from quantdesk/backtest.py.
 *
 * Engine convention, for a price panel and a weight matrix sharing the same
 * rows (dates) and columns (tickers):
 *
 * - rets = pctChange(closes), with the first row (and any missing entry)
 *   treated as zero return;
 * - weightsUsed = weights shifted down one row and filled with 0, so a weight
 *   decided at the close of day t earns day t + 1 returns and can never touch
 *   the return of the day it was decided on;
 * - gross_t = sum(weightsUsed_t * rets_t);
 * - turnover_t = sum(abs(weights_t - weights_{t-1})) on the decision-day
 *   weights, with the day before the first day treated as all-zero (entering
 *   the initial position is a trade and is charged);
 * - cost_t = turnover_t * (commissionBps + slippageBps) / 10000, charged on
 *   day t;
 * - net = gross - cost; equity = cumprod(1 + net).
 *
 * This simulation ignores intraday fills, market impact beyond a flat
 * slippage haircut, borrow and financing costs, and dividends/splits unless
 * the input prices are already adjusted. Results are research estimates, not
 * achievable returns.
 */

import { type Matrix, colCount, pctChange } from "./frame";
import { summaryMetrics } from "./metrics";
import type { BacktestResult, PricePanel } from "./types";

export interface BacktestOptions {
  commissionBps?: number;
  slippageBps?: number;
  /**
   * Benchmark closes aligned to the panel's dates (NaN where missing). When
   * provided, the result carries a benchmark equity curve normalized to 1.0
   * at the start of the backtest, built from forward-filled prices.
   */
  benchmarkCloses?: number[];
}

/**
 * Run the daily backtest described in the module comment. `weights` must be
 * positionally aligned with the panel (same row and column counts); since
 * matrices carry no labels, misaligned shapes are rejected rather than
 * reindexed. NaN weights are treated as flat (0). The engine does not enforce
 * a leverage limit; keeping each row's sum of absolute weights within bounds
 * is the caller's responsibility (see the strategy contract and the risk
 * overlays).
 *
 * Leading NaNs in a price column (history before a late listing) are allowed
 * and contribute zero return while the asset has no price. NaNs after a
 * column's first observation are rejected: turning such a gap into a zero
 * return would let a held position skip the entire gap move and exit at the
 * last seen price with no loss and no cost, which silently flatters results.
 * Callers must fill or drop those gaps first.
 */
export function runBacktest(
  panel: PricePanel,
  weights: Matrix,
  options: BacktestOptions = {},
): BacktestResult {
  const { commissionBps = 1.0, slippageBps = 2.0, benchmarkCloses } = options;
  const closes = panel.closes;
  const n = closes.length;
  const c = colCount(closes);
  if (n === 0 || c === 0) {
    throw new Error("runBacktest requires a non-empty price panel");
  }
  if (panel.dates.length !== n) {
    throw new Error("panel dates and closes row counts differ");
  }
  if (weights.length !== n || colCount(weights) !== c) {
    throw new Error("weights must share the price panel's shape");
  }

  const gapTickers: string[] = [];
  for (let j = 0; j < c; j++) {
    let seen = false;
    for (let t = 0; t < n; t++) {
      const v = closes[t]![j]!;
      if (Number.isNaN(v)) {
        if (seen) {
          gapTickers.push(panel.tickers[j] ?? `column ${j}`);
          break;
        }
      } else {
        seen = true;
      }
    }
  }
  if (gapTickers.length > 0) {
    throw new Error(
      "prices contain NaN gaps after the first observation for: " +
        gapTickers.join(", ") +
        "; fill or drop these gaps before running the backtest",
    );
  }

  const rets = pctChange(closes);
  const costRate = (commissionBps + slippageBps) / 10000.0;
  const netReturns = new Array<number>(n);
  const equity = new Array<number>(n);
  const turnover = new Array<number>(n);
  const costs = new Array<number>(n);
  const weightsUsed: Matrix = new Array<number[]>(n);
  let acc = 1.0;
  for (let t = 0; t < n; t++) {
    const decided = weights[t]!;
    const prev = t >= 1 ? weights[t - 1]! : undefined;
    const r = rets[t]!;
    const used = new Array<number>(c);
    let grossReturn = 0.0;
    let turn = 0.0;
    for (let j = 0; j < c; j++) {
      const prevW = prev === undefined ? 0.0 : nanToZero(prev[j]!);
      used[j] = prevW;
      const ret = r[j]!;
      grossReturn += prevW * (Number.isNaN(ret) ? 0.0 : ret);
      turn += Math.abs(nanToZero(decided[j]!) - prevW);
    }
    weightsUsed[t] = used;
    turnover[t] = turn;
    const cost = turn * costRate;
    costs[t] = cost;
    const net = grossReturn - cost;
    netReturns[t] = net;
    acc *= 1.0 + net;
    equity[t] = acc;
  }

  const result: BacktestResult = {
    netReturns,
    equity,
    weightsUsed,
    turnover,
    costs,
    metrics: summaryMetrics(netReturns, equity, panel.dates),
  };
  if (benchmarkCloses !== undefined) {
    result.benchmarkEquity = benchmarkEquity(benchmarkCloses, n);
  }
  return result;
}

/**
 * Benchmark equity curve normalized to 1.0 on the first backtest day:
 * forward-fill the benchmark closes, take daily returns with missing entries
 * as zero, and compound. Leading days with no benchmark price stay at 1.0.
 */
export function benchmarkEquity(benchCloses: number[], expectedLength?: number): number[] {
  if (expectedLength !== undefined && benchCloses.length !== expectedLength) {
    throw new Error("benchmark closes must align with the panel dates");
  }
  const out = new Array<number>(benchCloses.length);
  let lastPrice = Number.NaN;
  let acc = 1.0;
  for (let t = 0; t < benchCloses.length; t++) {
    const raw = benchCloses[t]!;
    const price = Number.isNaN(raw) ? lastPrice : raw;
    const ret = Number.isNaN(price) || Number.isNaN(lastPrice) ? 0.0 : price / lastPrice - 1.0;
    acc *= 1.0 + ret;
    out[t] = acc;
    lastPrice = price;
  }
  return out;
}

function nanToZero(v: number): number {
  return Number.isNaN(v) ? 0.0 : v;
}
