"use client";

/**
 * The two-question setup: how much pretend money, and how bumpy a ride.
 * Completing it funds a fresh paper portfolio through the store's
 * initSettings reducer; there is no third question by design.
 */

import { useState } from "react";

import { initSettings, store, type Risk } from "@/lib/store";

import { RISK_COPY, RISK_TARGET_VOL } from "./engine-adapter";
import { InfoTip } from "./info-tip";
import styles from "./plan.module.css";

const RISK_ORDER: Risk[] = ["conservative", "balanced", "aggressive"];
const DEFAULT_BUDGET = "100000";
const MIN_BUDGET = 1_000;

export function SetupFlow() {
  const [budgetText, setBudgetText] = useState(DEFAULT_BUDGET);
  const [risk, setRisk] = useState<Risk>("balanced");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const budget = Number(budgetText.replace(/[,\s$]/g, ""));
    if (!Number.isFinite(budget) || budget < MIN_BUDGET) {
      setError(
        `Please enter at least $${MIN_BUDGET.toLocaleString("en-US")} — small budgets cannot buy whole shares of most of these stocks.`
      );
      return;
    }
    store.setState((prev) =>
      initSettings(prev, {
        budget,
        risk,
        createdAt: new Date().toISOString(),
      })
    );
  };

  return (
    <form className={styles.setupCard} onSubmit={submit}>
      <h1>Set up your paper portfolio</h1>
      <p className="muted" style={{ marginTop: "0.5rem" }}>
        Two questions and you are in. Everything here uses pretend money —
        nothing is ever bought or sold for real.
      </p>

      <div className={styles.setupQuestion}>
        1. How much pretend money do you want to start with?
        <InfoTip label="paper budget">
          This is play money that exists only in your browser. The app uses it
          to size positions the way it would size real ones, so the experience
          is realistic — but no actual account is touched, ever.
        </InfoTip>
      </div>
      <div className={styles.budgetRow}>
        <span>$</span>
        <input
          className={styles.budgetInput}
          inputMode="numeric"
          value={budgetText}
          onChange={(e) => setBudgetText(e.target.value)}
          aria-label="Paper budget in dollars"
        />
      </div>
      <p className={styles.setupNote}>
        $100,000 is the default because it makes the percentages easy to read.
        It is pretend money either way.
      </p>

      <div className={styles.setupQuestion}>
        2. How bumpy a ride are you comfortable with?
        <InfoTip label="bumpiness">
          Bumpiness is what professionals call volatility: how widely results
          swing from day to day. The app sizes positions so your portfolio
          targets a chosen level of it — the US stock market has historically
          run near 16–20% a year. A calmer setting holds more cash; a bumpier
          one stays more invested.
        </InfoTip>
      </div>
      <div className={styles.riskOptions} role="radiogroup" aria-label="Risk setting">
        {RISK_ORDER.map((option) => (
          <label
            key={option}
            className={`${styles.riskOption} ${risk === option ? styles.riskOptionActive : ""}`}
          >
            <input
              type="radio"
              name="risk"
              value={option}
              checked={risk === option}
              onChange={() => setRisk(option)}
            />
            <span className={styles.riskName}>{RISK_COPY[option].label}</span>
            <div className={styles.riskBlurb}>{RISK_COPY[option].blurb}</div>
            <div className={styles.riskVol}>
              Targets about {(RISK_TARGET_VOL[option] * 100).toFixed(0)}% annualized
              volatility.
            </div>
          </label>
        ))}
      </div>

      <p className={styles.setupNote}>
        Not a permanent choice — you can change the risk setting any time on
        the Today page.
      </p>

      {error !== null ? <p className={styles.errorText}>{error}</p> : null}

      <button type="submit" className={styles.primaryButton}>
        Create my paper portfolio
      </button>

      <p className={styles.disclaimer}>
        Simulated trading with pretend money, computed from free market data
        that can be delayed or imperfect. Nothing here is investment advice.
      </p>
    </form>
  );
}
