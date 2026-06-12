/**
 * The one place page code talks to the recommendation engine. Everything the
 * Today page needs is "the blend's target weights for the most recent day",
 * so that is the whole surface area; if the blend module's signature evolves,
 * this adapter is the only file to update.
 */

import { blendWeightsForRisk } from "@/lib/engine/blend";
import type { PricePanel } from "@/lib/fetch-prices";
import type { Risk } from "@/lib/store";

export { RISK_TARGET_VOL } from "@/lib/engine/blend";

/**
 * Plain-language copy for the risk dial, shared by setup and the plan header.
 * The fractions are anchored to the market-volatility figure quoted next to
 * this copy on the setup screen — the US market has historically run near
 * 16-20% annualized — so the targets work out to 8% ≈ half, 12% ≈
 * two-thirds, and 16% ≈ the market's own level.
 */
export const RISK_COPY: Record<Risk, { label: string; blurb: string }> = {
  conservative: {
    label: "Conservative",
    blurb:
      "Aims for roughly half the stock market's bumpiness. Smaller swings, more cash on the sidelines.",
  },
  balanced: {
    label: "Balanced",
    blurb:
      "Aims for roughly two-thirds of the stock market's bumpiness. The middle road.",
  },
  aggressive: {
    label: "Aggressive",
    blurb:
      "Aims for close to the stock market's own bumpiness. Bigger swings in both directions.",
  },
};

/**
 * Today's target portfolio: ticker -> fraction of equity, from the blend's
 * most recent row. The benchmark column is excluded before the engine runs —
 * SPY is the yardstick the strategy is measured against, not a position it
 * takes. JSON encodes missing prices as null, and the engine expects NaN, so
 * non-finite cells are converted on the way in. Weights below a dust
 * threshold are dropped.
 */
export function latestBlendTargets(
  panel: PricePanel,
  risk: Risk,
  excludeTicker: string
): Record<string, number> {
  const keep: number[] = [];
  const tickers: string[] = [];
  for (let j = 0; j < panel.tickers.length; j++) {
    const ticker = panel.tickers[j];
    if (ticker !== undefined && ticker !== excludeTicker) {
      keep.push(j);
      tickers.push(ticker);
    }
  }

  const closes: number[][] = panel.closes.map((row) =>
    keep.map((j) => {
      const v = row[j];
      return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
    })
  );

  const weights = blendWeightsForRisk({ dates: panel.dates, tickers, closes }, risk);

  const lastRow = weights[weights.length - 1];
  const out: Record<string, number> = {};
  if (lastRow === undefined) return out;
  for (let j = 0; j < tickers.length; j++) {
    const ticker = tickers[j];
    const w = lastRow[j];
    if (ticker !== undefined && w !== undefined && Number.isFinite(w) && w > 1e-6) {
      out[ticker] = w;
    }
  }
  return out;
}
