/**
 * The Why page's single integration point with the shared engine: split the
 * benchmark out of a fetched panel, run the exact blend pipeline at the
 * user's risk setting, and backtest it with the engine's default costs
 * (commission 1 bp + slippage 2 bps, matching the Python engine).
 */

import { runBacktest } from "@/lib/engine/backtest";
import { blendWeightsForRisk } from "@/lib/engine/blend";
import type { SummaryMetrics } from "@/lib/engine/types";
import { BENCHMARK_TICKER, type PricePanel } from "@/lib/fetch-prices";
import type { Risk } from "@/lib/store";

import { last } from "./series";

export interface WhyComputation {
  dates: string[];
  equity: number[];
  netReturns: number[];
  metrics: SummaryMetrics;
  /** SPY growth-of-$1 over the same window; null when SPY is absent. */
  benchmarkEquity: number[] | null;
  strategyTickers: string[];
  /** The blend's target weights on the final day (the position carried into "today"). */
  lastWeights: number[];
  /** Final close per strategy ticker (NaN where missing), the base for live marking. */
  lastCloses: number[];
  spyLastClose: number | null;
  risk: Risk;
}

/** JSON encodes missing prices as null; the engine expects NaN. */
function toFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Run the exact blend pipeline over a fetched price panel. The benchmark
 * column (SPY) is split out before the strategies see the panel, so the
 * blend trades only the 20-stock universe, exactly like the CLI.
 */
export function computeWhyBacktest(panel: PricePanel, risk: Risk): WhyComputation {
  const spyIndex = panel.tickers.indexOf(BENCHMARK_TICKER);
  const strategyTickers: string[] = [];
  const keep: number[] = [];
  for (let j = 0; j < panel.tickers.length; j++) {
    const ticker = panel.tickers[j];
    if (ticker !== undefined && j !== spyIndex) {
      strategyTickers.push(ticker);
      keep.push(j);
    }
  }

  const strategyCloses = panel.closes.map((row) => keep.map((j) => toFinite(row[j])));
  const benchmarkCloses =
    spyIndex >= 0 ? panel.closes.map((row) => toFinite(row[spyIndex])) : undefined;

  const strategyPanel = {
    dates: panel.dates,
    tickers: strategyTickers,
    closes: strategyCloses,
  };

  const weights = blendWeightsForRisk(strategyPanel, risk);
  const result = runBacktest(strategyPanel, weights, { benchmarkCloses });

  const spyLast = benchmarkCloses === undefined ? undefined : last(benchmarkCloses);

  return {
    dates: panel.dates,
    equity: result.equity,
    netReturns: result.netReturns,
    metrics: result.metrics,
    benchmarkEquity: result.benchmarkEquity ?? null,
    strategyTickers,
    lastWeights: last(weights) ?? [],
    lastCloses: last(strategyCloses) ?? [],
    spyLastClose: spyLast !== undefined && Number.isFinite(spyLast) ? spyLast : null,
    risk,
  };
}
