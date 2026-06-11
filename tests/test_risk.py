"""Tests for the risk overlays in quantdesk.risk.

All data here is synthetic with fixed seeds; nothing touches the network.
"""

import numpy as np
import pandas as pd
import pytest

from quantdesk.risk import TRADING_DAYS_PER_YEAR, cap_weights, drawdown_guard, vol_target


def make_random_walk_prices(n_days: int = 300, n_assets: int = 4, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2020-01-01", periods=n_days)
    columns = [f"A{i}" for i in range(n_assets)]
    rets = rng.normal(0.0003, 0.01, size=(n_days, n_assets))
    return pd.DataFrame(100.0 * np.cumprod(1.0 + rets, axis=0), index=index, columns=columns)


def make_equal_weights(prices: pd.DataFrame) -> pd.DataFrame:
    n_assets = prices.shape[1]
    return pd.DataFrame(1.0 / n_assets, index=prices.index, columns=prices.columns)


class TestVolTarget:
    def test_preserves_shape_and_labels(self) -> None:
        prices = make_random_walk_prices()
        weights = make_equal_weights(prices)
        scaled = vol_target(weights, prices)
        assert scaled.shape == weights.shape
        assert scaled.index.equals(weights.index)
        assert list(scaled.columns) == list(weights.columns)

    def test_no_lookahead_final_day(self) -> None:
        # The multiplier for day t may only use returns through day t - 1, so
        # perturbing the final price must not change any output row.
        prices = make_random_walk_prices()
        weights = make_equal_weights(prices)
        bumped = prices.copy()
        bumped.iloc[-1] *= 1.5
        pd.testing.assert_frame_equal(
            vol_target(weights, prices), vol_target(weights, bumped)
        )

    def test_no_lookahead_mid_series(self) -> None:
        # Perturbing prices from day k onward may only affect output rows
        # strictly after day k.
        prices = make_random_walk_prices()
        weights = make_equal_weights(prices)
        k = 150
        bumped = prices.copy()
        bumped.iloc[k:] *= 1.25
        clean_out = vol_target(weights, prices)
        bumped_out = vol_target(weights, bumped)
        pd.testing.assert_frame_equal(clean_out.iloc[: k + 1], bumped_out.iloc[: k + 1])

    def test_leverage_cap_and_warmup_passthrough(self) -> None:
        # Constant prices give zero realized volatility, which drives the raw
        # multiplier to infinity; the clip at max_leverage is what binds once
        # the lookback window is full. Before that, weights pass through
        # unscaled.
        index = pd.bdate_range("2021-01-04", periods=60)
        prices = pd.DataFrame(100.0, index=index, columns=["A", "B"])
        weights = pd.DataFrame(0.5, index=index, columns=["A", "B"])
        scaled = vol_target(weights, prices, lookback=20, max_leverage=1.5)
        pd.testing.assert_frame_equal(scaled.iloc[:20], weights.iloc[:20])
        pd.testing.assert_frame_equal(scaled.iloc[20:], weights.iloc[20:] * 1.5)

    def test_known_answer_alternating_returns(self) -> None:
        # Strictly alternating +1%/-1% returns have a sample standard
        # deviation of exactly 0.01 * sqrt(20 / 19) over any 20-day window,
        # so the steady-state multiplier is computable in closed form.
        n_days = 120
        index = pd.bdate_range("2021-01-04", periods=n_days)
        rets = np.tile([0.01, -0.01], n_days // 2)
        prices = pd.DataFrame({"A": 100.0 * np.cumprod(1.0 + rets)}, index=index)
        weights = pd.DataFrame({"A": np.ones(n_days)}, index=index)
        scaled = vol_target(weights, prices, target_annual_vol=0.10, lookback=20)
        expected = 0.10 / (0.01 * np.sqrt(20 / 19) * np.sqrt(TRADING_DAYS_PER_YEAR))
        assert scaled["A"].iloc[-1] == pytest.approx(expected, rel=1e-9)

    def test_handles_reordered_price_columns(self) -> None:
        prices = make_random_walk_prices()
        weights = make_equal_weights(prices)
        reordered = prices[list(reversed(list(prices.columns)))]
        pd.testing.assert_frame_equal(
            vol_target(weights, prices), vol_target(weights, reordered)
        )

    def test_rejects_mismatched_index(self) -> None:
        prices = make_random_walk_prices(n_days=50)
        weights = make_equal_weights(prices).iloc[:-1]
        with pytest.raises(ValueError):
            vol_target(weights, prices)

    def test_rejects_bad_params(self) -> None:
        prices = make_random_walk_prices(n_days=50)
        weights = make_equal_weights(prices)
        with pytest.raises(ValueError):
            vol_target(weights, prices, target_annual_vol=0.0)
        with pytest.raises(ValueError):
            vol_target(weights, prices, lookback=1)
        with pytest.raises(ValueError):
            vol_target(weights, prices, max_leverage=0.0)


class TestCapWeights:
    def test_caps_each_position_symmetrically(self) -> None:
        index = pd.bdate_range("2021-01-04", periods=2)
        weights = pd.DataFrame({"A": [0.6, -0.6], "B": [0.1, 0.1]}, index=index)
        capped = cap_weights(weights, max_weight=0.25)
        assert (capped.abs().to_numpy() <= 0.25 + 1e-12).all()
        assert capped.loc[index[0], "A"] == pytest.approx(0.25)
        assert capped.loc[index[1], "A"] == pytest.approx(-0.25)
        # Exposure removed by the cap must not be redistributed to other
        # positions.
        assert capped.loc[index[0], "B"] == pytest.approx(0.1)

    def test_compliant_rows_unchanged(self) -> None:
        index = pd.bdate_range("2021-01-04", periods=3)
        weights = pd.DataFrame(0.2, index=index, columns=["A", "B", "C"])
        pd.testing.assert_frame_equal(cap_weights(weights), weights)

    def test_never_increases_any_position(self) -> None:
        rng = np.random.default_rng(11)
        index = pd.bdate_range("2021-01-04", periods=50)
        weights = pd.DataFrame(
            rng.normal(0.0, 0.3, size=(50, 6)), index=index, columns=list("ABCDEF")
        )
        capped = cap_weights(weights)
        assert (capped.abs().to_numpy() <= np.abs(weights.to_numpy()) + 1e-12).all()

    def test_gross_above_one_scaled_down_to_one(self) -> None:
        # Eight positions of 0.1875 are each under the cap but sum to a gross
        # exposure of 1.5, so the row must be scaled down to exactly 1.0.
        index = pd.bdate_range("2021-01-04", periods=1)
        weights = pd.DataFrame(
            [[0.1875] * 8], index=index, columns=[f"A{i}" for i in range(8)]
        )
        capped = cap_weights(weights, max_weight=0.25)
        assert capped.abs().sum(axis=1).iloc[0] == pytest.approx(1.0)
        assert capped.iloc[0, 0] == pytest.approx(0.125)

    def test_rejects_nonpositive_cap(self) -> None:
        index = pd.bdate_range("2021-01-04", periods=1)
        weights = pd.DataFrame([[0.1]], index=index, columns=["A"])
        with pytest.raises(ValueError):
            cap_weights(weights, max_weight=0.0)


class TestDrawdownGuard:
    def test_hysteresis_path(self) -> None:
        # Peak 110, drop to 93 (15.45% drawdown) trips the guard; the partial
        # recovery to 95 (13.6%) is not enough to resume; 102 (7.27%) is.
        index = pd.bdate_range("2021-01-04", periods=8)
        equity = pd.Series(
            [100.0, 105.0, 110.0, 100.0, 93.0, 95.0, 102.0, 112.0], index=index
        )
        guard = drawdown_guard(equity, threshold=0.15, resume_at=0.075)
        expected = pd.Series(
            [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0], index=index, name="exposure"
        )
        pd.testing.assert_series_equal(guard, expected)

    def test_threshold_is_strict(self) -> None:
        # A drawdown exactly equal to the threshold does not trip the guard.
        # The values 128 and 96 make the 0.25 drawdown exact in binary
        # floating point.
        index = pd.bdate_range("2021-01-04", periods=2)
        equity = pd.Series([128.0, 96.0], index=index)
        guard = drawdown_guard(equity, threshold=0.25, resume_at=0.1)
        assert guard.tolist() == [1.0, 1.0]

    def test_retriggers_after_recovery(self) -> None:
        index = pd.bdate_range("2021-01-04", periods=6)
        equity = pd.Series([100.0, 80.0, 96.0, 100.0, 80.0, 99.0], index=index)
        guard = drawdown_guard(equity, threshold=0.15, resume_at=0.075)
        assert guard.tolist() == [1.0, 0.0, 1.0, 1.0, 0.0, 1.0]

    def test_values_are_binary_and_index_preserved(self) -> None:
        rng = np.random.default_rng(3)
        index = pd.bdate_range("2020-01-01", periods=400)
        equity = pd.Series(
            100.0 * np.cumprod(1.0 + rng.normal(0.0, 0.02, 400)), index=index
        )
        guard = drawdown_guard(equity)
        assert guard.index.equals(index)
        assert set(np.unique(guard.to_numpy())) <= {0.0, 1.0}

    def test_rejects_bad_params(self) -> None:
        index = pd.bdate_range("2021-01-04", periods=3)
        equity = pd.Series([100.0, 90.0, 95.0], index=index)
        with pytest.raises(ValueError):
            drawdown_guard(equity, threshold=0.1, resume_at=0.1)
        with pytest.raises(ValueError):
            drawdown_guard(equity, threshold=0.0, resume_at=-0.1)
        with pytest.raises(ValueError):
            drawdown_guard(pd.Series([100.0, -5.0, 95.0], index=index))
