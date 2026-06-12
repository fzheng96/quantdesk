"use client";

/**
 * The Portfolio page: value cards, the positions table marked to live
 * quotes, the equity chart against "just bought SPY" from the same start
 * date, the trade log, and the reset flow.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";

import { BENCHMARK_TICKER, fetchPrices, type PriceFetchResult } from "@/lib/fetch-prices";
import { getServerSnapshot, markToMarket, portfolioValue, store } from "@/lib/store";
import { useLiveQuotes } from "@/lib/use-live-quotes";

import { MetricCard } from "../plan/metric-card";
import {
  buildBenchmarkSeries,
  buildPortfolioSeries,
  etDayString,
  fmtEtTime,
  fmtMoney,
  fmtMoneyRound,
  fmtMoneySigned,
  fmtPctSigned,
  livePriceMap,
  positionCosts,
} from "../plan/plan-logic";
import planStyles from "../plan/plan.module.css";
import { EquityChart } from "./equity-chart";
import { PositionsTable } from "./positions-table";
import { ResetButton } from "./reset-button";
import styles from "./portfolio.module.css";
import { TradeHistory } from "./trade-history";

export function PortfolioClient() {
  const appState = useSyncExternalStore(store.subscribe, store.getState, getServerSnapshot);
  const settings = appState.settings;

  const heldTickers = useMemo(
    () => Object.keys(appState.portfolio.positions).sort(),
    [appState.portfolio.positions]
  );

  // Quotes for every held name plus the benchmark; identity changes only
  // when the set of held tickers does, so polling is not restarted by
  // unrelated renders.
  const quoteTickers = useMemo(
    () => [...heldTickers, BENCHMARK_TICKER],
    [heldTickers]
  );
  const live = useLiveQuotes(quoteTickers);

  const [priceResult, setPriceResult] = useState<PriceFetchResult | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  const heldKey = heldTickers.join(",");
  useEffect(() => {
    let disposed = false;
    const tickers = heldKey === "" ? [BENCHMARK_TICKER] : [...heldKey.split(","), BENCHMARK_TICKER];
    fetchPrices(tickers, 5)
      .then((result) => {
        if (!disposed) setPriceResult(result);
      })
      .catch((err: unknown) => {
        if (!disposed) setPriceError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, [heldKey]);

  const panel = priceResult?.panel ?? null;
  const priceMap = useMemo(() => livePriceMap(panel, live.quotes), [panel, live.quotes]);

  let totalValue: number | null = null;
  if (settings !== null) {
    try {
      totalValue = portfolioValue(appState, priceMap);
    } catch {
      totalValue = null;
    }
  }

  // Demo mode: history is the bundled months-old snapshot and no live
  // quotes overlay it, so values on screen are stale and must not be
  // recorded as today's portfolio value.
  const quotesLive = live.lastSuccessAt !== null && Object.keys(live.quotes).length > 0;
  const demoPaused = (priceResult?.fromDemo ?? false) && !quotesLive;

  // Keep the daily snapshot current from this page too, so the chart grows
  // no matter which page the user checks in on.
  const today = etDayString(live.asOf ?? undefined);
  useEffect(() => {
    if (settings === null || panel === null || demoPaused) return;
    try {
      store.setState((s) => markToMarket(s, priceMap, today));
    } catch {
      // A held ticker without a usable price yet; the next refresh retries.
    }
  }, [settings, panel, priceMap, today, demoPaused]);

  if (settings === null) {
    return (
      <section className="card">
        <h1 className={planStyles.pageTitle}>Portfolio</h1>
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          You have no paper portfolio yet. Head to the <Link href="/">Today</Link>{" "}
          page — setup is two questions, and all the money is pretend.
        </p>
      </section>
    );
  }

  const costs = positionCosts(appState.portfolio.trades);
  const totalPnl = totalValue !== null ? totalValue - settings.budget : null;
  const totalPnlPct =
    totalPnl !== null && settings.budget > 0 ? totalPnl / settings.budget : null;

  const startDay = etDayString(settings.createdAt);
  const youSeries = buildPortfolioSeries(
    appState.portfolio.snapshots,
    startDay,
    settings.budget,
    today,
    totalValue
  );
  const spyQuote = live.quotes[BENCHMARK_TICKER];
  const spySeries =
    panel !== null
      ? buildBenchmarkSeries(
          panel,
          BENCHMARK_TICKER,
          startDay,
          settings.budget,
          today,
          spyQuote !== undefined && Number.isFinite(spyQuote.price) ? spyQuote.price : null
        )
      : [];

  return (
    <div className={planStyles.stack}>
      <div className={planStyles.metricGrid}>
        <MetricCard
          label="Portfolio value"
          value={totalValue !== null ? fmtMoney(totalValue) : "—"}
          sub={live.asOf !== null ? `at prices as of ${fmtEtTime(live.asOf)}` : undefined}
          explain="Your cash plus what your positions are worth at the latest quoted prices. All pretend money."
        />
        <MetricCard
          label="Total gain or loss"
          value={totalPnl !== null ? fmtMoneySigned(totalPnl) : "—"}
          sub={totalPnlPct !== null ? `${fmtPctSigned(totalPnlPct)} since ${startDay}` : undefined}
          tone={totalPnl === null ? "neutral" : totalPnl >= 0 ? "up" : "down"}
          explain="Today's portfolio value minus the budget you started with. Short histories are mostly luck, in both directions."
        />
        <MetricCard
          label="Cash"
          value={fmtMoney(appState.portfolio.cash)}
          explain="The uninvested part of your budget. The strategy holds cash deliberately when few stocks are trending."
        />
      </div>

      {priceError !== null ? (
        <div className={planStyles.banner}>{priceError}</div>
      ) : null}
      {priceResult !== null && priceResult.fromDemo ? (
        <div className={planStyles.banner}>
          Live price sources are unreachable right now, so values use the
          bundled demo snapshot (data as of {priceResult.panel.asOf.slice(0, 10)}).
        </div>
      ) : null}

      <section className="card">
        <h2 className={planStyles.pageTitle}>Positions</h2>
        <PositionsTable
          positions={appState.portfolio.positions}
          costs={costs}
          prices={priceMap}
          totalValue={totalValue}
        />
        <p className={planStyles.disclaimer}>
          Simulated positions in a paper portfolio, valued from free quotes
          that can be delayed about 15 minutes. Not investment advice.
        </p>
      </section>

      <section className="card">
        <h2 className={planStyles.pageTitle}>You vs just buying SPY</h2>
        {youSeries.length >= 2 ? (
          <>
            <div className={planStyles.chartHeader} style={{ marginTop: "0.5rem" }}>
              <span className={planStyles.legend} style={{ marginLeft: 0 }}>
                <span className={planStyles.legendItem}>
                  <span
                    className={planStyles.legendSwatch}
                    style={{ background: "#5ab0f2" }}
                  />
                  Your paper portfolio{" "}
                  {totalValue !== null ? fmtMoneyRound(totalValue) : ""}
                </span>
                <span className={planStyles.legendItem}>
                  <span
                    className={planStyles.legendSwatch}
                    style={{ background: "#8b93a7" }}
                  />
                  SPY from the same start{" "}
                  {spySeries.length > 0
                    ? fmtMoneyRound(spySeries[spySeries.length - 1]?.value ?? 0)
                    : ""}
                </span>
              </span>
            </div>
            <EquityChart
              variant="full"
              series={[
                { label: "Your paper portfolio", color: "#5ab0f2", points: youSeries },
                { label: "SPY from the same start", color: "#8b93a7", points: spySeries },
              ]}
            />
          </>
        ) : (
          <p className={styles.emptyNote}>
            The chart needs at least two days of history. It records one point
            per day you visit, starting {startDay}.
          </p>
        )}
        <p className={styles.framingNote}>
          The gray line is what the same pretend budget would be worth if you
          had simply bought SPY — a fund that tracks the S&amp;P 500 — on your
          start date and never touched it. Over a few days or weeks the gap
          between the lines is mostly luck; the strategy&apos;s case for itself
          is the five-year evidence on the <Link href="/why">Why</Link> page,
          not a good week here.
        </p>
        <p className={planStyles.disclaimer}>
          Simulated performance from free market data. Not investment advice,
          and no promise about what comes next.
        </p>
      </section>

      <section className="card">
        <h2 className={planStyles.pageTitle}>Trade history</h2>
        <TradeHistory trades={appState.portfolio.trades} />
      </section>

      <section className="card">
        <h2 className={planStyles.pageTitle}>Start over</h2>
        <div style={{ marginTop: "0.75rem" }}>
          <ResetButton budget={settings.budget} />
        </div>
      </section>
    </div>
  );
}
