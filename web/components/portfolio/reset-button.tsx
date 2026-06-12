"use client";

/**
 * Reset with an explicit two-step confirmation: the first click only
 * reveals what reset means, and a second, differently-labeled click does
 * it. The store's reducer keeps the user's settings and refunds the full
 * budget as cash.
 */

import { useState } from "react";

import { reset, store } from "@/lib/store";

import { fmtMoneyRound } from "../plan/plan-logic";
import planStyles from "../plan/plan.module.css";
import styles from "./portfolio.module.css";

export function ResetButton({ budget }: { budget: number }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className={styles.resetZone}>
        <button
          type="button"
          className={styles.dangerButton}
          onClick={() => setConfirming(true)}
        >
          Reset paper portfolio…
        </button>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          Wipes every position, trade, and chart point. Your settings stay.
        </span>
      </div>
    );
  }

  return (
    <div className={styles.resetZone}>
      <span className={styles.resetWarning}>
        This erases all paper trades and history and refunds your starting{" "}
        {fmtMoneyRound(budget)} of pretend money. There is no undo.
      </span>
      <button
        type="button"
        className={styles.dangerButton}
        onClick={() => {
          store.setState(reset);
          setConfirming(false);
        }}
      >
        Yes, start over
      </button>
      <button
        type="button"
        className={planStyles.ghostButton}
        onClick={() => setConfirming(false)}
      >
        Keep my portfolio
      </button>
    </div>
  );
}
