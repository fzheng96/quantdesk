/**
 * Paper-portfolio state: pure reducers plus localStorage persistence.
 *
 * Everything here manages SIMULATED money only — the app never touches a real
 * brokerage account. State lives under a single localStorage key so a reset or
 * an export is one key read/write.
 *
 * Money math runs in integer cents internally. Floating-point dollar
 * arithmetic drifts (100 - 3 * 10.1 === 69.69999999999999), and a cash figure
 * the user stares at every day must never grow phantom digits. Reducers
 * convert dollars to cents on entry with toCents (which rounds away any
 * residue carried in from a previous float), do all addition and subtraction
 * on integers, and convert back to dollars once on exit.
 *
 * The reducers are pure: they never read the clock, never touch storage, and
 * never mutate their inputs. Persistence is a separate, thin layer at the
 * bottom of this file.
 */

export const STORAGE_KEY = "quantdesk.v1";

// ---------------------------------------------------------------------------
// Types (the persisted shape — see SPEC.md "State")
// ---------------------------------------------------------------------------

export type Risk = "conservative" | "balanced" | "aggressive";
export type Side = "buy" | "sell";

export interface Settings {
  /** Starting paper-money budget in dollars. */
  budget: number;
  risk: Risk;
  /** ISO timestamp recorded when the user finished the two-question setup. */
  createdAt: string;
}

export interface Trade {
  /** Trading day the order was filled, formatted YYYY-MM-DD. */
  date: string;
  ticker: string;
  side: Side;
  shares: number;
  /**
   * Fill price per share in dollars — the latest quoted price at the moment
   * the plan was applied, or the most recent daily close when no live quote
   * was available.
   */
  price: number;
}

export interface Snapshot {
  /** Calendar day the portfolio was valued, formatted YYYY-MM-DD. */
  date: string;
  /** Total portfolio value (cash plus positions) in dollars. */
  value: number;
}

export interface Portfolio {
  /** Uninvested cash in dollars, always an exact number of cents. */
  cash: number;
  /** Ticker -> shares held. Fully sold tickers are removed from the map. */
  positions: Record<string, number>;
  trades: Trade[];
  /** At most one entry per calendar day, kept sorted by date ascending. */
  snapshots: Snapshot[];
}

export interface AppState {
  /** Null until the user completes setup; pages use this to show onboarding. */
  settings: Settings | null;
  portfolio: Portfolio;
}

/** One line of the day's plan. The fill price comes from the prices map. */
export interface Order {
  ticker: string;
  side: Side;
  shares: number;
}

/** Ticker -> price per share in dollars (latest live quote, falling back to the most recent close). */
export type PriceMap = Record<string, number>;

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/**
 * Convert a dollar amount to integer cents. Rounding here is what stops float
 * residue from compounding: a cash balance of 0.9299999999999999 dollars
 * round-trips to exactly 93 cents.
 */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) {
    throw new Error(`Expected a finite dollar amount, got ${dollars}.`);
  }
  return Math.round(dollars * 100);
}

/** Convert integer cents back to dollars for storage and display. */
export function fromCents(cents: number): number {
  return cents / 100;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Snapshots and trades are keyed by calendar day, so reducers insist on the
 * YYYY-MM-DD form. A full ISO timestamp slipping in would silently break the
 * one-snapshot-per-day guarantee.
 */
function assertDay(date: string, fn: string): void {
  if (!DAY_RE.test(date)) {
    throw new Error(`${fn} expects a YYYY-MM-DD date, got "${date}".`);
  }
}

/** Look up a ticker's price and convert it to cents, rejecting unusable values. */
function priceCentsFor(ticker: string, prices: PriceMap): number {
  const price = prices[ticker];
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    throw new Error(`No usable price for ${ticker}; cannot value or trade it.`);
  }
  return Math.round(price * 100);
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/** The pre-setup state: no settings, an empty unfunded portfolio. */
export function initialState(): AppState {
  return {
    settings: null,
    portfolio: { cash: 0, positions: {}, trades: [], snapshots: [] },
  };
}

/**
 * Complete setup: store the user's settings and fund a fresh portfolio with
 * the full budget as cash. Any prior portfolio is discarded — setup is a
 * clean start, not a top-up.
 */
export function initSettings(state: AppState, settings: Settings): AppState {
  if (!Number.isFinite(settings.budget) || settings.budget <= 0) {
    throw new Error(`Budget must be a positive dollar amount, got ${settings.budget}.`);
  }
  const budget = fromCents(toCents(settings.budget));
  return {
    settings: { ...settings, budget },
    portfolio: { cash: budget, positions: {}, trades: [], snapshots: [] },
  };
}

/**
 * Change the risk setting in place, keeping the budget, cash, positions, and
 * history untouched. Switching risk only changes the target weights the next
 * plan aims for, so there is no reason to restart the ledger over it.
 */
export function setRisk(state: AppState, risk: Risk): AppState {
  if (state.settings === null) {
    throw new Error("setRisk requires completed setup.");
  }
  if (!isRisk(risk)) {
    throw new Error(`Unknown risk setting "${String(risk)}".`);
  }
  if (state.settings.risk === risk) return state;
  return {
    settings: { ...state.settings, risk },
    portfolio: state.portfolio,
  };
}

/**
 * Apply a day's plan to the portfolio. Every order fills at the ticker's
 * price in `prices` (the latest quoted price, or the most recent close when
 * no quote is available), and each fill is appended to the trade log dated
 * `date`. Fills are cost-free: no commission or slippage is charged, which
 * slightly flatters the paper ledger relative to the Why-page backtest —
 * the UI says so wherever fills are explained.
 *
 * Sells are processed before buys regardless of the array order, so the cash
 * freed by trimming positions can fund the same day's purchases — the same
 * sequencing a real rebalance would use. Within each side the caller's order
 * is preserved, and the trade log records fills in execution order.
 *
 * Throws (leaving the state untouched) on: a missing or non-positive price,
 * a non-positive share count, selling more shares than held, or buys that
 * exceed available cash. A paper portfolio that allowed negative cash would
 * be quietly lying about performance.
 */
export function applyPlan(
  state: AppState,
  orders: readonly Order[],
  prices: PriceMap,
  date: string
): AppState {
  if (orders.length === 0) return state;
  assertDay(date, "applyPlan");

  const sequenced = [
    ...orders.filter((o) => o.side === "sell"),
    ...orders.filter((o) => o.side === "buy"),
  ];

  let cashCents = toCents(state.portfolio.cash);
  const positions: Record<string, number> = { ...state.portfolio.positions };
  const fills: Trade[] = [];

  for (const { ticker, side, shares } of sequenced) {
    if (typeof ticker !== "string" || ticker.length === 0) {
      throw new Error("applyPlan: every order needs a ticker.");
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      throw new Error(
        `applyPlan: share count for ${ticker} must be positive, got ${shares}.`
      );
    }
    const priceCents = priceCentsFor(ticker, prices);
    // Exact for whole-share orders; rounded to the nearest cent otherwise.
    const amountCents = Math.round(shares * priceCents);

    if (side === "sell") {
      const held = positions[ticker] ?? 0;
      if (shares > held) {
        throw new Error(
          `applyPlan: cannot sell ${shares} shares of ${ticker}; only ${held} held.`
        );
      }
      const remaining = held - shares;
      if (remaining <= 0) {
        delete positions[ticker];
      } else {
        positions[ticker] = remaining;
      }
      cashCents += amountCents;
    } else {
      if (amountCents > cashCents) {
        throw new Error(
          `applyPlan: buying ${shares} shares of ${ticker} costs ` +
            `$${fromCents(amountCents).toFixed(2)} but only ` +
            `$${fromCents(cashCents).toFixed(2)} cash is available.`
        );
      }
      positions[ticker] = (positions[ticker] ?? 0) + shares;
      cashCents -= amountCents;
    }
    fills.push({ date, ticker, side, shares, price: fromCents(priceCents) });
  }

  return {
    settings: state.settings,
    portfolio: {
      cash: fromCents(cashCents),
      positions,
      trades: [...state.portfolio.trades, ...fills],
      snapshots: state.portfolio.snapshots,
    },
  };
}

/** Total portfolio value (cash plus positions) in cents at the given prices. */
function computeValueCents(portfolio: Portfolio, prices: PriceMap): number {
  let total = toCents(portfolio.cash);
  for (const [ticker, shares] of Object.entries(portfolio.positions)) {
    total += Math.round(shares * priceCentsFor(ticker, prices));
  }
  return total;
}

/**
 * Current portfolio value in dollars at the given prices, without recording
 * anything. Pages use this to mark displayed values to live quotes between
 * the daily snapshots.
 */
export function portfolioValue(state: AppState, prices: PriceMap): number {
  return fromCents(computeValueCents(state.portfolio, prices));
}

/**
 * Value the portfolio at the given prices and record one snapshot for `date`.
 *
 * Idempotent per day: re-marking the same date replaces that day's snapshot
 * instead of appending, so refreshing the page or re-fetching quotes can
 * never inflate the history. If the recomputed value is unchanged the same
 * state object is returned, letting subscribers skip a redundant render and
 * the store skip a redundant write.
 *
 * Throws if any held ticker is missing a usable price — a partial valuation
 * would record a portfolio value that is simply wrong.
 */
export function markToMarket(state: AppState, prices: PriceMap, date: string): AppState {
  assertDay(date, "markToMarket");
  const value = fromCents(computeValueCents(state.portfolio, prices));

  const existing = state.portfolio.snapshots.find((s) => s.date === date);
  if (existing !== undefined && existing.value === value) return state;

  const snapshots = state.portfolio.snapshots.filter((s) => s.date !== date);
  snapshots.push({ date, value });
  snapshots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    settings: state.settings,
    portfolio: { ...state.portfolio, snapshots },
  };
}

/**
 * The /portfolio Reset button: wipe positions, trades, and snapshots and
 * refund the full budget as cash, keeping the user's settings so they do not
 * have to redo setup. Before setup it simply returns the initial state.
 */
export function reset(state: AppState): AppState {
  if (state.settings === null) return initialState();
  return {
    settings: state.settings,
    portfolio: {
      cash: fromCents(toCents(state.settings.budget)),
      positions: {},
      trades: [],
      snapshots: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Validation (for untrusted JSON coming out of localStorage)
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isRisk(x: unknown): x is Risk {
  return x === "conservative" || x === "balanced" || x === "aggressive";
}

function isSide(x: unknown): x is Side {
  return x === "buy" || x === "sell";
}

/**
 * Structurally validate a parsed localStorage payload. Returns a clean copy
 * or null if anything is off — a damaged or hand-edited payload falls back to
 * the initial state rather than crashing every page.
 */
function validateState(raw: unknown): AppState | null {
  if (!isRecord(raw)) return null;
  const { settings, portfolio } = raw;

  let validSettings: Settings | null = null;
  if (settings !== null && settings !== undefined) {
    if (
      !isRecord(settings) ||
      !isFiniteNumber(settings.budget) ||
      settings.budget <= 0 ||
      !isRisk(settings.risk) ||
      typeof settings.createdAt !== "string"
    ) {
      return null;
    }
    validSettings = {
      budget: settings.budget,
      risk: settings.risk,
      createdAt: settings.createdAt,
    };
  }

  if (!isRecord(portfolio)) return null;
  if (!isFiniteNumber(portfolio.cash)) return null;

  if (!isRecord(portfolio.positions)) return null;
  const positions: Record<string, number> = {};
  for (const [ticker, shares] of Object.entries(portfolio.positions)) {
    if (!isFiniteNumber(shares) || shares <= 0) return null;
    positions[ticker] = shares;
  }

  if (!Array.isArray(portfolio.trades)) return null;
  const trades: Trade[] = [];
  for (const t of portfolio.trades as unknown[]) {
    if (
      !isRecord(t) ||
      typeof t.date !== "string" ||
      typeof t.ticker !== "string" ||
      !isSide(t.side) ||
      !isFiniteNumber(t.shares) ||
      !isFiniteNumber(t.price)
    ) {
      return null;
    }
    trades.push({
      date: t.date,
      ticker: t.ticker,
      side: t.side,
      shares: t.shares,
      price: t.price,
    });
  }

  if (!Array.isArray(portfolio.snapshots)) return null;
  const snapshots: Snapshot[] = [];
  for (const s of portfolio.snapshots as unknown[]) {
    if (!isRecord(s) || typeof s.date !== "string" || !isFiniteNumber(s.value)) {
      return null;
    }
    snapshots.push({ date: s.date, value: s.value });
  }

  return {
    settings: validSettings,
    portfolio: { cash: portfolio.cash, positions, trades, snapshots },
  };
}

// ---------------------------------------------------------------------------
// Persistence (localStorage; safe on the server and in privacy modes)
// ---------------------------------------------------------------------------

/**
 * localStorage is absent during server rendering and can throw on access in
 * some privacy modes, so every touch goes through this guard.
 */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Read and validate persisted state, falling back to the initial state. */
export function loadState(): AppState {
  const storage = getStorage();
  if (storage === null) return initialState();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return initialState();
    return validateState(JSON.parse(raw)) ?? initialState();
  } catch {
    return initialState();
  }
}

/** Persist state. Quota or privacy-mode failures are swallowed: the in-memory
 * state stays correct and the next successful write catches storage up. */
export function saveState(state: AppState): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Intentionally ignored; see the function comment.
  }
}

// ---------------------------------------------------------------------------
// Store singleton (subscribe/getState/setState, useSyncExternalStore-ready)
// ---------------------------------------------------------------------------

type Listener = () => void;

let cachedState: AppState | null = null;
const listeners = new Set<Listener>();
let storageEventsHooked = false;

const SERVER_SNAPSHOT: AppState = initialState();

/**
 * A stable reference for useSyncExternalStore's server snapshot. Server
 * rendering always sees the pre-setup state; the client hydrates the real
 * one after mount.
 */
export function getServerSnapshot(): AppState {
  return SERVER_SNAPSHOT;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Keep this tab in sync when another tab writes the same key. */
function hookStorageEvents(): void {
  if (storageEventsHooked || typeof window === "undefined") return;
  storageEventsHooked = true;
  window.addEventListener("storage", (event) => {
    // A null key means storage.clear() ran somewhere; reload in that case too.
    if (event.key === STORAGE_KEY || event.key === null) store.refresh();
  });
}

export const store = {
  /** Current state, lazily loaded from localStorage on first access. */
  getState(): AppState {
    if (cachedState === null) cachedState = loadState();
    return cachedState;
  },

  /**
   * Run a reducer against the current state, persist the result, and notify
   * subscribers. Reducers that return the same reference (no-ops) skip both
   * the write and the notification.
   */
  setState(update: (prev: AppState) => AppState): AppState {
    const next = update(store.getState());
    if (next !== cachedState) {
      cachedState = next;
      saveState(next);
      notify();
    }
    return next;
  },

  /** Re-read from localStorage (used after cross-tab writes or data import). */
  refresh(): AppState {
    cachedState = loadState();
    notify();
    return cachedState;
  },

  subscribe(listener: Listener): () => void {
    hookStorageEvents();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
