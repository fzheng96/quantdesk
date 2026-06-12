"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./onboarding.module.css";

/**
 * Deliberately separate from the store's "quantdesk.v1" key so dismissing
 * the tour never touches portfolio state, and resetting the portfolio
 * never resurrects the tour. The key predates this component: an earlier
 * overlay wrote the same flag, and users who dismissed that one must not
 * see the tour again.
 */
const STORAGE_KEY = "quantdesk.v1.seenIntro";

interface Step {
  title: string;
  body: (dismiss: () => void) => ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Pretend money, real prices",
    body: () => (
      <>
        QuantDesk recommends <strong>simulated trades</strong> into a paper portfolio that lives
        only in your browser. No account, no real orders, no real money — the point is to learn
        what following a systematic strategy actually feels like. Nothing here is investment
        advice.
      </>
    ),
  },
  {
    title: "Follow the plan in one click",
    body: () => (
      <>
        Each market day, the strategy turns the latest daily closing prices into a concrete order
        list — &ldquo;Buy 17 shares of AAPL — about $5,000.&rdquo; One click applies the whole
        plan to your paper portfolio at the latest quoted prices, and you can watch how it does
        against simply holding the market.
      </>
    ),
  },
  {
    title: "Check the evidence first",
    body: (dismiss) => (
      <>
        The <Link href="/why" onClick={dismiss}>Why page</Link> reruns the exact same engine over
        the last five years of prices, right in your browser — equity curve, drawdowns, and what
        could go wrong. Look at the worst stretch before deciding to follow anything.
      </>
    ),
  },
];

/**
 * The 3-step first-visit walkthrough for the Today page. Renders nothing
 * after the first dismissal (a localStorage flag). The Today page should
 * render <FirstVisitOverlay /> anywhere in its tree.
 */
export function FirstVisitOverlay() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === null) setOpen(true);
    } catch {
      // Storage unavailable (private mode): skip the tour rather than loop it.
    }
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // If the flag cannot persist, the tour may reappear next visit; harmless.
    }
  }, []);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open, step]);

  if (!open) return null;

  const current = STEPS[step] ?? STEPS[0];
  if (current === undefined) return null;
  const isLast = step === STEPS.length - 1;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    // Minimal focus trap: keep Tab cycling inside the dialog.
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    if (first === undefined || lastEl === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && document.activeElement === lastEl) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop} onClick={dismiss}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-visit-title"
        tabIndex={-1}
        className={styles.dialog}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <p className={styles.stepKicker}>
          Step {step + 1} of {STEPS.length}
        </p>
        <h2 id="first-visit-title" className={styles.title}>
          {current.title}
        </h2>
        <p className={styles.body}>{current.body(dismiss)}</p>
        <div className={styles.dots} aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={i === step ? `${styles.dot} ${styles.dotActive}` : styles.dot} />
          ))}
        </div>
        <div className={styles.controls}>
          {step > 0 ? (
            <button type="button" className={styles.back} onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          ) : null}
          {isLast ? (
            <button type="button" className={styles.next} onClick={dismiss}>
              Got it — show me today&rsquo;s plan
            </button>
          ) : (
            <button type="button" className={styles.next} onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          )}
          <button type="button" className={styles.skip} onClick={dismiss}>
            Skip the tour
          </button>
        </div>
      </div>
    </div>
  );
}
