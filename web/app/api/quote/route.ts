/**
 * GET /api/quote?tickers=AAPL,SPY
 *
 * Server-side proxy for live quotes from Yahoo's v8 chart API with
 * range=1d: last traded price, previous close, and percent change per
 * ticker, plus an overall market state. The same fixed-universe allowlist
 * as /api/prices applies before any upstream request.
 *
 * Market state comes from the Yahoo meta when present; otherwise it is
 * derived from regular NYSE hours in America/New_York. A ticker whose
 * quote cannot be assembled is omitted from the response; only when every
 * ticker fails does the route return 503.
 */

import {
  ALLOWED_TICKERS,
  normalizeTickers,
  type MarketState,
  type Quote,
  type QuotePayload,
} from "../../../lib/fetch-prices";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_USER_AGENT = "Mozilla/5.0 (compatible; quantdesk/0.2)";
const FETCH_TIMEOUT_MS = 6000;

const SUCCESS_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const validation = normalizeTickers(url.searchParams.get("tickers"));
  if (!validation.ok) {
    return jsonResponse(
      {
        error:
          `Unknown tickers: ${validation.invalid.join(", ")}. ` +
          `This service only covers the app's built-in list of stocks: ${[...ALLOWED_TICKERS].join(", ")}.`,
      },
      400,
    );
  }

  const outcomes = await Promise.all(
    validation.tickers.map(async (ticker): Promise<QuoteOutcome> => {
      try {
        return { ticker, ...(await fetchYahooQuote(ticker)) };
      } catch (err) {
        return { ticker, failure: describeError(err) };
      }
    }),
  );
  const fetched = outcomes.filter(isFetched);
  if (fetched.length === 0) {
    const details = outcomes
      .filter(isFailed)
      .map((outcome) => `${outcome.ticker}: ${outcome.failure}`)
      .join("; ");
    return jsonResponse(
      {
        error:
          "The free quote source is unreachable right now, so no live prices are available. " +
          "Please try again in a minute. " +
          `Details: ${details}`,
      },
      503,
    );
  }

  const quotes: Record<string, Quote> = {};
  for (const outcome of fetched) {
    quotes[outcome.ticker] = outcome.quote;
  }
  const marketState =
    fetched.find((outcome) => outcome.marketState !== null)?.marketState ??
    nyseMarketState(new Date());
  const body: QuotePayload = {
    asOf: new Date().toISOString(),
    marketState,
    quotes,
  };
  return jsonResponse(body, 200, SUCCESS_CACHE);
}

type QuoteOutcome =
  | { ticker: string; quote: Quote; marketState: MarketState | null }
  | { ticker: string; failure: string };

function isFetched(
  outcome: QuoteOutcome,
): outcome is Extract<QuoteOutcome, { quote: Quote }> {
  return "quote" in outcome;
}

function isFailed(
  outcome: QuoteOutcome,
): outcome is Extract<QuoteOutcome, { failure: string }> {
  return "failure" in outcome;
}

async function fetchYahooQuote(
  ticker: string,
): Promise<{ quote: Quote; marketState: MarketState | null }> {
  const symbol = yahooSymbol(ticker);
  const params = new URLSearchParams({ range: "1d", interval: "1d" });
  const response = await fetch(
    `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?${params.toString()}`,
    {
      headers: { "User-Agent": YAHOO_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`Yahoo returned HTTP ${response.status} for ${symbol}`);
  }
  return parseYahooQuote(await response.text(), symbol);
}

function yahooSymbol(ticker: string): string {
  const symbol = ticker.trim().toUpperCase();
  return symbol.endsWith(".US") ? symbol.slice(0, -3) : symbol;
}

interface YahooQuotePayload {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      meta?: {
        regularMarketPrice?: unknown;
        chartPreviousClose?: unknown;
        previousClose?: unknown;
        marketState?: unknown;
      } | null;
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
      };
    } | null> | null;
  } | null;
}

/**
 * Assemble a quote from a Yahoo range=1d chart payload. The last traded
 * price is the meta's regularMarketPrice when present, else the last
 * numeric close of the session bars, else the previous close (the "no
 * session data" case — for example, a ticker before its first trade of the
 * day). A ticker with no usable previous close is rejected rather than
 * reported with an invented change.
 */
function parseYahooQuote(
  text: string,
  symbol: string,
): { quote: Quote; marketState: MarketState | null } {
  let payload: YahooQuotePayload;
  try {
    payload = JSON.parse(text) as YahooQuotePayload;
  } catch {
    throw new Error(
      `Yahoo response for ${symbol} is not JSON; the endpoint may be rate-limiting right now`,
    );
  }
  const chart = payload.chart;
  if (chart?.error) {
    throw new Error(
      `Yahoo returned an error for ${symbol}: ${chart.error.code ?? "unknown"}: ${chart.error.description ?? ""}`,
    );
  }
  const result = chart?.result?.[0];
  if (result == null) {
    throw new Error(`Yahoo returned no result for ${symbol}`);
  }
  const meta = result.meta ?? {};
  const prevClose =
    finiteOrNull(meta.chartPreviousClose) ?? finiteOrNull(meta.previousClose);
  if (prevClose === null) {
    throw new Error(`Yahoo returned no previous close for ${symbol}`);
  }
  const sessionCloses = result.indicators?.quote?.[0]?.close ?? [];
  const price =
    finiteOrNull(meta.regularMarketPrice) ??
    lastFinite(sessionCloses) ??
    prevClose;
  return {
    quote: {
      price,
      prevClose,
      changePct: (price / prevClose - 1) * 100,
    },
    marketState: mapMarketState(meta.marketState),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lastFinite(values: ReadonlyArray<number | null>): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Map Yahoo's marketState strings onto the app's four states. */
function mapMarketState(raw: unknown): MarketState | null {
  if (typeof raw !== "string") return null;
  const state = raw.toUpperCase();
  if (state === "REGULAR") return "open";
  if (state.startsWith("PRE")) return "pre";
  if (state.startsWith("POST")) return "after";
  if (state === "CLOSED") return "closed";
  return null;
}

// Regular NYSE session boundaries, in minutes after midnight Eastern.
const PRE_OPEN_MINUTES = 4 * 60;
const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;
const AFTER_END_MINUTES = 20 * 60;

const EASTERN_CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Derive the market state from regular NYSE hours in America/New_York.
 * Exchange holidays are not modeled — on a holiday this reports "open"
 * during normal hours — which is acceptable because Yahoo's own
 * marketState is preferred whenever present and this is only the fallback.
 */
function nyseMarketState(now: Date): MarketState {
  const parts = EASTERN_CLOCK_FORMAT.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const weekday = part("weekday");
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const minutes = (Number(part("hour")) % 24) * 60 + Number(part("minute"));
  if (minutes >= PRE_OPEN_MINUTES && minutes < OPEN_MINUTES) return "pre";
  if (minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES) return "open";
  if (minutes >= CLOSE_MINUTES && minutes < AFTER_END_MINUTES) return "after";
  return "closed";
}

function jsonResponse(
  body: unknown,
  status: number,
  cacheControl = "no-store",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
