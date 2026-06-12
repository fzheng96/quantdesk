"use client";

/**
 * The trade log, newest first: every simulated fill the paper portfolio has
 * ever made, exactly as the store recorded it.
 */

import type { Trade } from "@/lib/store";

import { InfoTip } from "../plan/info-tip";
import { fmtMoney } from "../plan/plan-logic";
import styles from "./portfolio.module.css";

export function TradeHistory({ trades }: { trades: readonly Trade[] }) {
  if (trades.length === 0) {
    return (
      <p className={styles.emptyNote}>
        No trades yet — following a plan on the Today page records its fills
        here.
      </p>
    );
  }

  const newestFirst = [...trades].reverse();

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Order</th>
            <th>Stock</th>
            <th>Shares</th>
            <th>
              Fill price{" "}
              <InfoTip label="fill price">
                The quoted price each simulated order was filled at. A real
                order would also pay commissions and get a slightly worse
                price (slippage); the backtest on the Why page charges for
                both.
              </InfoTip>
            </th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {newestFirst.map((trade, i) => (
            <tr key={`${trade.date}-${trade.ticker}-${trade.side}-${i}`}>
              <td>{trade.date}</td>
              <td className={trade.side === "buy" ? styles.sideBuy : styles.sideSell}>
                {trade.side === "buy" ? "Buy" : "Sell"}
              </td>
              <td className={styles.tickerCell}>{trade.ticker}</td>
              <td>{trade.shares.toLocaleString("en-US")}</td>
              <td>{fmtMoney(trade.price)}</td>
              <td>{fmtMoney(trade.shares * trade.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
