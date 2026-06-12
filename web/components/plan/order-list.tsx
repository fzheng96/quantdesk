"use client";

/**
 * TODAY'S PLAN: the concrete order list that moves the paper portfolio to
 * the blend's current targets, sized and priced at the latest quotes, with
 * the one-click follow button.
 */

import { fmtMoney, fmtMoneyRound, fmtPct, fmtShares, type PlannedOrder } from "./plan-logic";
import { InfoTip } from "./info-tip";
import styles from "./plan.module.css";

export type FollowState = "idle" | "done" | "error";

export function OrderList({
  orders,
  targets,
  asOfLabel,
  followState,
  followError,
  onFollow,
  followPaused = false,
}: {
  orders: PlannedOrder[];
  /** Today's target mix, ticker -> fraction of equity, for the details table. */
  targets: Record<string, number>;
  /** For example "prices as of 2:47 PM ET". */
  asOfLabel: string;
  followState: FollowState;
  followError: string | null;
  onFollow: () => void;
  /**
   * True when only stale demo data is available: the follow button stays
   * visible but disabled, so fabricated prices can never enter the ledger.
   */
  followPaused?: boolean;
}) {
  const targetRows = Object.entries(targets).sort((a, b) => b[1] - a[1]);
  const targetSum = targetRows.reduce((acc, [, w]) => acc + w, 0);

  return (
    <section className="card">
      <div className={styles.planHeaderRow}>
        <h2 className={styles.pageTitle}>
          Today&apos;s plan
          <InfoTip label="today's plan">
            After each market close, the strategy recomputes the portfolio it
            wants to hold. These orders are simply the difference between that
            target and what your paper portfolio holds now, sized at the
            latest quoted prices. Follow them, skip them, or just watch.
          </InfoTip>
        </h2>
        <span className={styles.planAsOf}>{asOfLabel}</span>
      </div>

      {orders.length === 0 ? (
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          No orders today — your paper portfolio already matches the plan.
          Check back after the next market close.
        </p>
      ) : (
        <div style={{ marginTop: "0.5rem" }}>
          {orders.map((order) => (
            <div className={styles.orderRow} key={`${order.side}-${order.ticker}`}>
              <span
                className={`${styles.sideBadge} ${
                  order.side === "buy" ? styles.sideBuy : styles.sideSell
                }`}
              >
                {order.side === "buy" ? "BUY" : "SELL"}
              </span>
              <span className={styles.orderMain}>
                {fmtShares(order.shares)} of{" "}
                <span className={styles.orderTicker}>{order.ticker}</span>
              </span>
              <span className={styles.orderAmount}>
                about {fmtMoneyRound(order.notional)} at {fmtMoney(order.price)}
              </span>
            </div>
          ))}
        </div>
      )}

      {orders.length > 0 ? (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onFollow}
          disabled={followPaused || followState === "done"}
        >
          {followPaused
            ? "Demo data — following is paused"
            : followState === "done"
              ? "Plan followed"
              : "Follow today's plan"}
        </button>
      ) : null}

      {followPaused && orders.length > 0 ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          These orders are sized from an old demo snapshot, so they cannot be
          followed — a fill at months-old prices would sit in your trade
          history forever. Following resumes once live prices are back.
        </p>
      ) : null}

      {followState === "done" ? (
        <p className={styles.successNote}>
          Done — every order filled in your paper portfolio at the prices
          shown. Check back tomorrow for the next plan.
        </p>
      ) : null}
      {followState === "error" && followError !== null ? (
        <p className={styles.errorText}>{followError}</p>
      ) : null}

      <details className={styles.targetsDetails}>
        <summary>See the full target mix</summary>
        <table className={styles.targetsTable}>
          <thead>
            <tr>
              <th>Stock</th>
              <th>
                Target weight{" "}
                <InfoTip label="target weight">
                  The slice of your total portfolio value the strategy wants in
                  this stock. No single stock is ever allowed more than 25%,
                  so one bad name cannot sink the whole book. Whatever the
                  weights do not claim stays in cash.
                </InfoTip>
              </th>
            </tr>
          </thead>
          <tbody>
            {targetRows.map(([ticker, weight]) => (
              <tr key={ticker}>
                <td>{ticker}</td>
                <td>{fmtPct(weight)}</td>
              </tr>
            ))}
            <tr>
              <td>Cash</td>
              <td>{fmtPct(Math.max(0, 1 - targetSum))}</td>
            </tr>
          </tbody>
        </table>
      </details>

      <p className={styles.disclaimer}>
        Simulated orders for a paper portfolio, sized from free quotes that
        can be delayed about 15 minutes. Not investment advice.
      </p>
    </section>
  );
}
