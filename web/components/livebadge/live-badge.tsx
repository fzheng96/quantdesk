"use client";

/**
 * The persistent prices-as-of badge: "Prices as of 2:47 PM ET · market
 * open", on every page via the site header. It turns amber with the word
 * "stale" when the last successful quote refresh is more than five minutes
 * old, and tapping it explains the honest model in one sentence.
 *
 * It subscribes to quotes for the benchmark only — the badge needs the
 * payload's timestamp and market state, not every ticker's price.
 */

import { useEffect, useRef, useState } from "react";

import { BENCHMARK_TICKER } from "@/lib/fetch-prices";
import { useLiveQuotes } from "@/lib/use-live-quotes";

import { fmtEtTime } from "../plan/plan-logic";
import styles from "./livebadge.module.css";

// A module-level constant keeps the ticker array's identity stable across
// renders, so the hook's polling loop is never restarted by a re-render.
const BADGE_TICKERS: string[] = [BENCHMARK_TICKER];

const MARKET_STATE_LABEL: Record<string, string> = {
  open: "market open",
  closed: "market closed",
  pre: "pre-market",
  after: "after hours",
};

export function LiveBadge() {
  const { asOf, marketState, isStale, error } = useLiveQuotes(BADGE_TICKERS);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const stateLabel =
    marketState !== null ? MARKET_STATE_LABEL[marketState] ?? marketState : null;

  // Quotes have never loaded and the most recent attempt failed: an outage,
  // not a connection still in flight, so the badge must say so instead of
  // promising a connection forever.
  const neverLoaded = asOf === null && error !== null;

  let text: string;
  if (asOf === null) {
    text = neverLoaded ? "Live prices unavailable" : "Connecting to live prices…";
  } else {
    const parts = [`Prices as of ${fmtEtTime(asOf)}`];
    if (stateLabel !== null) parts.push(stateLabel);
    if (isStale) parts.push("stale");
    text = parts.join(" · ");
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.badge} ${isStale ? styles.stale : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="What do these prices mean?"
      >
        <span
          className={`${styles.dot} ${
            isStale ? styles.dotStale : marketState === "open" ? styles.dotOpen : styles.dotClosed
          }`}
        />
        {text}
      </button>
      {open ? (
        <div className={styles.popover} role="note">
          Recommendations are computed once per day from daily closing prices;
          live quotes — which the free source may delay by up to about 15
          minutes — keep valuations and order sizing current between closes.
          {neverLoaded
            ? " Live quotes are not loading right now, so displayed values fall back to the most recent daily close (or the bundled demo snapshot if price history is down too) and may be old."
            : ""}
        </div>
      ) : null}
    </div>
  );
}
