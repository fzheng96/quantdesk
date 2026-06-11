"""Paper trading broker and Alpaca paper adapter.

This module provides two execution backends for research workflows:

- :class:`PaperBroker`, a local simulated broker whose state (cash, positions,
  fill history) persists in SQLite across runs.
- :class:`AlpacaPaperAdapter`, a thin httpx client for Alpaca's paper-trading
  API. The base URL is pinned to the paper endpoint by construction, so this
  codebase has no live-trading path.

Neither backend models margin requirements, borrow availability, partial
fills, or market impact beyond a fixed slippage haircut. Fills are assumed to
execute in full at the supplied reference price plus slippage, which is
optimistic for anything but small orders in liquid names.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

__all__ = [
    "Order",
    "Fill",
    "Account",
    "PaperBroker",
    "suggest_orders",
    "AlpacaPaperAdapter",
]

# Positions smaller than this are treated as flat to absorb float rounding.
_QTY_EPSILON = 1e-9

# The only endpoint AlpacaPaperAdapter will ever talk to. Request URLs are
# built from this module-level constant rather than an instance or class
# attribute, so overriding BASE_URL after construction (or in a subclass)
# cannot re-point requests at the live API.
_PAPER_BASE_URL = "https://paper-api.alpaca.markets"


@dataclass(frozen=True)
class Order:
    """An instruction to trade ``qty`` units of ``symbol``.

    ``side`` is ``"buy"`` or ``"sell"`` and ``qty`` is always positive; the
    direction lives in ``side``, not in the sign of ``qty``.
    """

    symbol: str
    qty: float
    side: str


@dataclass(frozen=True)
class Fill:
    """The result of executing an :class:`Order`.

    ``price`` is the execution price after slippage. ``cost`` is the slippage
    paid in currency relative to the reference price, so a buy debits
    ``qty * reference_price + cost`` from cash and a sell credits
    ``qty * reference_price - cost``.
    """

    symbol: str
    qty: float
    side: str
    price: float
    cost: float
    timestamp: datetime


@dataclass(frozen=True)
class Account:
    """Cash balance and total equity (cash plus marked-to-market positions)."""

    cash: float
    equity: float


def _validate_order(order: Order) -> None:
    if order.side not in ("buy", "sell"):
        raise ValueError(f"order side must be 'buy' or 'sell', got {order.side!r}")
    if not order.qty > 0:
        raise ValueError(f"order qty must be positive, got {order.qty!r}")
    if not order.symbol:
        raise ValueError("order symbol must be a non-empty string")


class PaperBroker:
    """A simulated broker backed by SQLite.

    State persists across instances pointed at the same ``db_path``;
    ``starting_cash`` only seeds a fresh database and is ignored thereafter.

    The broker deliberately does not enforce buying power or borrow limits:
    cash may go negative and positions may go short. This keeps the
    accounting honest and simple, but it means callers are responsible for
    sizing orders sensibly (see :func:`suggest_orders`).
    """

    def __init__(self, db_path: str = "data/paper.sqlite", starting_cash: float = 100000.0):
        path = Path(db_path)
        if path.parent != Path("."):
            path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        self._init_schema(starting_cash)

    def _init_schema(self, starting_cash: float) -> None:
        with self._conn:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS account ("
                " id INTEGER PRIMARY KEY CHECK (id = 1),"
                " cash REAL NOT NULL)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS positions ("
                " symbol TEXT PRIMARY KEY,"
                " qty REAL NOT NULL)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS fills ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " symbol TEXT NOT NULL,"
                " qty REAL NOT NULL,"
                " side TEXT NOT NULL,"
                " price REAL NOT NULL,"
                " cost REAL NOT NULL,"
                " timestamp TEXT NOT NULL)"
            )
            self._conn.execute(
                "INSERT OR IGNORE INTO account (id, cash) VALUES (1, ?)",
                (starting_cash,),
            )

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        self._conn.close()

    def submit(self, order: Order, price: float, slippage_bps: float = 2.0) -> Fill:
        """Execute ``order`` against reference ``price`` and record the fill.

        Buys fill above the reference price and sells below it by
        ``slippage_bps`` basis points. The order always fills in full; there
        is no liquidity or buying-power check.
        """
        _validate_order(order)
        if not price > 0:
            raise ValueError(f"price must be positive, got {price!r}")
        if slippage_bps < 0:
            raise ValueError(f"slippage_bps must be non-negative, got {slippage_bps!r}")

        slip = slippage_bps / 10000.0
        if order.side == "buy":
            fill_price = price * (1.0 + slip)
            signed_qty = order.qty
        else:
            fill_price = price * (1.0 - slip)
            signed_qty = -order.qty
        cost = order.qty * price * slip
        cash_delta = -signed_qty * fill_price
        timestamp = datetime.now(timezone.utc)

        with self._conn:
            self._conn.execute("UPDATE account SET cash = cash + ? WHERE id = 1", (cash_delta,))
            row = self._conn.execute(
                "SELECT qty FROM positions WHERE symbol = ?", (order.symbol,)
            ).fetchone()
            new_qty = (row[0] if row else 0.0) + signed_qty
            if abs(new_qty) < _QTY_EPSILON:
                self._conn.execute("DELETE FROM positions WHERE symbol = ?", (order.symbol,))
            else:
                self._conn.execute(
                    "INSERT INTO positions (symbol, qty) VALUES (?, ?)"
                    " ON CONFLICT(symbol) DO UPDATE SET qty = excluded.qty",
                    (order.symbol, new_qty),
                )
            self._conn.execute(
                "INSERT INTO fills (symbol, qty, side, price, cost, timestamp)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (order.symbol, order.qty, order.side, fill_price, cost, timestamp.isoformat()),
            )

        return Fill(
            symbol=order.symbol,
            qty=order.qty,
            side=order.side,
            price=fill_price,
            cost=cost,
            timestamp=timestamp,
        )

    def positions(self) -> dict[str, float]:
        """Return current holdings as symbol -> signed quantity, flats excluded."""
        rows = self._conn.execute("SELECT symbol, qty FROM positions ORDER BY symbol").fetchall()
        return {symbol: qty for symbol, qty in rows}

    def account(self, prices: dict[str, float]) -> Account:
        """Return cash and equity, marking positions at ``prices``.

        Every held symbol must have a price; a missing one raises ValueError
        rather than silently valuing the position at zero.
        """
        cash = self._conn.execute("SELECT cash FROM account WHERE id = 1").fetchone()[0]
        equity = cash
        for symbol, qty in self.positions().items():
            if symbol not in prices:
                raise ValueError(f"no price supplied for held symbol {symbol!r}")
            equity += qty * prices[symbol]
        return Account(cash=cash, equity=equity)

    def history(self) -> list[Fill]:
        """Return all fills in execution order."""
        rows = self._conn.execute(
            "SELECT symbol, qty, side, price, cost, timestamp FROM fills ORDER BY id"
        ).fetchall()
        return [
            Fill(
                symbol=symbol,
                qty=qty,
                side=side,
                price=price,
                cost=cost,
                timestamp=datetime.fromisoformat(timestamp),
            )
            for symbol, qty, side, price, cost, timestamp in rows
        ]


def suggest_orders(
    positions: dict[str, float],
    target_weights: dict[str, float],
    prices: dict[str, float],
    equity: float,
    min_notional: float = 50.0,
) -> list[Order]:
    """Compute the orders that move ``positions`` to ``target_weights``.

    For each symbol in either the current book or the targets, the target
    quantity is ``weight * equity / price`` and the order is the difference
    from the current quantity. Diffs whose notional value is below
    ``min_notional`` are dropped to avoid churn on tiny rebalances; the
    resulting book therefore only approximates the targets. Sells are listed
    before buys so that executing in order frees cash first. Quantities are
    fractional; callers routing to a broker that requires whole shares must
    round themselves.
    """
    if equity < 0:
        raise ValueError(f"equity must be non-negative, got {equity!r}")
    symbols = sorted(set(positions) | set(target_weights))
    sells: list[Order] = []
    buys: list[Order] = []
    for symbol in symbols:
        current = positions.get(symbol, 0.0)
        weight = target_weights.get(symbol, 0.0)
        if abs(current) < _QTY_EPSILON and weight == 0.0:
            continue
        if symbol not in prices:
            raise ValueError(f"no price supplied for symbol {symbol!r}")
        price = prices[symbol]
        if not price > 0:
            raise ValueError(f"price for {symbol!r} must be positive, got {price!r}")
        diff = weight * equity / price - current
        if abs(diff) * price < min_notional:
            continue
        if diff > 0:
            buys.append(Order(symbol=symbol, qty=diff, side="buy"))
        else:
            sells.append(Order(symbol=symbol, qty=-diff, side="sell"))
    return sells + buys


class AlpacaPaperAdapter:
    """httpx client for Alpaca's paper-trading API.

    The base URL is fixed to the paper endpoint: passing any other value to
    the constructor raises ValueError, and every request URL is built from a
    module-level constant rather than ``self.BASE_URL``, so neither the
    constructor argument nor attribute assignment after construction can
    point this class at the live API. Credentials come only from the
    ALPACA_KEY_ID and ALPACA_SECRET_KEY environment variables and are never
    logged or included in repr output.

    ``submit_order`` places plain market orders with day time-in-force; limit
    orders, extended hours, and order cancellation are out of scope here.
    """

    # Documented alias of the pinned endpoint; requests do not read it.
    BASE_URL = _PAPER_BASE_URL

    def __init__(
        self,
        base_url: str = _PAPER_BASE_URL,
        client: httpx.Client | None = None,
        timeout: float = 10.0,
    ):
        if base_url != _PAPER_BASE_URL:
            raise ValueError(
                "AlpacaPaperAdapter only supports the paper endpoint"
                f" {_PAPER_BASE_URL}; refusing base_url {base_url!r}"
            )
        key_id = os.environ.get("ALPACA_KEY_ID")
        secret_key = os.environ.get("ALPACA_SECRET_KEY")
        if not key_id or not secret_key:
            raise ValueError(
                "ALPACA_KEY_ID and ALPACA_SECRET_KEY must be set in the environment"
            )
        self._headers = {
            "APCA-API-KEY-ID": key_id,
            "APCA-API-SECRET-KEY": secret_key,
        }
        self._client = client if client is not None else httpx.Client(timeout=timeout)

    def __repr__(self) -> str:
        # Credentials are deliberately omitted so reprs are safe to log.
        return f"{type(self).__name__}(base_url={_PAPER_BASE_URL!r})"

    def submit_order(self, order: Order) -> dict:
        """Place a market day order and return the API response body."""
        _validate_order(order)
        response = self._client.post(
            f"{_PAPER_BASE_URL}/v2/orders",
            headers=self._headers,
            json={
                "symbol": order.symbol,
                "qty": str(order.qty),
                "side": order.side,
                "type": "market",
                "time_in_force": "day",
            },
        )
        response.raise_for_status()
        return response.json()

    def positions(self) -> dict[str, float]:
        """Return open positions as symbol -> signed quantity."""
        response = self._client.get(f"{_PAPER_BASE_URL}/v2/positions", headers=self._headers)
        response.raise_for_status()
        result: dict[str, float] = {}
        for position in response.json():
            qty = float(position["qty"])
            # Alpaca reports short positions with side "short" and positive qty
            # in some payload versions; the sign of qty is authoritative when
            # negative, otherwise fall back to the side field.
            if qty > 0 and position.get("side") == "short":
                qty = -qty
            result[position["symbol"]] = qty
        return result

    def account(self) -> Account:
        """Return cash and equity from the paper account."""
        response = self._client.get(f"{_PAPER_BASE_URL}/v2/account", headers=self._headers)
        response.raise_for_status()
        body = response.json()
        return Account(cash=float(body["cash"]), equity=float(body["equity"]))
