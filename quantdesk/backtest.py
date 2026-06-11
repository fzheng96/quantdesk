"""Vectorized portfolio backtest engine and walk-forward analysis.

Engine convention
-----------------
For a price frame ``prices`` and a weight frame ``weights`` sharing the same
index and columns:

- ``rets = prices.pct_change()`` (first row treated as zero return);
- ``weights_used = weights.shift(1)`` filled with 0, so a weight decided at
  the close of day t earns day t+1 returns and can never touch the return of
  the day it was decided on;
- ``gross_t = sum(weights_used_t * rets_t)``;
- ``turnover_t = sum(abs(weights_t - weights_{t-1}))`` on the decision-day
  weights, with the day before the first day treated as all-zero (entering
  the initial position is a trade and is charged);
- ``cost_t = turnover_t * (commission_bps + slippage_bps) / 10000`` charged
  on day t;
- ``net = gross - cost``; ``equity = cumprod(1 + net)``.

This is a daily close-to-close simulation. It ignores intraday fills,
market impact beyond a flat slippage haircut, borrow costs on shorts,
financing on leverage, and dividends/splits unless the input prices are
already adjusted. Results are research estimates, not achievable returns.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Protocol

import pandas as pd

from quantdesk import metrics


class Strategy(Protocol):
    """Structural mirror of the Strategy protocol in quantdesk.strategies.

    Declared here so the engine depends only on the shape (a ``name`` and a
    ``generate_weights`` method), not on the strategies module itself. Any
    object with these members can be used in ``walk_forward``.
    """

    name: str

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame: ...


@dataclass
class BacktestResult:
    """Output of a single backtest run.

    ``metrics`` holds scalar summary statistics keyed by name: cagr, ann_vol,
    sharpe, sortino, max_drawdown (depth as a positive fraction),
    max_drawdown_peak, max_drawdown_trough, max_drawdown_days, calmar, and
    hit_rate. ``benchmark_equity`` is present only when benchmark prices were
    supplied, normalized to 1.0 at the start of the backtest.
    """

    net_returns: pd.Series
    equity: pd.Series
    weights_used: pd.DataFrame
    turnover: pd.Series
    costs: pd.Series
    metrics: dict[str, Any]
    benchmark_equity: pd.Series | None = None


def _summary_metrics(net_returns: pd.Series, equity: pd.Series) -> dict[str, Any]:
    """Compute the standard scalar metrics for a net return series."""
    drawdown = metrics.max_drawdown(equity)
    return {
        "cagr": metrics.cagr(net_returns),
        "ann_vol": metrics.ann_vol(net_returns),
        "sharpe": metrics.sharpe(net_returns),
        "sortino": metrics.sortino(net_returns),
        "max_drawdown": drawdown.depth,
        "max_drawdown_peak": drawdown.peak,
        "max_drawdown_trough": drawdown.trough,
        "max_drawdown_days": drawdown.duration_days,
        "calmar": metrics.calmar(net_returns),
        "hit_rate": metrics.hit_rate(net_returns),
    }


def _benchmark_equity(benchmark_prices: pd.Series | pd.DataFrame, index: pd.Index) -> pd.Series:
    """Build a benchmark equity curve normalized to 1.0 on the first backtest day."""
    bench = benchmark_prices
    if isinstance(bench, pd.DataFrame):
        if bench.shape[1] != 1:
            raise ValueError("benchmark_prices must be a Series or a single-column DataFrame")
        bench = bench.iloc[:, 0]
    aligned = bench.reindex(index).ffill()
    bench_rets = aligned.pct_change().fillna(0.0)
    return (1.0 + bench_rets).cumprod()


def run_backtest(
    prices: pd.DataFrame,
    weights: pd.DataFrame,
    commission_bps: float = 1.0,
    slippage_bps: float = 2.0,
    benchmark_prices: pd.Series | pd.DataFrame | None = None,
) -> BacktestResult:
    """Run the daily backtest described in the module docstring.

    ``weights`` is reindexed to the price frame's index and columns with
    missing entries treated as flat (0), so a strategy that omits an asset
    or a date simply holds nothing there. The engine does not enforce a
    leverage limit; keeping row-wise sum of absolute weights within bounds
    is the caller's responsibility (see the Strategy contract and the risk
    overlays).

    Leading NaNs in a price column (history before a late listing) are
    allowed and contribute zero return while the asset has no price. NaNs
    after a column's first observation are rejected with ValueError: turning
    such a gap into a zero return would let a held position skip the entire
    gap move and exit at the last seen price with no loss and no cost, which
    silently flatters results. Callers must fill or drop those gaps first.
    """
    if prices.empty:
        raise ValueError("run_backtest requires a non-empty price frame")
    gap_after_listing = prices.isna() & prices.ffill().notna()
    if bool(gap_after_listing.any().any()):
        bad = [str(col) for col in prices.columns if gap_after_listing[col].any()]
        raise ValueError(
            "prices contain NaN gaps after the first observation for: "
            + ", ".join(bad)
            + "; fill or drop these gaps before running the backtest"
        )
    aligned = weights.reindex(index=prices.index, columns=prices.columns).fillna(0.0)
    rets = prices.pct_change().fillna(0.0)
    shifted = aligned.shift(1).fillna(0.0)
    weights_used = shifted
    gross = (weights_used * rets).sum(axis=1)
    turnover = (aligned - shifted).abs().sum(axis=1)
    costs = turnover * (commission_bps + slippage_bps) / 10000.0
    net = gross - costs
    equity = (1.0 + net).cumprod()
    benchmark_equity = None
    if benchmark_prices is not None:
        benchmark_equity = _benchmark_equity(benchmark_prices, prices.index)
    return BacktestResult(
        net_returns=net,
        equity=equity,
        weights_used=weights_used,
        turnover=turnover,
        costs=costs,
        metrics=_summary_metrics(net, equity),
        benchmark_equity=benchmark_equity,
    )


@dataclass
class WalkForwardWindow:
    """One train/test split and the parameter choice made on it.

    The training window covers [train_start, train_end] inclusive; the test
    window covers (train_end, test_end]. ``chosen`` is the winning strategy
    instance and ``train_sharpe`` is its in-sample Sharpe, which should be
    expected to overstate out-of-sample performance: it is the maximum over
    the candidate grid, a selection-biased statistic.
    """

    train_start: pd.Timestamp
    train_end: pd.Timestamp
    test_end: pd.Timestamp
    chosen: Strategy
    train_sharpe: float


@dataclass
class WalkForwardResult:
    """Stitched out-of-sample results and the per-window choices behind them.

    ``results`` maps each strategy-family name to a BacktestResult built by
    concatenating only the test segments. ``choices`` maps the same names to
    the per-window selection records.
    """

    results: dict[str, BacktestResult]
    choices: dict[str, list[WalkForwardWindow]]


def _windows(
    index: pd.DatetimeIndex, train_years: int, test_years: int
) -> list[tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]]:
    """Roll (train_start, train_end, test_end) splits across the index.

    Windows advance by ``test_years`` so consecutive test segments tile the
    out-of-sample period without gaps or overlap. A final partial test
    window is kept rather than discarded, so the most recent data is used
    even when it does not fill a whole test period.
    """
    out: list[tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]] = []
    train_start = index[0]
    last = index[-1]
    while True:
        train_end = train_start + pd.DateOffset(years=train_years)
        if train_end >= last:
            break
        test_end = min(train_end + pd.DateOffset(years=test_years), last)
        out.append((train_start, train_end, test_end))
        train_start = train_start + pd.DateOffset(years=test_years)
    return out


def walk_forward(
    prices: pd.DataFrame,
    strategy_grid: dict[str, list[Strategy]],
    train_years: int = 3,
    test_years: int = 1,
    commission_bps: float = 1.0,
    slippage_bps: float = 2.0,
) -> WalkForwardResult:
    """Walk-forward parameter selection with out-of-sample stitching.

    For each family in ``strategy_grid`` and each rolling window: every
    candidate generates weights on all prices up to the train end (so
    lookbacks can warm up on earlier history), is backtested, and is scored
    by net Sharpe over the training window alone; the best candidate is then
    applied to the following test window, and the test-segment returns are
    concatenated into one out-of-sample BacktestResult per family.

    Candidates whose training Sharpe is NaN (for example, a strategy that
    never traded) rank below every real score. Ties keep the earlier
    candidate in the list, so put simpler parameter sets first.

    Known limitation, stated honestly: each test segment is simulated
    independently, so when the winning parameter set changes between
    windows, the cost of trading out of the old holdings into the new ones
    at the boundary is not charged. Stitched results are therefore slightly
    optimistic when choices are unstable.
    """
    if prices.empty:
        raise ValueError("walk_forward requires a non-empty price frame")
    windows = _windows(prices.index, train_years, test_years)
    if not windows:
        raise ValueError(
            "not enough history for a single train/test split: "
            f"need more than {train_years} years of prices"
        )
    results: dict[str, BacktestResult] = {}
    choices: dict[str, list[WalkForwardWindow]] = {}
    for family, candidates in strategy_grid.items():
        if not candidates:
            raise ValueError(f"strategy_grid[{family!r}] has no candidates")
        window_choices: list[WalkForwardWindow] = []
        net_parts: list[pd.Series] = []
        weight_parts: list[pd.DataFrame] = []
        turnover_parts: list[pd.Series] = []
        cost_parts: list[pd.Series] = []
        for train_start, train_end, test_end in windows:
            train_prices = prices.loc[:train_end]
            best: Strategy | None = None
            best_sharpe = -math.inf
            for candidate in candidates:
                candidate_weights = candidate.generate_weights(train_prices)
                trained = run_backtest(
                    train_prices,
                    candidate_weights,
                    commission_bps=commission_bps,
                    slippage_bps=slippage_bps,
                )
                train_net = trained.net_returns.loc[train_start:train_end]
                score = metrics.sharpe(train_net)
                if math.isnan(score):
                    score = -math.inf
                if best is None or score > best_sharpe:
                    best = candidate
                    best_sharpe = score
            assert best is not None
            test_prices = prices.loc[:test_end]
            test_weights = best.generate_weights(test_prices)
            tested = run_backtest(
                test_prices,
                test_weights,
                commission_bps=commission_bps,
                slippage_bps=slippage_bps,
            )
            in_test = tested.net_returns.index > train_end
            net_parts.append(tested.net_returns.loc[in_test])
            weight_parts.append(tested.weights_used.loc[in_test])
            turnover_parts.append(tested.turnover.loc[in_test])
            cost_parts.append(tested.costs.loc[in_test])
            window_choices.append(
                WalkForwardWindow(
                    train_start=train_start,
                    train_end=train_end,
                    test_end=test_end,
                    chosen=best,
                    train_sharpe=best_sharpe,
                )
            )
        net = pd.concat(net_parts)
        equity = (1.0 + net).cumprod()
        results[family] = BacktestResult(
            net_returns=net,
            equity=equity,
            weights_used=pd.concat(weight_parts),
            turnover=pd.concat(turnover_parts),
            costs=pd.concat(cost_parts),
            metrics=_summary_metrics(net, equity),
        )
        choices[family] = window_choices
    return WalkForwardResult(results=results, choices=choices)
