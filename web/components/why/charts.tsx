/**
 * Hand-rolled SVG charts for the Why page: equity-vs-benchmark and
 * drawdown. No chart library, per the spec. Pure presentational
 * components — all series math happens in series.ts / the engine.
 */

import { fmtDate, fmtPct, shortMonth } from "./series";
import styles from "./why.module.css";

const W = 720;
const H = 260;
const MARGIN = { top: 12, right: 18, bottom: 28, left: 56 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const PLOT_H = H - MARGIN.top - MARGIN.bottom;

const BLEND_COLOR = "#5ab0f2";
const BENCH_COLOR = "#8b93a7";
const DRAWDOWN_COLOR = "#d9777c";
const GRID_COLOR = "#262d3b";
const LABEL_COLOR = "#8b93a7";

function xAt(index: number, count: number): number {
  if (count <= 1) return MARGIN.left;
  return MARGIN.left + (index / (count - 1)) * PLOT_W;
}

function yAt(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return MARGIN.top + PLOT_H / 2;
  return MARGIN.top + (1 - (value - min) / span) * PLOT_H;
}

function polylinePoints(values: readonly number[], min: number, max: number): string {
  return values
    .map((v, i) => `${xAt(i, values.length).toFixed(2)},${yAt(v, min, max).toFixed(2)}`)
    .join(" ");
}

function niceTicks(min: number, max: number, target = 4): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const rawStep = span / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = magnitude * 10;
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (magnitude * factor >= rawStep) {
      step = magnitude * factor;
      break;
    }
  }
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) {
    ticks.push(t);
  }
  return ticks;
}

function xTickIndexes(count: number): number[] {
  if (count <= 1) return [0];
  const picks = [0, Math.round((count - 1) / 3), Math.round((2 * (count - 1)) / 3), count - 1];
  return [...new Set(picks)].sort((a, b) => a - b);
}

function XAxis({ dates }: { dates: readonly string[] }) {
  return (
    <>
      {xTickIndexes(dates.length).map((i) => {
        const date = dates[i];
        if (date === undefined) return null;
        const x = xAt(i, dates.length);
        const anchor = i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle";
        return (
          <text
            key={i}
            x={x}
            y={H - 8}
            fontSize={11}
            fill={LABEL_COLOR}
            textAnchor={anchor}
          >
            {shortMonth(date)}
          </text>
        );
      })}
    </>
  );
}

export interface LiveEndpoint {
  blend: number | null;
  benchmark: number | null;
  label: string;
}

/**
 * Growth-of-$1 chart: the blend in accent blue, SPY in gray. When a live
 * quote extension is supplied, both curves get an open dot just past the
 * final close, marking today's value between closes.
 */
export function EquityChart({
  dates,
  blend,
  benchmark,
  live,
}: {
  dates: string[];
  blend: number[];
  benchmark: number[] | null;
  live?: LiveEndpoint | null;
}) {
  if (blend.length === 0 || dates.length === 0) return null;

  const allValues = [...blend];
  if (benchmark !== null) allValues.push(...benchmark);
  if (live?.blend != null) allValues.push(live.blend);
  if (live?.benchmark != null) allValues.push(live.benchmark);
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (min === max) {
    min -= 0.05;
    max += 0.05;
  }
  const pad = (max - min) * 0.04;
  min -= pad;
  max += pad;

  const ticks = niceTicks(min, max);
  const liveX = MARGIN.left + PLOT_W + 9;
  const lastBlend = blend[blend.length - 1];
  const lastBench = benchmark === null ? undefined : benchmark[benchmark.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={styles.chartSvg}
      role="img"
      aria-label="Line chart of the growth of one dollar: the strategy blend versus simply holding SPY over the same period."
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={MARGIN.left}
            x2={MARGIN.left + PLOT_W}
            y1={yAt(t, min, max)}
            y2={yAt(t, min, max)}
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
          <text
            x={MARGIN.left - 7}
            y={yAt(t, min, max) + 4}
            fontSize={11}
            fill={LABEL_COLOR}
            textAnchor="end"
          >
            {`$${t.toFixed(2)}`}
          </text>
        </g>
      ))}
      <XAxis dates={dates} />
      {benchmark !== null ? (
        <polyline
          points={polylinePoints(benchmark, min, max)}
          fill="none"
          stroke={BENCH_COLOR}
          strokeWidth={1.4}
        />
      ) : null}
      <polyline
        points={polylinePoints(blend, min, max)}
        fill="none"
        stroke={BLEND_COLOR}
        strokeWidth={1.8}
      />
      {live?.blend != null && lastBlend !== undefined ? (
        <g>
          <line
            x1={xAt(blend.length - 1, blend.length)}
            y1={yAt(lastBlend, min, max)}
            x2={liveX}
            y2={yAt(live.blend, min, max)}
            stroke={BLEND_COLOR}
            strokeWidth={1.4}
            strokeDasharray="3 3"
          />
          <circle
            cx={liveX}
            cy={yAt(live.blend, min, max)}
            r={3.5}
            fill="none"
            stroke={BLEND_COLOR}
            strokeWidth={1.8}
          />
        </g>
      ) : null}
      {live?.benchmark != null && lastBench !== undefined && benchmark !== null ? (
        <g>
          <line
            x1={xAt(benchmark.length - 1, benchmark.length)}
            y1={yAt(lastBench, min, max)}
            x2={liveX}
            y2={yAt(live.benchmark, min, max)}
            stroke={BENCH_COLOR}
            strokeWidth={1.2}
            strokeDasharray="3 3"
          />
          <circle
            cx={liveX}
            cy={yAt(live.benchmark, min, max)}
            r={3}
            fill="none"
            stroke={BENCH_COLOR}
            strokeWidth={1.5}
          />
        </g>
      ) : null}
    </svg>
  );
}

export function EquityLegend({ hasBenchmark }: { hasBenchmark: boolean }) {
  return (
    <div className={styles.legend}>
      <span className={styles.legendItem}>
        <span className={styles.legendSwatch} style={{ background: BLEND_COLOR }} />
        The strategy blend
      </span>
      {hasBenchmark ? (
        <span className={styles.legendItem}>
          <span className={styles.legendSwatch} style={{ background: BENCH_COLOR }} />
          Just buying SPY
        </span>
      ) : null}
    </div>
  );
}

/**
 * Drawdown chart: how far below its own previous peak the blend sat each
 * day. Values are fractions at or below zero. The deepest point is marked.
 */
export function DrawdownChart({
  dates,
  drawdown,
}: {
  dates: string[];
  drawdown: number[];
}) {
  if (drawdown.length === 0 || dates.length === 0) return null;

  let minValue = 0;
  let minIndex = 0;
  drawdown.forEach((v, i) => {
    if (v < minValue) {
      minValue = v;
      minIndex = i;
    }
  });

  const max = 0.002; // hair of headroom so the zero line is visible
  const min = Math.min(minValue * 1.12, -0.01);
  const ticks = niceTicks(min, 0, 3);

  const zeroY = yAt(0, min, max);
  const linePts = drawdown.map(
    (v, i) => `${xAt(i, drawdown.length).toFixed(2)},${yAt(v, min, max).toFixed(2)}`,
  );
  const areaPath = `M ${xAt(0, drawdown.length).toFixed(2)} ${zeroY.toFixed(2)} L ${linePts.join(
    " L ",
  )} L ${xAt(drawdown.length - 1, drawdown.length).toFixed(2)} ${zeroY.toFixed(2)} Z`;

  const troughDate = dates[minIndex];
  const troughX = xAt(minIndex, drawdown.length);
  const troughLabelAnchor =
    troughX < MARGIN.left + 90 ? "start" : troughX > MARGIN.left + PLOT_W - 90 ? "end" : "middle";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={styles.chartSvg}
      role="img"
      aria-label={`Area chart of drawdown: how far below its previous peak the blend sat each day. The deepest point is ${fmtPct(
        Math.abs(minValue),
      )}${troughDate !== undefined ? ` in ${shortMonth(troughDate)}` : ""}.`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={MARGIN.left}
            x2={MARGIN.left + PLOT_W}
            y1={yAt(t, min, max)}
            y2={yAt(t, min, max)}
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
          <text
            x={MARGIN.left - 7}
            y={yAt(t, min, max) + 4}
            fontSize={11}
            fill={LABEL_COLOR}
            textAnchor="end"
          >
            {`${Math.round(t * 100)}%`}
          </text>
        </g>
      ))}
      <XAxis dates={dates} />
      <path d={areaPath} fill={DRAWDOWN_COLOR} fillOpacity={0.22} />
      <polyline
        points={linePts.join(" ")}
        fill="none"
        stroke={DRAWDOWN_COLOR}
        strokeWidth={1.5}
      />
      <line
        x1={MARGIN.left}
        x2={MARGIN.left + PLOT_W}
        y1={zeroY}
        y2={zeroY}
        stroke={LABEL_COLOR}
        strokeWidth={1}
      />
      <circle
        cx={troughX}
        cy={yAt(minValue, min, max)}
        r={3.5}
        fill={DRAWDOWN_COLOR}
      />
      <text
        x={troughX}
        y={yAt(minValue, min, max) - 8}
        fontSize={11}
        fill={DRAWDOWN_COLOR}
        textAnchor={troughLabelAnchor}
      >
        {`${fmtPct(minValue, 1)}${troughDate !== undefined ? ` (${fmtDate(troughDate)})` : ""}`}
      </text>
    </svg>
  );
}
