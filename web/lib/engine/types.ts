/** Shared engine data shapes. The engine is pure: no DOM, no fetch, no state. */

/**
 * Close prices as parallel arrays. `closes` is row-major by date:
 * closes[dateIndex][tickerIndex]. Dates are ISO "YYYY-MM-DD" strings in
 * ascending order. NaN in `closes` marks a missing price (for example,
 * history before a late listing); JSON sources that encode missing values as
 * null must convert them to NaN before calling the engine.
 */
export interface PricePanel {
  dates: string[];
  tickers: string[];
  closes: number[][];
}

/**
 * Scalar summary statistics of a backtest. `maxDrawdown` is the depth of the
 * worst peak-to-trough decline as a positive fraction (0.25 means a 25%
 * loss), `maxDrawdownDays` is the calendar-day span from peak to trough.
 * Ratios can be Infinity or NaN in degenerate cases (for example, the Sharpe
 * ratio of a constant return series); display code must guard for that.
 */
export interface SummaryMetrics {
  cagr: number;
  annVol: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  maxDrawdownPeak: string;
  maxDrawdownTrough: string;
  maxDrawdownDays: number;
  calmar: number;
  hitRate: number;
}

/**
 * Output of a single backtest run. All series align with the input panel's
 * dates. `weightsUsed` are the weights that earned each day's return (the
 * decision weights shifted forward one day). `benchmarkEquity` is present
 * only when benchmark closes were supplied, normalized to 1.0 at the start.
 */
export interface BacktestResult {
  netReturns: number[];
  equity: number[];
  weightsUsed: number[][];
  turnover: number[];
  costs: number[];
  metrics: SummaryMetrics;
  benchmarkEquity?: number[];
}
