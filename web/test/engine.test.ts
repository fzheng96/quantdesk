/**
 * Unit tests for the engine port: small hand-built panels exercising the
 * semantic corners the parity fixture covers only in aggregate — return and
 * weight timing, turnover charging, warm-up behavior, tie-breaking, state
 * carry-forward, and metric edge cases. Where exact expected values are not
 * derivable by hand, they were computed with the reference Python engine on
 * the same inputs (the same engine that generates the parity fixture).
 */

import { describe, expect, test } from "vitest";

import { benchmarkEquity, runBacktest } from "../lib/engine/backtest";
import { blendWeights, blendWeightsForRisk, RISK_TARGET_VOL } from "../lib/engine/blend";
import { pctChange } from "../lib/engine/frame";
import {
  annVol,
  cagr,
  calmar,
  hitRate,
  maxDrawdown,
  sharpe,
  sortino,
} from "../lib/engine/metrics";
import { capWeights, volTarget } from "../lib/engine/risk";
import {
  dmaWeights,
  meanrevWeights,
  tsmomWeights,
  xsmomWeights,
} from "../lib/engine/strategies";
import type { PricePanel } from "../lib/engine/types";

const NaN_ = Number.NaN;

function panelOf(closes: number[][], tickers?: string[]): PricePanel {
  const width = closes[0]?.length ?? 0;
  return {
    dates: closes.map((_, i) => isoDate(i)),
    tickers: tickers ?? Array.from({ length: width }, (_, j) => `T${j}`),
    closes,
  };
}

/** Sequential weekday-ish dates; only ordering and spacing of 1 day matter here. */
function isoDate(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1 + i));
  return d.toISOString().slice(0, 10);
}

function expectSeriesClose(actual: number[], expected: number[], tol = 1e-10): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(
      tol * Math.max(1, Math.abs(expected[i]!)),
    );
  }
}

function expectMatrixClose(actual: number[][], expected: number[][], tol = 1e-10): void {
  expect(actual.length).toBe(expected.length);
  for (let t = 0; t < expected.length; t++) {
    expectSeriesClose(actual[t]!, expected[t]!, tol);
  }
}

describe("pctChange", () => {
  test("element-wise change with NaN propagation and no forward-filling", () => {
    const out = pctChange([[100], [110], [NaN_], [121]]);
    expect(out[0]![0]).toBeNaN();
    expect(out[1]![0]).toBeCloseTo(0.1, 12);
    expect(out[2]![0]).toBeNaN();
    expect(out[3]![0]).toBeNaN();
  });

  test("multi-period change skips the right number of rows", () => {
    const out = pctChange([[100], [101], [102], [104]], 2);
    expect(out[0]![0]).toBeNaN();
    expect(out[1]![0]).toBeNaN();
    expect(out[2]![0]).toBeCloseTo(0.02, 12);
    expect(out[3]![0]).toBeCloseTo(104 / 101 - 1, 12);
  });
});

describe("runBacktest timing and costs", () => {
  test("a weight decided on day t earns day t+1's return, never day t's", () => {
    // One ticker, weight only on day 0. Day 1's 10% move is earned; day 2's
    // is not. Entering (day 0) and exiting (day 1) each pay 3 bps turnover.
    const panel = panelOf([[100], [110], [121]]);
    const result = runBacktest(panel, [[1], [0], [0]]);
    expectSeriesClose(result.turnover, [1.0, 1.0, 0.0]);
    expectSeriesClose(result.netReturns, [-0.0003, 0.0997000000000001, 0.0]);
    expectSeriesClose(result.equity, [0.9997, 1.09937009, 1.09937009]);
    expectMatrixClose(result.weightsUsed, [[0], [1], [0]]);
  });

  test("the initial position is a trade and is charged on day 0", () => {
    const panel = panelOf([[100], [100], [100]]);
    const result = runBacktest(panel, [[0.5], [0.5], [0.5]]);
    expectSeriesClose(result.turnover, [0.5, 0.0, 0.0]);
    expectSeriesClose(result.costs, [0.5 * 0.0003, 0.0, 0.0]);
  });

  test("leading NaNs contribute zero return; interior gaps are rejected", () => {
    const leading = panelOf([
      [NaN_, 50.0],
      [NaN_, 50.5],
      [100.0, 51.0],
      [101.0, 51.5],
      [102.0, 52.0],
    ]);
    const half = [
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ];
    const result = runBacktest(leading, half);
    expectSeriesClose(result.netReturns, [
      -0.0003, 0.0050000000000000044, 0.004950495049504955, 0.009901960784313713,
      0.009804863981543788,
    ]);
    expectSeriesClose(result.turnover, [1.0, 0.0, 0.0, 0.0, 0.0]);

    const gappy = panelOf([[100.0], [NaN_], [101.0]], ["GAP"]);
    expect(() => runBacktest(gappy, [[0], [0], [0]])).toThrow(/GAP/);
  });

  test("custom costs scale linearly with turnover", () => {
    const panel = panelOf([[100], [100]]);
    const result = runBacktest(panel, [[1], [1]], { commissionBps: 5, slippageBps: 5 });
    expectSeriesClose(result.costs, [0.001, 0.0]);
  });

  test("benchmark equity normalizes to 1.0 at the start and forward-fills", () => {
    expectSeriesClose(benchmarkEquity([100, 110, NaN_, 121]), [1.0, 1.1, 1.1, 1.21]);
    expectSeriesClose(benchmarkEquity([NaN_, 100, 105]), [1.0, 1.0, 1.05]);
  });
});

describe("strategies", () => {
  test("tsmom holds 1/N where the skip-adjusted trailing return is positive", () => {
    // Golden from the reference engine: lookback 3, skip 1, one riser and one
    // faller. The first valid signal row is the lookback row.
    const closes = [
      [100, 100],
      [101, 99],
      [102, 98],
      [103, 97],
      [104, 96],
      [105, 95],
      [106, 94],
      [107, 93],
    ];
    expectMatrixClose(tsmomWeights(closes, 3, 1), [
      [0, 0],
      [0, 0],
      [0, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
    ]);
  });

  test("xsmom breaks rank ties by column order (method='first')", () => {
    // Columns A and B are identical, C is weaker; topN = 1 must always pick
    // A, the earlier column, exactly as the reference rank() does.
    const closes = [
      [100, 100, 100],
      [101, 101, 100.5],
      [102, 102, 101],
      [103, 103, 101.5],
      [104, 104, 102],
      [105, 105, 102.5],
    ];
    expectMatrixClose(xsmomWeights(closes, 3, 0, 1), [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
  });

  test("dma holds while the fast average exceeds the slow average", () => {
    // Golden from the reference engine: fast 2, slow 3, a dip and recovery.
    const closes = [[100], [102], [104], [103], [99], [95], [96], [99], [103], [107]];
    expectMatrixClose(dmaWeights(closes, 2, 3), [
      [0],
      [0],
      [1],
      [1],
      [0],
      [0],
      [0],
      [1],
      [1],
      [1],
    ]);
  });

  test("meanrev enters below entryZ, exits above zero, and never weights flat names", () => {
    // Golden from the reference engine: zWindow 4, shortWindow 1. Column A
    // crashes on day 5 (z far below -1.5, enter with the whole book since it
    // is the only live signal) and bounces enough by day 6 for z to cross
    // zero (exit). Column B is constant: its z-score is never defined (0/0),
    // so the carried state stays flat throughout.
    const closes = [
      [100, 50],
      [100, 50],
      [100, 50],
      [100, 50],
      [100, 50],
      [60, 50],
      [54, 50],
      [52, 50],
      [53, 50],
      [70, 50],
      [90, 50],
      [95, 50],
    ];
    const expected = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [1, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    expectMatrixClose(meanrevWeights(closes, 4, 1, -1.5), expected);
  });

  test("strategies zero out weights where the asset has no price", () => {
    // The faller column has NaN prices late in the sample; even though its
    // momentum signal (computed from earlier prices) could fire, the weight
    // must be zero on unpriced days. Use a riser so the signal is live.
    const closes = [[100], [101], [102], [103], [NaN_], [NaN_]];
    const weights = tsmomWeights(closes, 3, 1);
    expect(weights[4]![0]).toBe(0);
    expect(weights[5]![0]).toBe(0);
  });

  test("parameter validation mirrors the reference engine", () => {
    expect(() => tsmomWeights([[1]], 5, 5)).toThrow(/lookback/);
    expect(() => tsmomWeights([[1]], 5, -1)).toThrow(/skip/);
    expect(() => xsmomWeights([[1]], 5, 1, 0)).toThrow(/topN/);
    expect(() => dmaWeights([[1]], 10, 10)).toThrow(/slow/);
    expect(() => meanrevWeights([[1]], 1)).toThrow(/zWindow/);
    expect(() => meanrevWeights([[1]], 4, 0)).toThrow(/shortWindow/);
    expect(() => meanrevWeights([[1]], 4, 1, 0.5)).toThrow(/entryZ/);
  });
});

describe("risk overlays", () => {
  test("volTarget lags its estimate one day and passes warm-up through at min(1, maxLeverage)", () => {
    // Golden from the reference engine: single asset, constant 0.8 weight,
    // lookback 2, maxLeverage 1.5. Days 0-1 are warm-up (multiplier exactly
    // 1.0, not 1.5); from day 2 the multiplier uses volatility measured
    // through the previous day only.
    const closes = [[100], [101], [99], [102], [103], [101], [104], [104.5]];
    const weights = closes.map(() => [0.8]);
    const out = volTarget(weights, closes, 0.1, 2, 1.5);
    expectMatrixClose(out, [
      [0.8],
      [0.8],
      [0.890870806374747],
      [0.2989300712420248],
      [0.17780074237407398],
      [0.43459001945759435],
      [0.3048693384942383],
      [0.18136455966177104],
    ]);
  });

  test("volTarget clips an infinite multiplier (zero realized vol) at maxLeverage", () => {
    // Flat prices make every gross return zero, so realized volatility is
    // exactly zero after warm-up and the raw multiplier is infinite.
    const closes = [[100], [100], [100], [100], [100]];
    const weights = closes.map(() => [0.5]);
    const out = volTarget(weights, closes, 0.1, 2, 1.5);
    // Warm-up rows scale by 1.0; post-warm-up rows clip to maxLeverage.
    expectMatrixClose(out, [[0.5], [0.5], [0.75], [0.75], [0.75]]);
  });

  test("volTarget validates its parameters", () => {
    const one = [[1.0]];
    expect(() => volTarget(one, one, 0)).toThrow(/targetAnnualVol/);
    expect(() => volTarget(one, one, 0.1, 1)).toThrow(/lookback/);
    expect(() => volTarget(one, one, 0.1, 2, 0)).toThrow(/maxLeverage/);
    expect(() => volTarget([[1.0], [1.0]], one, 0.1)).toThrow(/shape/);
  });

  test("capWeights clips per-name and rescales rows whose gross exposure exceeds 1", () => {
    const out = capWeights(
      [
        [0.5, 0.4, 0.3, 0.0, 0.0],
        [0.6, 0.6, 0.6, 0.6, 0.6],
        [-0.5, 0.1, 0.0, 0.0, 0.0],
      ],
      0.25,
    );
    // Row 0: capped to 0.25 each, gross 0.75 <= 1, untouched after the cap.
    expectSeriesClose(out[0]!, [0.25, 0.25, 0.25, 0.0, 0.0]);
    // Row 1: five names capped to 0.25 gives gross 1.25 > 1, scaled by 1/1.25.
    expectSeriesClose(out[1]!, [0.2, 0.2, 0.2, 0.2, 0.2]);
    // Row 2: negative weights clip symmetrically; gross 0.35 needs no rescale.
    expectSeriesClose(out[2]!, [-0.25, 0.1, 0.0, 0.0, 0.0]);
  });
});

describe("metrics", () => {
  test("cagr compounds and annualizes by observation count", () => {
    const r = new Array<number>(252).fill(0.001);
    expect(cagr(r)).toBeCloseTo(Math.pow(1.001, 252) - 1, 12);
    // A total wipeout has no defined annualized rate; the convention is -1.
    expect(cagr([-1.0])).toBe(-1.0);
  });

  test("sharpe of a constant series follows the zero-volatility convention", () => {
    expect(sharpe([0.01, 0.01, 0.01])).toBe(Number.POSITIVE_INFINITY);
    expect(sharpe([-0.01, -0.01])).toBe(Number.NEGATIVE_INFINITY);
    expect(sharpe([0, 0, 0])).toBeNaN();
  });

  test("annVol is NaN for a single observation", () => {
    expect(annVol([0.01])).toBeNaN();
  });

  test("sortino uses the full-sample downside convention", () => {
    // Downside deviation includes the zero contribution of winning periods:
    // sqrt((0^2 + (-0.1)^2) / 2), not sqrt((-0.1)^2 / 1).
    const expected = (0.0 / Math.sqrt(0.005)) * Math.sqrt(252);
    expect(sortino([0.1, -0.1])).toBeCloseTo(expected, 12);
    expect(sortino([0.01, 0.02])).toBe(Number.POSITIVE_INFINITY);
  });

  test("maxDrawdown finds the earliest worst trough and its preceding peak", () => {
    const dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
    const dd = maxDrawdown([1.0, 1.2, 0.6, 0.9, 1.5], dates);
    expect(dd.depth).toBeCloseTo(0.5, 12);
    expect(dd.peak).toBe("2024-01-02");
    expect(dd.trough).toBe("2024-01-03");
    expect(dd.durationDays).toBe(1);
  });

  test("maxDrawdown of a never-declining curve is zero at the first observation", () => {
    const dd = maxDrawdown([1.0, 1.1, 1.2], ["2024-01-01", "2024-01-02", "2024-01-03"]);
    // The depth comes out as negative zero (the negated minimum of an
    // all-zero drawdown series), exactly like the reference engine; compare
    // numerically rather than with Object.is.
    expect(dd.depth === 0).toBe(true);
    expect(dd.peak).toBe("2024-01-01");
    expect(dd.trough).toBe("2024-01-01");
    expect(dd.durationDays).toBe(0);
  });

  test("calmar divides growth by drawdown depth", () => {
    const r = [0.1, -0.2, 0.05];
    expect(calmar(r)).toBeCloseTo(cagr(r) / 0.2, 12);
  });

  test("hitRate excludes zero-return periods from both sides", () => {
    expect(hitRate([0.01, -0.01, 0.0, 0.0, 0.02])).toBeCloseTo(2 / 3, 12);
    expect(hitRate([0.0, 0.0])).toBeNaN();
  });

  test("metric functions reject empty or all-NaN input", () => {
    expect(() => cagr([])).toThrow(/non-NaN/);
    expect(() => sharpe([NaN_, NaN_])).toThrow(/non-NaN/);
  });
});

describe("blend", () => {
  // A deterministic pseudo-random panel long enough for every member's
  // warm-up (dma needs 200 rows, the momentum strategies 252).
  function syntheticPanel(nDays: number, nTickers: number): PricePanel {
    let state = 123456789;
    const next = (): number => {
      // Park-Miller LCG; deterministic across runs and platforms.
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
    const closes: number[][] = [];
    const level = Array.from({ length: nTickers }, () => 100.0);
    for (let t = 0; t < nDays; t++) {
      for (let j = 0; j < nTickers; j++) {
        level[j] = level[j]! * (1 + 0.0003 + 0.02 * (next() - 0.5));
      }
      closes.push([...level]);
    }
    return panelOf(closes);
  }

  const panel = syntheticPanel(320, 8);

  test("blend weights respect the cap and the gross exposure bound", () => {
    const weights = blendWeights(panel);
    for (const row of weights) {
      let gross = 0;
      for (const w of row) {
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(0.25 + 1e-12);
        gross += Math.abs(w);
      }
      expect(gross).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test("blend is all cash until the slowest member can produce a signal", () => {
    const weights = blendWeights(panel);
    // dma(50, 200) is the earliest member to fire, at row 199.
    for (let t = 0; t < 199; t++) {
      for (const w of weights[t]!) {
        expect(w).toBe(0);
      }
    }
    const lateGross = weights
      .slice(260)
      .some((row) => row.reduce((s, w) => s + Math.abs(w), 0) > 0);
    expect(lateGross).toBe(true);
  });

  test("risk presets map to the documented volatility targets", () => {
    expect(RISK_TARGET_VOL.conservative).toBe(0.08);
    expect(RISK_TARGET_VOL.balanced).toBe(0.12);
    expect(RISK_TARGET_VOL.aggressive).toBe(0.16);
    // The named-risk helper is exactly the explicit-target pipeline.
    expect(blendWeightsForRisk(panel, "balanced")).toEqual(blendWeights(panel));
    expect(blendWeightsForRisk(panel, "aggressive")).toEqual(
      blendWeights(panel, { targetAnnualVol: 0.16 }),
    );
  });
});
