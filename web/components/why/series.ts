/**
 * Pure series math and formatting helpers for the Why page. No DOM, no
 * engine imports — everything here is unit-tested in series.test.ts.
 */

export function last<T>(values: readonly T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined;
}

/**
 * Per-day distance below the running equity peak, as fractions at or below
 * zero (-0.25 means the curve sat 25% under its own previous high).
 */
export function drawdownSeries(equity: readonly number[]): number[] {
  let peak = Number.NEGATIVE_INFINITY;
  return equity.map((value) => {
    if (value > peak) peak = value;
    return peak > 0 ? value / peak - 1 : 0;
  });
}

/**
 * Portfolio return implied by moving each held position from its last
 * close to its latest quote. Positions without a usable quote or base
 * close (NaN marks a missing price) are treated as unchanged, which
 * understates movement rather than inventing it.
 */
export function markToQuotes(
  weights: readonly number[],
  baseCloses: readonly number[],
  quotePrices: readonly (number | null)[],
): number {
  let ret = 0;
  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i] ?? 0;
    const base = baseCloses[i];
    const quote = quotePrices[i];
    if (weight === 0 || base === undefined || !Number.isFinite(base) || base <= 0) continue;
    if (quote === undefined || quote === null || quote <= 0) continue;
    ret += weight * (quote / base - 1);
  }
  return ret;
}

/** "0.156" -> "15.6%"; non-finite values (NaN, ±Infinity) -> "n/a". */
export function fmtPct(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(decimals)}%`;
}

/** "1.0723" -> "1.07"; non-finite values -> "n/a". */
export function fmtRatio(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(decimals);
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function parseIsoDate(iso: string): { year: string; month: string; day: string } | null {
  const parts = iso.split("-");
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) return null;
  return { year, month, day };
}

/** "2021-06-11" -> "Jun 2021". Falls back to the input when unparseable. */
export function shortMonth(iso: string): string {
  const parts = parseIsoDate(iso);
  if (parts === null) return iso;
  const monthIndex = Number(parts.month) - 1;
  const name = MONTH_NAMES[monthIndex];
  if (name === undefined) return iso;
  return `${name} ${parts.year}`;
}

/** "2021-06-11" -> "Jun 11, 2021". Falls back to the input when unparseable. */
export function fmtDate(iso: string): string {
  const parts = parseIsoDate(iso);
  if (parts === null) return iso;
  const monthIndex = Number(parts.month) - 1;
  const name = MONTH_NAMES[monthIndex];
  if (name === undefined) return iso;
  return `${name} ${Number(parts.day)}, ${parts.year}`;
}
