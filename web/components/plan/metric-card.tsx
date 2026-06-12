"use client";

/**
 * A labeled number with a mandatory plain-English explanation. Nothing on
 * the site shows a metric without one, so the explanation prop is required.
 */

import { InfoTip } from "./info-tip";
import styles from "./plan.module.css";

export type MetricTone = "up" | "down" | "neutral";

export function MetricCard({
  label,
  value,
  sub,
  explain,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  explain: React.ReactNode;
  tone?: MetricTone;
}) {
  const toneClass =
    tone === "up" ? styles.toneUp : tone === "down" ? styles.toneDown : "";
  return (
    <div className={`${styles.metricCard}`}>
      <div className={styles.metricLabel}>
        <span>{label}</span>
        <InfoTip label={label}>{explain}</InfoTip>
      </div>
      <div className={`${styles.metricValue} ${toneClass}`}>{value}</div>
      {sub !== undefined ? <div className={styles.metricSub}>{sub}</div> : null}
    </div>
  );
}
