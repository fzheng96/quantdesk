"""Generate web/test/fixtures/parity.json from the installed Python engine.

The fixture is the parity contract between the audited Python engine and the
TypeScript port in web/lib/engine: a seeded synthetic price panel plus, for
each strategy and for the blend pipeline, the Python-computed target weights,
net returns, equity curve, and summary metrics. The web test suite must
reproduce every series within 1e-8 relative tolerance.

Run from the repo root with the project virtualenv:

    .venv/bin/python scripts/make_parity_fixtures.py

The panel is synthetic by design (seeded geometric random walks): parity is a
statement about the math, not about market data, and a synthetic panel keeps
the fixture deterministic and license-free.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from quantdesk.backtest import BacktestResult, run_backtest
from quantdesk.risk import cap_weights, vol_target
from quantdesk.strategies import (
    CrossSectionalMomentum,
    DualMovingAverage,
    MeanReversion,
    TimeSeriesMomentum,
)

N_TICKERS = 20
N_DAYS = 1300
SEED = 42
COMMISSION_BPS = 1.0
SLIPPAGE_BPS = 2.0
BLEND_TARGET_VOL = 0.12
BLEND_MAX_WEIGHT = 0.25

OUT_PATH = Path("web") / "test" / "fixtures" / "parity.json"


def make_panel() -> pd.DataFrame:
    """Seeded geometric random walks: N_TICKERS columns over N_DAYS business days."""
    rng = np.random.default_rng(SEED)
    index = pd.bdate_range("2018-01-01", periods=N_DAYS)
    tickers = [f"S{i:02d}" for i in range(N_TICKERS)]
    drifts = rng.uniform(0.0001, 0.0006, size=N_TICKERS)
    vols = rng.uniform(0.010, 0.025, size=N_TICKERS)
    steps = drifts + vols * rng.standard_normal((N_DAYS, N_TICKERS))
    steps[0] = 0.0
    levels = 100.0 * np.exp(np.cumsum(steps, axis=0))
    return pd.DataFrame(levels, index=index, columns=tickers)


def series_list(series: pd.Series) -> list[float]:
    return [float(v) for v in series.to_numpy()]


def frame_rows(frame: pd.DataFrame) -> list[list[float]]:
    return [[float(v) for v in row] for row in frame.to_numpy()]


def metric_dict(result: BacktestResult) -> dict[str, object]:
    """Scalar metrics under the camelCase names the TypeScript port uses."""
    m = result.metrics
    return {
        "cagr": float(m["cagr"]),
        "annVol": float(m["ann_vol"]),
        "sharpe": float(m["sharpe"]),
        "sortino": float(m["sortino"]),
        "maxDrawdown": float(m["max_drawdown"]),
        "maxDrawdownPeak": str(pd.Timestamp(m["max_drawdown_peak"]).date()),
        "maxDrawdownTrough": str(pd.Timestamp(m["max_drawdown_trough"]).date()),
        "maxDrawdownDays": int(m["max_drawdown_days"]),
        "calmar": float(m["calmar"]),
        "hitRate": float(m["hit_rate"]),
    }


def result_block(weights: pd.DataFrame, result: BacktestResult) -> dict[str, object]:
    return {
        "weights": frame_rows(weights),
        "netReturns": series_list(result.net_returns),
        "equity": series_list(result.equity),
        "metrics": metric_dict(result),
    }


def main() -> None:
    prices = make_panel()

    strategies = {
        "tsmom": TimeSeriesMomentum(),
        "xsmom": CrossSectionalMomentum(),
        "dma": DualMovingAverage(),
        "meanrev": MeanReversion(),
    }

    fixture: dict[str, object] = {
        "description": (
            "Parity fixture produced by scripts/make_parity_fixtures.py from "
            "the Python engine. Synthetic seeded price panel; every series "
            "must be reproduced by the TypeScript engine within 1e-8 relative "
            "tolerance."
        ),
        "seed": SEED,
        "costs": {"commissionBps": COMMISSION_BPS, "slippageBps": SLIPPAGE_BPS},
        "panel": {
            "dates": [str(d.date()) for d in prices.index],
            "tickers": list(prices.columns),
            "closes": frame_rows(prices),
        },
        "strategies": {},
    }

    strategy_weights: dict[str, pd.DataFrame] = {}
    for key, strategy in strategies.items():
        weights = strategy.generate_weights(prices)
        result = run_backtest(
            prices,
            weights,
            commission_bps=COMMISSION_BPS,
            slippage_bps=SLIPPAGE_BPS,
        )
        block = result_block(weights, result)
        block["params"] = strategy.name
        fixture["strategies"][key] = block  # type: ignore[index]
        strategy_weights[key] = weights

    # The blend pipeline mirrors web/lib/engine/blend.ts: equal-weight average
    # of the tsmom, xsmom, and dma target weights, vol-targeted to 12%
    # annualized, then per-position weights capped at 0.25. meanrev is part of
    # the parity fixture but deliberately not part of the blend.
    averaged = (
        strategy_weights["tsmom"] + strategy_weights["xsmom"] + strategy_weights["dma"]
    ) / 3.0
    targeted = vol_target(averaged, prices, target_annual_vol=BLEND_TARGET_VOL)
    blended = cap_weights(targeted, max_weight=BLEND_MAX_WEIGHT)
    blend_result = run_backtest(
        prices,
        blended,
        commission_bps=COMMISSION_BPS,
        slippage_bps=SLIPPAGE_BPS,
    )
    blend_block = result_block(blended, blend_result)
    blend_block["params"] = {
        "members": ["tsmom", "xsmom", "dma"],
        "targetAnnualVol": BLEND_TARGET_VOL,
        "volLookback": 20,
        "maxLeverage": 1.0,
        "maxWeight": BLEND_MAX_WEIGHT,
    }
    blend_block["averagedWeights"] = frame_rows(averaged)
    fixture["blend"] = blend_block

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # allow_nan=False makes the dump itself the finiteness check: any NaN or
    # infinity anywhere in the fixture raises instead of writing invalid JSON.
    text = json.dumps(fixture, allow_nan=False, separators=(",", ":"))
    OUT_PATH.write_text(text)

    n_values = sum(
        1 for _ in _walk_numbers(fixture)
    )
    print(f"wrote {OUT_PATH} ({len(text):,} bytes, {n_values:,} numeric values, all finite)")


def _walk_numbers(obj: object):
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        if isinstance(obj, float) and not math.isfinite(obj):
            raise ValueError("non-finite value in fixture")
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_numbers(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk_numbers(v)


if __name__ == "__main__":
    main()
