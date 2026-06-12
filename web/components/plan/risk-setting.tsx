"use client";

/**
 * The Today page's risk dial: the same three options as setup, changeable at
 * any time. Switching only changes the target weights the next plan aims
 * for — cash, positions, and history stay put — so no confirmation step is
 * needed. The Why page's volatility-target explainer points users here.
 */

import { setRisk, store, type Risk } from "@/lib/store";

import { RISK_COPY, RISK_TARGET_VOL } from "./engine-adapter";
import { InfoTip } from "./info-tip";
import styles from "./plan.module.css";

const RISK_ORDER: Risk[] = ["conservative", "balanced", "aggressive"];

export function RiskSetting({ risk }: { risk: Risk }) {
  return (
    <section className="card">
      <h2 className={styles.pageTitle}>
        Risk setting
        <InfoTip label="risk setting">
          The bumpiness level the strategy aims for, chosen during setup and
          changeable here whenever you like. Switching does not touch your
          cash, positions, or history — the next plan simply trades toward
          the new target sizes.
        </InfoTip>
      </h2>
      <div
        className={styles.riskOptions}
        role="radiogroup"
        aria-label="Risk setting"
        style={{ marginTop: "0.75rem" }}
      >
        {RISK_ORDER.map((option) => (
          <label
            key={option}
            className={`${styles.riskOption} ${risk === option ? styles.riskOptionActive : ""}`}
          >
            <input
              type="radio"
              name="risk-setting"
              value={option}
              checked={risk === option}
              onChange={() => store.setState((s) => setRisk(s, option))}
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
      <p className="muted" style={{ marginTop: "0.75rem" }}>
        Changing this updates today&apos;s plan immediately. Your pretend
        money and holdings are untouched; the orders above just start aiming
        at the new sizes.
      </p>
    </section>
  );
}
