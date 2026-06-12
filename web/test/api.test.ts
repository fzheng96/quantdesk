/**
 * Tests for the price proxy, the quote proxy, the client fetch helpers,
 * and the live-quotes reducer. No network: global fetch is stubbed with
 * fixture payloads shaped like real Yahoo chart JSON and Stooq CSV, and
 * the route handlers are called directly with constructed Requests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as getPrices } from "../app/api/prices/route";
import { GET as getQuote } from "../app/api/quote/route";
import {
  ALLOWED_TICKERS,
  fetchPrices,
  fetchQuotes,
  normalizeTickers,
  type PricePanel,
  type QuotePayload,
} from "../lib/fetch-prices";
import {
  initialLiveQuotesState,
  liveQuotesReducer,
  STALE_AFTER_MS,
  type LiveQuotesState,
} from "../lib/use-live-quotes";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Unix seconds for 15:00 UTC (10:00 or 11:00 New York) on the given day. */
function ts(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 15, 0, 0) / 1000;
}

const JAN = [ts(2024, 1, 2), ts(2024, 1, 3), ts(2024, 1, 4)];
const JAN_DATES = ["2024-01-02", "2024-01-03", "2024-01-04"];

function yahooChart(options: {
  timestamps: number[];
  close: Array<number | null>;
  adjclose?: Array<number | null>;
  meta?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: options.meta ?? {},
          timestamp: options.timestamps,
          indicators: {
            quote: [{ close: options.close }],
            ...(options.adjclose !== undefined
              ? { adjclose: [{ adjclose: options.adjclose }] }
              : {}),
          },
        },
      ],
      error: null,
    },
  });
}

function stooqCsv(rows: Array<[string, number]>): string {
  const lines = rows.map(
    ([date, close]) => `${date},1,1,1,${close},1000`,
  );
  return ["Date,Open,High,Low,Close,Volume", ...lines].join("\n");
}

const DEMO_PANEL: PricePanel = {
  source: "demo",
  asOf: "2026-06-11",
  note: "Bundled fallback prices.",
  dates: JAN_DATES,
  tickers: ["AAPL", "MSFT", "SPY"],
  closes: [
    [185, 370, 470],
    [186, 371, 471],
    [187, 372, 472],
  ],
};

type FetchHandler = (url: string) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(url);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function pricesRequest(query: string): Request {
  return new Request(`http://localhost/api/prices${query}`);
}

function quoteRequest(query: string): Request {
  return new Request(`http://localhost/api/quote${query}`);
}

// ---------------------------------------------------------------------------
// normalizeTickers
// ---------------------------------------------------------------------------

describe("normalizeTickers", () => {
  it("uppercases, trims, dedupes, and accepts allowlisted tickers", () => {
    const result = normalizeTickers(" aapl, msft , AAPL  spy ");
    expect(result).toEqual({ ok: true, tickers: ["AAPL", "MSFT", "SPY"] });
  });

  it("defaults a missing or blank parameter to the full universe plus SPY", () => {
    for (const raw of [null, "", "  ,  "]) {
      const result = normalizeTickers(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.tickers).toHaveLength(21);
        expect(result.tickers).toContain("SPY");
        expect(result.tickers).toContain("BRK-B");
      }
    }
  });

  it("rejects tickers outside the allowlist", () => {
    const result = normalizeTickers("AAPL,EVIL");
    expect(result).toEqual({ ok: false, invalid: ["EVIL"] });
    expect(ALLOWED_TICKERS.has("EVIL")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prices
// ---------------------------------------------------------------------------

describe("GET /api/prices", () => {
  it("serves a Yahoo panel, preferring adjusted close, with cache headers", async () => {
    stubFetch((url) => {
      if (url.includes("query1.finance.yahoo.com")) {
        if (url.includes("/chart/AAPL")) {
          return textResponse(
            yahooChart({
              timestamps: JAN,
              close: [186, 187, 188],
              adjclose: [185.5, 186.5, 187.5],
            }),
          );
        }
        return textResponse(
          yahooChart({ timestamps: JAN, close: [370, 371, 372] }),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const response = await getPrices(pricesRequest("?tickers=AAPL,MSFT&years=5"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    const body = (await response.json()) as PricePanel;
    expect(body.source).toBe("yahoo");
    expect(Number.isNaN(Date.parse(body.asOf))).toBe(false);
    expect(body.dates).toEqual(JAN_DATES);
    expect(body.tickers).toEqual(["AAPL", "MSFT"]);
    // Adjusted close wins over the raw close for AAPL.
    expect(body.closes).toEqual([
      [185.5, 370],
      [186.5, 371],
      [187.5, 372],
    ]);
  });

  it("forward-fills a short gap and keeps a late listing's leading rows as null", async () => {
    const fourDays = [...JAN, ts(2024, 1, 5)];
    stubFetch((url) => {
      if (url.includes("/chart/AAPL")) {
        // AAPL is missing Jan 3 (a null close): it should be forward-filled
        // from Jan 2.
        return textResponse(
          yahooChart({ timestamps: fourDays, close: [186, null, 188, 189] }),
        );
      }
      // MSFT starts a day late: the Jan 2 row has no fill source, so its
      // cell stays null while AAPL's real trading day is preserved — the
      // Python frame keeps the same leading NaN.
      return textResponse(
        yahooChart({
          timestamps: fourDays.slice(1),
          close: [371, 372, 373],
        }),
      );
    });

    const response = await getPrices(pricesRequest("?tickers=AAPL,MSFT"));
    const body = (await response.json()) as PricePanel;
    expect(body.dates).toEqual([
      "2024-01-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
    ]);
    expect(body.closes).toEqual([
      [186, null], // MSFT not yet listed; AAPL's day is kept
      [186, 371], // AAPL forward-filled from Jan 2
      [188, 372],
      [189, 373],
    ]);
  });

  it("leaves cells null after the fill limit instead of deleting trading days", async () => {
    // Six consecutive weekdays; MSFT goes dark after the first one. The
    // first three missing days are forward-filled (MAX_FFILL_DAYS), the
    // rest stay null — and every date survives for AAPL.
    const days = [
      ts(2024, 1, 2),
      ts(2024, 1, 3),
      ts(2024, 1, 4),
      ts(2024, 1, 5),
      ts(2024, 1, 8),
      ts(2024, 1, 9),
    ];
    stubFetch((url) => {
      if (url.includes("/chart/AAPL")) {
        return textResponse(
          yahooChart({ timestamps: days, close: [186, 187, 188, 189, 190, 191] }),
        );
      }
      return textResponse(
        yahooChart({ timestamps: days.slice(0, 1), close: [370] }),
      );
    });

    const response = await getPrices(pricesRequest("?tickers=AAPL,MSFT"));
    const body = (await response.json()) as PricePanel;
    expect(body.dates).toHaveLength(6);
    expect(body.closes.map((row) => row[1])).toEqual([
      370,
      370,
      370,
      370,
      null,
      null,
    ]);
    expect(body.closes.map((row) => row[0])).toEqual([186, 187, 188, 189, 190, 191]);
  });

  it("drops today's in-progress bar during the session and keeps it after the close", async () => {
    // Bars through Thursday 2024-01-04; the Jan 4 bar is the in-progress
    // session bar in the first half of the test.
    stubFetch(() =>
      textResponse(yahooChart({ timestamps: JAN, close: [186, 187, 188] })),
    );

    vi.useFakeTimers();
    // 14:00 New York on Jan 4: the session is open, so the Jan 4 bar is a
    // live price, not a close, and must be dropped.
    vi.setSystemTime(new Date("2024-01-04T19:00:00Z"));
    let response = await getPrices(pricesRequest("?tickers=AAPL"));
    let body = (await response.json()) as PricePanel;
    expect(body.dates).toEqual(["2024-01-02", "2024-01-03"]);

    // 16:30 New York on Jan 4: the close is final and the bar is served.
    vi.setSystemTime(new Date("2024-01-04T21:30:00Z"));
    response = await getPrices(pricesRequest("?tickers=AAPL"));
    body = (await response.json()) as PricePanel;
    expect(body.dates).toEqual(JAN_DATES);
  });

  it("falls back to Stooq per ticker and labels the panel stooq", async () => {
    const mock = stubFetch((url) => {
      if (url.includes("/chart/AAPL")) return textResponse("", 500);
      if (url.includes("query1.finance.yahoo.com")) {
        return textResponse(
          yahooChart({ timestamps: JAN, close: [370, 371, 372] }),
        );
      }
      if (url.includes("stooq.com")) {
        return textResponse(
          stooqCsv([
            ["2024-01-02", 186.25],
            ["2024-01-03", 187.5],
            ["2024-01-04", 188.75],
          ]),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const response = await getPrices(pricesRequest("?tickers=AAPL,MSFT"));
    const body = (await response.json()) as PricePanel;
    expect(body.source).toBe("stooq");
    expect(body.tickers).toEqual(["AAPL", "MSFT"]);
    expect(body.closes.map((row) => row[0])).toEqual([186.25, 187.5, 188.75]);
    const stooqCall = mock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("stooq.com"));
    expect(stooqCall).toContain("s=aapl.us");
  });

  it("drops a ticker that fails both sources but keeps the others", async () => {
    stubFetch((url) => {
      if (url.includes("/chart/AAPL") || url.includes("s=aapl.us")) {
        return textResponse("", 500);
      }
      return textResponse(
        yahooChart({ timestamps: JAN, close: [370, 371, 372] }),
      );
    });

    const response = await getPrices(pricesRequest("?tickers=AAPL,MSFT"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PricePanel;
    expect(body.tickers).toEqual(["MSFT"]);
    expect(body.closes.every((row) => row.length === 1)).toBe(true);
  });

  it("rejects tickers outside the allowlist with 400 and no upstream call", async () => {
    const mock = stubFetch(() => textResponse("", 500));
    const response = await getPrices(pricesRequest("?tickers=AAPL,EVIL"));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("EVIL");
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects a malformed years parameter with 400", async () => {
    stubFetch(() => textResponse("", 500));
    for (const years of ["abc", "0", "-3", "11"]) {
      const response = await getPrices(
        pricesRequest(`?tickers=AAPL&years=${years}`),
      );
      expect(response.status).toBe(400);
    }
  });

  it("returns 503 with a clear body when every source fails for every ticker", async () => {
    stubFetch(() => textResponse("", 500));
    const response = await getPrices(pricesRequest("?tickers=AAPL,MSFT"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Yahoo");
    expect(body.error).toContain("Stooq");
  });

  it("defaults a missing tickers parameter to the full 21-ticker universe", async () => {
    stubFetch(() =>
      textResponse(yahooChart({ timestamps: JAN, close: [1, 2, 3] })),
    );
    const response = await getPrices(pricesRequest(""));
    const body = (await response.json()) as PricePanel;
    expect(body.tickers).toHaveLength(21);
    expect(body.tickers).toContain("SPY");
  });
});

// ---------------------------------------------------------------------------
// GET /api/quote
// ---------------------------------------------------------------------------

describe("GET /api/quote", () => {
  it("serves last price, previous close, and change with cache headers", async () => {
    stubFetch((url) => {
      expect(url).toContain("range=1d");
      return textResponse(
        yahooChart({
          timestamps: [ts(2024, 1, 4)],
          close: [191.0],
          meta: {
            regularMarketPrice: 191.5,
            chartPreviousClose: 190.0,
            marketState: "REGULAR",
          },
        }),
      );
    });

    const response = await getQuote(quoteRequest("?tickers=AAPL"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    const body = (await response.json()) as QuotePayload;
    expect(body.marketState).toBe("open");
    expect(Number.isNaN(Date.parse(body.asOf))).toBe(false);
    const quote = body.quotes["AAPL"];
    expect(quote).toBeDefined();
    expect(quote?.price).toBe(191.5);
    expect(quote?.prevClose).toBe(190.0);
    expect(quote?.changePct).toBeCloseTo((191.5 / 190 - 1) * 100, 10);
  });

  it("falls back to the last session close, then to the previous close", async () => {
    stubFetch((url) => {
      if (url.includes("/chart/AAPL")) {
        // No regularMarketPrice: the last non-null session close wins.
        return textResponse(
          yahooChart({
            timestamps: [ts(2024, 1, 4), ts(2024, 1, 4) + 60],
            close: [191.0, null],
            meta: { chartPreviousClose: 190.0, marketState: "POST" },
          }),
        );
      }
      // No session data at all: previous close stands in, change is zero.
      return textResponse(
        yahooChart({
          timestamps: [ts(2024, 1, 4)],
          close: [null],
          meta: { previousClose: 470.0, marketState: "POST" },
        }),
      );
    });

    const response = await getQuote(quoteRequest("?tickers=AAPL,SPY"));
    const body = (await response.json()) as QuotePayload;
    expect(body.marketState).toBe("after");
    expect(body.quotes["AAPL"]?.price).toBe(191.0);
    expect(body.quotes["AAPL"]?.changePct).toBeCloseTo(
      (191 / 190 - 1) * 100,
      10,
    );
    expect(body.quotes["SPY"]?.price).toBe(470.0);
    expect(body.quotes["SPY"]?.changePct).toBe(0);
  });

  it("derives the market state from NYSE hours when Yahoo omits it", async () => {
    stubFetch(() =>
      textResponse(
        yahooChart({
          timestamps: [ts(2026, 6, 10)],
          close: [191.0],
          meta: { chartPreviousClose: 190.0 },
        }),
      ),
    );

    // Wednesday 2026-06-10, 18:00 UTC = 14:00 New York: regular session.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T18:00:00Z"));
    let response = await getQuote(quoteRequest("?tickers=AAPL"));
    expect(((await response.json()) as QuotePayload).marketState).toBe("open");

    // Saturday 2026-06-13: closed regardless of the hour.
    vi.setSystemTime(new Date("2026-06-13T18:00:00Z"));
    response = await getQuote(quoteRequest("?tickers=AAPL"));
    expect(((await response.json()) as QuotePayload).marketState).toBe(
      "closed",
    );
  });

  it("omits a failing ticker but still serves the rest", async () => {
    stubFetch((url) => {
      if (url.includes("/chart/AAPL")) return textResponse("", 500);
      return textResponse(
        yahooChart({
          timestamps: [ts(2024, 1, 4)],
          close: [470.5],
          meta: { chartPreviousClose: 470.0, marketState: "CLOSED" },
        }),
      );
    });

    const response = await getQuote(quoteRequest("?tickers=AAPL,SPY"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as QuotePayload;
    expect(body.quotes["AAPL"]).toBeUndefined();
    expect(body.quotes["SPY"]?.price).toBe(470.5);
    expect(body.marketState).toBe("closed");
  });

  it("returns 400 off-allowlist and 503 when every ticker fails", async () => {
    const mock = stubFetch(() => textResponse("", 500));
    const rejected = await getQuote(quoteRequest("?tickers=HACK"));
    expect(rejected.status).toBe(400);
    expect(mock).not.toHaveBeenCalled();

    const down = await getQuote(quoteRequest("?tickers=AAPL,SPY"));
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store");
    const body = (await down.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Client helpers: fetchPrices / fetchQuotes
// ---------------------------------------------------------------------------

describe("fetchPrices (client)", () => {
  const LIVE_PANEL: PricePanel = {
    source: "yahoo",
    asOf: "2026-06-11T12:00:00.000Z",
    dates: JAN_DATES,
    tickers: ["AAPL", "MSFT"],
    closes: [
      [185.5, 370],
      [186.5, 371],
      [187.5, 372],
    ],
  };

  it("passes a live panel through untouched", async () => {
    stubFetch((url) => {
      expect(url).toContain("/api/prices");
      return textResponse(JSON.stringify(LIVE_PANEL));
    });
    const result = await fetchPrices(["AAPL", "MSFT"]);
    expect(result.fromDemo).toBe(false);
    expect(result.liveError).toBeUndefined();
    expect(result.panel).toEqual(LIVE_PANEL);
  });

  it("falls back to the bundled demo data on 503, narrowed to the request", async () => {
    stubFetch((url) => {
      if (url.includes("/api/prices")) {
        return textResponse(
          JSON.stringify({ error: "Both free price sources are down." }),
          503,
        );
      }
      expect(url).toContain("/demo-prices.json");
      return textResponse(JSON.stringify(DEMO_PANEL));
    });
    const result = await fetchPrices(["MSFT", "AAPL"]);
    expect(result.fromDemo).toBe(true);
    expect(result.liveError).toBe("Both free price sources are down.");
    expect(result.panel.source).toBe("demo");
    // Narrowed to the requested tickers, in the requested order.
    expect(result.panel.tickers).toEqual(["MSFT", "AAPL"]);
    expect(result.panel.closes).toEqual([
      [370, 185],
      [371, 186],
      [372, 187],
    ]);
    expect(result.panel.note).toBe(DEMO_PANEL.note);
  });

  it("falls back to demo data when the network request itself fails", async () => {
    stubFetch((url) => {
      if (url.includes("/api/prices")) throw new Error("network down");
      return textResponse(JSON.stringify(DEMO_PANEL));
    });
    const result = await fetchPrices();
    expect(result.fromDemo).toBe(true);
    expect(result.liveError).toBe("network down");
    expect(result.panel.tickers).toEqual(DEMO_PANEL.tickers);
  });

  it("throws on 4xx instead of masking a bad request with demo data", async () => {
    stubFetch(() =>
      textResponse(JSON.stringify({ error: "Unknown tickers: EVIL." }), 400),
    );
    await expect(fetchPrices(["AAPL"])).rejects.toThrow(
      "Unknown tickers: EVIL.",
    );
  });

  it("throws when live and demo data are both unavailable", async () => {
    stubFetch(() => textResponse("", 503));
    await expect(fetchPrices(["AAPL"])).rejects.toThrow(/demo prices/);
  });
});

describe("fetchQuotes (client)", () => {
  it("returns the payload on success and surfaces server errors", async () => {
    const payload: QuotePayload = {
      asOf: "2026-06-11T12:00:00.000Z",
      marketState: "open",
      quotes: { AAPL: { price: 191.5, prevClose: 190, changePct: 0.789 } },
    };
    stubFetch((url) => {
      expect(url).toContain("/api/quote");
      return textResponse(JSON.stringify(payload));
    });
    await expect(fetchQuotes(["AAPL"])).resolves.toEqual(payload);

    stubFetch(() =>
      textResponse(JSON.stringify({ error: "Quote source is down." }), 503),
    );
    await expect(fetchQuotes(["AAPL"])).rejects.toThrow(
      "Quote source is down.",
    );
  });
});

// ---------------------------------------------------------------------------
// liveQuotesReducer
// ---------------------------------------------------------------------------

describe("liveQuotesReducer", () => {
  const T0 = 1_750_000_000_000;
  const payload: QuotePayload = {
    asOf: "2026-06-11T12:00:00.000Z",
    marketState: "open",
    quotes: { AAPL: { price: 191.5, prevClose: 190, changePct: 0.789 } },
  };

  function loaded(): LiveQuotesState {
    return liveQuotesReducer(initialLiveQuotesState, {
      type: "success",
      payload,
      now: T0,
    });
  }

  it("populates state on success and clears staleness and errors", () => {
    const state = loaded();
    expect(state.quotes).toEqual(payload.quotes);
    expect(state.asOf).toBe(payload.asOf);
    expect(state.marketState).toBe("open");
    expect(state.isStale).toBe(false);
    expect(state.error).toBeNull();
    expect(state.lastSuccessAt).toBe(T0);
  });

  it("keeps the last good quotes on failure and records the error", () => {
    const state = liveQuotesReducer(loaded(), {
      type: "failure",
      error: "Quote source is down.",
      now: T0 + 60_000,
    });
    expect(state.quotes).toEqual(payload.quotes);
    expect(state.error).toBe("Quote source is down.");
    expect(state.isStale).toBe(false); // only one minute old
  });

  it("is stale immediately when there has never been a success", () => {
    const state = liveQuotesReducer(initialLiveQuotesState, {
      type: "failure",
      error: "network down",
      now: T0,
    });
    expect(state.isStale).toBe(true);
  });

  it("flips isStale once the last success is older than five minutes", () => {
    const fresh = liveQuotesReducer(loaded(), {
      type: "tick",
      now: T0 + STALE_AFTER_MS,
    });
    expect(fresh.isStale).toBe(false);
    const stale = liveQuotesReducer(fresh, {
      type: "tick",
      now: T0 + STALE_AFTER_MS + 1,
    });
    expect(stale.isStale).toBe(true);
  });

  it("returns the identical state object when a tick changes nothing", () => {
    const state = loaded();
    const ticked = liveQuotesReducer(state, { type: "tick", now: T0 + 1000 });
    expect(ticked).toBe(state);
  });

  it("recovers from staleness on the next success", () => {
    const stale = liveQuotesReducer(loaded(), {
      type: "tick",
      now: T0 + STALE_AFTER_MS + 1,
    });
    const recovered = liveQuotesReducer(stale, {
      type: "success",
      payload,
      now: T0 + STALE_AFTER_MS + 2,
    });
    expect(recovered.isStale).toBe(false);
    expect(recovered.error).toBeNull();
  });
});
