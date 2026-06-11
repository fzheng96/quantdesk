"""Performance metrics for daily return and equity series.

Every function here is pure: no I/O, no hidden state, deterministic output
for a given input. Inputs are pandas Series; NaN observations are dropped
before computing. Annualization assumes the supplied series is sampled at
``periods_per_year`` per year (252 by default, the trading-day convention),
which is an approximation: it ignores calendar gaps, holidays, and the fact
that real return distributions are not i.i.d. normal. Treat annualized
figures as comparable summaries, not forecasts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import pandas as pd

TRADING_DAYS_PER_YEAR = 252


def _clean(series: pd.Series, func_name: str) -> pd.Series:
    """Drop NaNs and reject empty input, which has no meaningful statistics."""
    cleaned = series.dropna()
    if cleaned.empty:
        raise ValueError(f"{func_name} requires at least one non-NaN observation")
    return cleaned


def cagr(returns: pd.Series, periods_per_year: int = TRADING_DAYS_PER_YEAR) -> float:
    """Compound annual growth rate of a periodic return series.

    The elapsed time is measured by observation count divided by
    ``periods_per_year``, not by calendar dates, so a series with missing
    days is annualized as if those days never existed. If compounding wipes
    out the capital (total growth factor <= 0), -1.0 is returned, meaning
    a total loss; the true annualized figure is undefined in that case.
    """
    r = _clean(returns, "cagr")
    total = float((1.0 + r).prod())
    if total <= 0.0:
        return -1.0
    years = len(r) / periods_per_year
    return total ** (1.0 / years) - 1.0


def ann_vol(returns: pd.Series, periods_per_year: int = TRADING_DAYS_PER_YEAR) -> float:
    """Annualized volatility: sample standard deviation (ddof=1) scaled by sqrt(periods_per_year).

    Returns NaN for a single observation, where a sample standard deviation
    is undefined.
    """
    r = _clean(returns, "ann_vol")
    return float(r.std(ddof=1) * math.sqrt(periods_per_year))


def sharpe(returns: pd.Series, periods_per_year: int = TRADING_DAYS_PER_YEAR) -> float:
    """Annualized Sharpe ratio with a zero risk-free rate.

    Computed as mean / sample std (ddof=1), scaled by sqrt(periods_per_year).
    A constant series has zero volatility, so the ratio is returned as +inf
    for a positive mean, -inf for a negative mean, and NaN when the mean is
    also zero. A single observation returns NaN. Note that the Sharpe ratio
    penalizes upside and downside volatility equally and says nothing about
    tail risk.
    """
    r = _clean(returns, "sharpe")
    mean = float(r.mean())
    # A series of identical values has zero sample deviation by definition,
    # but the computed std can come back as float noise around 1e-19 because
    # the computed mean of n identical floats is not always bit-identical to
    # the value itself. Detecting the constant case explicitly keeps the
    # documented zero-volatility convention reachable.
    if (r.to_numpy() == r.iloc[0]).all():
        std = 0.0
    else:
        std = float(r.std(ddof=1))
    if math.isnan(std):
        return math.nan
    if std == 0.0:
        if mean > 0.0:
            return math.inf
        if mean < 0.0:
            return -math.inf
        return math.nan
    return mean / std * math.sqrt(periods_per_year)


def sortino(returns: pd.Series, periods_per_year: int = TRADING_DAYS_PER_YEAR) -> float:
    """Annualized Sortino ratio with a zero target return.

    The downside deviation is sqrt(mean(min(r, 0)^2)) over ALL observations,
    not just the negative ones; this is the full-sample convention, which
    yields lower (more conservative) downside deviation than averaging over
    losing periods only. Competing definitions exist, so do not compare this
    number against Sortino ratios computed elsewhere without checking the
    convention. A series with no negative returns gives +inf for a positive
    mean and NaN otherwise.
    """
    r = _clean(returns, "sortino")
    mean = float(r.mean())
    downside = r.clip(upper=0.0)
    downside_dev = math.sqrt(float((downside**2).mean()))
    if downside_dev == 0.0:
        return math.inf if mean > 0.0 else math.nan
    return mean / downside_dev * math.sqrt(periods_per_year)


@dataclass(frozen=True)
class MaxDrawdown:
    """Worst peak-to-trough decline of an equity curve.

    ``depth`` is the positive fraction lost from the peak (0.25 means a 25%
    decline). ``duration_days`` covers peak to trough only; it says nothing
    about how long recovery took, or whether the curve recovered at all.
    """

    depth: float
    peak: pd.Timestamp
    trough: pd.Timestamp
    duration_days: int


def max_drawdown(equity: pd.Series) -> MaxDrawdown:
    """Locate the maximum drawdown of an equity curve.

    Expects a strictly positive equity series with a unique, sorted index.
    With a DatetimeIndex, duration is measured in calendar days between the
    peak and the trough; otherwise it falls back to the number of index
    positions between them. If the curve never declines, depth is 0.0 and
    peak/trough both point at the first observation. Ties are broken by
    taking the earliest trough and the earliest peak preceding it.
    """
    eq = _clean(equity, "max_drawdown")
    drawdown = eq / eq.cummax() - 1.0
    trough = drawdown.idxmin()
    depth = -float(drawdown.min())
    peak = eq.loc[:trough].idxmax()
    if isinstance(eq.index, pd.DatetimeIndex):
        duration = int((trough - peak).days)
    else:
        duration = int(eq.index.get_loc(trough)) - int(eq.index.get_loc(peak))
    return MaxDrawdown(depth=depth, peak=peak, trough=trough, duration_days=duration)


def calmar(returns: pd.Series, periods_per_year: int = TRADING_DAYS_PER_YEAR) -> float:
    """Calmar ratio: CAGR divided by maximum drawdown depth.

    The equity curve is rebuilt from the return series by compounding.
    A series that never draws down (depth 0) gives +inf for positive growth
    and NaN for zero growth; negative growth always implies a nonzero
    drawdown, so that branch cannot occur. The ratio is highly sensitive to
    the single worst episode in the sample and is therefore noisy on short
    histories.
    """
    r = _clean(returns, "calmar")
    growth = cagr(r, periods_per_year)
    equity = (1.0 + r).cumprod()
    depth = max_drawdown(equity).depth
    if depth == 0.0:
        return math.inf if growth > 0.0 else math.nan
    return growth / depth


def hit_rate(returns: pd.Series) -> float:
    """Fraction of winning periods: wins / (wins + losses).

    Zero-return periods are excluded from both numerator and denominator so
    that stretches with no position (returns of exactly 0) do not distort
    the rate. Returns NaN when every period is zero. A high hit rate does
    not imply profitability: a strategy can win often and still lose money
    if losses are larger than gains.
    """
    r = _clean(returns, "hit_rate")
    wins = int((r > 0.0).sum())
    losses = int((r < 0.0).sum())
    total = wins + losses
    if total == 0:
        return math.nan
    return wins / total


def monthly_returns(returns: pd.Series) -> pd.DataFrame:
    """Compounded calendar-month returns as a years-by-months table.

    Requires a DatetimeIndex. The result has one row per calendar year and
    twelve columns labeled with month numbers 1 through 12; months with no
    observations are NaN. Partial months at the edges of the sample are
    compounded over whatever days exist, so first and last cells may cover
    far fewer than a full month.
    """
    r = _clean(returns, "monthly_returns")
    if not isinstance(r.index, pd.DatetimeIndex):
        raise TypeError("monthly_returns requires a Series with a DatetimeIndex")
    compounded = (1.0 + r).groupby([r.index.year, r.index.month]).prod() - 1.0
    table = compounded.unstack()
    table = table.reindex(columns=range(1, 13))
    table.index.name = "year"
    table.columns.name = "month"
    return table
