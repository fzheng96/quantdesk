/**
 * GET /api/prices?tickers=AAPL,MSFT&years=5
 *
 * Server-side proxy for daily close-price history: Yahoo's v8 chart API
 * first, the Stooq CSV endpoint as a per-ticker fallback, mirroring the
 * semantics of the Python data layer in quantdesk/data.py. Tickers are
 * validated against the fixed universe allowlist before any upstream
 * request is made — this is a proxy for the app's own universe, not an
 * open relay.
 *
 * Response: { source, asOf, dates, tickers, closes } with closes row-major
 * by date. A cell is null where a ticker has no usable close for that date
 * (before a late listing, or inside a gap longer than the fill limit) —
 * matching the NaN cells the Python frame keeps. A ticker that fails on
 * both sources is dropped from the panel (the returned tickers array is the
 * source of truth for what survived); only when every ticker fails does the
 * route return 503, which is the client's cue to offer the bundled demo
 * data.
 *
 * One deliberate divergence from the Python sources: a bar dated today
 * (US Eastern) is dropped while the regular session has not yet closed.
 * Yahoo serves the in-progress bar at the latest traded price during the
 * session, and the product's stated model is that recommendations come from
 * completed daily closes — live quotes, not a provisional close, are what
 * keep valuations current intraday.
 */

import {
  ALLOWED_TICKERS,
  normalizeTickers,
  type PricePanel,
} from "../../../lib/fetch-prices";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const STOOQ_URL = "https://stooq.com/q/d/l/";
const YAHOO_USER_AGENT = "Mozilla/5.0 (compatible; quantdesk/0.2)";
const STOOQ_USER_AGENT = "quantdesk/0.2";
// Both sources usually answer in well under a second; anything slower is
// effectively an outage, and the route has to finish within a serverless
// time budget.
const FETCH_TIMEOUT_MS = 8000;
// Mirrors MAX_FFILL_DAYS in quantdesk/data.py: gaps of up to three
// consecutive missing closes are forward-filled, longer gaps are not.
const MAX_FFILL_DAYS = 3;
const MAX_YEARS = 10;
const DEFAULT_YEARS = 5;

const SUCCESS_CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

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
  const years = parseYears(url.searchParams.get("years"));
  if (years === null) {
    return jsonResponse(
      { error: `years must be a number between 1 and ${MAX_YEARS}.` },
      400,
    );
  }

  const now = new Date();
  const start = new Date(now.getTime() - years * 365.25 * 86_400_000);

  const outcomes = await Promise.all(
    validation.tickers.map((ticker) => fetchDailyCloses(ticker, start, now)),
  );
  const fetched = outcomes.filter(isFetched);
  // Today's bar is provisional until the 4 PM ET close: during the session
  // it holds the latest traded price, not a daily close, so it is dropped
  // from every source.
  const provisional = provisionalEasternDate(now);
  if (provisional !== null) {
    for (const outcome of fetched) outcome.byDate.delete(provisional);
  }
  if (fetched.length === 0) {
    const details = outcomes
      .filter(isFailed)
      .map((outcome) => `${outcome.ticker}: ${outcome.failure}`)
      .join("; ");
    return jsonResponse(
      {
        error:
          "Both free price sources (Yahoo and Stooq) are unreachable right now. " +
          "Please try again in a minute. " +
          `Details: ${details}`,
      },
      503,
    );
  }

  const aligned = alignPanel(fetched);
  if (aligned.dates.length === 0) {
    return jsonResponse(
      {
        error:
          "The price sources answered, but no completed trading days could be " +
          "assembled from their data. Please try again in a minute.",
      },
      503,
    );
  }

  // The response carries a single source label; when any ticker needed the
  // fallback the panel is labeled with the fallback source, the
  // conservative choice of the two.
  const source: PricePanel["source"] = fetched.some(
    (outcome) => outcome.source === "stooq",
  )
    ? "stooq"
    : "yahoo";
  const body: PricePanel = {
    source,
    asOf: now.toISOString(),
    dates: aligned.dates,
    tickers: aligned.tickers,
    closes: aligned.closes,
  };
  return jsonResponse(body, 200, SUCCESS_CACHE);
}

type FetchOutcome =
  | { ticker: string; byDate: Map<string, number>; source: "yahoo" | "stooq" }
  | { ticker: string; failure: string };

function isFetched(
  outcome: FetchOutcome,
): outcome is Extract<FetchOutcome, { byDate: Map<string, number> }> {
  return "byDate" in outcome;
}

function isFailed(
  outcome: FetchOutcome,
): outcome is Extract<FetchOutcome, { failure: string }> {
  return "failure" in outcome;
}

async function fetchDailyCloses(
  ticker: string,
  start: Date,
  end: Date,
): Promise<FetchOutcome> {
  let yahooFailure: string;
  try {
    const byDate = await fetchYahooDaily(ticker, start, end);
    return { ticker, byDate, source: "yahoo" };
  } catch (err) {
    yahooFailure = describeError(err);
  }
  try {
    const byDate = await fetchStooqDaily(ticker, start, end);
    return { ticker, byDate, source: "stooq" };
  } catch (err) {
    return {
      ticker,
      failure: `Yahoo: ${yahooFailure}; Stooq: ${describeError(err)}`,
    };
  }
}

async function fetchYahooDaily(
  ticker: string,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const symbol = yahooSymbol(ticker);
  const params = new URLSearchParams({
    period1: String(Math.floor(start.getTime() / 1000)),
    // Yahoo treats period2 as exclusive, so one extra day keeps the
    // requested end date inside the window.
    period2: String(Math.floor(end.getTime() / 1000) + 86_400),
    interval: "1d",
  });
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
  return parseYahooDaily(await response.text(), symbol);
}

function yahooSymbol(ticker: string): string {
  // Yahoo wants plain uppercase US symbols ("BRK-B"); a Stooq-style ".US"
  // suffix is stripped when callers share one ticker spelling.
  const symbol = ticker.trim().toUpperCase();
  return symbol.endsWith(".US") ? symbol.slice(0, -3) : symbol;
}

interface YahooChartPayload {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    } | null> | null;
  } | null;
}

/** Parse a Yahoo v8 chart payload into a date -> close map, preferring adjclose. */
function parseYahooDaily(text: string, symbol: string): Map<string, number> {
  let payload: YahooChartPayload;
  try {
    payload = JSON.parse(text) as YahooChartPayload;
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
  const timestamps = result?.timestamp ?? [];
  if (timestamps.length === 0) {
    throw new Error(`Yahoo returned no rows for ${symbol}`);
  }
  const quoteClose = result?.indicators?.quote?.[0]?.close ?? [];
  const adjclose = result?.indicators?.adjclose?.[0]?.adjclose;
  // Adjusted close is preferred when present: it is comparable to Stooq's
  // split-adjusted series, and the engine consumes closes only.
  const closes =
    adjclose != null && adjclose.length === timestamps.length
      ? adjclose
      : quoteClose;
  const byDate = new Map<string, number>();
  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i];
    const close = closes[i];
    if (
      typeof ts === "number" &&
      typeof close === "number" &&
      Number.isFinite(close)
    ) {
      // Duplicate dates keep the last bar, like the Python parser.
      byDate.set(easternDate(ts), close);
    }
  }
  if (byDate.size === 0) {
    throw new Error(`Yahoo response for ${symbol} has no numeric close prices`);
  }
  return byDate;
}

// Daily bar timestamps sit at the US market open in UTC, so formatting them
// in US Eastern time recovers the trading date. en-CA formats as YYYY-MM-DD.
const EASTERN_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function easternDate(unixSeconds: number): string {
  return EASTERN_DATE_FORMAT.format(new Date(unixSeconds * 1000));
}

const EASTERN_HOUR_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

/**
 * Today's US Eastern date while the regular session has not yet closed
 * (before 4 PM ET), or null once the close is final. Bars carrying this
 * date are still being traded and must not be served as a daily close.
 * Early-close days are handled conservatively: their final bar appears
 * once the regular 4 PM boundary passes.
 */
function provisionalEasternDate(now: Date): string | null {
  const hour = Number(EASTERN_HOUR_FORMAT.format(now));
  return hour < 16 ? EASTERN_DATE_FORMAT.format(now) : null;
}

async function fetchStooqDaily(
  ticker: string,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const symbol = stooqSymbol(ticker);
  const params = new URLSearchParams({
    s: symbol,
    d1: compactDate(start),
    d2: compactDate(end),
    i: "d",
  });
  const response = await fetch(`${STOOQ_URL}?${params.toString()}`, {
    headers: { "User-Agent": STOOQ_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Stooq returned HTTP ${response.status} for ${symbol}`);
  }
  return parseStooqDaily(await response.text(), symbol);
}

function stooqSymbol(ticker: string): string {
  // Stooq expects US listings as e.g. "aapl.us"; tickers that already carry
  // an exchange suffix pass through as-is.
  const symbol = ticker.trim().toLowerCase();
  return symbol.includes(".") ? symbol : `${symbol}.us`;
}

function compactDate(value: Date): string {
  return value.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Parse a Stooq daily CSV into a date -> close map. */
function parseStooqDaily(text: string, symbol: string): Map<string, number> {
  const body = text.trim();
  if (body === "" || body.toLowerCase().startsWith("no data")) {
    throw new Error(`Stooq returned no data for ${symbol}`);
  }
  if (body.startsWith("<")) {
    // Stooq sometimes serves an HTML interstitial (a browser-verification
    // or rate-limit page) in place of the CSV.
    throw new Error(
      `Stooq returned an HTML page instead of CSV for ${symbol}; the endpoint is likely rate-limiting right now`,
    );
  }
  const lines = body.split(/\r?\n/);
  const header = (lines[0] ?? "")
    .split(",")
    .map((column) => column.trim().toLowerCase());
  const dateIndex = header.indexOf("date");
  const closeIndex = header.indexOf("close");
  if (dateIndex === -1 || closeIndex === -1) {
    throw new Error(`Stooq response for ${symbol} is missing date or close columns`);
  }
  const byDate = new Map<string, number>();
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const cells = line.split(",");
    const date = cells[dateIndex]?.trim() ?? "";
    const close = Number(cells[closeIndex]);
    // Individual bad cells are skipped rather than failing the whole fetch.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close)) {
      byDate.set(date, close);
    }
  }
  if (byDate.size === 0) {
    throw new Error(`Stooq response for ${symbol} has no numeric close prices`);
  }
  return byDate;
}

/**
 * Align per-ticker series onto the union of their trading dates.
 *
 * Gaps of up to MAX_FFILL_DAYS consecutive missing closes are
 * forward-filled, and cells still missing after the fill — leading rows
 * before a ticker's first observation, or the tail of a gap longer than the
 * fill limit — stay null, mirroring the Python data layer's NaN cells. Only
 * rows where every ticker is null are dropped (the Python frame's
 * dropna(how="all")). Keeping partial rows matters: a single truncated or
 * gappy series must not silently delete real trading days for the whole
 * universe — the engine accepts leading nulls and its own gap check rejects
 * genuinely broken interior gaps.
 */
function alignPanel(
  series: ReadonlyArray<{ ticker: string; byDate: Map<string, number> }>,
): { dates: string[]; tickers: string[]; closes: Array<Array<number | null>> } {
  const allDates = [
    ...new Set(series.flatMap((entry) => [...entry.byDate.keys()])),
  ].sort();
  const columns = series.map((entry) => {
    const filled: Array<number | null> = [];
    let last: number | null = null;
    let gap = 0;
    for (const date of allDates) {
      const value = entry.byDate.get(date);
      if (value !== undefined) {
        filled.push(value);
        last = value;
        gap = 0;
      } else if (last !== null && gap < MAX_FFILL_DAYS) {
        filled.push(last);
        gap += 1;
      } else {
        filled.push(null);
        gap += 1;
      }
    }
    return filled;
  });
  const dates: string[] = [];
  const closes: Array<Array<number | null>> = [];
  for (let i = 0; i < allDates.length; i += 1) {
    const row = columns.map((column) => column[i] ?? null);
    if (row.some((value) => typeof value === "number")) {
      dates.push(allDates[i] as string);
      closes.push(row);
    }
  }
  return { dates, tickers: series.map((entry) => entry.ticker), closes };
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

function parseYears(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_YEARS;
  const years = Number(raw);
  if (!Number.isFinite(years) || years <= 0 || years > MAX_YEARS) return null;
  return years;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
