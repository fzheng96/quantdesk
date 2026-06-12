/**
 * Shared market-data contracts and the browser-side fetch helpers.
 *
 * The server routes under app/api import the ticker allowlist and response
 * types from here, so the client and the proxy cannot drift apart. The
 * helpers themselves only ever call same-origin URLs: the two proxy routes
 * and the bundled demo snapshot. The browser never talks to a data vendor
 * directly.
 */

export type PriceSource = "yahoo" | "stooq" | "demo";

export interface PricePanel {
  source: PriceSource;
  /** ISO timestamp of when the panel was assembled (the snapshot date for demo data). */
  asOf: string;
  /** Trading dates, ascending, formatted YYYY-MM-DD. */
  dates: string[];
  tickers: string[];
  /**
   * Row-major by date: closes[i][j] is the closing price of tickers[j] on
   * dates[i], or null where that ticker has no usable close (before a late
   * listing, or inside a gap too long to forward-fill).
   */
  closes: Array<Array<number | null>>;
  /** Present on the bundled demo snapshot: a plain-language description of what it is. */
  note?: string;
}

export type MarketState = "open" | "closed" | "pre" | "after";

export interface Quote {
  /** Last traded price. The free source may delay it by up to about 15 minutes. */
  price: number;
  /** Previous regular-session closing price. */
  prevClose: number;
  /** Percent change from the previous close: 1.5 means up 1.5%. */
  changePct: number;
}

export interface QuotePayload {
  asOf: string;
  marketState: MarketState;
  quotes: Record<string, Quote>;
}

// Twenty liquid US megacaps — the same list as the Python CLI's
// DEFAULT_UNIVERSE in quantdesk/cli.py — plus the SPY benchmark. The API
// routes are a proxy for this fixed universe, not an open relay: a ticker
// outside this list is rejected before any upstream request is made.
export const DEFAULT_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B", "JPM", "V",
  "UNH", "XOM", "LLY", "PG", "MA", "HD", "COST", "ABBV", "CRM", "KO",
] as const;

export const BENCHMARK_TICKER = "SPY";

export const ALLOWED_TICKERS: ReadonlySet<string> = new Set([
  ...DEFAULT_UNIVERSE,
  BENCHMARK_TICKER,
]);

export type TickerValidation =
  | { ok: true; tickers: string[] }
  | { ok: false; invalid: string[] };

/**
 * Split a comma- or space-separated ticker list, uppercase, dedupe, and
 * check every entry against the allowlist. A missing or empty parameter
 * means the full universe plus the benchmark, mirroring the Python CLI.
 */
export function normalizeTickers(raw: string | null | undefined): TickerValidation {
  const fullUniverse = (): string[] => [...DEFAULT_UNIVERSE, BENCHMARK_TICKER];
  if (raw == null) return { ok: true, tickers: fullUniverse() };
  const parts = raw
    .split(",")
    .flatMap((chunk) => chunk.split(/\s+/))
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== "");
  const tickers = [...new Set(parts)];
  if (tickers.length === 0) return { ok: true, tickers: fullUniverse() };
  const invalid = tickers.filter((ticker) => !ALLOWED_TICKERS.has(ticker));
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, tickers };
}

export interface PriceFetchResult {
  panel: PricePanel;
  /** True when the live sources were down and the bundled snapshot was served instead. */
  fromDemo: boolean;
  /** Plain-language reason the live fetch failed; set only when fromDemo is true. */
  liveError?: string;
}

const DEMO_PRICES_URL = "/demo-prices.json";

/**
 * Fetch the close-price history panel from the proxy. When the proxy
 * reports that every live source is down (503), or the request itself
 * cannot complete, the bundled demo snapshot is loaded instead and the
 * result is flagged so the UI can label it honestly. A 4xx response throws
 * rather than falling back: that means the request was wrong, and demo
 * data would only hide the bug.
 */
export async function fetchPrices(
  tickers?: readonly string[],
  years = 5,
): Promise<PriceFetchResult> {
  const params = new URLSearchParams();
  if (tickers !== undefined && tickers.length > 0) {
    params.set("tickers", tickers.join(","));
  }
  params.set("years", String(years));

  let liveError = "The price service could not be reached.";
  let response: Response | null = null;
  try {
    response = await fetch(`/api/prices?${params.toString()}`);
  } catch (err) {
    liveError = describeError(err);
  }
  if (response !== null) {
    if (response.ok) {
      try {
        const panel: unknown = await response.json();
        assertPricePanel(panel);
        return { panel, fromDemo: false };
      } catch (err) {
        // A 200 with an unreadable body is treated like an outage.
        liveError = describeError(err);
      }
    } else {
      const message = await readErrorMessage(response);
      if (response.status >= 400 && response.status < 500) {
        throw new Error(
          message ?? `The price request was rejected (HTTP ${response.status}).`,
        );
      }
      liveError =
        message ?? `The price service responded with HTTP ${response.status}.`;
    }
  }
  const demo = await loadDemoPrices(tickers);
  return { panel: demo, fromDemo: true, liveError };
}

/**
 * Load the bundled demo snapshot directly, optionally narrowed to the
 * requested tickers. Exposed on its own so the UI can offer demo data as
 * an explicit choice, not only as the automatic fallback.
 */
export async function loadDemoPrices(
  tickers?: readonly string[],
): Promise<PricePanel> {
  let response: Response;
  try {
    response = await fetch(DEMO_PRICES_URL);
  } catch (err) {
    throw new Error(
      `The bundled demo prices could not be loaded either: ${describeError(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `The bundled demo prices could not be loaded either (HTTP ${response.status}).`,
    );
  }
  const panel: unknown = await response.json();
  assertPricePanel(panel);
  if (tickers === undefined || tickers.length === 0) return panel;
  return subsetPanel(panel, tickers);
}

/** Narrow a panel to the requested tickers, in the requested order. */
export function subsetPanel(
  panel: PricePanel,
  tickers: readonly string[],
): PricePanel {
  const wanted = tickers
    .map((ticker) => ticker.trim().toUpperCase())
    .filter((ticker) => panel.tickers.includes(ticker));
  const columnIndexes = wanted.map((ticker) => panel.tickers.indexOf(ticker));
  return {
    ...panel,
    tickers: wanted,
    closes: panel.closes.map((row) =>
      columnIndexes.map((column) => row[column] ?? null),
    ),
  };
}

/** Fetch live quotes from the proxy. Throws with a plain message on any failure. */
export async function fetchQuotes(
  tickers: readonly string[],
): Promise<QuotePayload> {
  if (tickers.length === 0) {
    throw new Error("At least one ticker is needed to fetch quotes.");
  }
  const params = new URLSearchParams({ tickers: tickers.join(",") });
  const response = await fetch(`/api/quote?${params.toString()}`);
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(
      message ?? `The quote request failed (HTTP ${response.status}).`,
    );
  }
  const payload: unknown = await response.json();
  assertQuotePayload(payload);
  return payload;
}

function assertPricePanel(value: unknown): asserts value is PricePanel {
  const panel = value as PricePanel | null;
  const valid =
    panel !== null &&
    typeof panel === "object" &&
    typeof panel.asOf === "string" &&
    Array.isArray(panel.dates) &&
    Array.isArray(panel.tickers) &&
    Array.isArray(panel.closes) &&
    panel.closes.length === panel.dates.length &&
    panel.closes.every(
      (row) => Array.isArray(row) && row.length === panel.tickers.length,
    );
  if (!valid) {
    throw new Error("Price data arrived in an unexpected shape.");
  }
}

function assertQuotePayload(value: unknown): asserts value is QuotePayload {
  const payload = value as QuotePayload | null;
  const valid =
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.asOf === "string" &&
    typeof payload.marketState === "string" &&
    payload.quotes !== null &&
    typeof payload.quotes === "object";
  if (!valid) {
    throw new Error("Quote data arrived in an unexpected shape.");
  }
}

/** Pull the { error } message out of a proxy error response, if there is one. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (
      body !== null &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // The body was not JSON; fall through to the status-based message.
  }
  return null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
