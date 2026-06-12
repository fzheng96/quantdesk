/**
 * Pure helpers behind the Today plan and the Portfolio page: order
 * computation, cost-basis math, chart series construction, and formatting.
 * No React, no DOM, no storage — everything here is unit-testable.
 */

// Type-only imports: this module must stay runtime-independent of the lib
// modules so the unit tests can run without bundler path aliases.
import type { PricePanel } from "@/lib/fetch-prices";
import type { Order, PriceMap, Snapshot, Trade } from "@/lib/store";

export type { PricePanel };

/** An order plus the price and dollar amount it was sized at, for display. */
export interface PlannedOrder extends Order {
  price: number;
  notional: number;
}

export interface ChartPoint {
  date: string;
  value: number;
}

/** Drop orders whose dollar size is below this, to avoid churn on tiny diffs. */
export const MIN_ORDER_NOTIONAL = 50;

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function isUsablePrice(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/** Most recent usable close per ticker, scanning back over any missing days. */
export function lastCloseMap(panel: PricePanel): PriceMap {
  const out: PriceMap = {};
  for (let j = 0; j < panel.tickers.length; j++) {
    const ticker = panel.tickers[j];
    if (ticker === undefined) continue;
    for (let i = panel.closes.length - 1; i >= 0; i--) {
      const price = panel.closes[i]?.[j];
      if (isUsablePrice(price)) {
        out[ticker] = price;
        break;
      }
    }
  }
  return out;
}

/**
 * The price every visible number is marked to: the latest live quote where
 * one exists, otherwise the most recent daily close from the panel.
 */
export function livePriceMap(
  panel: PricePanel | null,
  quotes: Record<string, { price: number } | undefined>
): PriceMap {
  const out: PriceMap = panel === null ? {} : lastCloseMap(panel);
  for (const [ticker, quote] of Object.entries(quotes)) {
    if (quote !== undefined && isUsablePrice(quote.price)) {
      out[ticker] = quote.price;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Order computation
// ---------------------------------------------------------------------------

export interface PlanInputs {
  /** Current paper positions: ticker -> shares held. */
  positions: Record<string, number>;
  /** Uninvested cash in dollars. */
  cash: number;
  /** Target portfolio weights from the blend: ticker -> fraction of equity. */
  targetWeights: Record<string, number>;
  /** Latest price per ticker; tickers without a price are left untouched. */
  prices: PriceMap;
  minNotional?: number;
}

/**
 * Compute the whole-share orders that move the paper portfolio toward the
 * target weights. Mirrors the Python broker's suggest_orders, with two
 * adjustments for a beginner-facing paper book:
 *
 * - Quantities are whole shares (targets are floored), because "buy 17
 *   shares" is the language the page speaks.
 * - Buys are checked against the cash that will exist after the sells fill,
 *   and are trimmed to what is affordable. The store's applyPlan refuses to
 *   overdraw cash, so the plan must never propose more buying than selling
 *   plus cash can fund (rounding and skipped tiny sells can otherwise leave
 *   the buys short).
 *
 * Sells come before buys, and within each side bigger dollar amounts come
 * first. Diffs below `minNotional` dollars are dropped to avoid churn, so the
 * resulting book only approximates the targets. Tickers with no usable price
 * are skipped entirely: an existing position in one stays untouched rather
 * than being traded blind.
 */
export function computePlanOrders(inputs: PlanInputs): PlannedOrder[] {
  const { positions, cash, targetWeights, prices } = inputs;
  const minNotional = inputs.minNotional ?? MIN_ORDER_NOTIONAL;

  let equity = cash;
  for (const [ticker, shares] of Object.entries(positions)) {
    const price = prices[ticker];
    if (isUsablePrice(price)) equity += shares * price;
  }
  if (!(equity > 0)) return [];

  const symbols = [
    ...new Set([...Object.keys(positions), ...Object.keys(targetWeights)]),
  ].sort();

  const sells: PlannedOrder[] = [];
  const buys: PlannedOrder[] = [];

  for (const ticker of symbols) {
    const price = prices[ticker];
    if (!isUsablePrice(price)) continue;
    const held = positions[ticker] ?? 0;
    const weight = targetWeights[ticker] ?? 0;
    if (held === 0 && weight === 0) continue;

    // The small epsilon keeps float residue (for example 16.999999999) from
    // flooring one share below the intended target.
    const targetShares = Math.max(0, Math.floor((weight * equity) / price + 1e-9));
    const diff = targetShares - held;
    if (diff === 0) continue;
    if (Math.abs(diff) * price < minNotional) continue;

    if (diff < 0) {
      const shares = Math.min(-diff, held);
      sells.push({ ticker, side: "sell", shares, price, notional: shares * price });
    } else {
      buys.push({ ticker, side: "buy", shares: diff, price, notional: diff * price });
    }
  }

  sells.sort((a, b) => b.notional - a.notional);
  buys.sort((a, b) => b.notional - a.notional);

  // Affordability pass: walk the buys against the cash the sells will free,
  // trimming any order the cash cannot cover. Cents-level rounding here
  // matches the store, which rounds each fill amount to the nearest cent.
  let cashCents = Math.round(cash * 100);
  for (const sell of sells) {
    cashCents += Math.round(sell.shares * Math.round(sell.price * 100));
  }
  const affordable: PlannedOrder[] = [];
  for (const buy of buys) {
    const priceCents = Math.round(buy.price * 100);
    const maxShares = Math.floor(cashCents / priceCents);
    const shares = Math.min(buy.shares, maxShares);
    if (shares < 1) continue;
    cashCents -= shares * priceCents;
    affordable.push({ ...buy, shares, notional: shares * buy.price });
  }

  return [...sells, ...affordable];
}

// ---------------------------------------------------------------------------
// Cost basis (average cost, the method most brokerage statements use)
// ---------------------------------------------------------------------------

export interface PositionCost {
  shares: number;
  /** Average price paid per share still held, in dollars. */
  avgCost: number;
}

/**
 * Replay the trade log to get each open position's average cost. Buys add to
 * the cost pool; sells remove shares at the running average, leaving the
 * average of the remaining shares unchanged.
 */
export function positionCosts(trades: readonly Trade[]): Record<string, PositionCost> {
  const pool: Record<string, { shares: number; cost: number }> = {};
  for (const t of trades) {
    const entry = pool[t.ticker] ?? { shares: 0, cost: 0 };
    if (t.side === "buy") {
      entry.shares += t.shares;
      entry.cost += t.shares * t.price;
    } else {
      const avg = entry.shares > 0 ? entry.cost / entry.shares : 0;
      const sold = Math.min(t.shares, entry.shares);
      entry.shares -= sold;
      entry.cost -= sold * avg;
    }
    pool[t.ticker] = entry;
  }
  const out: Record<string, PositionCost> = {};
  for (const [ticker, entry] of Object.entries(pool)) {
    if (entry.shares > 0) {
      out[ticker] = { shares: entry.shares, avgCost: entry.cost / entry.shares };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day change
// ---------------------------------------------------------------------------

/**
 * Dollar move of the held positions "today", or null when any held ticker is
 * missing a usable quote (a partial sum would be wrong) or nothing is held.
 *
 * Shares carried in from before today move against yesterday's close, the
 * usual day-change convention. Shares bought today move against their own
 * fill price instead: a position opened at 2 PM has only experienced the
 * market since 2 PM, and charging it the stock's full move since yesterday's
 * close would show money the user never made or lost.
 */
export function dayChange(
  positions: Record<string, number>,
  trades: readonly Trade[],
  quotes: Record<string, { price: number; prevClose: number } | undefined>,
  today: string
): number | null {
  const held = Object.entries(positions);
  if (held.length === 0) return null;

  let total = 0;
  for (const [ticker, shares] of held) {
    const quote = quotes[ticker];
    if (
      quote === undefined ||
      !Number.isFinite(quote.price) ||
      !Number.isFinite(quote.prevClose)
    ) {
      return null;
    }
    let boughtToday = 0;
    let boughtCost = 0;
    for (const t of trades) {
      if (t.date === today && t.ticker === ticker && t.side === "buy") {
        boughtToday += t.shares;
        boughtCost += t.shares * t.price;
      }
    }
    // Same-day sells make today's buys exceed the held count in rare cases;
    // the held shares are then all treated as bought today at the average
    // fill, which is the closest honest baseline available.
    const fromToday = Math.min(shares, boughtToday);
    const carried = shares - fromToday;
    const avgFill = boughtToday > 0 ? boughtCost / boughtToday : 0;
    total +=
      carried * (quote.price - quote.prevClose) +
      fromToday * (quote.price - avgFill);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Chart series
// ---------------------------------------------------------------------------

/**
 * The user's equity series: the starting budget on day one, the recorded
 * daily snapshots, and a final point marked to the latest live valuation.
 * Duplicate dates keep the later value, so today's snapshot is superseded by
 * the live number.
 */
export function buildPortfolioSeries(
  snapshots: readonly Snapshot[],
  startDate: string,
  budget: number,
  todayDate: string,
  liveValue: number | null
): ChartPoint[] {
  const byDate = new Map<string, number>();
  byDate.set(startDate, budget);
  for (const s of snapshots) byDate.set(s.date, s.value);
  if (liveValue !== null) byDate.set(todayDate, liveValue);
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

/**
 * What the same budget put into the benchmark on the same start date would
 * be worth: budget scaled by the benchmark's price relative to its close on
 * the first trading day at or after the start. The final point is marked to
 * the live quote when one is available.
 */
export function buildBenchmarkSeries(
  panel: PricePanel,
  benchmarkTicker: string,
  startDate: string,
  budget: number,
  todayDate: string,
  livePrice: number | null
): ChartPoint[] {
  const col = panel.tickers.indexOf(benchmarkTicker);
  if (col < 0) return [];

  const points: { date: string; price: number }[] = [];
  for (let i = 0; i < panel.dates.length; i++) {
    const date = panel.dates[i];
    const price = panel.closes[i]?.[col];
    if (date !== undefined && date >= startDate && isUsablePrice(price)) {
      points.push({ date, price });
    }
  }
  const base = points[0];
  if (base === undefined) return [];

  const series = points.map((p) => ({
    date: p.date,
    value: (budget * p.price) / base.price,
  }));
  const last = series[series.length - 1];
  if (livePrice !== null && isUsablePrice(livePrice)) {
    const livePoint = { date: todayDate, value: (budget * livePrice) / base.price };
    if (last !== undefined && last.date === todayDate) {
      series[series.length - 1] = livePoint;
    } else {
      series.push(livePoint);
    }
  }
  return series;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONEY_EXACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MONEY_ROUND = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Exact dollars and cents, for cash and portfolio values. */
export function fmtMoney(v: number): string {
  return MONEY_EXACT.format(v);
}

/** Rounded dollars, for order sizes and other approximate amounts. */
export function fmtMoneyRound(v: number): string {
  return MONEY_ROUND.format(v);
}

/** Compact dollars for chart axis labels: $98.5k, $1.2M. */
export function fmtMoneyShort(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `$${(v / 1_000).toFixed(0)}k`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return MONEY_ROUND.format(v);
}

/** Signed dollars for P&L: +$1,234 / -$1,234. */
export function fmtMoneySigned(v: number): string {
  const body = MONEY_ROUND.format(Math.abs(v));
  return v >= 0 ? `+${body}` : `-${body}`;
}

/** Signed percent with one decimal: +1.2% / -0.8%. */
export function fmtPctSigned(v: number): string {
  const body = `${Math.abs(v * 100).toFixed(1)}%`;
  return v >= 0 ? `+${body}` : `-${body}`;
}

/** Unsigned percent with one decimal. */
export function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtShares(v: number): string {
  return v === 1 ? "1 share" : `${v.toLocaleString("en-US")} shares`;
}

/** "Jun 11" style date label for chart axes. */
export function fmtDateShort(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2:47 PM ET" for the prices-as-of badge. */
export function fmtEtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  return `${time} ET`;
}

/**
 * The calendar day in New York for a given instant (default: now), formatted
 * YYYY-MM-DD. Trades and snapshots are keyed by US trading days, so a user
 * in another timezone must not roll the date early or late.
 */
export function etDayString(iso?: string): string {
  const d = iso === undefined ? new Date() : new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  // en-CA formats as YYYY-MM-DD, which is exactly the store's date key shape.
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
