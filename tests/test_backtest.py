"""Tests for the backtest engine: exact arithmetic, the timing convention,
the lookahead canary, and walk-forward selection. No network, fixed seeds."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from quantdesk.backtest import (
    BacktestResult,
    WalkForwardResult,
    run_backtest,
    walk_forward,
)

TOTAL_COST_RATE = 3.0 / 10000.0  # default 1 bp commission + 2 bps slippage


def _single_asset_frame(values: list[float]) -> pd.DataFrame:
    index = pd.date_range("2024-01-01", periods=len(values), freq="D")
    return pd.DataFrame({"AAA": values}, index=index)


class TestEngineKnownAnswers:
    def test_buy_and_hold_exact_arithmetic(self) -> None:
        prices = _single_asset_frame([100.0, 110.0, 121.0])
        weights = pd.DataFrame(1.0, index=prices.index, columns=prices.columns)
        result = run_backtest(prices, weights)
        # Day 0: no return earned yet (the weight starts working on day 1),
        # but entering the position is a trade with turnover 1.
        assert result.turnover.tolist() == pytest.approx([1.0, 0.0, 0.0])
        assert result.costs.tolist() == pytest.approx([TOTAL_COST_RATE, 0.0, 0.0])
        assert result.net_returns.tolist() == pytest.approx([-TOTAL_COST_RATE, 0.1, 0.1])
        expected_equity = [
            1.0 - TOTAL_COST_RATE,
            (1.0 - TOTAL_COST_RATE) * 1.1,
            (1.0 - TOTAL_COST_RATE) * 1.21,
        ]
        assert result.equity.tolist() == pytest.approx(expected_equity)
        assert result.weights_used.iloc[0, 0] == 0.0

    def test_weight_decided_at_t_earns_exactly_t_plus_1(self) -> None:
        prices = _single_asset_frame([100.0, 102.0, 99.0, 105.0, 104.0])
        weights = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
        weights.iloc[1, 0] = 1.0
        result = run_backtest(prices, weights, commission_bps=0.0, slippage_bps=0.0)
        expected = [0.0, 0.0, 99.0 / 102.0 - 1.0, 0.0, 0.0]
        assert result.net_returns.tolist() == pytest.approx(expected)

    def test_full_rotation_turnover_is_two(self) -> None:
        index = pd.date_range("2024-01-01", periods=3, freq="D")
        prices = pd.DataFrame({"AAA": [100.0, 101.0, 102.0], "BBB": [50.0, 50.5, 51.0]}, index=index)
        weights = pd.DataFrame({"AAA": [1.0, 0.0, 0.0], "BBB": [0.0, 1.0, 1.0]}, index=index)
        result = run_backtest(prices, weights)
        assert result.turnover.tolist() == pytest.approx([1.0, 2.0, 0.0])
        assert result.costs.iloc[1] == pytest.approx(2.0 * TOTAL_COST_RATE)

    def test_zero_costs_make_net_equal_gross(self) -> None:
        prices = _single_asset_frame([100.0, 103.0, 101.0, 106.0])
        weights = pd.DataFrame(0.5, index=prices.index, columns=prices.columns)
        result = run_backtest(prices, weights, commission_bps=0.0, slippage_bps=0.0)
        rets = prices["AAA"].pct_change().fillna(0.0)
        gross = weights["AAA"].shift(1).fillna(0.0) * rets
        assert result.net_returns.tolist() == pytest.approx(gross.tolist())
        assert result.costs.tolist() == pytest.approx([0.0] * 4)


class TestLookaheadCanary:
    def test_oracle_signal_earns_nothing_through_the_engine(self) -> None:
        """The canary that proves the engine cannot leak tomorrow into today.

        The oracle weight dated day t is the sign of the day-t return — the
        move that completes at the very moment the weight is struck. A leaky
        engine that paired each weight with its own day's return would let
        this oracle capture the absolute value of every daily move, which is
        spectacular by construction. The engine's one-day shift instead pairs
        the weight with the NEXT day's return, which on serially independent
        data it knows nothing about, so realized performance must be near
        zero (slightly negative after costs).
        """
        rng = np.random.default_rng(7)
        n_days, n_assets = 800, 4
        shocks = rng.normal(0.0, 0.01, size=(n_days, n_assets))
        index = pd.bdate_range("2015-01-02", periods=n_days)
        prices = pd.DataFrame(
            100.0 * np.cumprod(1.0 + shocks, axis=0), index=index, columns=list("ABCD")
        )
        realized = prices.pct_change()
        oracle = np.sign(realized).fillna(0.0) / n_assets
        result = run_backtest(prices, oracle)
        gross = result.net_returns + result.costs

        # Near zero: with ~1% daily moves, a leak would put the mean daily
        # gross around 0.8%; the honest engine must stay an order of
        # magnitude below that.
        assert abs(gross.mean()) < 1e-3
        assert result.metrics["sharpe"] < 1.5
        assert -0.30 < result.metrics["cagr"] < 0.10

        # The same weights paired with same-day returns (a deliberately
        # broken convention) are spectacular, proving the canary has teeth.
        leaky_gross = (oracle * realized).sum(axis=1)
        assert leaky_gross.mean() > 0.004
        assert leaky_gross.mean() > 5.0 * abs(gross.mean())


class TestInputsAndOutputs:
    def test_weights_missing_rows_and_columns_are_flat(self) -> None:
        index = pd.date_range("2024-01-01", periods=4, freq="D")
        prices = pd.DataFrame(
            {"AAA": [100.0, 101.0, 102.0, 103.0], "BBB": [50.0, 51.0, 52.0, 53.0]},
            index=index,
        )
        # Weights omit column BBB and the last row entirely.
        weights = pd.DataFrame({"AAA": [1.0, 1.0, 1.0]}, index=index[:3])
        result = run_backtest(prices, weights)
        assert result.weights_used.shape == prices.shape
        assert (result.weights_used["BBB"] == 0.0).all()
        # Row 3 of weights_used carries row 2 of the supplied weights, because
        # the engine shifts decisions forward by one day.
        assert result.weights_used.loc[index[3], "AAA"] == 1.0
        assert np.isfinite(result.net_returns).all()

    def test_benchmark_equity_is_normalized(self) -> None:
        prices = _single_asset_frame([100.0, 110.0, 121.0])
        weights = pd.DataFrame(1.0, index=prices.index, columns=prices.columns)
        benchmark = pd.Series([50.0, 55.0, 60.5], index=prices.index)
        result = run_backtest(prices, weights, benchmark_prices=benchmark)
        assert result.benchmark_equity is not None
        assert result.benchmark_equity.tolist() == pytest.approx([1.0, 1.1, 1.21])

    def test_benchmark_absent_by_default(self) -> None:
        prices = _single_asset_frame([100.0, 101.0])
        weights = pd.DataFrame(1.0, index=prices.index, columns=prices.columns)
        assert run_backtest(prices, weights).benchmark_equity is None

    def test_metrics_dict_has_expected_keys(self) -> None:
        prices = _single_asset_frame([100.0, 102.0, 101.0, 104.0, 103.0])
        weights = pd.DataFrame(1.0, index=prices.index, columns=prices.columns)
        result = run_backtest(prices, weights)
        expected_keys = {
            "cagr",
            "ann_vol",
            "sharpe",
            "sortino",
            "max_drawdown",
            "max_drawdown_peak",
            "max_drawdown_trough",
            "max_drawdown_days",
            "calmar",
            "hit_rate",
        }
        assert expected_keys <= set(result.metrics)

    def test_empty_prices_raise(self) -> None:
        empty = pd.DataFrame()
        with pytest.raises(ValueError):
            run_backtest(empty, empty)

    def test_nan_gap_after_first_observation_raises(self) -> None:
        # A flattened gap would let a held position exit at the last seen
        # price with zero loss, so the engine must refuse it outright.
        prices = _single_asset_frame([100.0, 101.0, float("nan"), 103.0])
        weights = pd.DataFrame(1.0, index=prices.index, columns=prices.columns)
        with pytest.raises(ValueError, match="AAA"):
            run_backtest(prices, weights)

    def test_trailing_nan_raises(self) -> None:
        prices = _single_asset_frame([100.0, 101.0, 102.0, float("nan")])
        weights = pd.DataFrame(1.0, index=prices.index, columns=prices.columns)
        with pytest.raises(ValueError, match="AAA"):
            run_backtest(prices, weights)

    def test_leading_nans_from_late_listing_are_allowed(self) -> None:
        index = pd.date_range("2024-01-01", periods=4, freq="D")
        prices = pd.DataFrame(
            {
                "AAA": [100.0, 101.0, 102.0, 103.0],
                "BBB": [float("nan"), float("nan"), 50.0, 51.0],
            },
            index=index,
        )
        weights = pd.DataFrame(
            {"AAA": [1.0, 1.0, 0.5, 0.5], "BBB": [0.0, 0.0, 0.5, 0.5]}, index=index
        )
        result = run_backtest(prices, weights, commission_bps=0.0, slippage_bps=0.0)
        # Day 3 is the first day a BBB weight is live; before that the
        # unpriced column contributes exactly nothing.
        expected_day3 = 0.5 * (103.0 / 102.0 - 1.0) + 0.5 * (51.0 / 50.0 - 1.0)
        assert result.net_returns.iloc[3] == pytest.approx(expected_day3)


class _SingleAssetLong:
    """Test double satisfying the Strategy protocol: always long one column."""

    def __init__(self, column: str, name: str) -> None:
        self.column = column
        self.name = name

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame:
        weights = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
        weights[self.column] = 1.0
        return weights


def _trending_prices() -> pd.DataFrame:
    """Six years where UP has a strong drift and FLAT is driftless noise."""
    rng = np.random.default_rng(11)
    index = pd.bdate_range("2015-01-01", "2020-12-31")
    up = 100.0 * np.cumprod(1.0 + 0.0006 + rng.normal(0.0, 0.001, len(index)))
    flat = 100.0 * np.cumprod(1.0 + rng.normal(0.0, 0.01, len(index)))
    return pd.DataFrame({"UP": up, "FLAT": flat}, index=index)


class TestWalkForward:
    def test_selects_the_better_candidate_every_window(self) -> None:
        prices = _trending_prices()
        grid = {"demo": [_SingleAssetLong("FLAT", "flat"), _SingleAssetLong("UP", "up")]}
        wf = walk_forward(prices, grid, train_years=3, test_years=1)
        assert isinstance(wf, WalkForwardResult)
        assert set(wf.results) == {"demo"}
        choices = wf.choices["demo"]
        # 2015-2020 with 3y train / 1y test yields exactly three windows,
        # the last with a clipped partial test period.
        assert len(choices) == 3
        assert all(choice.chosen.name == "up" for choice in choices)
        assert all(choice.train_sharpe > 1.0 for choice in choices)

    def test_stitched_result_covers_the_full_out_of_sample_period(self) -> None:
        prices = _trending_prices()
        grid = {"demo": [_SingleAssetLong("UP", "up"), _SingleAssetLong("FLAT", "flat")]}
        wf = walk_forward(prices, grid, train_years=3, test_years=1)
        result = wf.results["demo"]
        assert isinstance(result, BacktestResult)
        first_train_end = wf.choices["demo"][0].train_end
        expected_index = prices.index[prices.index > first_train_end]
        assert result.net_returns.index.equals(expected_index)
        assert result.turnover.index.equals(expected_index)
        # Consecutive windows must tile: each test period ends where the
        # next training period ends its advance.
        choices = wf.choices["demo"]
        assert choices[0].test_end == choices[1].train_end
        assert choices[1].test_end == choices[2].train_end
        # Always long the drifting asset, so out-of-sample growth is positive.
        assert result.net_returns.mean() > 0.0
        assert result.equity.iloc[-1] > 1.0
        assert "sharpe" in result.metrics

    def test_multiple_families_are_independent(self) -> None:
        prices = _trending_prices()
        grid = {
            "alpha": [_SingleAssetLong("UP", "up")],
            "beta": [_SingleAssetLong("FLAT", "flat")],
        }
        wf = walk_forward(prices, grid, train_years=3, test_years=1)
        assert set(wf.results) == {"alpha", "beta"}
        assert all(c.chosen.name == "up" for c in wf.choices["alpha"])
        assert all(c.chosen.name == "flat" for c in wf.choices["beta"])

    def test_insufficient_history_raises(self) -> None:
        index = pd.bdate_range("2024-01-01", periods=200)
        prices = pd.DataFrame({"AAA": np.linspace(100.0, 120.0, len(index))}, index=index)
        grid = {"demo": [_SingleAssetLong("AAA", "only")]}
        with pytest.raises(ValueError):
            walk_forward(prices, grid, train_years=3, test_years=1)

    def test_empty_candidate_list_raises(self) -> None:
        prices = _trending_prices()
        with pytest.raises(ValueError):
            walk_forward(prices, {"demo": []}, train_years=3, test_years=1)
