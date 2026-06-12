"use client";

/**
 * useLiveQuotes: keep a set of tickers marked to the latest quote.
 *
 * Fetches on mount, re-fetches every 60 seconds while the tab is visible,
 * and immediately on visibilitychange/focus. The state transitions live in
 * a pure reducer so they are unit-testable without a DOM: a fetch failure
 * keeps the last good quotes on screen (staleness, not absence, is the
 * signal that they are old), and isStale flips once the last successful
 * refresh is more than five minutes old.
 */

import { useEffect, useReducer } from "react";

import {
  fetchQuotes,
  type MarketState,
  type Quote,
  type QuotePayload,
} from "./fetch-prices";

// Compatibility aliases: earlier scaffolding exported these names from this
// module, so dependent components can keep importing them from here.
export type { MarketState, Quote, QuotePayload } from "./fetch-prices";
export type LiveQuote = Quote;
export type LiveQuotesResult = LiveQuotesState;

export const QUOTE_REFRESH_MS = 60_000;
export const STALE_AFTER_MS = 5 * 60_000;

export interface LiveQuotesState {
  quotes: Record<string, Quote>;
  /** ISO timestamp the server attached to the last successful payload. */
  asOf: string | null;
  marketState: MarketState | null;
  /**
   * True when the last successful refresh is older than five minutes, or
   * when quotes have never loaded and the most recent attempt failed.
   */
  isStale: boolean;
  /** Plain-language description of the most recent failure; cleared on success. */
  error: string | null;
  /** Epoch milliseconds of the last successful refresh; null before the first. */
  lastSuccessAt: number | null;
}

export const initialLiveQuotesState: LiveQuotesState = {
  quotes: {},
  asOf: null,
  marketState: null,
  isStale: false,
  error: null,
  lastSuccessAt: null,
};

export type LiveQuotesAction =
  | { type: "success"; payload: QuotePayload; now: number }
  | { type: "failure"; error: string; now: number }
  | { type: "tick"; now: number };

function computeStale(
  lastSuccessAt: number | null,
  hasError: boolean,
  now: number,
): boolean {
  if (lastSuccessAt === null) return hasError;
  return now - lastSuccessAt > STALE_AFTER_MS;
}

export function liveQuotesReducer(
  state: LiveQuotesState,
  action: LiveQuotesAction,
): LiveQuotesState {
  switch (action.type) {
    case "success":
      return {
        quotes: action.payload.quotes,
        asOf: action.payload.asOf,
        marketState: action.payload.marketState,
        isStale: false,
        error: null,
        lastSuccessAt: action.now,
      };
    case "failure":
      return {
        ...state,
        error: action.error,
        isStale: computeStale(state.lastSuccessAt, true, action.now),
      };
    case "tick": {
      const isStale = computeStale(
        state.lastSuccessAt,
        state.error !== null,
        action.now,
      );
      // Returning the same object when nothing changed keeps a once-a-minute
      // tick from re-rendering every consumer.
      return isStale === state.isStale ? state : { ...state, isStale };
    }
  }
}

export function useLiveQuotes(tickers: readonly string[]): LiveQuotesState {
  const [state, dispatch] = useReducer(
    liveQuotesReducer,
    initialLiveQuotesState,
  );
  // Keyed on the joined string so a caller passing a fresh array literal on
  // every render does not restart the polling loop.
  const key = tickers.join(",");

  useEffect(() => {
    if (key === "") return;
    const list = key.split(",");
    let disposed = false;

    async function refresh(): Promise<void> {
      try {
        const payload = await fetchQuotes(list);
        if (!disposed) {
          dispatch({ type: "success", payload, now: Date.now() });
        }
      } catch (err) {
        if (!disposed) {
          dispatch({
            type: "failure",
            error: err instanceof Error ? err.message : String(err),
            now: Date.now(),
          });
        }
      }
    }

    // Fetch on mount even in a hidden tab, so the first paint after the
    // user switches back already has data.
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      } else {
        // No fetching from background tabs, but staleness must stay honest.
        dispatch({ type: "tick", now: Date.now() });
      }
    }, QUOTE_REFRESH_MS);
    const onWake = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [key]);

  return state;
}
