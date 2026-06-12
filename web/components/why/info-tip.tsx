"use client";

import { useId, useState, type ReactNode } from "react";

import styles from "./why.module.css";

/**
 * A small "?" button that reveals a plain-English explanation on hover,
 * focus, or click. Used so every number on the Why page has its meaning
 * one interaction away, as the spec requires.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const tipId = useId();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;

  return (
    <span
      className={styles.infoTip}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.infoTipButton}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => setPinned((value) => !value)}
        onFocus={() => setHovered(true)}
        onBlur={() => {
          setHovered(false);
          setPinned(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setHovered(false);
            setPinned(false);
          }
        }}
      >
        ?
      </button>
      {open ? (
        <span role="tooltip" id={tipId} className={styles.infoTipBody}>
          {children}
        </span>
      ) : null}
    </span>
  );
}
