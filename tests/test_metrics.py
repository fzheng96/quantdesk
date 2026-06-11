"""Known-answer and edge-case tests for quantdesk.metrics.

Every expected value here is either computed by hand or written as the
closed-form expression the implementation must reproduce, so a regression
in any convention (ddof, annualization, drawdown direction) breaks a test.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from quantdesk import metrics


def _dated(values: list[float], start: str = "2024-01-01") -> pd.Series:
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq="D"))


class TestCagr:
    def test_constant_daily_return_is_exact(self) -> None:
        # One year of a constant 1% daily return compounds to exactly
        # 1.01**252, and with a one-year span CAGR equals total growth.
        returns = _dated([0.01] * 252)
        assert metrics.cagr(returns) == pytest.approx(1.01**252 - 1.0, rel=1e-12)

    def test_two_years_annualizes_by_period_count(self) -> None:
        # Doubling the sample length at the same daily return must leave
        # the annualized rate unchanged.
        returns = _dated([0.01] * 504)
        assert metrics.cagr(returns) == pytest.approx(1.01**252 - 1.0, rel=1e-12)

    def test_total_wipeout_reports_minus_one(self) -> None:
        returns = _dated([0.05, -1.0, 0.05])
        assert metrics.cagr(returns) == -1.0

    def test_empty_raises(self) -> None:
        with pytest.raises(ValueError):
            metrics.cagr(pd.Series(dtype=float))


class TestAnnVol:
    def test_two_point_exact(self) -> None:
        # Sample std (ddof=1) of [0.01, 0.03] is sqrt(0.0002).
        returns = _dated([0.01, 0.03])
        expected = math.sqrt(0.0002) * math.sqrt(252)
        assert metrics.ann_vol(returns) == pytest.approx(expected, rel=1e-12)

    def test_constant_series_has_zero_vol(self) -> None:
        returns = _dated([0.005] * 100)
        assert metrics.ann_vol(returns) == pytest.approx(0.0, abs=1e-15)


class TestSharpe:
    def test_constant_positive_return_is_positive_infinity(self) -> None:
        # A constant daily return has zero sample volatility, so the exactly
        # computable Sharpe is +inf; the documented convention is to return it.
        returns = _dated([0.001] * 252)
        result = metrics.sharpe(returns)
        assert math.isinf(result) and result > 0

    def test_constant_negative_return_is_negative_infinity(self) -> None:
        returns = _dated([-0.001] * 252)
        result = metrics.sharpe(returns)
        assert math.isinf(result) and result < 0

    def test_two_point_exact_value(self) -> None:
        # mean = 0.02, sample std = 0.01 * sqrt(2), so the ratio is sqrt(2)
        # and the annualized Sharpe is exactly sqrt(2 * 252) = sqrt(504).
        returns = _dated([0.01, 0.03])
        assert metrics.sharpe(returns) == pytest.approx(math.sqrt(504), rel=1e-12)

    def test_all_zero_returns_nan(self) -> None:
        returns = _dated([0.0] * 10)
        assert math.isnan(metrics.sharpe(returns))


class TestSortino:
    def test_hand_computed_value(self) -> None:
        values = [0.02, -0.01, 0.03, -0.02]
        returns = _dated(values)
        mean = sum(values) / len(values)
        downside_dev = math.sqrt((0.01**2 + 0.02**2) / len(values))
        expected = mean / downside_dev * math.sqrt(252)
        assert metrics.sortino(returns) == pytest.approx(expected, rel=1e-12)

    def test_no_losses_with_positive_mean_is_infinite(self) -> None:
        returns = _dated([0.01, 0.02, 0.0])
        assert math.isinf(metrics.sortino(returns))


class TestMaxDrawdown:
    def test_hand_crafted_path_exact(self) -> None:
        # Peak 1.2 on Jan 2, trough 0.9 on Jan 4: depth is 1 - 0.9/1.2 = 0.25.
        # The later dip from 1.3 to 1.2 is only ~7.7% and must not win.
        equity = _dated([1.0, 1.2, 1.1, 0.9, 1.0, 1.3, 1.2])
        result = metrics.max_drawdown(equity)
        assert result.depth == pytest.approx(0.25, rel=1e-12)
        assert result.peak == pd.Timestamp("2024-01-02")
        assert result.trough == pd.Timestamp("2024-01-04")
        assert result.duration_days == 2

    def test_monotonic_curve_has_zero_depth(self) -> None:
        equity = _dated([1.0, 1.1, 1.2, 1.3])
        result = metrics.max_drawdown(equity)
        assert result.depth == 0.0
        assert result.duration_days == 0


class TestCalmar:
    def test_consistent_with_components(self) -> None:
        returns = _dated([0.01, -0.02, 0.015, -0.005, 0.02, -0.01] * 42)
        equity = (1.0 + returns).cumprod()
        expected = metrics.cagr(returns) / metrics.max_drawdown(equity).depth
        assert metrics.calmar(returns) == pytest.approx(expected, rel=1e-12)

    def test_no_drawdown_with_growth_is_infinite(self) -> None:
        returns = _dated([0.01] * 50)
        assert math.isinf(metrics.calmar(returns))


class TestHitRate:
    def test_zeros_are_excluded(self) -> None:
        # Two wins, one loss, one flat day: 2 / 3, not 2 / 4.
        returns = _dated([0.01, -0.01, 0.02, 0.0])
        assert metrics.hit_rate(returns) == pytest.approx(2.0 / 3.0, rel=1e-12)

    def test_all_flat_is_nan(self) -> None:
        returns = _dated([0.0] * 5)
        assert math.isnan(metrics.hit_rate(returns))


class TestMonthlyReturns:
    def test_compounds_within_calendar_months(self) -> None:
        index = pd.date_range("2024-01-01", "2024-02-29", freq="D")
        returns = pd.Series(0.01, index=index)
        table = metrics.monthly_returns(returns)
        assert list(table.columns) == list(range(1, 13))
        assert table.loc[2024, 1] == pytest.approx(1.01**31 - 1.0, rel=1e-12)
        assert table.loc[2024, 2] == pytest.approx(1.01**29 - 1.0, rel=1e-12)
        assert math.isnan(table.loc[2024, 3])

    def test_spans_multiple_years(self) -> None:
        index = pd.date_range("2023-12-30", "2024-01-02", freq="D")
        returns = pd.Series([0.01, 0.01, 0.02, 0.02], index=index)
        table = metrics.monthly_returns(returns)
        assert list(table.index) == [2023, 2024]
        assert table.loc[2023, 12] == pytest.approx(1.01**2 - 1.0, rel=1e-12)
        assert table.loc[2024, 1] == pytest.approx(1.02**2 - 1.0, rel=1e-12)

    def test_requires_datetime_index(self) -> None:
        returns = pd.Series([0.01, 0.02])
        with pytest.raises(TypeError):
            metrics.monthly_returns(returns)
