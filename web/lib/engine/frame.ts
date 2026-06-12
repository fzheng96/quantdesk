/**
 * Dense series and matrix helpers shared by the engine port.
 *
 * A Matrix is row-major: rows are dates in ascending order, columns are
 * tickers, and NaN marks a missing observation. These helpers replicate the
 * semantics of the reference Python engine in ../../quantdesk at the repo
 * root, which the parity tests hold this port to within 1e-8 relative
 * tolerance: rolling windows emit NaN until they hold a full window of
 * non-missing values, standard deviations use the sample convention
 * (ddof = 1), and any comparison involving NaN is false.
 */

export type Matrix = number[][];

export function rowCount(m: Matrix): number {
  return m.length;
}

export function colCount(m: Matrix): number {
  const first = m[0];
  return first === undefined ? 0 : first.length;
}

/** A new matrix of the given shape with every cell set to `value`. */
export function filled(nRows: number, nCols: number, value: number): Matrix {
  const out: Matrix = new Array<number[]>(nRows);
  for (let t = 0; t < nRows; t++) {
    out[t] = new Array<number>(nCols).fill(value);
  }
  return out;
}

/**
 * Shift rows down by `periods` (the DataFrame.shift convention): row t of the
 * result is row t - periods of the input, and the vacated leading rows are
 * filled with `fill`.
 */
export function shiftRows(m: Matrix, periods: number, fill: number = Number.NaN): Matrix {
  const n = m.length;
  const c = colCount(m);
  const out = filled(n, c, fill);
  for (let t = periods; t < n; t++) {
    const src = m[t - periods]!;
    const dst = out[t]!;
    for (let j = 0; j < c; j++) {
      dst[j] = src[j]!;
    }
  }
  return out;
}

/**
 * Element-wise percentage change over `periods` rows with no forward-filling:
 * result[t][j] = m[t][j] / m[t - periods][j] - 1, NaN wherever the current or
 * the lagged value is missing or the row has no lag yet.
 */
export function pctChange(m: Matrix, periods = 1): Matrix {
  const n = m.length;
  const c = colCount(m);
  const out = filled(n, c, Number.NaN);
  for (let t = periods; t < n; t++) {
    const cur = m[t]!;
    const lag = m[t - periods]!;
    const dst = out[t]!;
    for (let j = 0; j < c; j++) {
      const a = cur[j]!;
      const b = lag[j]!;
      dst[j] = Number.isNaN(a) || Number.isNaN(b) ? Number.NaN : a / b - 1.0;
    }
  }
  return out;
}

/**
 * Rolling mean down each column with a full-window requirement: the result is
 * NaN until the trailing `window` rows are all non-missing.
 */
export function rollingMeanCols(m: Matrix, window: number): Matrix {
  return rollingCols(m, window, (values, start, end) => {
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += values[i]!;
    }
    return sum / window;
  });
}

/**
 * Rolling sample standard deviation (ddof = 1) down each column with a
 * full-window requirement, mirroring rolling(window).std().
 */
export function rollingStdCols(m: Matrix, window: number): Matrix {
  return rollingCols(m, window, (values, start, end) => twoPassStd(values, start, end));
}

/** Rolling sample standard deviation (ddof = 1) of a vector, full window required. */
export function rollingStdVec(v: number[], window: number): number[] {
  const n = v.length;
  const out = new Array<number>(n).fill(Number.NaN);
  let lastNaN = -1;
  for (let t = 0; t < n; t++) {
    if (Number.isNaN(v[t]!)) {
      lastNaN = t;
    }
    const start = t - window + 1;
    if (start >= 0 && lastNaN < start) {
      out[t] = twoPassStd(v, start, t + 1);
    }
  }
  return out;
}

/**
 * Two-pass sample standard deviation of values[start..end): mean first, then
 * the mean of squared deviations with the ddof = 1 denominator. The two-pass
 * form is numerically stable enough to track the reference implementation
 * well inside the parity tolerance.
 */
function twoPassStd(values: number[], start: number, end: number): number {
  const n = end - start;
  if (n < 2) {
    return Number.NaN;
  }
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += values[i]!;
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = start; i < end; i++) {
    const d = values[i]! - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

/** Shared driver for full-window rolling statistics down each column. */
function rollingCols(
  m: Matrix,
  window: number,
  stat: (columnValues: number[], start: number, end: number) => number,
): Matrix {
  const n = m.length;
  const c = colCount(m);
  const out = filled(n, c, Number.NaN);
  const column = new Array<number>(n);
  for (let j = 0; j < c; j++) {
    let lastNaN = -1;
    for (let t = 0; t < n; t++) {
      const v = m[t]![j]!;
      column[t] = v;
      if (Number.isNaN(v)) {
        lastNaN = t;
      }
      const start = t - window + 1;
      if (start >= 0 && lastNaN < start) {
        out[t]![j] = stat(column, start, t + 1);
      }
    }
  }
  return out;
}
