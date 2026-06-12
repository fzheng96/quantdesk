/**
 * Parity tests: the TypeScript engine must reproduce the Python engine.
 *
 * test/fixtures/parity.json is produced by scripts/make_parity_fixtures.py
 * at the repo root from the reference Python engine: a seeded synthetic price
 * panel plus, for each strategy and for the blend pipeline, the
 * Python-computed target weights, net returns, equity curve, and summary
 * metrics. Every series must match within 1e-8 relative tolerance. This is
 * the proof that the engine running in the browser is the same engine the
 * repository's Python test suite audits.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { runBacktest } from "../lib/engine/backtest";
import { averageMemberWeights, blendWeights } from "../lib/engine/blend";
import {
  dmaWeights,
  meanrevWeights,
  tsmomWeights,
  xsmomWeights,
} from "../lib/engine/strategies";
import type { PricePanel, SummaryMetrics } from "../lib/engine/types";

const RTOL = 1e-8;
// The absolute floor only matters where the expected value is exactly zero
// (for example, warm-up weights), where both engines produce exact zeros.
const ATOL = 1e-12;

type FixtureMetrics = SummaryMetrics;

interface FixtureBlock {
  weights: number[][];
  netReturns: number[];
  equity: number[];
  metrics: FixtureMetrics;
}

interface Fixture {
  description: string;
  seed: number;
  costs: { commissionBps: number; slippageBps: number };
  panel: { dates: string[]; tickers: string[]; closes: number[][] };
  strategies: Record<"tsmom" | "xsmom" | "dma" | "meanrev", FixtureBlock>;
  blend: FixtureBlock & { averagedWeights: number[][] };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"),
) as Fixture;

const panel: PricePanel = fixture.panel;
const costs = {
  commissionBps: fixture.costs.commissionBps,
  slippageBps: fixture.costs.slippageBps,
};

function assertClose(actual: number, expected: number, label: string): void {
  const diff = Math.abs(actual - expected);
  const bound = ATOL + RTOL * Math.abs(expected);
  if (!(diff <= bound)) {
    throw new Error(`${label}: got ${actual}, expected ${expected} (|diff| ${diff} > ${bound})`);
  }
}

function assertSeriesClose(actual: number[], expected: number[], label: string): void {
  expect(actual.length, `${label} length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    assertClose(actual[i]!, expected[i]!, `${label}[${i}]`);
  }
}

function assertMatrixClose(actual: number[][], expected: number[][], label: string): void {
  expect(actual.length, `${label} row count`).toBe(expected.length);
  for (let t = 0; t < expected.length; t++) {
    const a = actual[t]!;
    const e = expected[t]!;
    expect(a.length, `${label} row ${t} width`).toBe(e.length);
    for (let j = 0; j < e.length; j++) {
      assertClose(a[j]!, e[j]!, `${label}[${t}][${j}]`);
    }
  }
}

function assertMetricsClose(actual: SummaryMetrics, expected: FixtureMetrics): void {
  assertClose(actual.cagr, expected.cagr, "metrics.cagr");
  assertClose(actual.annVol, expected.annVol, "metrics.annVol");
  assertClose(actual.sharpe, expected.sharpe, "metrics.sharpe");
  assertClose(actual.sortino, expected.sortino, "metrics.sortino");
  assertClose(actual.maxDrawdown, expected.maxDrawdown, "metrics.maxDrawdown");
  assertClose(actual.calmar, expected.calmar, "metrics.calmar");
  assertClose(actual.hitRate, expected.hitRate, "metrics.hitRate");
  expect(actual.maxDrawdownPeak).toBe(expected.maxDrawdownPeak);
  expect(actual.maxDrawdownTrough).toBe(expected.maxDrawdownTrough);
  expect(actual.maxDrawdownDays).toBe(expected.maxDrawdownDays);
}

function checkStrategy(key: keyof Fixture["strategies"], weights: number[][]): void {
  const expected = fixture.strategies[key];
  assertMatrixClose(weights, expected.weights, `${key} weights`);
  const result = runBacktest(panel, weights, costs);
  assertSeriesClose(result.netReturns, expected.netReturns, `${key} netReturns`);
  assertSeriesClose(result.equity, expected.equity, `${key} equity`);
  assertMetricsClose(result.metrics, expected.metrics);
}

describe("parity with the Python engine (1e-8 relative tolerance)", () => {
  test("fixture sanity", () => {
    expect(panel.dates.length).toBe(panel.closes.length);
    expect(panel.tickers.length).toBe(panel.closes[0]!.length);
    expect(panel.dates.length).toBeGreaterThan(252);
  });

  test("tsmom: weights, net returns, equity, metrics", () => {
    checkStrategy("tsmom", tsmomWeights(panel.closes));
  });

  test("xsmom: weights, net returns, equity, metrics", () => {
    checkStrategy("xsmom", xsmomWeights(panel.closes));
  });

  test("dma: weights, net returns, equity, metrics", () => {
    checkStrategy("dma", dmaWeights(panel.closes));
  });

  test("meanrev: weights, net returns, equity, metrics", () => {
    checkStrategy("meanrev", meanrevWeights(panel.closes));
  });

  test("blend: averaged member weights match", () => {
    assertMatrixClose(
      averageMemberWeights(panel),
      fixture.blend.averagedWeights,
      "blend averagedWeights",
    );
  });

  test("blend: full pipeline weights, net returns, equity, metrics", () => {
    const weights = blendWeights(panel);
    assertMatrixClose(weights, fixture.blend.weights, "blend weights");
    const result = runBacktest(panel, weights, costs);
    assertSeriesClose(result.netReturns, fixture.blend.netReturns, "blend netReturns");
    assertSeriesClose(result.equity, fixture.blend.equity, "blend equity");
    assertMetricsClose(result.metrics, fixture.blend.metrics);
  });
});
