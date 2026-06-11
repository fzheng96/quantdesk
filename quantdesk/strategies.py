"""Trading strategies and the Strategy protocol.

Every strategy maps a wide close-price frame (columns are tickers, rows are an
ascending DatetimeIndex) to a weight frame with the same index and columns.
The shared timing convention: the weight in row t may use information up to
and including t only. The backtest engine applies that weight from t+1, so
strategies must not shift their own output. All strategies here are long-only
and keep the row-wise sum of absolute weights at or below 1.0; days without a
qualifying signal simply hold cash. Window parameters are in trading days.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np
import pandas as pd

__all__ = [
    "Strategy",
    "TimeSeriesMomentum",
    "CrossSectionalMomentum",
    "MeanReversion",
    "DualMovingAverage",
    "ALL_STRATEGIES",
]


@runtime_checkable
class Strategy(Protocol):
    """Contract every strategy implements.

    ``generate_weights`` must return a frame with the same index and columns
    as ``prices``, where row t is computed from prices up to and including t
    only, and the row-wise sum of absolute weights never exceeds 1.0.
    """

    name: str

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame:
        """Map close prices to target portfolio weights."""
        ...


def _window_return(prices: pd.DataFrame, lookback: int, skip: int) -> pd.DataFrame:
    """Per-asset return over the window from ``lookback`` days ago to ``skip`` days ago.

    Both endpoints lie at or before the current row, so the measure is free of
    lookahead by construction. Rows without enough history are NaN.
    """
    return prices.shift(skip) / prices.shift(lookback) - 1.0


def _zero_unpriced(weights: pd.DataFrame, prices: pd.DataFrame) -> pd.DataFrame:
    """Force weight 0 wherever the asset has no price on that day.

    A signal built purely from past prices can otherwise assign weight to an
    asset that is missing from today's data, which a real rebalance could not
    trade. This also guarantees the output contains no NaNs.
    """
    return weights.where(prices.notna(), 0.0)


@dataclass
class TimeSeriesMomentum:
    """Hold each asset whose own trailing return is positive, at a fixed 1/N.

    The momentum measure for row t is the return from t - lookback to t - skip;
    the skip gap sidesteps the well-documented one-month reversal in equities.
    Rationale: trends persist because information diffuses gradually and
    investors under-react, then herd. The effect is documented across asset
    classes and decades, which is why it is the default benchmark strategy here.

    Known failure modes: sharp V-shaped reversals (the strategy is still long
    after the peak and flat after the bottom), choppy sideways markets where
    the signal flips repeatedly and transaction costs compound, and parameter
    sensitivity — nearby lookbacks can produce noticeably different results,
    so a good backtest at (252, 21) is weak evidence by itself. Because each
    asset is sized at 1/N regardless of how many qualify, broad bear markets
    push the book toward cash, which protects capital but forfeits rebounds.
    """

    lookback: int = 252
    skip: int = 21
    name: str = field(init=False)

    def __post_init__(self) -> None:
        if self.skip < 0:
            raise ValueError("skip must be non-negative")
        if self.lookback <= self.skip:
            raise ValueError("lookback must be greater than skip")
        self.name = f"tsmom({self.lookback},{self.skip})"

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame:
        momentum = _window_return(prices, self.lookback, self.skip)
        n_assets = max(prices.shape[1], 1)
        weights = momentum.gt(0.0).astype(float) / n_assets
        return _zero_unpriced(weights, prices)


@dataclass
class CrossSectionalMomentum:
    """Equal-weight the ``top_n`` assets ranked by skip-adjusted momentum, long only.

    Assets are ranked each day by their return from t - lookback to t - skip
    and the best top_n are held at 1/top_n each. Rationale: relative strength
    among peers persists at the 3-to-12-month horizon (the classic
    cross-sectional momentum premium), and ranking strips out the common
    market component that dominates single-asset returns.

    Known failure modes: momentum crashes — after a market collapse the prior
    losers rally hardest and a momentum portfolio is positioned exactly wrong;
    because this variant is long only and always fully ranked, it stays
    invested through bear markets holding the least-bad losers rather than
    going to cash. Concentration in top_n names adds idiosyncratic risk, and
    turnover is high near rank boundaries, so costs matter. Position size is
    fixed at 1/top_n, so when fewer than top_n assets have enough history the
    remainder sits in cash instead of concentrating into the survivors. Ties
    are broken by column order, which is arbitrary.
    """

    lookback: int = 252
    skip: int = 21
    top_n: int = 5
    name: str = field(init=False)

    def __post_init__(self) -> None:
        if self.skip < 0:
            raise ValueError("skip must be non-negative")
        if self.lookback <= self.skip:
            raise ValueError("lookback must be greater than skip")
        if self.top_n < 1:
            raise ValueError("top_n must be at least 1")
        self.name = f"xsmom({self.lookback},{self.skip},{self.top_n})"

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame:
        momentum = _window_return(prices, self.lookback, self.skip)
        ranks = momentum.rank(axis=1, ascending=False, method="first")
        weights = ranks.le(self.top_n).astype(float) / self.top_n
        return _zero_unpriced(weights, prices)


@dataclass
class MeanReversion:
    """Buy short-term oversold assets and hold until the dislocation closes.

    For each asset the ``short_window`` return is converted to a z-score
    against its own trailing ``z_window`` history. A position opens when the
    z-score drops below ``entry_z`` and closes when it crosses above zero.
    Capital is split equally among the assets currently in a position, so the
    book is fully invested only while at least one signal is live. Rationale:
    at horizons of a few days, liquidity demand and overreaction push prices
    away from fair value, and that pressure tends to revert.

    Known failure modes: catching falling knives — an extreme negative
    z-score is sometimes real news (earnings collapse, fraud, delisting) and
    the price keeps falling with no mean to revert to; the strategy has no
    way to tell the difference. It loses persistently in trending regimes,
    and the z-score assumes the return distribution is locally stationary,
    which breaks exactly when volatility regimes shift. Equal-weighting the
    signaled names means a single live signal receives the entire book, which
    concentrates risk on precisely the most distressed asset.
    """

    z_window: int = 60
    short_window: int = 5
    entry_z: float = -1.5
    name: str = field(init=False)

    def __post_init__(self) -> None:
        if self.z_window < 2:
            raise ValueError("z_window must be at least 2 to compute a standard deviation")
        if self.short_window < 1:
            raise ValueError("short_window must be at least 1")
        if self.entry_z >= 0:
            raise ValueError("entry_z must be negative; entries trigger below it and exits above zero")
        self.name = f"meanrev({self.z_window},{self.short_window},{self.entry_z})"

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame:
        short_ret = prices.pct_change(self.short_window, fill_method=None)
        rolling = short_ret.rolling(self.z_window)
        zscore = (short_ret - rolling.mean()) / rolling.std()
        z = zscore.to_numpy()
        # Between the entry and exit thresholds (or while the z-score is
        # undefined) the previous state carries forward; before any state
        # exists the position is flat.
        state = np.where(z < self.entry_z, 1.0, np.where(z > 0.0, 0.0, np.nan))
        held = pd.DataFrame(state, index=prices.index, columns=prices.columns)
        held = held.ffill().fillna(0.0)
        count = held.sum(axis=1)
        weights = held.div(count.where(count > 0.0), axis=0).fillna(0.0)
        return _zero_unpriced(weights, prices)


@dataclass
class DualMovingAverage:
    """Hold each asset at 1/N while its fast moving average exceeds its slow one.

    Rationale: the moving-average crossover is a crude trend filter whose
    real value is risk management — it has historically kept portfolios out
    of the deepest, longest drawdowns, which matter more to compounding than
    the average day. Its simplicity is the point: two parameters leave little
    room for overfitting.

    Known failure modes: whipsaws in range-bound markets, where the averages
    cross back and forth and every crossing pays costs for no edge; structural
    lateness, since by the time the fast average crosses the slow one a
    meaningful part of the move is already over, so the filter gives up the
    start of every trend and rides every peak partway down. The signal is
    binary and says nothing about conviction or expected magnitude.
    """

    fast: int = 50
    slow: int = 200
    name: str = field(init=False)

    def __post_init__(self) -> None:
        if self.fast < 1:
            raise ValueError("fast must be at least 1")
        if self.slow <= self.fast:
            raise ValueError("slow must be greater than fast")
        self.name = f"dma({self.fast},{self.slow})"

    def generate_weights(self, prices: pd.DataFrame) -> pd.DataFrame:
        fast_ma = prices.rolling(self.fast).mean()
        slow_ma = prices.rolling(self.slow).mean()
        n_assets = max(prices.shape[1], 1)
        weights = fast_ma.gt(slow_ma).astype(float) / n_assets
        return _zero_unpriced(weights, prices)


ALL_STRATEGIES: dict[str, type] = {
    "tsmom": TimeSeriesMomentum,
    "xsmom": CrossSectionalMomentum,
    "meanrev": MeanReversion,
    "dma": DualMovingAverage,
}
