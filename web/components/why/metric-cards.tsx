import type { ReactNode } from "react";

import type { SummaryMetrics } from "@/lib/engine/types";

import { InfoTip } from "./info-tip";
import { fmtDate, fmtPct, fmtRatio } from "./series";
import styles from "./why.module.css";

interface CardSpec {
  label: string;
  value: string;
  sub?: string;
  explainLabel: string;
  explain: ReactNode;
}

/**
 * The seven headline metric cards, each with a plain-English "?" explainer
 * so no number on the page is left unexplained.
 */
export function MetricCards({ metrics }: { metrics: SummaryMetrics }) {
  const cards: CardSpec[] = [
    {
      label: "CAGR",
      value: fmtPct(metrics.cagr),
      explainLabel: "What does CAGR mean?",
      explain:
        "Compound annual growth rate: how fast the simulated account grew per year, on average, with compounding. It says nothing about how rough the ride was — check the drawdown chart for that.",
    },
    {
      label: "Ann. vol",
      value: fmtPct(metrics.annVol),
      explainLabel: "What does annualized volatility mean?",
      explain:
        "How much the value wobbles, scaled to a yearly number. At 12% volatility, swings of roughly ±12% over a year are ordinary, and bigger ones happen regularly. Wobble is the price paid, in stomach acid, for returns.",
    },
    {
      label: "Sharpe",
      value: fmtRatio(metrics.sharpe),
      explainLabel: "What does the Sharpe ratio mean?",
      explain:
        "Return per unit of wobble (with a risk-free rate of zero). For daily-data backtests: below 0.5 is weak, around 1 is good, 2 is suspicious, and 3+ usually means a bug or cheating somewhere.",
    },
    {
      label: "Sortino",
      value: fmtRatio(metrics.sortino),
      explainLabel: "What does the Sortino ratio mean?",
      explain:
        "Sharpe's fairer sibling: it only counts downside wobble, so pleasant upside surprises are not punished. Read it like Sharpe, with slightly higher thresholds.",
    },
    {
      label: "Max drawdown",
      value: fmtPct(metrics.maxDrawdown),
      sub: `${fmtDate(metrics.maxDrawdownPeak)} → ${fmtDate(metrics.maxDrawdownTrough)} · ${metrics.maxDrawdownDays} days down`,
      explainLabel: "What does max drawdown mean?",
      explain:
        "The worst peak-to-valley loss in the period, shown as a positive number: 30% means $10,000 became $7,000 at the lowest point. The dates cover the decline only, not the climb back. Ask honestly: would you have kept following the rules down there?",
    },
    {
      label: "Calmar",
      value: fmtRatio(metrics.calmar),
      explainLabel: "What does the Calmar ratio mean?",
      explain:
        "CAGR divided by max drawdown — yearly growth per unit of worst-case pain. Above 1 is rare over long periods. It hangs on a single worst episode, so it is noisy on short histories.",
    },
    {
      label: "Hit rate",
      value: fmtPct(metrics.hitRate),
      explainLabel: "What does hit rate mean?",
      explain:
        "The share of invested days that made money. Good strategies sit barely above a coin flip — profits come from winning slightly more often, or slightly bigger, compounded over thousands of days. A claimed 80% hit rate is a red flag, not a feature.",
    },
  ];

  return (
    <div className={styles.cardGrid}>
      {cards.map((card) => (
        <div key={card.label} className={styles.metricCard}>
          <div className={styles.metricLabel}>
            {card.label}
            <InfoTip label={card.explainLabel}>{card.explain}</InfoTip>
          </div>
          <div className={styles.metricValue}>{card.value}</div>
          {card.sub !== undefined ? <div className={styles.metricSub}>{card.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
