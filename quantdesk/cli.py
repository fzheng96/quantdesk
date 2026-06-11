"""Command-line interface for QuantDesk.

Wires the data, strategy, risk, backtest, broker, and reporting modules into
a small set of research commands. Everything here operates on historical data
or a local paper-trading ledger; by construction there is no path to a live
brokerage account anywhere in this codebase.

All reported figures come from simulated trading under assumed costs and are
not investment advice.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
import typer
from rich.console import Console
from rich.table import Table

from quantdesk.backtest import run_backtest
from quantdesk.broker import PaperBroker, suggest_orders
from quantdesk.data import DEFAULT_CACHE_PATH, DataError, get_prices
from quantdesk.report import render_tearsheet
from quantdesk.risk import vol_target
from quantdesk.strategies import ALL_STRATEGIES

app = typer.Typer(
    help=(
        "QuantDesk: backtesting and paper-trading research tools. "
        "All output is simulated; nothing here is investment advice."
    ),
    no_args_is_help=True,
)
console = Console()

# Twenty liquid US megacaps. Tickers are stored in their plain exchange
# spelling; the data layer owns any venue-specific mapping (Stooq wants
# lowercase with a .us suffix, e.g. BRK-B becomes brk-b.us).
DEFAULT_UNIVERSE: tuple[str, ...] = (
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B", "JPM", "V",
    "UNH", "XOM", "LLY", "PG", "MA", "HD", "COST", "ABBV", "CRM", "KO",
)
BENCHMARK_TICKER = "SPY"
DEFAULT_START = "2015-01-01"
# Like the price cache, the ledger path is relative to the current working
# directory: running from elsewhere starts a fresh ledger. paper-status
# prints the resolved path so a vanished portfolio is explainable.
DEFAULT_DB_PATH = "data/paper.sqlite"
DEMO_REPORT_PATH = Path("reports") / "demo.html"

_DISCLAIMER_LINE = (
    "Figures are net of assumed commission and slippage. "
    "Simulated results; not investment advice."
)

_SYNTHETIC_BANNER = (
    "SYNTHETIC DATA: prices below are seeded random walks, not market data. "
    "Every figure derived from them is meaningless as research."
)

# Display order for metric tables; _metric_summary must produce exactly these keys.
_METRIC_LABELS = ("CAGR", "Ann. vol", "Sharpe", "Sortino", "Max DD", "Calmar", "Hit rate")


def _parse_date(value: str, param: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise typer.BadParameter(
            f"{param} must be an ISO date (YYYY-MM-DD); got {value!r}."
        ) from exc


def _parse_range(start: str, end: Optional[str]) -> tuple[dt.date, dt.date]:
    """Parse and validate a date range; a missing end defaults to today."""
    start_date = _parse_date(start, "--start")
    end_date = _parse_date(end, "--end") if end else dt.date.today()
    if start_date > end_date:
        raise typer.BadParameter(
            f"--start {start_date} is after the end of the range ({end_date})."
        )
    return start_date, end_date


def _parse_tickers(raw: Optional[str]) -> list[str]:
    """Split a comma- or space-separated ticker list, defaulting to the built-in universe."""
    if raw is None:
        return list(DEFAULT_UNIVERSE)
    parts = [piece.strip().upper() for chunk in raw.split(",") for piece in chunk.split()]
    tickers = list(dict.fromkeys(part for part in parts if part))
    if not tickers:
        raise typer.BadParameter("Expected at least one ticker.")
    return tickers


def _resolve_strategy(name: str) -> str:
    key = name.strip().lower()
    if key not in ALL_STRATEGIES:
        known = ", ".join(sorted(ALL_STRATEGIES))
        raise typer.BadParameter(f"Unknown strategy {name!r}. Available strategies: {known}.")
    return key


def _fetch_close_prices(tickers: list[str], start: dt.date, end: dt.date) -> pd.DataFrame:
    """Load close prices, raising DataError when nothing usable comes back."""
    frame = get_prices(tickers, start, end)
    if frame.empty:
        raise DataError("no price data returned for the requested range")
    return frame


def _load_close_prices(tickers: list[str], start: dt.date, end: dt.date) -> pd.DataFrame:
    try:
        return _fetch_close_prices(tickers, start, end)
    except DataError as exc:
        console.print(f"[red]Data error:[/red] {exc}")
        raise typer.Exit(code=1) from exc


def _fetch_universe(
    tickers: list[str], start: dt.date, end: dt.date
) -> tuple[pd.DataFrame, Optional[pd.Series]]:
    """Load close prices for the tickers plus the benchmark, raising DataError on failure."""
    requested = list(dict.fromkeys([*tickers, BENCHMARK_TICKER]))
    frame = _fetch_close_prices(requested, start, end)
    available = [t for t in tickers if t in frame.columns]
    missing = [t for t in tickers if t not in frame.columns]
    if missing:
        console.print(f"[yellow]No data for: {', '.join(missing)}[/yellow]")
    if not available:
        raise DataError("none of the requested tickers returned data")
    prices = frame[available]
    benchmark = frame[BENCHMARK_TICKER] if BENCHMARK_TICKER in frame.columns else None
    return prices, benchmark


def _load_universe(
    tickers: list[str], start: dt.date, end: dt.date
) -> tuple[pd.DataFrame, Optional[pd.Series]]:
    """Like _fetch_universe, but reports a DataError and exits with code 1."""
    try:
        return _fetch_universe(tickers, start, end)
    except DataError as exc:
        console.print(f"[red]Data error:[/red] {exc}")
        raise typer.Exit(code=1) from exc


def _synthetic_universe(
    tickers: list[str], start: dt.date, end: dt.date, seed: int = 7
) -> tuple[pd.DataFrame, pd.Series]:
    """Seeded geometric random walks standing in for real close prices.

    Used only when the caller explicitly asked for synthetic data or the
    data source is unreachable. Every code path that consumes this output
    must label it loudly, because the numbers carry no information about
    real markets.
    """
    index = pd.bdate_range(start, end)
    if len(index) < 2:
        raise ValueError(f"no business days between {start} and {end}")
    rng = np.random.default_rng(seed)
    count = len(tickers) + 1
    drifts = rng.uniform(0.0001, 0.0006, size=count)
    vols = rng.uniform(0.010, 0.025, size=count)
    steps = drifts + vols * rng.standard_normal((len(index), count))
    steps[0] = 0.0
    levels = 100.0 * np.exp(np.cumsum(steps, axis=0))
    prices = pd.DataFrame(levels[:, :-1], index=index, columns=list(tickers))
    benchmark = pd.Series(levels[:, -1], index=index, name=BENCHMARK_TICKER)
    return prices, benchmark


def _load_synthetic_universe(
    tickers: list[str], start: dt.date, end: dt.date
) -> tuple[pd.DataFrame, pd.Series]:
    """Like _synthetic_universe, but reports a too-short range and exits with code 1."""
    try:
        return _synthetic_universe(tickers, start, end)
    except ValueError as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise typer.Exit(code=1) from exc


def _run_strategy(
    key: str,
    prices: pd.DataFrame,
    benchmark: Optional[pd.Series],
    use_vol_target: bool,
) -> Any:
    strategy = ALL_STRATEGIES[key]()
    try:
        weights = strategy.generate_weights(prices)
        if use_vol_target:
            weights = vol_target(weights, prices)
        return run_backtest(prices, weights, benchmark_prices=benchmark)
    except ValueError as exc:
        # The engine and overlays reject inputs they cannot simulate honestly
        # (for example, price gaps that would otherwise be flattened into
        # zero returns); report that instead of letting a traceback escape.
        console.print(f"[red]Error:[/red] {exc}")
        raise typer.Exit(code=1) from exc


def _fmt_pct(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.2%}"
    except (TypeError, ValueError):
        return str(value)


def _fmt_num(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def _metric_summary(result: Any) -> dict[str, str]:
    """Format the documented BacktestResult metrics keys into display strings.

    The key names and the positive-fraction drawdown convention are pinned
    down by the BacktestResult docstring; a missing key renders as n/a.
    """
    metrics = result.metrics
    return {
        "CAGR": _fmt_pct(metrics.get("cagr")),
        "Ann. vol": _fmt_pct(metrics.get("ann_vol")),
        "Sharpe": _fmt_num(metrics.get("sharpe")),
        "Sortino": _fmt_num(metrics.get("sortino")),
        "Max DD": _fmt_pct(metrics.get("max_drawdown")),
        "Calmar": _fmt_num(metrics.get("calmar")),
        "Hit rate": _fmt_pct(metrics.get("hit_rate")),
    }


def _comparison_table(
    prices: pd.DataFrame, benchmark: Optional[pd.Series], title: str
) -> Table:
    table = Table(title=title)
    table.add_column("Strategy")
    for label in _METRIC_LABELS:
        table.add_column(label, justify="right")
    for key in sorted(ALL_STRATEGIES):
        result = _run_strategy(key, prices, benchmark, use_vol_target=False)
        summary = _metric_summary(result)
        table.add_row(key, *(summary[label] for label in _METRIC_LABELS))
    return table


def _latest_targets(
    key: str, prices: pd.DataFrame
) -> tuple[dict[str, float], dict[str, float], Any]:
    """Return the strategy's final-row target weights, the latest closes, and the as-of date."""
    strategy = ALL_STRATEGIES[key]()
    weights = strategy.generate_weights(prices).fillna(0.0)
    as_of = weights.index[-1]
    last_prices = prices.iloc[-1]
    latest_prices = {
        str(sym): float(px) for sym, px in last_prices.items() if pd.notna(px)
    }
    targets = {
        str(sym): float(weight)
        for sym, weight in weights.iloc[-1].items()
        if str(sym) in latest_prices
    }
    return targets, latest_prices, as_of


def _print_weights(targets: dict[str, float], as_of: Any) -> None:
    as_of_label = as_of.date() if hasattr(as_of, "date") else as_of
    nonzero = {sym: w for sym, w in targets.items() if w != 0.0}
    if not nonzero:
        console.print(f"Target weights as of {as_of_label}: all zero (no current signal).")
        return
    table = Table(title=f"Target weights as of {as_of_label}")
    table.add_column("Ticker")
    table.add_column("Weight", justify="right")
    for sym, weight in sorted(nonzero.items(), key=lambda item: -abs(item[1])):
        table.add_row(sym, _fmt_pct(weight))
    console.print(table)


def _print_orders(orders: list, latest_prices: dict[str, float]) -> None:
    if not orders:
        console.print("No rebalancing orders suggested; portfolio already matches targets.")
        return
    table = Table(title="Suggested paper orders")
    table.add_column("Symbol")
    table.add_column("Side")
    table.add_column("Qty", justify="right")
    table.add_column("Last close", justify="right")
    table.add_column("Approx. notional", justify="right")
    for order in orders:
        price = latest_prices.get(order.symbol)
        notional = abs(order.qty) * price if price is not None else None
        table.add_row(
            order.symbol,
            order.side,
            f"{order.qty:,.4f}",
            f"{price:,.2f}" if price is not None else "n/a",
            f"{notional:,.2f}" if notional is not None else "n/a",
        )
    console.print(table)


def _require_priced_holdings(
    held: dict[str, float], latest_prices: dict[str, float], hint: str
) -> None:
    """Exit with an actionable message when a held symbol has no price.

    Valuing the book requires a price for every held symbol; reaching
    broker.account() without one would raise a bare ValueError.
    """
    unpriced = sorted(set(held) - set(latest_prices))
    if unpriced:
        console.print(
            f"[red]Error:[/red] the paper ledger holds "
            f"{', '.join(unpriced)} but no price is available for "
            f"{'it' if len(unpriced) == 1 else 'them'}. {hint}"
        )
        raise typer.Exit(code=1)


def _scan_targets(
    strategy: str, tickers: Optional[str], start: str, db: str
) -> tuple[Any, list, dict[str, float]]:
    """Shared body of scan and paper-apply: compute targets and the rebalance orders."""
    key = _resolve_strategy(strategy)
    start_date, end_date = _parse_range(start, None)
    prices, _ = _load_universe(_parse_tickers(tickers), start_date, end_date)
    targets, latest_prices, as_of = _latest_targets(key, prices)
    _print_weights(targets, as_of)
    broker = PaperBroker(db_path=db)
    _require_priced_holdings(
        broker.positions(),
        latest_prices,
        "Include the held symbols in --tickers, or omit --tickers to scan "
        "the full universe.",
    )
    account = broker.account(latest_prices)
    orders = suggest_orders(broker.positions(), targets, latest_prices, account.equity)
    return broker, orders, latest_prices


@app.command()
def fetch(
    tickers: Optional[list[str]] = typer.Argument(
        None, help="Tickers to fetch; defaults to the built-in universe plus the SPY benchmark."
    ),
    start: str = typer.Option(DEFAULT_START, "--start", help="Start date, YYYY-MM-DD."),
    end: Optional[str] = typer.Option(None, "--end", help="End date, YYYY-MM-DD; defaults to today."),
) -> None:
    """Download daily close prices into the local cache and summarize coverage."""
    start_date, end_date = _parse_range(start, end)
    if tickers:
        requested = list(dict.fromkeys(t.upper() for t in tickers))
    else:
        requested = [*DEFAULT_UNIVERSE, BENCHMARK_TICKER]
    frame = _load_close_prices(requested, start_date, end_date)
    table = Table(title=f"Close prices {start_date} to {end_date}")
    table.add_column("Ticker")
    table.add_column("First", justify="right")
    table.add_column("Last", justify="right")
    table.add_column("Rows", justify="right")
    for ticker in requested:
        column = frame[ticker].dropna() if ticker in frame.columns else None
        if column is not None and not column.empty:
            table.add_row(
                ticker,
                str(column.index[0].date()),
                str(column.index[-1].date()),
                str(len(column)),
            )
        else:
            table.add_row(ticker, "-", "-", "0")
    console.print(table)
    # The cache path is relative to the working directory, so a run from
    # elsewhere fills a different cache; printing the resolved path makes
    # that visible.
    console.print(f"Cache: {DEFAULT_CACHE_PATH.resolve()}")


@app.command()
def backtest(
    strategy: str = typer.Option(
        "tsmom", "--strategy", help=f"One of: {', '.join(sorted(ALL_STRATEGIES))}."
    ),
    tickers: Optional[str] = typer.Option(
        None, "--tickers", help="Comma-separated tickers; defaults to the built-in universe."
    ),
    start: str = typer.Option(DEFAULT_START, "--start", help="Start date, YYYY-MM-DD."),
    end: Optional[str] = typer.Option(None, "--end", help="End date, YYYY-MM-DD; defaults to today."),
    use_vol_target: bool = typer.Option(
        False,
        "--vol-target/--no-vol-target",
        help="Scale weights toward a 10% annualized volatility target (no lookahead).",
    ),
    report: Optional[Path] = typer.Option(
        None, "--report", help="Write a self-contained HTML tearsheet to this path."
    ),
) -> None:
    """Backtest one strategy net of commission and slippage, against the SPY benchmark."""
    key = _resolve_strategy(strategy)
    start_date, end_date = _parse_range(start, end)
    prices, benchmark = _load_universe(_parse_tickers(tickers), start_date, end_date)
    result = _run_strategy(key, prices, benchmark, use_vol_target)
    table = Table(title=f"{key}: {len(prices.columns)} assets, {start_date} to {end_date}")
    table.add_column("Metric")
    table.add_column("Value", justify="right")
    for label, value in _metric_summary(result).items():
        table.add_row(label, value)
    console.print(table)
    console.print(_DISCLAIMER_LINE)
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        render_tearsheet(result, str(report), title=f"{key} backtest")
        console.print(f"Tearsheet written to {report}")


@app.command()
def compare(
    tickers: Optional[str] = typer.Option(
        None, "--tickers", help="Comma-separated tickers; defaults to the built-in universe."
    ),
    start: str = typer.Option(DEFAULT_START, "--start", help="Start date, YYYY-MM-DD."),
    end: Optional[str] = typer.Option(None, "--end", help="End date, YYYY-MM-DD; defaults to today."),
    synthetic: bool = typer.Option(
        False,
        "--synthetic",
        help=(
            "Use seeded random-walk data instead of fetching real prices. "
            "Output is loudly labeled and useful only as an offline smoke run."
        ),
    ),
) -> None:
    """Run every registered strategy on the same data and tabulate results net of costs."""
    start_date, end_date = _parse_range(start, end)
    if synthetic:
        console.print(f"[bold red]{_SYNTHETIC_BANNER}[/bold red]")
        prices, benchmark = _load_synthetic_universe(_parse_tickers(tickers), start_date, end_date)
        title = (
            f"Strategy comparison (SYNTHETIC DATA): "
            f"{len(prices.columns)} assets, {start_date} to {end_date}"
        )
    else:
        prices, benchmark = _load_universe(_parse_tickers(tickers), start_date, end_date)
        title = f"Strategy comparison: {len(prices.columns)} assets, {start_date} to {end_date}"
    console.print(_comparison_table(prices, benchmark, title))
    console.print(_DISCLAIMER_LINE)


@app.command()
def scan(
    strategy: str = typer.Option(
        "tsmom", "--strategy", help=f"One of: {', '.join(sorted(ALL_STRATEGIES))}."
    ),
    tickers: Optional[str] = typer.Option(
        None, "--tickers", help="Comma-separated tickers; defaults to the built-in universe."
    ),
    start: str = typer.Option(
        DEFAULT_START, "--start", help="History start date; strategies need enough lookback."
    ),
    db: str = typer.Option(DEFAULT_DB_PATH, "--db", help="Paper-broker ledger path."),
) -> None:
    """Show the latest target weights and the paper orders that would rebalance into them.

    This only prints suggestions; use paper-apply to execute them against the
    local paper broker.
    """
    _, orders, latest_prices = _scan_targets(strategy, tickers, start, db)
    _print_orders(orders, latest_prices)


@app.command("paper-apply")
def paper_apply(
    strategy: str = typer.Option(
        "tsmom", "--strategy", help=f"One of: {', '.join(sorted(ALL_STRATEGIES))}."
    ),
    tickers: Optional[str] = typer.Option(
        None, "--tickers", help="Comma-separated tickers; defaults to the built-in universe."
    ),
    start: str = typer.Option(
        DEFAULT_START, "--start", help="History start date; strategies need enough lookback."
    ),
    db: str = typer.Option(DEFAULT_DB_PATH, "--db", help="Paper-broker ledger path."),
) -> None:
    """Execute the suggested rebalance against the local paper broker at the latest close.

    Fills are simulated with slippage applied against you; no real orders are
    placed anywhere.
    """
    broker, orders, latest_prices = _scan_targets(strategy, tickers, start, db)
    if not orders:
        console.print("Portfolio already matches targets; nothing to apply.")
        return
    table = Table(title="Paper fills")
    table.add_column("Symbol")
    table.add_column("Side")
    table.add_column("Qty", justify="right")
    table.add_column("Fill price", justify="right")
    table.add_column("Cost", justify="right")
    for order in orders:
        fill = broker.submit(order, price=latest_prices[order.symbol])
        table.add_row(
            fill.symbol,
            fill.side,
            f"{fill.qty:,.4f}",
            f"{fill.price:,.2f}",
            f"{fill.cost:,.2f}",
        )
    console.print(table)
    account = broker.account(latest_prices)
    console.print(f"Cash: ${account.cash:,.2f}  Equity: ${account.equity:,.2f}")


@app.command("paper-status")
def paper_status(
    db: str = typer.Option(DEFAULT_DB_PATH, "--db", help="Paper-broker ledger path."),
) -> None:
    """Show paper-broker cash, equity, open positions, and recent fills."""
    # The resolved path explains a "vanished" portfolio: the ledger default
    # is relative to the working directory, so each directory has its own.
    console.print(f"Ledger: {Path(db).resolve()}")
    broker = PaperBroker(db_path=db)
    positions = broker.positions()
    latest_prices: dict[str, float] = {}
    if positions:
        # Positions are marked at the most recent cached close; a short window
        # is enough to find one without refetching full history.
        end_date = dt.date.today()
        frame = _load_close_prices(sorted(positions), end_date - dt.timedelta(days=30), end_date)
        latest_prices = {
            str(sym): float(px) for sym, px in frame.iloc[-1].items() if pd.notna(px)
        }
        _require_priced_holdings(
            positions,
            latest_prices,
            "The cache has no close in the last 30 days for those symbols; "
            "run `quantdesk fetch` to refresh it.",
        )
    account = broker.account(latest_prices)
    console.print(f"Cash: ${account.cash:,.2f}")
    console.print(f"Equity: ${account.equity:,.2f}")
    if positions:
        table = Table(title="Open positions")
        table.add_column("Symbol")
        table.add_column("Qty", justify="right")
        table.add_column("Last close", justify="right")
        table.add_column("Value", justify="right")
        for symbol in sorted(positions):
            qty = positions[symbol]
            price = latest_prices.get(symbol)
            value = qty * price if price is not None else None
            table.add_row(
                symbol,
                f"{qty:,.4f}",
                f"{price:,.2f}" if price is not None else "n/a",
                f"{value:,.2f}" if value is not None else "n/a",
            )
        console.print(table)
    else:
        console.print("No open positions.")
    fills = broker.history()
    if fills:
        table = Table(title=f"Last {min(len(fills), 10)} fills")
        table.add_column("Timestamp")
        table.add_column("Symbol")
        table.add_column("Side")
        table.add_column("Qty", justify="right")
        table.add_column("Price", justify="right")
        for fill in fills[-10:]:
            table.add_row(
                str(fill.timestamp),
                fill.symbol,
                fill.side,
                f"{fill.qty:,.4f}",
                f"{fill.price:,.2f}",
            )
        console.print(table)


@app.command()
def demo(
    start: str = typer.Option(DEFAULT_START, "--start", help="Start date, YYYY-MM-DD."),
) -> None:
    """Run the full pipeline on the default universe and write reports/demo.html.

    Fetches data, compares every strategy net of costs, then renders a
    tearsheet for volatility-targeted time-series momentum. When the data
    source is unreachable, the demo finishes on loudly labeled synthetic
    random walks instead of failing.
    """
    start_date, end_date = _parse_range(start, None)
    console.print(
        f"Fetching {len(DEFAULT_UNIVERSE)} tickers plus {BENCHMARK_TICKER} "
        f"from {start_date} to {end_date}..."
    )
    benchmark: Optional[pd.Series]
    try:
        prices, benchmark = _fetch_universe(list(DEFAULT_UNIVERSE), start_date, end_date)
        synthetic = False
    except DataError as exc:
        console.print(f"[red]Data error:[/red] {exc}")
        console.print(
            "[bold red]Falling back to synthetic data so the demo can "
            f"finish. {_SYNTHETIC_BANNER}[/bold red]"
        )
        prices, benchmark = _load_synthetic_universe(list(DEFAULT_UNIVERSE), start_date, end_date)
        synthetic = True
    label = " (SYNTHETIC DATA)" if synthetic else ""
    title = f"Strategy comparison{label}: default universe, {start_date} to {end_date}"
    console.print(_comparison_table(prices, benchmark, title))
    result = _run_strategy("tsmom", prices, benchmark, use_vol_target=True)
    DEMO_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    render_tearsheet(
        result,
        str(DEMO_REPORT_PATH),
        title=f"QuantDesk demo{label}: time-series momentum, 10% vol target",
    )
    console.print(f"Tearsheet written to {DEMO_REPORT_PATH}")
    if synthetic:
        console.print(f"[bold red]{_SYNTHETIC_BANNER}[/bold red]")
    console.print(_DISCLAIMER_LINE)


if __name__ == "__main__":
    app()
