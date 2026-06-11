"""Risk overlays applied to strategy weights and equity curves.

Every function in this module is a pure transformation: weights, prices, or
an equity curve go in, adjusted weights or an exposure multiplier come out.
Nothing here places orders or touches the network. The overlays respect the
engine convention from SPEC.md (a weight decided at the close of day t earns
day t + 1 returns), and volatility targeting additionally lags its estimate
by one day so that no multiplier depends on the return of the day it is
applied to.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS_PER_YEAR = 252


def vol_target(
    weights: pd.DataFrame,
    prices: pd.DataFrame,
    target_annual_vol: float = 0.10,
    lookback: int = 20,
    max_leverage: float = 1.0,
) -> pd.DataFrame:
    """Scale daily weights so the strategy targets a constant annualized volatility.

    The strategy's gross daily returns are reconstructed under the engine
    convention (weights shifted one day before earning returns). Realized
    volatility is the rolling ``lookback``-day standard deviation of those
    gross returns, annualized with sqrt(252). The multiplier for day t is
    ``target_annual_vol`` divided by the realized volatility measured through
    day t - 1; the extra one-day shift guarantees the multiplier never uses
    the return of the day it is applied to. Multipliers are clipped at
    ``max_leverage``. During the warm-up period, before a full lookback
    window of returns exists, weights pass through scaled by
    min(1.0, max_leverage).

    Limitations stated honestly: the estimate is backward looking, so the
    overlay reacts to volatility spikes only after they have begun, and it
    raises exposure in calm markets, which is exactly when crowded strategies
    are most vulnerable to a regime change. The volatility is measured on the
    unscaled strategy in a single pass, so the scaled strategy hits the
    target only approximately, not exactly.
    """
    if target_annual_vol <= 0:
        raise ValueError("target_annual_vol must be positive")
    if lookback < 2:
        raise ValueError("lookback must be at least 2 to compute a standard deviation")
    if max_leverage <= 0:
        raise ValueError("max_leverage must be positive")
    if not weights.index.equals(prices.index):
        raise ValueError("weights and prices must share the same index")
    if set(weights.columns) != set(prices.columns):
        raise ValueError("weights and prices must cover the same assets")

    aligned_prices = prices[weights.columns]
    rets = aligned_prices.pct_change()
    gross = weights.shift(1).fillna(0.0).mul(rets).sum(axis=1)
    realized = gross.rolling(lookback).std() * np.sqrt(TRADING_DAYS_PER_YEAR)
    # The shift keeps the multiplier for day t a function of returns through
    # day t - 1 only. Where realized volatility is zero the raw ratio is
    # infinite, and the clip below maps it to max_leverage.
    scale = (target_annual_vol / realized).shift(1)
    scale = scale.clip(upper=max_leverage)
    scale = scale.fillna(min(1.0, max_leverage))
    return weights.mul(scale, axis=0)


def cap_weights(weights: pd.DataFrame, max_weight: float = 0.25) -> pd.DataFrame:
    """Cap each position's absolute weight, then enforce gross exposure of at most 1.

    Each weight is clipped into [-max_weight, max_weight]. If a row's gross
    exposure (the sum of absolute weights) still exceeds 1.0 after clipping,
    the whole row is scaled down proportionally to bring it back to 1.0.
    Renormalization only ever moves weights downward: exposure removed by the
    cap is not redistributed to other positions, and rows are never scaled up
    to restore lost exposure, so every output weight is at most as large in
    magnitude as its input.
    """
    if max_weight <= 0:
        raise ValueError("max_weight must be positive")
    capped = weights.clip(lower=-max_weight, upper=max_weight)
    gross = capped.abs().sum(axis=1)
    factor = pd.Series(1.0, index=weights.index)
    over = gross > 1.0
    factor.loc[over] = 1.0 / gross.loc[over]
    return capped.mul(factor, axis=0)


def drawdown_guard(
    equity: pd.Series,
    threshold: float = 0.15,
    resume_at: float = 0.075,
) -> pd.Series:
    """Exposure multiplier that steps aside after a deep drawdown.

    Returns a series of 0.0/1.0 values aligned with ``equity``. The
    multiplier is 1.0 until the drawdown from the running equity peak
    strictly exceeds ``threshold``; it is then 0.0 until the drawdown falls
    back below ``resume_at``, at which point it returns to 1.0. The gap
    between the two levels is deliberate hysteresis that prevents rapid
    on/off flipping while the drawdown hovers near the threshold.

    The drawdown is measured on whatever equity series is passed in,
    normally the unguarded backtest equity, so while sidelined the guard
    watches how the strategy would have performed and re-enters on its
    hypothetical recovery.

    An honest caveat: this guard reduces risk and, often, long-run return as
    well. It exits only after losses are already realized and re-enters only
    after part of the rebound has happened, so in V-shaped recoveries it
    systematically sells low and rebuys higher. It earns its keep mainly in
    long, grinding drawdowns.
    """
    if threshold <= 0:
        raise ValueError("threshold must be positive")
    if not 0 < resume_at < threshold:
        raise ValueError("resume_at must be positive and strictly below threshold")
    if (equity <= 0).any():
        raise ValueError("equity must be strictly positive")

    drawdown = 1.0 - equity / equity.cummax()
    invested = True
    flags = np.empty(len(equity), dtype=float)
    for i, dd in enumerate(drawdown.to_numpy()):
        if invested and dd > threshold:
            invested = False
        elif not invested and dd < resume_at:
            invested = True
        flags[i] = 1.0 if invested else 0.0
    return pd.Series(flags, index=equity.index, name="exposure")
