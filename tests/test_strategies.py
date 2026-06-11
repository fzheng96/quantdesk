"""Tests for quantdesk.strategies.

Everything here runs on synthetic frames built in-process; no test touches
the network or the filesystem.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quantdesk.strategies import (
    ALL_STRATEGIES,
    CrossSectionalMomentum,
    DualMovingAverage,
    MeanReversion,
    Strategy,
    TimeSeriesMomentum,
)


def random_walk_prices(
    n_days: int = 400,
    tickers: tuple[str, ...] = ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF"),
    seed: int = 7,
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    returns = rng.normal(0.0003, 0.01, size=(n_days, len(tickers)))
    levels = 100.0 * np.cumprod(1.0 + returns, axis=0)
    index = pd.bdate_range("2020-01-01", periods=n_days)
    return pd.DataFrame(levels, index=index, columns=list(tickers))


def frame_from_returns(returns: list[float], column: str = "X") -> pd.DataFrame:
    levels = 100.0 * np.cumprod(1.0 + np.asarray(returns))
    index = pd.bdate_range("2021-01-04", periods=len(returns))
    return pd.DataFrame({column: levels}, index=index)


def crash_and_rebound_returns() -> list[float]:
    """A path engineered for the mean-reversion state machine.

    Forty days of small alternating returns establish a calm z-score history,
    a -20% day forces the z-score far below any reasonable entry threshold,
    two flat days keep it negative, and a +30% day pushes it back above zero.
    """
    warmup = [0.005 if i % 2 == 0 else -0.005 for i in range(40)]
    return warmup + [-0.20, 0.0, 0.0, 0.30] + [0.0] * 12


# The contract tests use shortened windows so that a 400-day frame leaves
# plenty of rows past each strategy's warmup period.
SHORT_PARAM_STRATEGIES = [
    TimeSeriesMomentum(lookback=60, skip=5),
    CrossSectionalMomentum(lookback=60, skip=5, top_n=3),
    MeanReversion(z_window=30, short_window=5, entry_z=-1.5),
    DualMovingAverage(fast=10, slow=40),
]


@pytest.fixture(scope="module")
def prices() -> pd.DataFrame:
    return random_walk_prices()


@pytest.mark.parametrize("strategy", SHORT_PARAM_STRATEGIES, ids=lambda s: s.name)
class TestWeightContract:
    def test_index_and_columns_match(self, strategy: Strategy, prices: pd.DataFrame) -> None:
        weights = strategy.generate_weights(prices)
        assert weights.index.equals(prices.index)
        assert list(weights.columns) == list(prices.columns)

    def test_no_nans_in_output(self, strategy: Strategy, prices: pd.DataFrame) -> None:
        weights = strategy.generate_weights(prices)
        assert not weights.isna().any().any()

    def test_gross_exposure_at_most_one(self, strategy: Strategy, prices: pd.DataFrame) -> None:
        weights = strategy.generate_weights(prices)
        assert (weights.abs().sum(axis=1) <= 1.0 + 1e-9).all()

    def test_long_only(self, strategy: Strategy, prices: pd.DataFrame) -> None:
        weights = strategy.generate_weights(prices)
        assert (weights >= 0.0).all().all()

    def test_input_frame_not_mutated(self, strategy: Strategy, prices: pd.DataFrame) -> None:
        snapshot = prices.copy(deep=True)
        strategy.generate_weights(prices)
        pd.testing.assert_frame_equal(prices, snapshot)

    def test_future_prices_do_not_change_past_weights(
        self, strategy: Strategy, prices: pd.DataFrame
    ) -> None:
        # If any computation leaked future information, scaling every price
        # after the cutoff would alter at least one weight at or before it.
        cutoff = prices.index[300]
        tampered = prices.copy()
        tampered.loc[tampered.index > cutoff] *= 5.0
        original = strategy.generate_weights(prices).loc[:cutoff]
        rerun = strategy.generate_weights(tampered).loc[:cutoff]
        pd.testing.assert_frame_equal(original, rerun)


def test_tsmom_holds_uptrend_skips_downtrend() -> None:
    days = 40
    index = pd.bdate_range("2021-01-04", periods=days)
    frame = pd.DataFrame(
        {
            "UP": 100.0 * 1.01 ** np.arange(days),
            "DOWN": 100.0 * 0.99 ** np.arange(days),
        },
        index=index,
    )
    weights = TimeSeriesMomentum(lookback=10, skip=2).generate_weights(frame)
    assert weights["UP"].iloc[-1] == pytest.approx(0.5)
    assert weights["DOWN"].iloc[-1] == 0.0
    # The first ten rows lack a full lookback window, so the book stays flat.
    assert (weights.iloc[:10] == 0.0).all().all()


def test_xsmom_picks_strongest_assets() -> None:
    days = 60
    drifts = {"A": 0.004, "B": 0.003, "C": 0.001, "D": 0.0, "E": -0.002}
    index = pd.bdate_range("2021-01-04", periods=days)
    frame = pd.DataFrame(
        {ticker: 100.0 * (1.0 + drift) ** np.arange(days) for ticker, drift in drifts.items()},
        index=index,
    )
    last = CrossSectionalMomentum(lookback=20, skip=2, top_n=2).generate_weights(frame).iloc[-1]
    assert last["A"] == pytest.approx(0.5)
    assert last["B"] == pytest.approx(0.5)
    assert last[["C", "D", "E"]].eq(0.0).all()


def test_xsmom_small_universe_leaves_remainder_in_cash() -> None:
    # With only three assets and top_n=5, every asset is held at the fixed
    # 1/top_n size and the rest of the book sits in cash.
    days = 60
    index = pd.bdate_range("2021-01-04", periods=days)
    frame = pd.DataFrame(
        {ticker: 100.0 * (1.0 + drift) ** np.arange(days) for ticker, drift in
         {"A": 0.002, "B": 0.001, "C": -0.001}.items()},
        index=index,
    )
    last = CrossSectionalMomentum(lookback=20, skip=2, top_n=5).generate_weights(frame).iloc[-1]
    assert last.eq(0.2).all()
    assert last.sum() == pytest.approx(0.6)


def test_meanrev_enters_on_crash_exits_on_rebound() -> None:
    frame = frame_from_returns(crash_and_rebound_returns())
    strategy = MeanReversion(z_window=20, short_window=5, entry_z=-1.5)
    series = strategy.generate_weights(frame)["X"]
    # The calm warmup never pushes the z-score below the entry threshold.
    assert (series.iloc[:40] == 0.0).all()
    # The crash day takes the z-score far below the threshold, opening the position.
    assert series.iloc[40] == 1.0
    # The two flat days keep the z-score negative, so the position is held.
    assert (series.iloc[41:43] == 1.0).all()
    # The rebound lifts the z-score above zero, closing the position for good.
    assert (series.iloc[43:] == 0.0).all()


def test_meanrev_splits_weight_equally_among_signaled_assets() -> None:
    base = frame_from_returns(crash_and_rebound_returns())
    frame = pd.DataFrame({"X": base["X"], "Y": base["X"]}, index=base.index)
    weights = MeanReversion(z_window=20, short_window=5, entry_z=-1.5).generate_weights(frame)
    crash_row = weights.iloc[40]
    assert crash_row["X"] == pytest.approx(0.5)
    assert crash_row["Y"] == pytest.approx(0.5)


def test_dma_long_uptrend_flat_downtrend() -> None:
    days = 30
    index = pd.bdate_range("2021-01-04", periods=days)
    frame = pd.DataFrame(
        {"UP": 100.0 + np.arange(days, dtype=float), "DOWN": 200.0 - np.arange(days, dtype=float)},
        index=index,
    )
    weights = DualMovingAverage(fast=3, slow=10).generate_weights(frame)
    assert weights["UP"].iloc[-1] == pytest.approx(0.5)
    assert weights["DOWN"].iloc[-1] == 0.0
    # The first nine rows lack a full slow window, so the book stays flat.
    assert (weights.iloc[:9] == 0.0).all().all()


def test_registry_keys_classes_and_protocol() -> None:
    assert set(ALL_STRATEGIES) == {"tsmom", "xsmom", "meanrev", "dma"}
    assert ALL_STRATEGIES["tsmom"] is TimeSeriesMomentum
    assert ALL_STRATEGIES["xsmom"] is CrossSectionalMomentum
    assert ALL_STRATEGIES["meanrev"] is MeanReversion
    assert ALL_STRATEGIES["dma"] is DualMovingAverage
    for cls in ALL_STRATEGIES.values():
        instance = cls()
        assert isinstance(instance, Strategy)
        assert isinstance(instance.name, str)
        assert instance.name


@pytest.mark.parametrize(
    "factory",
    [
        lambda: TimeSeriesMomentum(lookback=10, skip=10),
        lambda: TimeSeriesMomentum(lookback=10, skip=-1),
        lambda: CrossSectionalMomentum(top_n=0),
        lambda: CrossSectionalMomentum(lookback=5, skip=21),
        lambda: MeanReversion(z_window=1),
        lambda: MeanReversion(short_window=0),
        lambda: MeanReversion(entry_z=0.5),
        lambda: DualMovingAverage(fast=50, slow=50),
        lambda: DualMovingAverage(fast=0, slow=10),
    ],
)
def test_invalid_parameters_raise(factory) -> None:
    with pytest.raises(ValueError):
        factory()


def test_late_listing_asset_gets_zero_weight_not_nan() -> None:
    # A column with leading NaNs models an asset that starts trading after
    # the rest of the universe, which the wide frame from get_prices can
    # produce because its index is the union of all per-ticker histories.
    frame = random_walk_prices(n_days=200, seed=11)
    frame.loc[frame.index[:60], "AAA"] = np.nan
    strategies = [
        TimeSeriesMomentum(lookback=40, skip=5),
        CrossSectionalMomentum(lookback=40, skip=5, top_n=3),
        MeanReversion(z_window=20, short_window=5),
        DualMovingAverage(fast=5, slow=20),
    ]
    for strategy in strategies:
        weights = strategy.generate_weights(frame)
        assert not weights.isna().any().any(), strategy.name
        assert (weights["AAA"].iloc[:60] == 0.0).all(), strategy.name
