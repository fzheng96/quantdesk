/**
 * The blend: the product's single recommendation engine, defined once here.
 *
 * Pipeline (pinned by the parity fixture in test/fixtures/parity.json):
 * 1. average the tsmom, xsmom and dma target weights equally;
 * 2. volatility-target the averaged book to the user's risk setting
 *    (conservative 8% / balanced 12% / aggressive 16% annualized);
 * 3. cap every position at 25% of the portfolio, scaling a row down
 *    proportionally if its gross exposure still exceeds 1.
 *
 * Why meanrev is excluded, with the numbers. On the 2018+ megacap universe
 * (20 names, 2018-01-01 through 2026-06-11, net of the same 3 bps turnover
 * cost — the run published on the project site and reproducible with the
 * reference engine), mean reversion has the worst risk-adjusted record of the
 * four strategies: Sharpe 0.75 versus 0.97 (dma), 1.07 (tsmom) and 1.10
 * (xsmom); the worst Sortino at 1.12 versus 1.36-1.59; the lowest hit rate at
 * 50.9%; and a 35.7% max drawdown against 29.3% for both trend strategies.
 * The only deeper drawdown in the group is xsmom's 37.4%, which at least came
 * with a 28.4% CAGR versus meanrev's 17.0%. Blending meanrev in would deepen
 * losses without improving return per unit of risk, so the blend averages the
 * three trend-flavored books only. The meanrev port still exists in
 * strategies.ts and is held to the same 1e-8 parity bar, so the exclusion is
 * a product decision, not a coverage gap.
 */

import { type Matrix, colCount, filled } from "./frame";
import { capWeights, volTarget } from "./risk";
import { dmaWeights, tsmomWeights, xsmomWeights } from "./strategies";
import type { PricePanel } from "./types";

export type { PricePanel } from "./types";

export type RiskLevel = "conservative" | "balanced" | "aggressive";

/** Annualized volatility target for each user risk setting. */
export const RISK_TARGET_VOL: Record<RiskLevel, number> = {
  conservative: 0.08,
  balanced: 0.12,
  aggressive: 0.16,
};

export const BLEND_MEMBERS = ["tsmom", "xsmom", "dma"] as const;

export interface BlendParams {
  targetAnnualVol: number;
  volLookback: number;
  maxLeverage: number;
  maxWeight: number;
}

/** Defaults match the parity fixture's blend block (balanced 12% target). */
export const DEFAULT_BLEND_PARAMS: BlendParams = {
  targetAnnualVol: RISK_TARGET_VOL.balanced,
  volLookback: 20,
  maxLeverage: 1.0,
  maxWeight: 0.25,
};

/**
 * Equal-weight average of the three member books, computed with the members'
 * default parameters (tsmom 252/21, xsmom 252/21 top 5, dma 50/200). The
 * members are long-only with row gross exposure at most 1, so the average is
 * too.
 */
export function averageMemberWeights(panel: PricePanel): Matrix {
  const closes = panel.closes;
  const tsmom = tsmomWeights(closes);
  const xsmom = xsmomWeights(closes);
  const dma = dmaWeights(closes);
  const n = closes.length;
  const c = colCount(closes);
  const out = filled(n, c, 0.0);
  for (let t = 0; t < n; t++) {
    const a = tsmom[t]!;
    const b = xsmom[t]!;
    const d = dma[t]!;
    const dst = out[t]!;
    for (let j = 0; j < c; j++) {
      dst[j] = (a[j]! + b[j]! + d[j]!) / 3.0;
    }
  }
  return out;
}

/**
 * The full blend pipeline. The second argument is either a named risk level
 * ("conservative" | "balanced" | "aggressive", mapped through
 * RISK_TARGET_VOL) or explicit overrides of the pipeline parameters. Omitted
 * params fall back to the fixture-pinned defaults, so `blendWeights(panel)`
 * is exactly the configuration the parity tests audit.
 */
export function blendWeights(panel: PricePanel, risk?: RiskLevel): number[][];
export function blendWeights(panel: PricePanel, params?: Partial<BlendParams>): number[][];
export function blendWeights(
  panel: PricePanel,
  riskOrParams?: RiskLevel | Partial<BlendParams>,
): number[][] {
  const params =
    typeof riskOrParams === "string"
      ? { targetAnnualVol: RISK_TARGET_VOL[riskOrParams] }
      : riskOrParams;
  const p = { ...DEFAULT_BLEND_PARAMS, ...params };
  const averaged = averageMemberWeights(panel);
  const targeted = volTarget(
    averaged,
    panel.closes,
    p.targetAnnualVol,
    p.volLookback,
    p.maxLeverage,
  );
  return capWeights(targeted, p.maxWeight);
}

/** The blend at a named user risk setting. */
export function blendWeightsForRisk(panel: PricePanel, risk: RiskLevel): number[][] {
  return blendWeights(panel, { targetAnnualVol: RISK_TARGET_VOL[risk] });
}
