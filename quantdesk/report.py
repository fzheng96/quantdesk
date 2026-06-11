"""Self-contained HTML tearsheet rendering.

``render_tearsheet`` turns a backtest result into a single dark-themed HTML
file with inline CSS and hand-built inline SVG charts.  The output makes
zero external requests of any kind: no scripts, stylesheets, fonts, or
images are referenced, so the file can be archived, mailed, or opened
offline and will render identically years from now.

Honest limitations:

* Charts are static SVG with no tooltips, zoom, or other interactivity.
* All annualization assumes 252 daily bars per year; feeding intraday or
  non-daily results will produce misleading annualized figures.
* Headline numbers are computed by ``quantdesk.metrics`` from
  ``result.net_returns`` and ``result.equity`` — the same functions and
  conventions behind the CLI tables — rather than read from the
  ``result.metrics`` dict, so the page never depends on that dict's key
  naming.  Chart series (drawdown, rolling Sharpe) are derived locally
  from the same documented fields.
"""

from __future__ import annotations

import html
import math
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd

from quantdesk import metrics

# The import below is needed only by type checkers; at runtime the renderer
# is duck-typed against the documented BacktestResult fields, which keeps
# this module importable even if the backtest module is mid-refactor.
if TYPE_CHECKING:
    from quantdesk.backtest import BacktestResult

_TRADING_DAYS = 252
_ROLLING_WINDOW = 60
_MONTH_LABELS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

_COLOR_STRATEGY = "#5ab0f2"
_COLOR_BENCHMARK = "#9aa3b5"
_COLOR_DRAWDOWN = "#e0635e"
_COLOR_SHARPE = "#d8a657"
_POSITIVE_RGB = (47, 158, 88)
_NEGATIVE_RGB = (204, 74, 73)

_DISCLAIMER = (
    "This tearsheet is research output produced from simulated trading. "
    "Simulated performance is hypothetical: it reflects no actual positions, "
    "ignores taxes and borrowing constraints, models costs only "
    "approximately, and routinely overstates what live trading would have "
    "achieved. This document is not investment advice and not a "
    "recommendation to buy or sell any security."
)

_CSS = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #0e1117; color: #e7eaf0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  line-height: 1.5;
}
main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
header h1 { margin: 0 0 4px; font-size: 26px; font-weight: 650; }
header .meta { color: #8b93a7; font-size: 13px; margin: 0; }
section {
  margin-top: 24px; background: #171c26; border: 1px solid #262d3b;
  border-radius: 10px; padding: 18px 20px;
}
h2 {
  margin: 0 0 12px; font-size: 13px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: #aeb6c8;
}
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.card { background: #1d2330; border-radius: 8px; padding: 12px 14px; }
.card .label { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: #8b93a7; }
.card .value { font-size: 22px; font-weight: 650; margin-top: 2px; }
.card .sub { font-size: 11px; color: #8b93a7; margin-top: 2px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: #262d3b; stroke-width: 1; }
.zero { stroke: #8b93a7; stroke-width: 1; stroke-dasharray: 4 4; }
.tick { fill: #8b93a7; font-size: 11px; }
.legend { margin-bottom: 8px; font-size: 12px; color: #aeb6c8; }
.legend .key { margin-right: 16px; }
.legend .dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  margin-right: 6px; vertical-align: middle;
}
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
table.kv { width: auto; min-width: 320px; }
th, td { padding: 5px 8px; text-align: right; border: 1px solid #262d3b; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
.note, .empty { color: #8b93a7; font-size: 12px; }
.empty { font-style: italic; }
footer {
  margin-top: 28px; padding-top: 14px; border-top: 1px solid #262d3b;
  color: #8b93a7; font-size: 12px;
}
"""


def _finite(value: Any) -> bool:
    """Return True when the value converts to a finite float.

    The parameter is Any on purpose: callers pass plain floats, numpy
    scalars, and the None that pandas lookups can return.
    """
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _fmt_pct(value: Any, digits: int = 2) -> str:
    if not _finite(value):
        return "—"
    return f"{float(value) * 100:.{digits}f}%"


def _fmt_num(value: Any, digits: int = 2) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if math.isnan(number):
        return "—"
    # Sharpe, Sortino, and Calmar are defined as infinite in degenerate
    # cases (see quantdesk.metrics); show that rather than a dash so the
    # card matches the CLI table for the same run.
    if math.isinf(number):
        return "inf" if number > 0 else "-inf"
    return f"{number:.{digits}f}"


def _clean_series(series: pd.Series) -> pd.Series:
    """Drop NaNs, coerce to float, and ensure a DatetimeIndex.

    The engine contract promises a DatetimeIndex; the conversion here is a
    safety net for frames that arrive with string dates from a cache layer.
    """
    out = series.dropna().astype(float)
    if not isinstance(out.index, pd.DatetimeIndex):
        out = out.copy()
        out.index = pd.DatetimeIndex(out.index)
    return out


def _metric_value(metric: Callable[[pd.Series], float], series: pd.Series) -> float:
    """Apply a quantdesk.metrics function, mapping empty input to NaN.

    The metrics module raises on empty series because the statistics are
    undefined there; the tearsheet prefers to render a dash instead.
    """
    if series.empty:
        return float("nan")
    return float(metric(series))


def _drawdown_series(equity: pd.Series) -> pd.Series:
    if equity.empty:
        return pd.Series(dtype=float)
    return equity / equity.cummax() - 1.0


def _rolling_sharpe(net: pd.Series) -> pd.Series:
    if len(net) < _ROLLING_WINDOW:
        return pd.Series(dtype=float)
    mean = net.rolling(_ROLLING_WINDOW).mean()
    std = net.rolling(_ROLLING_WINDOW).std(ddof=1)
    rolling = mean / std * math.sqrt(_TRADING_DAYS)
    return rolling.replace([np.inf, -np.inf], np.nan).dropna()


def _rebase(series: pd.Series) -> pd.Series:
    """Rescale a curve to start at 1.0 so two curves compare fairly."""
    if series.empty or float(series.iloc[0]) == 0:
        return series
    return series / float(series.iloc[0])


def _svg_time_chart(
    series: Sequence[tuple[str, pd.Series, str]],
    *,
    y_fmt: Callable[[float], str],
    height: int = 280,
    fill_to_zero: bool = False,
    zero_line: bool = False,
) -> str:
    """Render one or more time series as a hand-built inline SVG line chart.

    The svg element deliberately omits the conventional xmlns attribute:
    its value is a URL, the rendered file must contain no protocol
    references, and browsers parse inline svg inside HTML correctly
    without it.  X positions are spaced by bar count rather than calendar
    time, the standard convention for daily charts because it removes
    weekend and holiday gaps.
    """
    width = 880
    margin_left, margin_right, margin_top, margin_bottom = 64, 14, 12, 32
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom

    cleaned: list[tuple[str, pd.Series, str]] = []
    for label, raw, color in series:
        values = raw.replace([np.inf, -np.inf], np.nan).dropna().astype(float)
        if not values.empty:
            cleaned.append((label, values, color))
    if not cleaned:
        return '<p class="empty">Not enough data to draw this chart.</p>'

    union = sorted({ts for _, s, _ in cleaned for ts in s.index})
    position = {ts: i for i, ts in enumerate(union)}
    n = len(union)

    stacked = np.concatenate([s.to_numpy() for _, s, _ in cleaned])
    lo = float(stacked.min())
    hi = float(stacked.max())
    if fill_to_zero or zero_line:
        lo = min(lo, 0.0)
        hi = max(hi, 0.0)
    if hi - lo <= 0:
        bump = abs(hi) * 0.1 if hi != 0 else 1.0
        lo -= bump
        hi += bump
    pad = (hi - lo) * 0.06
    y_lo = lo - pad
    y_hi = hi + pad

    def x_px(ts: pd.Timestamp) -> float:
        if n == 1:
            return margin_left + plot_w / 2
        return margin_left + position[ts] / (n - 1) * plot_w

    def y_px(value: float) -> float:
        return margin_top + (y_hi - value) / (y_hi - y_lo) * plot_h

    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        'preserveAspectRatio="xMidYMid meet">'
    ]
    for tick in np.linspace(lo, hi, 5):
        y = y_px(float(tick))
        parts.append(
            f'<line x1="{margin_left}" y1="{y:.1f}" '
            f'x2="{width - margin_right}" y2="{y:.1f}" class="grid"></line>'
        )
        parts.append(
            f'<text x="{margin_left - 8}" y="{y + 4:.1f}" text-anchor="end" '
            f'class="tick">{html.escape(y_fmt(float(tick)))}</text>'
        )
    for i in np.unique(np.linspace(0, n - 1, min(6, n)).round().astype(int)):
        ts = union[int(i)]
        parts.append(
            f'<text x="{x_px(ts):.1f}" y="{height - 8}" text-anchor="middle" '
            f'class="tick">{ts.strftime("%Y-%m")}</text>'
        )
    if zero_line and y_lo < 0.0 < y_hi:
        zero_y = y_px(0.0)
        parts.append(
            f'<line x1="{margin_left}" y1="{zero_y:.1f}" '
            f'x2="{width - margin_right}" y2="{zero_y:.1f}" class="zero"></line>'
        )
    for _, values, color in cleaned:
        points = [(x_px(ts), y_px(float(v))) for ts, v in values.items()]
        path_d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in points)
        if fill_to_zero and len(points) > 1:
            base_y = y_px(0.0)
            area_d = (
                f"{path_d} L{points[-1][0]:.1f} {base_y:.1f} "
                f"L{points[0][0]:.1f} {base_y:.1f} Z"
            )
            parts.append(
                f'<path d="{area_d}" fill="{color}" fill-opacity="0.3" '
                'stroke="none"></path>'
            )
        parts.append(
            f'<path d="{path_d}" fill="none" stroke="{color}" '
            'stroke-width="1.8" stroke-linejoin="round"></path>'
        )
    parts.append("</svg>")
    return "".join(parts)


def _legend(entries: Sequence[tuple[str, str]]) -> str:
    keys = "".join(
        f'<span class="key"><span class="dot" style="background:{color}">'
        f"</span>{html.escape(label)}</span>"
        for label, color in entries
    )
    return f'<div class="legend">{keys}</div>'


def _section(heading: str, body: str) -> str:
    return f"<section>\n<h2>{html.escape(heading)}</h2>\n{body}\n</section>"


def _metric_cards(cards: Sequence[tuple[str, str, str]]) -> str:
    rendered = ['<div class="cards">']
    for label, value, sub in cards:
        sub_html = f'<div class="sub">{html.escape(sub)}</div>' if sub else ""
        rendered.append(
            f'<div class="card"><div class="label">{html.escape(label)}</div>'
            f'<div class="value">{html.escape(value)}</div>{sub_html}</div>'
        )
    rendered.append("</div>")
    return "".join(rendered)


def _heat_style(value: float, max_abs: float) -> str:
    if max_abs <= 0:
        return ""
    intensity = min(abs(value) / max_abs, 1.0)
    r, g, b = _POSITIVE_RGB if value >= 0 else _NEGATIVE_RGB
    alpha = 0.10 + 0.65 * intensity
    return f"background-color:rgba({r},{g},{b},{alpha:.2f})"


def _monthly_heatmap(net: pd.Series) -> str:
    if net.empty:
        return '<p class="empty">Not enough data to build a monthly table.</p>'
    years = net.index.year
    months = net.index.month
    monthly = (1.0 + net).groupby([years, months]).prod() - 1.0
    grid = monthly.unstack().reindex(columns=range(1, 13))
    yearly = (1.0 + net).groupby(years).prod() - 1.0

    finite_values = grid.to_numpy(dtype=float)
    finite_values = finite_values[np.isfinite(finite_values)]
    max_abs = float(np.abs(finite_values).max()) if finite_values.size else 0.0

    header = (
        "<tr><th>Year</th>"
        + "".join(f"<th>{m}</th>" for m in _MONTH_LABELS)
        + "<th>Year Total</th></tr>"
    )
    rows = []
    for year in grid.index:
        cells = [f"<th>{int(year)}</th>"]
        for month in range(1, 13):
            value = grid.at[year, month]
            if _finite(value):
                cells.append(
                    f'<td style="{_heat_style(float(value), max_abs)}">'
                    f"{_fmt_pct(value, 1)}</td>"
                )
            else:
                cells.append("<td></td>")
        cells.append(f"<td>{_fmt_pct(yearly.get(year), 1)}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return f'<div class="scroll"><table>{header}{"".join(rows)}</table></div>'


def _turnover_block(turnover: pd.Series, costs: pd.Series) -> str:
    if turnover.empty:
        return '<p class="empty">No turnover data available.</p>'
    average = float(turnover.mean())
    rows = [
        ("Average daily turnover", _fmt_pct(average)),
        ("Median daily turnover", _fmt_pct(float(turnover.median()))),
        ("Annualized turnover", f"{_fmt_num(average * _TRADING_DAYS, 1)}×"),
    ]
    if not costs.empty:
        rows.append(
            ("Average daily cost", f"{_fmt_num(float(costs.mean()) * 1e4)} bps")
        )
        rows.append(("Total cost deducted", _fmt_pct(float(costs.sum()))))
    body = "".join(
        f"<tr><th>{html.escape(name)}</th><td>{html.escape(value)}</td></tr>"
        for name, value in rows
    )
    note = (
        '<p class="note">Total cost deducted is the simple sum of daily cost '
        "charges; the compounded impact on equity differs slightly.</p>"
    )
    return f'<table class="kv">{body}</table>{note}'


def render_tearsheet(result: BacktestResult, path: str, title: str) -> Path:
    """Write a fully self-contained HTML tearsheet for a backtest result.

    Sections: headline metric cards (CAGR, Sharpe, Sortino, max drawdown,
    Calmar, annualized volatility, hit rate), equity curve versus benchmark
    when one is present, drawdown area chart, rolling 60-day Sharpe,
    monthly-return heatmap, turnover and cost summary, and a disclaimer
    footer.  Everything is inline; the file makes no external requests and
    contains no URLs.  Parent directories of ``path`` are created when
    missing.  Returns the written path.
    """
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    net = _clean_series(result.net_returns)
    equity = _clean_series(result.equity)
    turnover = _clean_series(result.turnover)
    costs = _clean_series(result.costs)
    benchmark = (
        _clean_series(result.benchmark_equity)
        if result.benchmark_equity is not None
        else None
    )

    if equity.empty:
        depth: float = float("nan")
        drawdown_sub = ""
    else:
        worst = metrics.max_drawdown(equity)
        # The depth is a positive fraction lost from the peak, matching the
        # CLI table; the drawdown chart below still plots negative values.
        depth = worst.depth
        drawdown_sub = ""
        if depth > 0:
            drawdown_sub = (
                f"{worst.peak.date()} to {worst.trough.date()}, "
                f"{worst.duration_days} days"
            )
    cards = [
        ("CAGR", _fmt_pct(_metric_value(metrics.cagr, net)), ""),
        ("Sharpe", _fmt_num(_metric_value(metrics.sharpe, net)), "rf = 0"),
        ("Sortino", _fmt_num(_metric_value(metrics.sortino, net)), ""),
        ("Max Drawdown", _fmt_pct(depth), drawdown_sub),
        ("Calmar", _fmt_num(_metric_value(metrics.calmar, net)), ""),
        ("Ann. Vol", _fmt_pct(_metric_value(metrics.ann_vol, net)), ""),
        (
            "Hit Rate",
            _fmt_pct(_metric_value(metrics.hit_rate, net)),
            "wins / (wins + losses), flat days excluded",
        ),
    ]

    # Both curves are rebased to 1.0 over the overlapping window so the
    # comparison is apples-to-apples regardless of input scaling.
    equity_specs: list[tuple[str, pd.Series, str]] = [
        ("Strategy", _rebase(equity), _COLOR_STRATEGY)
    ]
    if benchmark is not None and not benchmark.empty and not equity.empty:
        window = benchmark.loc[
            (benchmark.index >= equity.index[0])
            & (benchmark.index <= equity.index[-1])
        ]
        window = _rebase(window)
        if not window.empty:
            equity_specs.append(("Benchmark", window, _COLOR_BENCHMARK))
    has_benchmark = len(equity_specs) > 1
    equity_heading = "Equity Curve vs Benchmark" if has_benchmark else "Equity Curve"
    equity_body = _legend(
        [(label, color) for label, _, color in equity_specs]
    ) + _svg_time_chart(equity_specs, y_fmt=lambda v: f"{v:.2f}", height=300)

    drawdown_body = _svg_time_chart(
        [("Drawdown", _drawdown_series(equity), _COLOR_DRAWDOWN)],
        y_fmt=lambda v: f"{v * 100:.0f}%",
        height=220,
        fill_to_zero=True,
    )
    rolling_body = _svg_time_chart(
        [("Rolling Sharpe", _rolling_sharpe(net), _COLOR_SHARPE)],
        y_fmt=lambda v: f"{v:.1f}",
        height=220,
        zero_line=True,
    )

    sections = [
        _section("Headline Metrics", _metric_cards(cards)),
        _section(equity_heading, equity_body),
        _section("Drawdown", drawdown_body),
        _section(f"Rolling {_ROLLING_WINDOW}-Day Sharpe", rolling_body),
        _section("Monthly Returns", _monthly_heatmap(net)),
        _section("Turnover and Costs", _turnover_block(turnover, costs)),
    ]

    if net.empty:
        meta = "no data"
    else:
        meta = (
            f"{net.index[0].date()} to {net.index[-1].date()} · "
            f"{len(net)} trading days"
        )
    safe_title = html.escape(title)
    document = (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{safe_title}</title>\n"
        f"<style>{_CSS}</style>\n"
        "</head>\n<body>\n<main>\n"
        f"<header>\n<h1>{safe_title}</h1>\n"
        f'<p class="meta">{html.escape(meta)}</p>\n</header>\n'
        + "\n".join(sections)
        + f"\n<footer><p>{_DISCLAIMER}</p></footer>\n</main>\n</body>\n</html>\n"
    )
    out_path.write_text(document, encoding="utf-8")
    return out_path
