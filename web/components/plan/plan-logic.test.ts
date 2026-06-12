import { describe, expect, it } from "vitest";

import {
  buildBenchmarkSeries,
  buildPortfolioSeries,
  computePlanOrders,
  dayChange,
  etDayString,
  lastCloseMap,
  livePriceMap,
  positionCosts,
  type PricePanel,
} from "./plan-logic";

const panel: PricePanel = {
  source: "demo",
  asOf: "2026-06-11T20:00:00Z",
  dates: ["2026-06-08", "2026-06-09", "2026-06-10"],
  tickers: ["AAA", "BBB", "SPY"],
  closes: [
    [100, 50, 500],
    [101, 51, 505],
    [102, NaN, 510],
  ],
};

describe("lastCloseMap / livePriceMap", () => {
  it("takes the most recent usable close, scanning past missing days", () => {
    const closes = lastCloseMap(panel);
    expect(closes).toEqual({ AAA: 102, BBB: 51, SPY: 510 });
  });

  it("overlays live quotes on top of closes and ignores unusable quotes", () => {
    const prices = livePriceMap(panel, {
      AAA: { price: 103.5 },
      SPY: { price: NaN },
    });
    expect(prices).toEqual({ AAA: 103.5, BBB: 51, SPY: 510 });
  });
});

describe("computePlanOrders", () => {
  it("buys whole shares from all cash toward the target weights", () => {
    const orders = computePlanOrders({
      positions: {},
      cash: 10_000,
      targetWeights: { AAA: 0.25, BBB: 0.25 },
      prices: { AAA: 100, BBB: 50 },
    });
    expect(orders).toEqual([
      { ticker: "AAA", side: "buy", shares: 25, price: 100, notional: 2500 },
      { ticker: "BBB", side: "buy", shares: 50, price: 50, notional: 2500 },
    ]);
  });

  it("sells a position whose target weight dropped to zero, sells first", () => {
    const orders = computePlanOrders({
      positions: { AAA: 10 },
      cash: 0,
      targetWeights: { AAA: 0, BBB: 0.5 },
      prices: { AAA: 100, BBB: 50 },
    });
    expect(orders[0]).toEqual({
      ticker: "AAA",
      side: "sell",
      shares: 10,
      price: 100,
      notional: 1000,
    });
    expect(orders[1]).toMatchObject({ ticker: "BBB", side: "buy", shares: 10 });
  });

  it("drops diffs below the minimum notional", () => {
    const orders = computePlanOrders({
      positions: { AAA: 100 },
      cash: 0,
      // Target is 99.6 shares -> floored to 99 -> a 1-share, $100... no:
      // 0.99 * 10000 / 100 = 99 shares, diff -1 share = $100 notional.
      // Use a tighter weight so the diff lands under $50.
      targetWeights: { AAA: 0.999 },
      prices: { AAA: 100 },
      minNotional: 150,
    });
    expect(orders).toEqual([]);
  });

  it("never proposes buys that outrun cash plus sell proceeds", () => {
    // Ten positions each one tiny sell below the notional floor (skipped),
    // plus one real buy. The naive target for the buy exceeds available
    // cash, so the order must be trimmed to what cash can actually fund.
    const positions: Record<string, number> = {};
    const targetWeights: Record<string, number> = {};
    const prices: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const t = `T${i}`;
      positions[t] = 100;
      prices[t] = 100;
      targetWeights[t] = 0.09951; // target 99 shares -> sell 1 share = $100
    }
    targetWeights["BUY"] = 1 - 10 * 0.09951; // 0.0049 of ~100k = $490
    prices["BUY"] = 100;

    const orders = computePlanOrders({
      positions,
      cash: 0,
      targetWeights,
      prices,
      minNotional: 150, // the $100 sells are skipped, freeing no cash
    });
    const buys = orders.filter((o) => o.side === "buy");
    const sells = orders.filter((o) => o.side === "sell");
    expect(sells).toEqual([]);
    // With zero cash and no sells, no buy is affordable at all.
    expect(buys).toEqual([]);
  });

  it("trims a buy to the affordable share count instead of overdrawing", () => {
    const orders = computePlanOrders({
      positions: {},
      cash: 250,
      targetWeights: { AAA: 1.0 },
      prices: { AAA: 100 },
    });
    // Full target would be 2 shares ($200 <= $250), affordable as-is.
    expect(orders).toEqual([
      { ticker: "AAA", side: "buy", shares: 2, price: 100, notional: 200 },
    ]);
  });

  it("skips tickers with no usable price rather than trading them blind", () => {
    const orders = computePlanOrders({
      positions: { GONE: 5 },
      cash: 1_000,
      targetWeights: { AAA: 0.5 },
      prices: { AAA: 100 },
    });
    expect(orders.every((o) => o.ticker !== "GONE")).toBe(true);
  });
});

describe("positionCosts", () => {
  it("averages buys and removes sells at the running average", () => {
    const costs = positionCosts([
      { date: "2026-01-02", ticker: "AAA", side: "buy", shares: 10, price: 100 },
      { date: "2026-01-03", ticker: "AAA", side: "buy", shares: 10, price: 200 },
      { date: "2026-01-04", ticker: "AAA", side: "sell", shares: 5, price: 300 },
    ]);
    expect(costs["AAA"]).toEqual({ shares: 15, avgCost: 150 });
  });

  it("drops fully closed positions", () => {
    const costs = positionCosts([
      { date: "2026-01-02", ticker: "AAA", side: "buy", shares: 10, price: 100 },
      { date: "2026-01-04", ticker: "AAA", side: "sell", shares: 10, price: 90 },
    ]);
    expect(costs["AAA"]).toBeUndefined();
  });
});

describe("chart series", () => {
  it("builds the portfolio series from start, snapshots, and the live value", () => {
    const series = buildPortfolioSeries(
      [
        { date: "2026-06-09", value: 100_500 },
        { date: "2026-06-10", value: 100_200 },
      ],
      "2026-06-08",
      100_000,
      "2026-06-10",
      100_750
    );
    expect(series).toEqual([
      { date: "2026-06-08", value: 100_000 },
      { date: "2026-06-09", value: 100_500 },
      // The live valuation supersedes the recorded snapshot for today.
      { date: "2026-06-10", value: 100_750 },
    ]);
  });

  it("scales the benchmark to the same budget from the same start date", () => {
    const series = buildBenchmarkSeries(
      panel,
      "SPY",
      "2026-06-09",
      100_000,
      "2026-06-11",
      515
    );
    expect(series).toEqual([
      { date: "2026-06-09", value: 100_000 },
      { date: "2026-06-10", value: (100_000 * 510) / 505 },
      { date: "2026-06-11", value: (100_000 * 515) / 505 },
    ]);
  });
});

describe("dayChange", () => {
  const TODAY = "2026-06-11";

  it("measures carried positions from the previous close", () => {
    const pnl = dayChange(
      { AAA: 10 },
      [{ date: "2026-06-09", ticker: "AAA", side: "buy", shares: 10, price: 95 }],
      { AAA: { price: 103, prevClose: 100 } },
      TODAY
    );
    expect(pnl).toBeCloseTo(10 * 3, 10);
  });

  it("measures shares bought today from their fill price, not the previous close", () => {
    // Bought at 102 this afternoon with the stock up 3 since yesterday's
    // close: the user's own move is only 1 per share, not 3.
    const pnl = dayChange(
      { AAA: 10 },
      [{ date: TODAY, ticker: "AAA", side: "buy", shares: 10, price: 102 }],
      { AAA: { price: 103, prevClose: 100 } },
      TODAY
    );
    expect(pnl).toBeCloseTo(10 * 1, 10);
  });

  it("splits a position between carried shares and today's buys", () => {
    const pnl = dayChange(
      { AAA: 15 },
      [
        { date: "2026-06-09", ticker: "AAA", side: "buy", shares: 5, price: 95 },
        { date: TODAY, ticker: "AAA", side: "buy", shares: 10, price: 102 },
      ],
      { AAA: { price: 103, prevClose: 100 } },
      TODAY
    );
    // 5 carried shares from prevClose (+3 each), 10 new shares from 102 (+1 each).
    expect(pnl).toBeCloseTo(5 * 3 + 10 * 1, 10);
  });

  it("averages multiple same-day fills", () => {
    const pnl = dayChange(
      { AAA: 10 },
      [
        { date: TODAY, ticker: "AAA", side: "buy", shares: 5, price: 101 },
        { date: TODAY, ticker: "AAA", side: "buy", shares: 5, price: 103 },
      ],
      { AAA: { price: 103, prevClose: 100 } },
      TODAY
    );
    // Average fill is 102, so the move is +1 per share.
    expect(pnl).toBeCloseTo(10 * 1, 10);
  });

  it("returns null with no positions or when a held ticker lacks a usable quote", () => {
    expect(dayChange({}, [], {}, TODAY)).toBeNull();
    expect(
      dayChange({ AAA: 10, BBB: 5 }, [], { AAA: { price: 103, prevClose: 100 } }, TODAY)
    ).toBeNull();
    expect(
      dayChange({ AAA: 10 }, [], { AAA: { price: NaN, prevClose: 100 } }, TODAY)
    ).toBeNull();
  });
});

describe("etDayString", () => {
  it("returns the New York calendar day for a UTC instant", () => {
    // 03:00 UTC on Jan 2 is still the evening of Jan 1 in New York.
    expect(etDayString("2026-01-02T03:00:00Z")).toBe("2026-01-01");
    expect(etDayString("2026-06-11T20:00:00Z")).toBe("2026-06-11");
  });
});
