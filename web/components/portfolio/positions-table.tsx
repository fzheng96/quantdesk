"use client";

/**
 * The positions table: every open paper position valued at the latest
 * quote, with its weight in the book and its profit or loss since purchase.
 */

import type { PriceMap } from "@/lib/store";

import { InfoTip } from "../plan/info-tip";
import {
  fmtMoney,
  fmtMoneySigned,
  fmtPct,
  fmtPctSigned,
  type PositionCost,
} from "../plan/plan-logic";
import styles from "./portfolio.module.css";

export function PositionsTable({
  positions,
  costs,
  prices,
  totalValue,
}: {
  positions: Record<string, number>;
  costs: Record<string, PositionCost>;
  prices: PriceMap;
  totalValue: number | null;
}) {
  const rows = Object.entries(positions).sort((a, b) => a[0].localeCompare(b[0]));

  if (rows.length === 0) {
    return (
      <p className={styles.emptyNote}>
        No positions yet. Follow a plan on the Today page and they will show
        up here.
      </p>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Stock</th>
            <th>Shares</th>
            <th>
              Price{" "}
              <InfoTip label="price">
                The latest quoted price per share. The free source can delay
                it by up to about 15 minutes.
              </InfoTip>
            </th>
            <th>Value</th>
            <th>
              Weight{" "}
              <InfoTip label="weight">
                This position&apos;s share of your total portfolio value,
                including cash. The strategy never lets a single stock exceed
                25%.
              </InfoTip>
            </th>
            <th>
              Since buy{" "}
              <InfoTip label="since buy">
                Today&apos;s value compared with what you paid, using your
                average purchase price across all your buys of this stock.
              </InfoTip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([ticker, shares]) => {
            const price = prices[ticker];
            const cost = costs[ticker];
            const value = price !== undefined ? shares * price : null;
            const pnl =
              price !== undefined && cost !== undefined
                ? (price - cost.avgCost) * shares
                : null;
            const pnlPct =
              price !== undefined && cost !== undefined && cost.avgCost > 0
                ? price / cost.avgCost - 1
                : null;
            return (
              <tr key={ticker}>
                <td className={styles.tickerCell}>{ticker}</td>
                <td>{shares.toLocaleString("en-US")}</td>
                <td>{price !== undefined ? fmtMoney(price) : "—"}</td>
                <td>{value !== null ? fmtMoney(value) : "—"}</td>
                <td>
                  {value !== null && totalValue !== null && totalValue > 0
                    ? fmtPct(value / totalValue)
                    : "—"}
                </td>
                <td className={pnl === null ? "" : pnl >= 0 ? styles.up : styles.down}>
                  {pnl !== null ? fmtMoneySigned(pnl) : "—"}
                  {pnlPct !== null ? ` (${fmtPctSigned(pnlPct)})` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
