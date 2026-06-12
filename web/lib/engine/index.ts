/**
 * Public surface of the engine port. Everything here is pure computation —
 * no DOM, no fetch, no storage — and is held to 1e-8 relative parity with the
 * reference Python engine by web/test/parity.test.ts.
 */

export type { Matrix } from "./frame";
export { colCount, pctChange, rowCount } from "./frame";
export type { BacktestResult, PricePanel, SummaryMetrics } from "./types";
export {
  TRADING_DAYS_PER_YEAR,
  annVol,
  cagr,
  calmar,
  hitRate,
  maxDrawdown,
  sharpe,
  sortino,
  summaryMetrics,
} from "./metrics";
export type { MaxDrawdown } from "./metrics";
export { dmaWeights, meanrevWeights, tsmomWeights, xsmomWeights } from "./strategies";
export { capWeights, volTarget } from "./risk";
export { benchmarkEquity, runBacktest } from "./backtest";
export type { BacktestOptions } from "./backtest";
export {
  BLEND_MEMBERS,
  DEFAULT_BLEND_PARAMS,
  RISK_TARGET_VOL,
  averageMemberWeights,
  blendWeights,
  blendWeightsForRisk,
} from "./blend";
export type { BlendParams, RiskLevel } from "./blend";
