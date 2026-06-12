import { beforeEach, describe, expect, it } from "vitest";

import {
  applyPlan,
  fromCents,
  getServerSnapshot,
  initSettings,
  initialState,
  loadState,
  markToMarket,
  portfolioValue,
  reset,
  saveState,
  setRisk,
  store,
  toCents,
  STORAGE_KEY,
  type AppState,
  type Order,
  type PriceMap,
  type Settings,
} from "../lib/store";

// ---------------------------------------------------------------------------
// Test scaffolding: an in-memory localStorage so persistence is testable in
// Node. Reducer tests do not need it, but a fresh one is installed before
// every test so no test can leak state into another.
// ---------------------------------------------------------------------------

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  const storage = {
    get length(): number {
      return data.size;
    },
    clear: (): void => {
      data.clear();
    },
    getItem: (key: string): string | null => data.get(key) ?? null,
    key: (index: number): string | null => [...data.keys()][index] ?? null,
    removeItem: (key: string): void => {
      data.delete(key);
    },
    setItem: (key: string, value: string): void => {
      data.set(key, value);
    },
  };
  return storage as Storage;
}

function installLocalStorage(storage: Storage | undefined): void {
  if (storage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      writable: true,
      configurable: true,
    });
  }
}

beforeEach(() => {
  installLocalStorage(memoryStorage());
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY1 = "2026-06-10";
const DAY2 = "2026-06-11";

const SETTINGS: Settings = {
  budget: 100_000,
  risk: "balanced",
  createdAt: "2026-06-10T14:30:00.000Z",
};

function fundedState(budget = 100_000): AppState {
  return initSettings(initialState(), { ...SETTINGS, budget });
}

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

describe("money helpers", () => {
  it("converts dollars to integer cents and back exactly", () => {
    expect(toCents(10.1)).toBe(1010);
    expect(toCents(0.07)).toBe(7);
    expect(fromCents(6970)).toBe(69.7);
  });

  it("rounds away float residue when converting to cents", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in doubles; cents math absorbs it.
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(0.9299999999999999)).toBe(93);
  });

  it("rejects non-finite dollar amounts", () => {
    expect(() => toCents(Number.NaN)).toThrow();
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// initialState / initSettings
// ---------------------------------------------------------------------------

describe("initialState and initSettings", () => {
  it("starts with no settings and an empty, unfunded portfolio", () => {
    const state = initialState();
    expect(state.settings).toBeNull();
    expect(state.portfolio).toEqual({
      cash: 0,
      positions: {},
      trades: [],
      snapshots: [],
    });
  });

  it("funds a fresh portfolio with the full budget as cash", () => {
    const state = fundedState();
    expect(state.settings).toEqual(SETTINGS);
    expect(state.portfolio.cash).toBe(100_000);
    expect(state.portfolio.positions).toEqual({});
    expect(state.portfolio.trades).toEqual([]);
    expect(state.portfolio.snapshots).toEqual([]);
  });

  it("rejects a budget that is zero, negative, or not finite", () => {
    expect(() => initSettings(initialState(), { ...SETTINGS, budget: 0 })).toThrow();
    expect(() => initSettings(initialState(), { ...SETTINGS, budget: -5 })).toThrow();
    expect(() =>
      initSettings(initialState(), { ...SETTINGS, budget: Number.NaN })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// setRisk
// ---------------------------------------------------------------------------

describe("setRisk", () => {
  it("changes only the risk setting, keeping budget and portfolio intact", () => {
    const before = applyPlan(fundedState(), [{ ticker: "AAPL", side: "buy", shares: 10 }], { AAPL: 100 }, DAY1);
    const after = setRisk(before, "aggressive");
    expect(after.settings?.risk).toBe("aggressive");
    expect(after.settings?.budget).toBe(before.settings?.budget);
    expect(after.settings?.createdAt).toBe(before.settings?.createdAt);
    expect(after.portfolio).toBe(before.portfolio);
  });

  it("returns the same state object when the risk is unchanged", () => {
    const state = fundedState();
    expect(setRisk(state, "balanced")).toBe(state);
  });

  it("throws before setup and on an unknown risk value", () => {
    expect(() => setRisk(initialState(), "balanced")).toThrow();
    expect(() =>
      setRisk(fundedState(), "reckless" as Parameters<typeof setRisk>[1])
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyPlan
// ---------------------------------------------------------------------------

describe("applyPlan", () => {
  it("fills a buy at the given close and debits exact cents", () => {
    const state = fundedState(100);
    const next = applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 3 }], { AAPL: 10.1 }, DAY1);

    // Naive float math would produce 69.69999999999999 here.
    expect(next.portfolio.cash).toBe(69.7);
    expect(next.portfolio.positions).toEqual({ AAPL: 3 });
    expect(next.portfolio.trades).toEqual([
      { date: DAY1, ticker: "AAPL", side: "buy", shares: 3, price: 10.1 },
    ]);
  });

  it("does not drift across many small fills", () => {
    let state = fundedState(1);
    for (let i = 0; i < 10; i++) {
      state = applyPlan(state, [{ ticker: "F", side: "buy", shares: 1 }], { F: 0.07 }, DAY1);
    }
    // 1.00 - 10 * 0.07: naive float math gives 0.30000000000000016.
    expect(state.portfolio.cash).toBe(0.3);
    expect(state.portfolio.positions).toEqual({ F: 10 });
    expect(state.portfolio.trades).toHaveLength(10);
  });

  it("accumulates shares when buying a ticker already held", () => {
    let state = fundedState(1000);
    state = applyPlan(state, [{ ticker: "MSFT", side: "buy", shares: 2 }], { MSFT: 100 }, DAY1);
    state = applyPlan(state, [{ ticker: "MSFT", side: "buy", shares: 3 }], { MSFT: 110 }, DAY2);
    expect(state.portfolio.positions).toEqual({ MSFT: 5 });
    expect(state.portfolio.cash).toBe(1000 - 200 - 330);
  });

  it("credits sale proceeds and removes a fully sold position", () => {
    let state = fundedState(1000);
    state = applyPlan(state, [{ ticker: "MSFT", side: "buy", shares: 4 }], { MSFT: 100 }, DAY1);
    state = applyPlan(state, [{ ticker: "MSFT", side: "sell", shares: 4 }], { MSFT: 120 }, DAY2);

    expect(state.portfolio.cash).toBe(1000 - 400 + 480);
    expect(state.portfolio.positions).toEqual({});
    expect(state.portfolio.trades).toHaveLength(2);
  });

  it("settles sells before buys so freed cash can fund the purchases", () => {
    let state = fundedState(50);
    state = applyPlan(state, [{ ticker: "MSFT", side: "buy", shares: 10 }], { MSFT: 5 }, DAY1);
    expect(state.portfolio.cash).toBe(0);

    // The buy is listed first but costs 50, which only exists after the sell.
    const orders: Order[] = [
      { ticker: "AAPL", side: "buy", shares: 5 },
      { ticker: "MSFT", side: "sell", shares: 10 },
    ];
    const next = applyPlan(state, orders, { AAPL: 10, MSFT: 5 }, DAY2);

    expect(next.portfolio.cash).toBe(0);
    expect(next.portfolio.positions).toEqual({ AAPL: 5 });
    // The trade log records execution order: the sell settled first.
    expect(next.portfolio.trades.at(-2)?.side).toBe("sell");
    expect(next.portfolio.trades.at(-1)?.side).toBe("buy");
  });

  it("returns the same state object for an empty order list", () => {
    const state = fundedState();
    expect(applyPlan(state, [], {}, DAY1)).toBe(state);
  });

  it("does not mutate the input state", () => {
    const state = fundedState(1000);
    const before = JSON.parse(JSON.stringify(state)) as AppState;
    applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 1 }], { AAPL: 10 }, DAY1);
    expect(state).toEqual(before);
  });

  it("throws when a ticker has no usable price", () => {
    const state = fundedState();
    expect(() =>
      applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 1 }], {}, DAY1)
    ).toThrow(/price/i);
    expect(() =>
      applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 1 }], { AAPL: 0 }, DAY1)
    ).toThrow(/price/i);
  });

  it("throws when selling more shares than held", () => {
    let state = fundedState(1000);
    state = applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 2 }], { AAPL: 10 }, DAY1);
    expect(() =>
      applyPlan(state, [{ ticker: "AAPL", side: "sell", shares: 3 }], { AAPL: 10 }, DAY2)
    ).toThrow(/only 2 held/);
  });

  it("throws when a buy exceeds available cash", () => {
    const state = fundedState(100);
    expect(() =>
      applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 11 }], { AAPL: 10 }, DAY1)
    ).toThrow(/cash/i);
  });

  it("throws on zero or negative share counts", () => {
    const state = fundedState();
    expect(() =>
      applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 0 }], { AAPL: 10 }, DAY1)
    ).toThrow(/positive/);
    expect(() =>
      applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: -1 }], { AAPL: 10 }, DAY1)
    ).toThrow(/positive/);
  });

  it("rejects dates that are not plain YYYY-MM-DD days", () => {
    const state = fundedState();
    expect(() =>
      applyPlan(
        state,
        [{ ticker: "AAPL", side: "buy", shares: 1 }],
        { AAPL: 10 },
        "2026-06-10T14:30:00.000Z"
      )
    ).toThrow(/YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------
// markToMarket
// ---------------------------------------------------------------------------

describe("markToMarket", () => {
  function heldState(): AppState {
    // 100 budget, 3 shares of AAPL at 10.10 -> cash 69.70.
    return applyPlan(
      fundedState(100),
      [{ ticker: "AAPL", side: "buy", shares: 3 }],
      { AAPL: 10.1 },
      DAY1
    );
  }

  it("records cash plus holdings, exact to the cent", () => {
    const next = markToMarket(heldState(), { AAPL: 10.1 }, DAY1);
    expect(next.portfolio.snapshots).toEqual([{ date: DAY1, value: 100 }]);
  });

  it("is idempotent for the same day and prices", () => {
    const once = markToMarket(heldState(), { AAPL: 10.1 }, DAY1);
    const twice = markToMarket(once, { AAPL: 10.1 }, DAY1);
    expect(twice.portfolio.snapshots).toHaveLength(1);
    // The value did not change, so the exact same state object comes back.
    expect(twice).toBe(once);
  });

  it("replaces the same day's snapshot when prices move", () => {
    const morning = markToMarket(heldState(), { AAPL: 10.1 }, DAY1);
    const afternoon = markToMarket(morning, { AAPL: 12.1 }, DAY1);
    expect(afternoon.portfolio.snapshots).toEqual([
      { date: DAY1, value: 69.7 + 3 * 12.1 },
    ]);
  });

  it("appends a new day and keeps snapshots sorted by date", () => {
    // Mark the later day first to prove sorting is by date, not insertion.
    const later = markToMarket(heldState(), { AAPL: 10.1 }, DAY2);
    const both = markToMarket(later, { AAPL: 10.1 }, DAY1);
    expect(both.portfolio.snapshots.map((s) => s.date)).toEqual([DAY1, DAY2]);
  });

  it("throws when a held ticker has no usable price", () => {
    expect(() => markToMarket(heldState(), {}, DAY1)).toThrow(/AAPL/);
  });

  it("leaves cash, positions, and trades untouched", () => {
    const state = heldState();
    const next = markToMarket(state, { AAPL: 99 }, DAY1);
    expect(next.portfolio.cash).toBe(state.portfolio.cash);
    expect(next.portfolio.positions).toEqual(state.portfolio.positions);
    expect(next.portfolio.trades).toEqual(state.portfolio.trades);
  });

  it("portfolioValue agrees with the snapshot without recording one", () => {
    const state = heldState();
    expect(portfolioValue(state, { AAPL: 10.1 })).toBe(100);
    expect(state.portfolio.snapshots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("refunds the budget and clears history while keeping settings", () => {
    let state = fundedState(1000);
    state = applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 5 }], { AAPL: 50 }, DAY1);
    state = markToMarket(state, { AAPL: 55 }, DAY1);

    const fresh = reset(state);
    expect(fresh.settings).toEqual(state.settings);
    expect(fresh.portfolio).toEqual({
      cash: 1000,
      positions: {},
      trades: [],
      snapshots: [],
    });
  });

  it("returns the initial state when setup was never completed", () => {
    expect(reset(initialState())).toEqual(initialState());
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("round-trips state through localStorage", () => {
    let state = fundedState(500);
    state = applyPlan(state, [{ ticker: "AAPL", side: "buy", shares: 2 }], { AAPL: 100 }, DAY1);
    state = markToMarket(state, { AAPL: 110 }, DAY1);

    saveState(state);
    expect(loadState()).toEqual(state);
  });

  it("returns the initial state when nothing is stored", () => {
    expect(loadState()).toEqual(initialState());
  });

  it("falls back to the initial state on corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadState()).toEqual(initialState());
  });

  it("falls back to the initial state on a structurally invalid payload", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        settings: SETTINGS,
        portfolio: {
          cash: 10,
          positions: { AAPL: "three" }, // shares must be numbers
          trades: [],
          snapshots: [],
        },
      })
    );
    expect(loadState()).toEqual(initialState());
  });

  it("is safe when localStorage does not exist at all", () => {
    installLocalStorage(undefined);
    expect(loadState()).toEqual(initialState());
    expect(() => saveState(fundedState())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

describe("store singleton", () => {
  beforeEach(() => {
    // The singleton caches state at module scope; re-read from the fresh
    // storage installed by the outer beforeEach.
    store.refresh();
  });

  it("lazily loads persisted state", () => {
    saveState(fundedState(250));
    store.refresh();
    expect(store.getState().portfolio.cash).toBe(250);
  });

  it("persists reducer results and notifies subscribers", () => {
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setState((prev) => initSettings(prev, SETTINGS));
    expect(notifications).toBe(1);
    expect(loadState().settings).toEqual(SETTINGS);

    unsubscribe();
    store.setState(reset);
    expect(notifications).toBe(1);
  });

  it("skips persistence and notification when a reducer no-ops", () => {
    store.setState((prev) => initSettings(prev, SETTINGS));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    // An empty plan returns the same reference, so nothing should fire.
    store.setState((prev) => applyPlan(prev, [], {}, DAY1));
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it("provides a stable server snapshot equal to the initial state", () => {
    expect(getServerSnapshot()).toBe(getServerSnapshot());
    expect(getServerSnapshot()).toEqual(initialState());
  });
});

// ---------------------------------------------------------------------------
// PriceMap stays a plain ticker->dollar map (compile-time contract check)
// ---------------------------------------------------------------------------

const _contractCheck: PriceMap = { AAPL: 10.1, SPY: 543.21 };
void _contractCheck;
