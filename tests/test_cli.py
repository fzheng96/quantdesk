"""Smoke tests for the typer CLI.

The network is never touched: the data loader is replaced with deterministic
synthetic frames, and broker state lives in per-test temporary SQLite files.
These tests check wiring and exit codes, not strategy economics; the engine,
strategy, and broker behavior have their own dedicated test modules.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from typer.testing import CliRunner

from quantdesk import cli

runner = CliRunner()


def trending_prices(tickers: list[str], days: int = 420, seed: int = 11) -> pd.DataFrame:
    """Build a steadily rising path with small seeded noise.

    The drift dominates the noise so trend-following strategies have an
    unambiguous long signal on the final row, which keeps the scan and
    paper-apply tests deterministic.
    """
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2020-01-02", periods=days)
    drift = np.arange(days, dtype=float)[:, None] * 0.002
    noise = rng.normal(0.0, 0.003, size=(days, len(tickers))).cumsum(axis=0)
    levels = 100.0 * np.exp(drift + noise)
    return pd.DataFrame(levels, index=index, columns=list(tickers))


def _failure_details(result) -> str:
    if result.exception is not None:
        return f"{result.exception!r}\n{result.output}"
    return result.output


@pytest.fixture()
def fake_prices(monkeypatch) -> list[list[str]]:
    """Replace the data layer with an offline deterministic source.

    Returns the list of ticker lists requested, so tests can assert on what
    the CLI asked for.
    """
    calls: list[list[str]] = []

    def _fake(tickers, start, end, source=None, cache=None):
        symbols = list(dict.fromkeys(tickers))
        calls.append(symbols)
        return trending_prices(symbols)

    monkeypatch.setattr(cli, "get_prices", _fake)
    return calls


def test_help_lists_all_commands() -> None:
    result = runner.invoke(cli.app, ["--help"])
    assert result.exit_code == 0
    for command in ("fetch", "backtest", "compare", "scan", "paper-apply", "paper-status", "demo"):
        assert command in result.output


def test_default_universe_shape() -> None:
    assert len(cli.DEFAULT_UNIVERSE) == 20
    assert "AAPL" in cli.DEFAULT_UNIVERSE
    assert "BRK-B" in cli.DEFAULT_UNIVERSE
    assert cli.BENCHMARK_TICKER == "SPY"
    assert cli.BENCHMARK_TICKER not in cli.DEFAULT_UNIVERSE


def test_fetch_summarizes_each_ticker(fake_prices) -> None:
    result = runner.invoke(
        cli.app, ["fetch", "AAPL", "MSFT", "--start", "2020-01-01", "--end", "2021-06-30"]
    )
    assert result.exit_code == 0, _failure_details(result)
    assert "AAPL" in result.output
    assert "MSFT" in result.output


def test_fetch_defaults_to_universe_plus_benchmark(fake_prices) -> None:
    result = runner.invoke(cli.app, ["fetch"])
    assert result.exit_code == 0, _failure_details(result)
    assert fake_prices, "expected the data layer to be called"
    requested = fake_prices[0]
    assert "AAPL" in requested
    assert "SPY" in requested


def test_fetch_rejects_malformed_date(fake_prices) -> None:
    result = runner.invoke(cli.app, ["fetch", "AAPL", "--start", "not-a-date"])
    assert result.exit_code != 0


def test_fetch_rejects_inverted_date_range(fake_prices) -> None:
    result = runner.invoke(
        cli.app, ["fetch", "AAPL", "--start", "2024-01-01", "--end", "2023-01-01"]
    )
    assert result.exit_code != 0
    assert "after" in result.output


def test_backtest_rejects_inverted_date_range(fake_prices) -> None:
    result = runner.invoke(
        cli.app,
        ["backtest", "--strategy", "tsmom", "--start", "2024-01-01", "--end", "2023-01-01"],
    )
    assert result.exit_code != 0
    assert "after" in result.output


def test_backtest_unknown_strategy_fails(fake_prices) -> None:
    result = runner.invoke(cli.app, ["backtest", "--strategy", "nope"])
    assert result.exit_code != 0


def test_backtest_smoke(fake_prices) -> None:
    result = runner.invoke(
        cli.app,
        ["backtest", "--strategy", "tsmom", "--tickers", "AAPL,MSFT,NVDA", "--start", "2020-01-01"],
    )
    assert result.exit_code == 0, _failure_details(result)
    assert "Sharpe" in result.output


def test_backtest_with_vol_target_smoke(fake_prices) -> None:
    result = runner.invoke(
        cli.app, ["backtest", "--strategy", "dma", "--tickers", "AAPL,MSFT", "--vol-target"]
    )
    assert result.exit_code == 0, _failure_details(result)


def test_backtest_writes_report(fake_prices, tmp_path, monkeypatch) -> None:
    rendered: dict[str, str] = {}

    def _fake_render(result, path, title):
        rendered["path"] = path
        rendered["title"] = title
        Path(path).write_text("<html></html>")

    monkeypatch.setattr(cli, "render_tearsheet", _fake_render)
    out = tmp_path / "sheet.html"
    result = runner.invoke(
        cli.app,
        ["backtest", "--strategy", "tsmom", "--tickers", "AAPL,MSFT", "--report", str(out)],
    )
    assert result.exit_code == 0, _failure_details(result)
    assert rendered["path"] == str(out)
    assert out.exists()


def test_compare_lists_every_strategy(fake_prices) -> None:
    result = runner.invoke(
        cli.app, ["compare", "--tickers", "AAPL,MSFT,NVDA,AMZN,GOOGL,META"]
    )
    assert result.exit_code == 0, _failure_details(result)
    for name in cli.ALL_STRATEGIES:
        assert name in result.output


def test_scan_prints_targets_and_orders(fake_prices, tmp_path) -> None:
    db = tmp_path / "paper.sqlite"
    result = runner.invoke(
        cli.app, ["scan", "--strategy", "dma", "--tickers", "AAPL,MSFT", "--db", str(db)]
    )
    assert result.exit_code == 0, _failure_details(result)
    assert "Target weights" in result.output


def test_scan_reports_held_symbol_outside_requested_tickers(fake_prices, tmp_path) -> None:
    db = tmp_path / "paper.sqlite"
    apply_result = runner.invoke(
        cli.app, ["paper-apply", "--strategy", "dma", "--tickers", "AAPL,MSFT", "--db", str(db)]
    )
    assert apply_result.exit_code == 0, _failure_details(apply_result)
    # The ledger now holds MSFT, which a narrower scan cannot price; that
    # must be a clear error rather than a traceback.
    result = runner.invoke(
        cli.app, ["scan", "--strategy", "dma", "--tickers", "AAPL", "--db", str(db)]
    )
    assert result.exit_code == 1
    assert "MSFT" in result.output
    assert "--tickers" in result.output


def test_paper_status_reports_held_symbol_with_no_recent_price(
    fake_prices, tmp_path, monkeypatch
) -> None:
    db = tmp_path / "paper.sqlite"
    apply_result = runner.invoke(
        cli.app, ["paper-apply", "--strategy", "dma", "--tickers", "AAPL,MSFT", "--db", str(db)]
    )
    assert apply_result.exit_code == 0, _failure_details(apply_result)

    def _msft_unpriced(tickers, start, end, source=None, cache=None):
        frame = trending_prices(list(dict.fromkeys(tickers)))
        frame["MSFT"] = np.nan
        return frame

    monkeypatch.setattr(cli, "get_prices", _msft_unpriced)
    result = runner.invoke(cli.app, ["paper-status", "--db", str(db)])
    assert result.exit_code == 1
    assert "MSFT" in result.output


def test_paper_apply_then_status_roundtrip(fake_prices, tmp_path) -> None:
    db = tmp_path / "paper.sqlite"
    apply_result = runner.invoke(
        cli.app, ["paper-apply", "--strategy", "dma", "--tickers", "AAPL,MSFT", "--db", str(db)]
    )
    assert apply_result.exit_code == 0, _failure_details(apply_result)
    status_result = runner.invoke(cli.app, ["paper-status", "--db", str(db)])
    assert status_result.exit_code == 0, _failure_details(status_result)
    assert "Cash" in status_result.output
    assert "Equity" in status_result.output


def test_paper_status_fresh_ledger(tmp_path) -> None:
    db = tmp_path / "paper.sqlite"
    result = runner.invoke(cli.app, ["paper-status", "--db", str(db)])
    assert result.exit_code == 0, _failure_details(result)
    assert "100,000.00" in result.output
    assert "No open positions" in result.output


def test_demo_writes_report(fake_prices, tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    rendered: dict[str, str] = {}

    def _fake_render(result, path, title):
        rendered["path"] = path
        Path(path).write_text("<html></html>")

    monkeypatch.setattr(cli, "render_tearsheet", _fake_render)
    result = runner.invoke(cli.app, ["demo"])
    assert result.exit_code == 0, _failure_details(result)
    assert rendered["path"] == str(Path("reports") / "demo.html")
    assert (tmp_path / "reports" / "demo.html").exists()


def test_demo_falls_back_to_synthetic_when_data_unavailable(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    def _unreachable(tickers, start, end, source=None, cache=None):
        raise cli.DataError("source unreachable")

    monkeypatch.setattr(cli, "get_prices", _unreachable)
    rendered: dict[str, str] = {}

    def _fake_render(result, path, title):
        rendered["title"] = title
        Path(path).write_text("<html></html>")

    monkeypatch.setattr(cli, "render_tearsheet", _fake_render)
    result = runner.invoke(cli.app, ["demo"])
    assert result.exit_code == 0, _failure_details(result)
    assert "SYNTHETIC" in result.output
    assert "SYNTHETIC" in rendered["title"]
    assert (tmp_path / "reports" / "demo.html").exists()


def test_compare_synthetic_never_touches_the_data_layer(monkeypatch) -> None:
    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("get_prices must not be called with --synthetic")

    monkeypatch.setattr(cli, "get_prices", _must_not_be_called)
    result = runner.invoke(
        cli.app,
        [
            "compare",
            "--tickers", "AAPL,MSFT,NVDA",
            "--start", "2020-01-01",
            "--end", "2021-12-31",
            "--synthetic",
        ],
    )
    assert result.exit_code == 0, _failure_details(result)
    assert "SYNTHETIC" in result.output
    for name in cli.ALL_STRATEGIES:
        assert name in result.output


def test_compare_synthetic_rejects_weekend_only_range(monkeypatch) -> None:
    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("get_prices must not be called with --synthetic")

    monkeypatch.setattr(cli, "get_prices", _must_not_be_called)
    # 2021-01-02 is a Saturday, so the range contains no business days; the
    # command must fail with a message rather than a traceback.
    result = runner.invoke(
        cli.app,
        [
            "compare",
            "--tickers", "AAPL,MSFT",
            "--start", "2021-01-02",
            "--end", "2021-01-02",
            "--synthetic",
        ],
    )
    assert result.exit_code == 1
    assert "no business days" in result.output
