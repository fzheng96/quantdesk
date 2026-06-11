"""Tests for the HTML tearsheet renderer.

No network access anywhere: the BacktestResult fed to the renderer is
built from a seeded random walk.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from quantdesk.backtest import BacktestResult
from quantdesk.report import render_tearsheet


def _make_result(days: int = 750, with_benchmark: bool = True) -> BacktestResult:
    rng = np.random.default_rng(42)
    index = pd.bdate_range("2020-01-02", periods=days)
    tickers = ["AAA", "BBB", "CCC"]
    net = pd.Series(rng.normal(0.0004, 0.01, days), index=index)
    weights = pd.DataFrame(
        rng.uniform(0.0, 1.0 / len(tickers), size=(days, len(tickers))),
        index=index,
        columns=tickers,
    )
    turnover = weights.diff().abs().sum(axis=1).fillna(0.0)
    costs = turnover * 3.0 / 10_000.0
    benchmark = None
    if with_benchmark:
        benchmark = (
            1.0 + pd.Series(rng.normal(0.0003, 0.009, days), index=index)
        ).cumprod()
    return BacktestResult(
        net_returns=net,
        equity=(1.0 + net).cumprod(),
        weights_used=weights,
        turnover=turnover,
        costs=costs,
        metrics={},
        benchmark_equity=benchmark,
    )


@pytest.fixture(scope="module")
def rendered(tmp_path_factory: pytest.TempPathFactory) -> str:
    path = tmp_path_factory.mktemp("report") / "tearsheet.html"
    render_tearsheet(_make_result(), str(path), "Momentum Tearsheet")
    return path.read_text(encoding="utf-8")


def test_writes_file(tmp_path: Path) -> None:
    path = tmp_path / "out.html"
    render_tearsheet(_make_result(days=120), str(path), "Smoke")
    assert path.exists()
    assert path.stat().st_size > 0


def test_title_in_output(rendered: str) -> None:
    assert "<title>Momentum Tearsheet</title>" in rendered
    assert "<h1>Momentum Tearsheet</h1>" in rendered


def test_contains_svg_charts(rendered: str) -> None:
    assert rendered.count("<svg") >= 3
    assert "<path" in rendered
    assert "<line" in rendered
    assert "<text" in rendered


def test_chart_sections_present(rendered: str) -> None:
    for heading in (
        "Headline Metrics",
        "Equity Curve",
        "Drawdown",
        "Rolling 60-Day Sharpe",
        "Monthly Returns",
        "Turnover and Costs",
    ):
        assert heading in rendered


def test_no_external_references(rendered: str) -> None:
    assert "http://" not in rendered
    assert "https://" not in rendered
    assert "<script" not in rendered
    assert "<link" not in rendered
    assert "@import" not in rendered


def test_metric_cards_present(rendered: str) -> None:
    for label in (
        "CAGR",
        "Sharpe",
        "Sortino",
        "Max Drawdown",
        "Calmar",
        "Ann. Vol",
        "Hit Rate",
    ):
        assert label in rendered


def test_disclaimer_present(rendered: str) -> None:
    lowered = rendered.lower()
    assert "simulated" in lowered
    assert "not investment advice" in lowered


def test_monthly_heatmap_axes(rendered: str) -> None:
    for token in ("Jan", "Dec", "2020", "2021", "2022", "Year Total"):
        assert token in rendered


def test_benchmark_curve_present(rendered: str) -> None:
    assert "Equity Curve vs Benchmark" in rendered
    assert "Benchmark" in rendered


def test_benchmark_absent_when_not_provided(tmp_path: Path) -> None:
    path = tmp_path / "no_bench.html"
    render_tearsheet(_make_result(with_benchmark=False), str(path), "Solo")
    content = path.read_text(encoding="utf-8")
    assert "Benchmark" not in content
    assert "Equity Curve" in content


def test_title_is_escaped(tmp_path: Path) -> None:
    path = tmp_path / "escaped.html"
    render_tearsheet(
        _make_result(days=120), str(path), '<script>alert("x")</script> & Co'
    )
    content = path.read_text(encoding="utf-8")
    assert "<script" not in content
    assert "&lt;script&gt;" in content


def test_creates_parent_directories(tmp_path: Path) -> None:
    nested = tmp_path / "reports" / "nested" / "out.html"
    render_tearsheet(_make_result(days=120), str(nested), "Nested")
    assert nested.exists()


def test_headline_metrics_match_cli_conventions(tmp_path: Path) -> None:
    """The cards must agree with quantdesk.metrics, which the CLI table uses.

    The series mixes wins, a loss, and exact-zero (flat) days, so the hit
    rate differs sharply between the include-zeros and exclude-zeros
    conventions, and the drawdown sign distinguishes the two surfaces.
    """
    index = pd.bdate_range("2024-01-02", periods=6)
    net = pd.Series([0.0, 0.0, 0.10, -0.25, 0.05, 0.0], index=index)
    result = BacktestResult(
        net_returns=net,
        equity=(1.0 + net).cumprod(),
        weights_used=pd.DataFrame({"AAA": [0.0] * 6}, index=index),
        turnover=pd.Series(0.0, index=index),
        costs=pd.Series(0.0, index=index),
        metrics={},
    )
    path = tmp_path / "conventions.html"
    render_tearsheet(result, str(path), "Conventions")
    content = path.read_text(encoding="utf-8")
    # Hit rate counts 2 wins out of 3 decided days; flat days are excluded.
    assert "66.67%" in content
    assert "33.33%" not in content
    # Drawdown depth is a positive fraction, matching the CLI table.
    assert "25.00%" in content
    assert "-25.00%" not in content


def test_short_history_skips_rolling_chart_gracefully(tmp_path: Path) -> None:
    path = tmp_path / "short.html"
    render_tearsheet(_make_result(days=30), str(path), "Short")
    content = path.read_text(encoding="utf-8")
    assert "Rolling 60-Day Sharpe" in content
    assert "Not enough data" in content
