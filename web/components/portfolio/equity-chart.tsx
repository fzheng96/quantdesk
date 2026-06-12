/**
 * Hand-rolled SVG equity chart in the tearsheet's visual language: dark
 * panel, faint gridlines, accent-blue strategy line, dim-gray benchmark.
 * Time is on the x axis (sparse series like daily snapshots land in the
 * right place next to dense daily benchmarks), and the last point of each
 * series — the live valuation — gets an endpoint dot.
 *
 * Pure render, no hooks: the parents own data fetching and legends' values.
 */

import { fmtDateShort, fmtMoneyShort, type ChartPoint } from "../plan/plan-logic";
import styles from "./portfolio.module.css";

export interface ChartSeries {
  label: string;
  color: string;
  points: ChartPoint[];
}

interface Scaled {
  x: number;
  y: number;
}

function timeOf(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function EquityChart({
  series,
  variant = "full",
}: {
  series: ChartSeries[];
  variant?: "full" | "sparkline";
}) {
  const drawn = series.filter((s) => s.points.length > 0);
  if (drawn.length === 0) return null;

  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const s of drawn) {
    for (const p of s.points) {
      const t = timeOf(p.date);
      if (Number.isNaN(t) || !Number.isFinite(p.value)) continue;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      if (p.value < vMin) vMin = p.value;
      if (p.value > vMax) vMax = p.value;
    }
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(vMin)) return null;
  if (tMax === tMin) tMax = tMin + 1;
  if (vMax === vMin) {
    vMin *= 0.99;
    vMax *= 1.01;
  }
  const vPad = (vMax - vMin) * 0.06;
  vMin -= vPad;
  vMax += vPad;

  const isFull = variant === "full";
  const width = isFull ? 640 : 240;
  const height = isFull ? 280 : 64;
  const pad = isFull
    ? { left: 58, right: 16, top: 14, bottom: 28 }
    : { left: 4, right: 6, top: 6, bottom: 6 };

  const sx = (t: number) =>
    pad.left + ((t - tMin) / (tMax - tMin)) * (width - pad.left - pad.right);
  const sy = (v: number) =>
    height - pad.bottom - ((v - vMin) / (vMax - vMin)) * (height - pad.top - pad.bottom);

  const scale = (p: ChartPoint): Scaled | null => {
    const t = timeOf(p.date);
    if (Number.isNaN(t) || !Number.isFinite(p.value)) return null;
    return { x: sx(t), y: sy(p.value) };
  };

  // Four horizontal gridlines with value labels (full variant only).
  const gridTicks = isFull
    ? [0, 1, 2, 3].map((i) => vMin + ((i + 0.5) / 4) * (vMax - vMin))
    : [];

  // First, middle, and last date labels along the x axis.
  const longest = drawn.reduce((a, b) => (a.points.length >= b.points.length ? a : b));
  const xTickPoints: ChartPoint[] = [];
  if (isFull && longest.points.length > 0) {
    const first = longest.points[0];
    const mid = longest.points[Math.floor(longest.points.length / 2)];
    const last = longest.points[longest.points.length - 1];
    for (const p of [first, mid, last]) {
      if (p !== undefined && !xTickPoints.some((q) => q.date === p.date)) {
        xTickPoints.push(p);
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={isFull ? styles.chartSvg : styles.sparklineSvg}
      role="img"
      aria-label={`Chart comparing ${drawn.map((s) => s.label).join(" and ")}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {gridTicks.map((v) => (
        <g key={v}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={sy(v)}
            y2={sy(v)}
            stroke="#262d3b"
            strokeWidth={1}
          />
          <text x={pad.left - 8} y={sy(v) + 3.5} textAnchor="end" className={styles.axisText}>
            {fmtMoneyShort(v)}
          </text>
        </g>
      ))}
      {xTickPoints.map((p) => {
        const s = scale(p);
        if (s === null) return null;
        return (
          <text
            key={p.date}
            x={s.x}
            y={height - 8}
            textAnchor="middle"
            className={styles.axisText}
          >
            {fmtDateShort(p.date)}
          </text>
        );
      })}
      {drawn.map((s) => {
        const pts = s.points
          .map(scale)
          .filter((p): p is Scaled => p !== null);
        if (pts.length === 0) return null;
        const path = pts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
          .join(" ");
        const end = pts[pts.length - 1];
        return (
          <g key={s.label}>
            {pts.length > 1 ? (
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={isFull ? 2 : 1.6}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {end !== undefined ? (
              <>
                <circle cx={end.x} cy={end.y} r={isFull ? 6 : 4} fill={s.color} opacity={0.2} />
                <circle cx={end.x} cy={end.y} r={isFull ? 3 : 2.2} fill={s.color} />
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
