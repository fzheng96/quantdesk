"use client";

/**
 * The "?" affordance behind every number on the site: hover (desktop) or tap
 * (mobile) reveals a plain-English explanation. The popover is a real button
 * so it is keyboard-reachable, and Escape or a second tap closes it.
 */

import { useEffect, useRef, useState } from "react";

import styles from "./plan.module.css";

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className={`${styles.tip} ${open ? styles.tipOpen : ""}`} ref={rootRef}>
      <button
        type="button"
        className={styles.tipButton}
        aria-label={`What does ${label} mean?`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      <span role="tooltip" className={styles.tipBody}>
        {children}
      </span>
    </span>
  );
}
