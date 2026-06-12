"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { RISK_TARGET_VOL } from "@/lib/engine/blend";
import {
  BENCHMARK_TICKER,
  DEFAULT_UNIVERSE,
  fetchPrices,
  type MarketState,
  type PricePanel,
} from "@/lib/fetch-prices";
import { loadState, type Risk } from "@/lib/store";
import { useLiveQuotes } from "@/lib/use-live-quotes";

import { DrawdownChart, EquityChart, EquityLegend, type LiveEndpoint } from "./charts";
import { computeWhyBacktest, type WhyComputation } from "./engine-adapter";
import { InfoTip } from "./info-tip";
import { MetricCards } from "./metric-cards";
import { drawdownSeries, fmtDate, last, markToQuotes } from "./series";
import styles from "./why.module.css";

type Phase =
  | { kind: "loading"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "computing"; panel: PricePanel }
  | { kind: "engine-failed"; message: string }
  | { kind: "done"; panel: PricePanel; fromDemo: boolean; result: WhyComputation };

/** Stable reference so the quotes hook is not re-triggered every render. */
const ALL_TICKERS: readonly string[] = [...DEFAULT_UNIVERSE, BENCHMARK_TICKER];

function marketStateLabel(state: MarketState | null): string {
  switch (state) {
    case "open":
      return "market open";
    case "closed":
      return "market closed";
    case "pre":
      return "pre-market";
    case "after":
      return "after hours";
    default:
      return "market status unknown";
  }
}

/**
 * The live backtest widget: fetches five years of daily closes, runs the
 * exact blend engine in the browser (with a visible computing state), and
 * renders the equity curve, drawdown chart, and metric cards. fetchPrices
 * falls back to the bundled demo panel on outages; that case is labeled
 * honestly in the output.
 */
export function WhyBacktest() {
  const [phase, setPhase] = useState<Phase>({
    kind: "loading",
    message: "Fetching five years of daily prices…",
  });
  const [risk, setRisk] = useState<Risk>("balanced");
  const [attempt, setAttempt] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const riskNow: Risk = loadState().settings?.risk ?? "balanced";
    setRisk(riskNow);
    setPhase({ kind: "loading", message: "Fetching five years of daily prices…" });

    const load = async () => {
      let panel: PricePanel;
      let fromDemo: boolean;
      try {
        const fetched = await fetchPrices(undefined, 5);
        panel = fetched.panel;
        fromDemo = fetched.fromDemo;
      } catch (err) {
        if (!cancelled) {
          const detail = err instanceof Error ? err.message : "The request failed.";
          setPhase({ kind: "failed", message: detail });
        }
        return;
      }
      if (cancelled) return;

      // Two-step state so "computing…" actually paints before the engine runs.
      setPhase({ kind: "computing", panel });
      window.setTimeout(() => {
        if (cancelled || !mountedRef.current) return;
        try {
          const result = computeWhyBacktest(panel, riskNow);
          setPhase({ kind: "done", panel, fromDemo, result });
        } catch (err) {
          const detail = err instanceof Error ? ` (${err.message})` : "";
          setPhase({
            kind: "engine-failed",
            message: `The engine could not run on the fetched data${detail}. Trying again usually fixes this; if it keeps happening, the data source is returning a broken series.`,
          });
        }
      }, 60);
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const quotesState = useLiveQuotes(ALL_TICKERS);
  const { quotes, marketState, isStale } = quotesState;

  const drawdown = useMemo(
    () => (phase.kind === "done" ? drawdownSeries(phase.result.equity) : []),
    [phase],
  );

  const live = useMemo<LiveEndpoint | null>(() => {
    if (phase.kind !== "done") return null;
    const result = phase.result;
    const quotePrices = result.strategyTickers.map(
      (ticker): number | null => quotes[ticker]?.price ?? null,
    );
    if (!quotePrices.some((price) => price !== null)) return null;
    const lastEquity = last(result.equity);
    if (lastEquity === undefined) return null;
    const blendLive =
      lastEquity * (1 + markToQuotes(result.lastWeights, result.lastCloses, quotePrices));
    const spyQuote = quotes[BENCHMARK_TICKER]?.price ?? null;
    const lastBench = result.benchmarkEquity === null ? undefined : last(result.benchmarkEquity);
    const benchmarkLive =
      lastBench !== undefined &&
      spyQuote !== null &&
      spyQuote > 0 &&
      result.spyLastClose !== null &&
      result.spyLastClose > 0
        ? lastBench * (spyQuote / result.spyLastClose)
        : null;
    return {
      blend: blendLive,
      benchmark: benchmarkLive,
      label: marketStateLabel(marketState),
    };
  }, [phase, quotes, marketState]);

  if (phase.kind === "loading") {
    return (
      <div className={styles.statusCard} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        <span>{phase.message}</span>
      </div>
    );
  }

  if (phase.kind === "failed" || phase.kind === "engine-failed") {
    return (
      <div className={styles.errorCard}>
        <p>
          {phase.message}
          {phase.kind === "failed"
            ? " Nothing is broken on your side — the app pulls prices from free public sources, and they are sometimes down or rate-limited."
            : ""}
        </p>
        <div className={styles.buttonRow}>
          <button type="button" className={styles.button} onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "computing") {
    return (
      <div className={styles.statusCard} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        <span>
          Computing — running the blend over {phase.panel.dates.length.toLocaleString()} trading
          days in your browser…
        </span>
      </div>
    );
  }

  const { panel, fromDemo, result } = phase;
  const firstDate = panel.dates[0];
  const lastDate = last(panel.dates);
  const targetVolPct = Math.round(RISK_TARGET_VOL[risk] * 100);

  return (
    <div className={styles.stack}>
      {fromDemo ? (
        <p className={styles.demoBanner}>
          The live price sources are unreachable right now, so this run uses the demo panel
          bundled with the app, which ends on {fmtDate(panel.asOf.slice(0, 10))}. The methodology
          shown is real; the end date is not today.
        </p>
      ) : null}

      <div className={styles.windowNote}>
        <p>
          <strong>This backtest just ran in your browser</strong>, using the same blend engine
          that builds the Today plan: equal parts of three rules — own a stock while its past
          year is up (time-series momentum), hold the five strongest of the twenty by past-year
          return (cross-sectional momentum), and own a stock while its 50-day average price is
          above its 200-day average (trend filter) — scaled to your risk setting and capped at
          25% per position.{" "}
          <InfoTip label="Why only three of the repo's four strategies?">
            The repo also ships a short-term mean-reversion strategy. It is deliberately left out
            of the blend: on the 2018-onward research runs it had the worst risk-adjusted return
            of the four (Sharpe 0.75 versus 0.97–1.10 for the others), the lowest hit rate at
            about 51%, and a 35.7% max drawdown against 29.3% for both trend strategies — the
            most turbulence for the least reward.
          </InfoTip>
        </p>
        <p>
          Window:{" "}
          <strong>
            {firstDate !== undefined ? fmtDate(firstDate) : "?"} to{" "}
            {lastDate !== undefined ? fmtDate(lastDate) : "?"}
          </strong>{" "}
          ({panel.dates.length.toLocaleString()} trading days) of daily closing prices for{" "}
          {result.strategyTickers.length} large US stocks, with SPY as the do-nothing-clever
          benchmark. Risk setting: <strong>{risk}</strong> ({targetVolPct}% volatility target){" "}
          <InfoTip label="What does the volatility target mean?">
            The blend automatically shrinks positions when markets get turbulent and re-expands
            them when things calm down, aiming for a ride with about {targetVolPct}% annualized
            wobble. For scale, the stock market itself has historically wobbled around 16–20% a
            year. You chose this on the Today page, and you can change it there any time.
          </InfoTip>
          . Every simulated trade is charged 3 basis points{" "}
          <InfoTip label="What is a basis point?">
            A basis point is one hundredth of a percent. The simulation charges 0.03% of every
            dollar traded ($3 per $10,000) for commission and slippage — an optimistic floor for
            real-world costs, not an estimate.
          </InfoTip>
          .
        </p>
        <p>
          One honest wrinkle: the first year of the window is warm-up. The slowest signal looks
          back 252 trading days, so the blend holds mostly cash until it has enough history — the
          flat start of the curve is the strategy waiting, not failing.
        </p>
      </div>

      <figure className={styles.figure}>
        <figcaption className={styles.chartTitle}>
          Growth of $1: the blend vs. just buying SPY
          <InfoTip label="How do I read the equity chart?">
            Each line shows what $1 grew into, day by day, after costs. SPY is a fund that simply
            tracks the S&amp;P 500 — the alternative that requires no cleverness. If the blend
            does not clearly beat it, the strategy added effort and risk for nothing. Also ask
            where any gap came from: one lucky stretch, or steady behavior?
          </InfoTip>
        </figcaption>
        <EquityChart
          dates={result.dates}
          blend={result.equity}
          benchmark={result.benchmarkEquity}
          live={live}
        />
        <EquityLegend hasBenchmark={result.benchmarkEquity !== null} />
        {live !== null ? (
          <div className={styles.figcaption}>
            The open dots extend each curve to the latest quotes ({live.label}
            {isStale ? "; quotes are stale right now" : ""}). Quotes from the free source can be
            delayed by up to about 15 minutes.
          </div>
        ) : null}
      </figure>

      <figure className={styles.figure}>
        <figcaption className={styles.chartTitle}>
          Drawdown: how far below its own peak the blend sat
          <InfoTip label="How do I read the drawdown chart?">
            This is the equity curve&rsquo;s shadow: 0% means the account was at an all-time
            high; −20% means it sat one fifth below its best day so far. Look at the width of the
            valleys, not just the depth — a loss that takes a year to recover is much harder to
            live with than a deeper one that snaps back in weeks.
          </InfoTip>
        </figcaption>
        <DrawdownChart dates={result.dates} drawdown={drawdown} />
        <div className={styles.figcaption}>
          Before trusting any growth number, find the deepest valley here and ask: would I have
          kept following the rules at that point?
        </div>
      </figure>

      <MetricCards metrics={result.metrics} />

      <p className={styles.disclaimer}>
        Simulated results computed from free daily price data, net of assumed costs. Hypothetical
        performance like this routinely overstates what live trading would achieve, and none of
        it is investment advice.
      </p>

      <p className={styles.sourceNote}>
        Data source: {panel.source === "demo" ? "bundled demo panel" : panel.source}, as of{" "}
        {fmtDate(panel.asOf.slice(0, 10))}. This page recomputes everything from raw closes each
        time you load it — nothing is precomputed or hand-picked.
      </p>
    </div>
  );
}
