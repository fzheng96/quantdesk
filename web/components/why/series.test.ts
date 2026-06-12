import { describe, expect, it } from "vitest";

import {
  drawdownSeries,
  fmtDate,
  fmtPct,
  fmtRatio,
  last,
  markToQuotes,
  shortMonth,
} from "./series";

describe("drawdownSeries", () => {
  it("is zero at new highs and negative below the running peak", () => {
    const dd = drawdownSeries([1, 1.1, 0.99, 1.21]);
    expect(dd[0]).toBe(0);
    expect(dd[1]).toBe(0);
    expect(dd[2]).toBeCloseTo(0.99 / 1.1 - 1, 12);
    expect(dd[3]).toBe(0);
  });

  it("returns an empty array for an empty curve", () => {
    expect(drawdownSeries([])).toEqual([]);
  });
});

describe("markToQuotes", () => {
  it("weights each position's quote-vs-close move", () => {
    const ret = markToQuotes([0.5, 0.25], [100, 200], [110, 210]);
    expect(ret).toBeCloseTo(0.5 * 0.1 + 0.25 * 0.05, 12);
  });

  it("treats positions without a quote as unchanged", () => {
    expect(markToQuotes([0.5, 0.5], [100, 200], [110, null])).toBeCloseTo(0.05, 12);
  });

  it("ignores zero weights and non-positive bases", () => {
    expect(markToQuotes([0, 1], [100, 0], [200, 50])).toBe(0);
  });

  it("ignores NaN bases, which mark missing prices", () => {
    expect(markToQuotes([1], [Number.NaN], [50])).toBe(0);
  });
});

describe("formatters", () => {
  it("formats fractions as percentages", () => {
    expect(fmtPct(0.1234)).toBe("12.3%");
    expect(fmtPct(-0.05, 0)).toBe("-5%");
  });

  it("renders non-finite values as n/a instead of NaN or Infinity", () => {
    expect(fmtPct(Number.NaN)).toBe("n/a");
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe("n/a");
    expect(fmtRatio(Number.NEGATIVE_INFINITY)).toBe("n/a");
  });

  it("formats ratios with two decimals by default", () => {
    expect(fmtRatio(1.0723)).toBe("1.07");
  });

  it("formats ISO dates", () => {
    expect(shortMonth("2021-06-11")).toBe("Jun 2021");
    expect(fmtDate("2021-06-01")).toBe("Jun 1, 2021");
  });

  it("falls back to the raw string for unparseable dates", () => {
    expect(shortMonth("garbage")).toBe("garbage");
    expect(fmtDate("2021-13-01")).toBe("2021-13-01");
  });
});

describe("last", () => {
  it("returns the final element or undefined", () => {
    expect(last([1, 2, 3])).toBe(3);
    expect(last([])).toBeUndefined();
  });
});
