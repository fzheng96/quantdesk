"use client";

/**
 * The Today page: setup on first visit, then the daily plan — the blend's
 * target portfolio turned into a concrete order list, marked to the latest
 * quotes — plus the portfolio value cards and the vs-SPY sparkline.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";

import {
  BENCHMARK_TICKER,
  DEFAULT_UNIVERSE,
  fetchPrices,
  type PriceFetchResult,
} from "@/lib/fetch-prices";
import {
  applyPlan,
  getServerSnapshot,
  markToMarket,
  portfolioValue,
  store,
} from "@/lib/store";
import { useLiveQuotes } from "@/lib/use-live-quotes";

import { FirstVisitOverlay } from "../onboarding/first-visit-overlay";
import { EquityChart } from "../portfolio/equity-chart";
import { latestBlendTargets } from "./engine-adapter";
import { MetricCard } from "./metric-card";
import { OrderList, type FollowState } from "./order-list";
import {
  buildBenchmarkSeries,
  buildPortfolioSeries,
  computePlanOrders,
  dayChange,
  etDayString,
  fmtEtTime,
  fmtMoney,
  fmtMoneyRound,
  fmtMoneySigned,
  fmtPct,
  fmtPctSigned,
  livePriceMap,
} from "./plan-logic";
import styles from "./plan.module.css";
import { RiskSetting } from "./risk-setting";
import { SetupFlow } from "./setup-flow";

// Stable identity so the quote polling loop is never restarted by renders.
const ALL_TICKERS: string[] = [...DEFAULT_UNIVERSE, BENCHMARK_TICKER];

/** Portfolio value, or null while some held ticker still has no price. */
function safePortfolioValue(
  state: ReturnType<typeof store.getState>,
  prices: Record<string, number>
): number | null {
  try {
    return portfolioValue(state, prices);
  } catch {
    return null;
  }
}

export function TodayClient() {
  const appState = useSyncExternalStore(store.subscribe, store.getState, getServerSnapshot);
  const live = useLiveQuotes(ALL_TICKERS);

  const [priceResult, setPriceResult] = useState<PriceFetchResult | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [followState, setFollowState] = useState<FollowState>("idle");
  const [followError, setFollowError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    fetchPrices(ALL_TICKERS, 5)
      .then((result) => {
        if (!disposed) setPriceResult(result);
      })
      .catch((err: unknown) => {
        if (!disposed) setPriceError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, []);

  const panel = priceResult?.panel ?? null;
  const settings = appState.settings;

  const priceMap = useMemo(() => livePriceMap(panel, live.quotes), [panel, live.quotes]);

  const targets = useMemo(() => {
    if (panel === null || settings === null) return {};
    return latestBlendTargets(panel, settings.risk, BENCHMARK_TICKER);
  }, [panel, settings]);

  const equity = settings === null ? null : safePortfolioValue(appState, priceMap);

  const orders = useMemo(() => {
    if (settings === null || panel === null) return [];
    return computePlanOrders({
      positions: appState.portfolio.positions,
      cash: appState.portfolio.cash,
      targetWeights: targets,
      prices: priceMap,
    });
  }, [settings, panel, appState.portfolio.positions, appState.portfolio.cash, targets, priceMap]);

  // Demo mode: the price history is the bundled months-old snapshot AND no
  // live quotes have arrived to overlay it. Everything shown is then priced
  // from stale data, so nothing may be recorded and nothing may be traded —
  // a fill or snapshot at demo prices would sit in the permanent ledger
  // dated today.
  const quotesLive = live.lastSuccessAt !== null && Object.keys(live.quotes).length > 0;
  const demoPaused = (priceResult?.fromDemo ?? false) && !quotesLive;

  // Record today's portfolio value whenever fresh prices arrive, so the
  // equity chart accrues one honest point per day the user shows up.
  const today = etDayString(live.asOf ?? undefined);
  useEffect(() => {
    if (settings === null || panel === null || demoPaused) return;
    try {
      store.setState((s) => markToMarket(s, priceMap, today));
    } catch {
      // A held ticker without a usable price yet; the next refresh retries.
    }
  }, [settings, panel, priceMap, today, demoPaused]);

  // "Plan followed" sticks only as long as the followed plan does. When a
  // genuinely different, non-empty order list appears (a new day's plan, or
  // residual diffs after prices moved), the button must come back to life.
  const orderSignature = orders
    .map((o) => `${o.side}:${o.ticker}:${o.shares}`)
    .join("|");
  const followedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      followState === "done" &&
      orderSignature !== "" &&
      orderSignature !== followedSignatureRef.current
    ) {
      setFollowState("idle");
      setFollowError(null);
    }
  }, [followState, orderSignature]);

  if (settings === null) {
    return (
      <>
        <FirstVisitOverlay />
        <SetupFlow />
      </>
    );
  }

  if (priceError !== null) {
    return (
      <section className="card">
        <h1 className={styles.pageTitle}>Today</h1>
        <p className={styles.errorText} style={{ marginTop: "0.75rem" }}>
          {priceError}
        </p>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Reload the page to try again.
        </p>
      </section>
    );
  }

  if (priceResult === null || panel === null) {
    return (
      <section className="card">
        <h1 className={styles.pageTitle}>Today</h1>
        <p className={styles.loadingCard} style={{ marginTop: "0.75rem" }}>
          Fetching five years of prices and computing today&apos;s plan in your
          browser…
        </p>
      </section>
    );
  }

  const onFollow = () => {
    // The button is disabled in demo mode; this guard keeps a stale closure
    // or programmatic click from writing demo-priced fills anyway.
    if (demoPaused) return;
    try {
      store.setState((s) => applyPlan(s, orders, priceMap, today));
      store.setState((s) => markToMarket(s, priceMap, today));
      followedSignatureRef.current = orderSignature;
      setFollowState("done");
      setFollowError(null);
    } catch (err) {
      setFollowState("error");
      setFollowError(
        `The plan could not be applied: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // Day change, computable only once live quotes exist for the held
  // tickers. Shares bought today are measured from their fill price, not
  // yesterday's close — see dayChange.
  const heldTickers = Object.keys(appState.portfolio.positions);
  const dayPnl = dayChange(
    appState.portfolio.positions,
    appState.portfolio.trades,
    live.quotes,
    today
  );
  const dayPct =
    dayPnl !== null && equity !== null && equity - dayPnl > 0 ? dayPnl / (equity - dayPnl) : null;

  const startDay = etDayString(settings.createdAt);
  const youSeries = buildPortfolioSeries(
    appState.portfolio.snapshots,
    startDay,
    settings.budget,
    today,
    equity
  );
  const spyQuote = live.quotes[BENCHMARK_TICKER];
  const spySeries = buildBenchmarkSeries(
    panel,
    BENCHMARK_TICKER,
    startDay,
    settings.budget,
    today,
    spyQuote !== undefined && Number.isFinite(spyQuote.price) ? spyQuote.price : null
  );

  const cash = appState.portfolio.cash;
  const investedFrac = equity !== null && equity > 0 ? (equity - cash) / equity : null;

  const asOfLabel =
    live.asOf !== null
      ? `sized at prices as of ${fmtEtTime(live.asOf)}`
      : "sized at the most recent daily close";

  return (
    <div className={styles.stack}>
      <FirstVisitOverlay />

      {priceResult.fromDemo ? (
        <div className={styles.banner}>
          Live price sources are unreachable right now, so today&apos;s plan is
          computed from the bundled demo snapshot (data as of{" "}
          {panel.asOf.slice(0, 10)}). Treat it as a tour, not today&apos;s
          market.
          {demoPaused
            ? " Following the plan is paused so months-old prices never enter your trade history."
            : ""}
        </div>
      ) : null}

      <OrderList
        orders={orders}
        targets={targets}
        asOfLabel={asOfLabel}
        followState={followState}
        followError={followError}
        onFollow={onFollow}
        followPaused={demoPaused}
      />

      <div className={styles.metricGrid}>
        <MetricCard
          label="Portfolio value"
          value={equity !== null ? fmtMoney(equity) : "—"}
          sub={`started with ${fmtMoneyRound(settings.budget)}`}
          explain="Your cash plus what your positions are worth at the latest quoted prices. All of it is pretend money."
        />
        <MetricCard
          label="Today so far"
          value={dayPnl !== null ? fmtMoneySigned(dayPnl) : "—"}
          sub={
            heldTickers.length === 0
              ? "no positions yet"
              : dayPct !== null
                ? fmtPctSigned(dayPct)
                : "waiting for live quotes"
          }
          tone={dayPnl === null ? "neutral" : dayPnl >= 0 ? "up" : "down"}
          explain="How much your positions have moved today, at the latest quotes. Shares you already held are measured from yesterday's market close; shares you bought today are measured from the price you paid, so this is genuinely your money's move. One day means almost nothing — it is shown so you never wonder."
        />
        <MetricCard
          label="Cash on the sidelines"
          value={fmtMoney(cash)}
          sub={equity !== null && equity > 0 ? `${fmtPct(cash / equity)} of the portfolio` : undefined}
          explain="The part of your budget the strategy is not investing right now. When few stocks are trending, it deliberately holds more cash rather than forcing trades."
        />
        <MetricCard
          label="Positions"
          value={String(heldTickers.length)}
          sub={investedFrac !== null ? `${fmtPct(investedFrac)} invested` : undefined}
          explain="How many different stocks your paper portfolio holds. Spreading across names limits the damage any single one can do."
        />
      </div>

      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <span>You vs the market</span>
          <span className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{ background: "#5ab0f2" }} />
              You {equity !== null ? fmtMoneyRound(equity) : ""}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{ background: "#8b93a7" }} />
              SPY{" "}
              {spySeries.length > 0
                ? fmtMoneyRound(spySeries[spySeries.length - 1]?.value ?? 0)
                : ""}
            </span>
          </span>
        </div>
        {youSeries.length >= 2 ? (
          <EquityChart
            variant="sparkline"
            series={[
              { label: "Your paper portfolio", color: "#5ab0f2", points: youSeries },
              { label: "SPY from the same start", color: "#8b93a7", points: spySeries },
            ]}
          />
        ) : (
          <p className={styles.loadingCard} style={{ marginTop: "0.5rem" }}>
            Your line starts today. Come back after the next market close to
            see your first point — the full chart lives on the{" "}
            <Link href="/portfolio">Portfolio</Link> page.
          </p>
        )}
        <p className={styles.disclaimer}>
          SPY tracks the S&amp;P 500 — what you would have if you had just
          bought the market with the same pretend money on day one. Simulated
          results from free data; not investment advice.
        </p>
      </div>

      <RiskSetting risk={settings.risk} />

      <section className="card">
        <h2 className={styles.pageTitle}>
          When to come back
          <span className={styles.legend} />
        </h2>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Signals update once per day, after the US market closes. Checking in
          daily — or even weekly — is plenty: trading much more often than
          weekly mostly pays trading costs without adding any new information.
        </p>
      </section>
    </div>
  );
}
