"""Tests for quantdesk.broker. No network access: HTTP goes through httpx.MockTransport."""

from __future__ import annotations

import json
from datetime import datetime

import httpx
import pytest

from quantdesk.broker import (
    Account,
    AlpacaPaperAdapter,
    Fill,
    Order,
    PaperBroker,
    suggest_orders,
)


@pytest.fixture
def broker(tmp_path) -> PaperBroker:
    return PaperBroker(db_path=str(tmp_path / "paper.sqlite"), starting_cash=100000.0)


class TestPaperBrokerFills:
    def test_buy_fills_above_reference_price(self, broker: PaperBroker) -> None:
        fill = broker.submit(Order("AAPL", 10.0, "buy"), price=100.0, slippage_bps=2.0)
        assert fill.price == pytest.approx(100.0 * 1.0002)
        assert fill.cost == pytest.approx(10.0 * 100.0 * 0.0002)
        assert fill.symbol == "AAPL"
        assert fill.qty == 10.0
        assert fill.side == "buy"
        assert isinstance(fill.timestamp, datetime)

    def test_sell_fills_below_reference_price(self, broker: PaperBroker) -> None:
        broker.submit(Order("AAPL", 10.0, "buy"), price=100.0)
        fill = broker.submit(Order("AAPL", 10.0, "sell"), price=100.0, slippage_bps=2.0)
        assert fill.price == pytest.approx(100.0 * 0.9998)
        assert fill.cost == pytest.approx(10.0 * 100.0 * 0.0002)

    def test_zero_slippage_fills_at_reference(self, broker: PaperBroker) -> None:
        fill = broker.submit(Order("MSFT", 5.0, "buy"), price=200.0, slippage_bps=0.0)
        assert fill.price == 200.0
        assert fill.cost == 0.0

    @pytest.mark.parametrize(
        "order, price",
        [
            (Order("AAPL", 10.0, "hold"), 100.0),
            (Order("AAPL", 0.0, "buy"), 100.0),
            (Order("AAPL", -5.0, "buy"), 100.0),
            (Order("", 10.0, "buy"), 100.0),
            (Order("AAPL", 10.0, "buy"), 0.0),
            (Order("AAPL", 10.0, "buy"), -1.0),
        ],
    )
    def test_invalid_submissions_raise(self, broker: PaperBroker, order: Order, price: float) -> None:
        with pytest.raises(ValueError):
            broker.submit(order, price=price)

    def test_negative_slippage_raises(self, broker: PaperBroker) -> None:
        with pytest.raises(ValueError):
            broker.submit(Order("AAPL", 1.0, "buy"), price=100.0, slippage_bps=-1.0)


class TestPaperBrokerAccounting:
    def test_round_trip_conserves_value_up_to_costs(self, broker: PaperBroker) -> None:
        # Buy and then fully sell at the same reference price. The only
        # leakage should be the slippage cost on each leg.
        buy = broker.submit(Order("AAPL", 10.0, "buy"), price=100.0, slippage_bps=2.0)
        mid_account = broker.account({"AAPL": 100.0})
        assert mid_account.cash == pytest.approx(100000.0 - 10.0 * buy.price)
        assert mid_account.equity == pytest.approx(100000.0 - buy.cost)

        sell = broker.submit(Order("AAPL", 10.0, "sell"), price=100.0, slippage_bps=2.0)
        final_account = broker.account({})
        assert broker.positions() == {}
        assert final_account.cash == pytest.approx(100000.0 - buy.cost - sell.cost)
        assert final_account.equity == pytest.approx(final_account.cash)

    def test_positions_track_signed_quantity(self, broker: PaperBroker) -> None:
        broker.submit(Order("AAPL", 10.0, "buy"), price=100.0)
        broker.submit(Order("AAPL", 4.0, "sell"), price=100.0)
        broker.submit(Order("MSFT", 3.0, "buy"), price=200.0)
        assert broker.positions() == pytest.approx({"AAPL": 6.0, "MSFT": 3.0})

    def test_flat_positions_are_dropped(self, broker: PaperBroker) -> None:
        broker.submit(Order("AAPL", 10.0, "buy"), price=100.0)
        broker.submit(Order("AAPL", 10.0, "sell"), price=100.0)
        assert "AAPL" not in broker.positions()

    def test_account_requires_price_for_held_symbol(self, broker: PaperBroker) -> None:
        broker.submit(Order("AAPL", 10.0, "buy"), price=100.0)
        with pytest.raises(ValueError, match="AAPL"):
            broker.account({})

    def test_account_marks_positions_at_supplied_prices(self, broker: PaperBroker) -> None:
        broker.submit(Order("AAPL", 10.0, "buy"), price=100.0, slippage_bps=0.0)
        account = broker.account({"AAPL": 110.0})
        assert isinstance(account, Account)
        assert account.cash == pytest.approx(99000.0)
        assert account.equity == pytest.approx(99000.0 + 10.0 * 110.0)


class TestPaperBrokerPersistence:
    def test_state_survives_reopen(self, tmp_path) -> None:
        db_path = str(tmp_path / "paper.sqlite")
        first = PaperBroker(db_path=db_path, starting_cash=50000.0)
        first.submit(Order("AAPL", 10.0, "buy"), price=100.0, slippage_bps=0.0)
        first.close()

        second = PaperBroker(db_path=db_path, starting_cash=50000.0)
        assert second.positions() == pytest.approx({"AAPL": 10.0})
        assert second.account({"AAPL": 100.0}).cash == pytest.approx(49000.0)
        assert len(second.history()) == 1

    def test_starting_cash_only_seeds_fresh_database(self, tmp_path) -> None:
        db_path = str(tmp_path / "paper.sqlite")
        first = PaperBroker(db_path=db_path, starting_cash=50000.0)
        first.close()
        # A different starting_cash on reopen must not overwrite the ledger.
        second = PaperBroker(db_path=db_path, starting_cash=999999.0)
        assert second.account({}).cash == pytest.approx(50000.0)

    def test_history_preserves_order_and_fields(self, broker: PaperBroker) -> None:
        broker.submit(Order("AAPL", 10.0, "buy"), price=100.0)
        broker.submit(Order("MSFT", 5.0, "sell"), price=200.0)
        fills = broker.history()
        assert [f.symbol for f in fills] == ["AAPL", "MSFT"]
        assert [f.side for f in fills] == ["buy", "sell"]
        assert all(isinstance(f, Fill) for f in fills)
        assert all(isinstance(f.timestamp, datetime) for f in fills)

    def test_creates_parent_directory(self, tmp_path) -> None:
        db_path = tmp_path / "nested" / "dir" / "paper.sqlite"
        PaperBroker(db_path=str(db_path)).close()
        assert db_path.exists()


class TestSuggestOrders:
    def test_rebalance_from_all_cash(self) -> None:
        orders = suggest_orders(
            positions={},
            target_weights={"AAPL": 0.5, "MSFT": 0.5},
            prices={"AAPL": 100.0, "MSFT": 200.0},
            equity=10000.0,
        )
        assert orders == [
            Order("AAPL", 50.0, "buy"),
            Order("MSFT", 25.0, "buy"),
        ]

    def test_position_without_target_is_sold(self) -> None:
        orders = suggest_orders(
            positions={"AAPL": 50.0},
            target_weights={},
            prices={"AAPL": 100.0},
            equity=10000.0,
        )
        assert orders == [Order("AAPL", 50.0, "sell")]

    def test_diff_is_relative_to_current_position(self) -> None:
        orders = suggest_orders(
            positions={"AAPL": 30.0},
            target_weights={"AAPL": 0.5},
            prices={"AAPL": 100.0},
            equity=10000.0,
        )
        assert orders == [Order("AAPL", 20.0, "buy")]

    def test_sells_come_before_buys(self) -> None:
        orders = suggest_orders(
            positions={"AAPL": 100.0},
            target_weights={"MSFT": 0.5},
            prices={"AAPL": 100.0, "MSFT": 200.0},
            equity=10000.0,
        )
        assert [o.side for o in orders] == ["sell", "buy"]

    def test_min_notional_filters_small_diffs(self) -> None:
        # The AAPL diff is 0.4 shares = $40 notional, below the $50 floor.
        orders = suggest_orders(
            positions={"AAPL": 49.6},
            target_weights={"AAPL": 0.5, "MSFT": 0.5},
            prices={"AAPL": 100.0, "MSFT": 200.0},
            equity=10000.0,
        )
        assert orders == [Order("MSFT", 25.0, "buy")]

    def test_already_balanced_book_yields_no_orders(self) -> None:
        assert (
            suggest_orders(
                positions={"AAPL": 50.0},
                target_weights={"AAPL": 0.5},
                prices={"AAPL": 100.0},
                equity=10000.0,
            )
            == []
        )

    def test_missing_price_raises(self) -> None:
        with pytest.raises(ValueError, match="AAPL"):
            suggest_orders(
                positions={"AAPL": 10.0},
                target_weights={},
                prices={},
                equity=10000.0,
            )

    def test_negative_equity_raises(self) -> None:
        with pytest.raises(ValueError):
            suggest_orders(positions={}, target_weights={"AAPL": 0.5}, prices={"AAPL": 100.0}, equity=-1.0)


@pytest.fixture
def alpaca_env(monkeypatch) -> None:
    monkeypatch.setenv("ALPACA_KEY_ID", "test-key-id")
    monkeypatch.setenv("ALPACA_SECRET_KEY", "test-secret")


def _mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


class TestAlpacaPaperAdapter:
    def test_rejects_non_paper_base_url(self, alpaca_env) -> None:
        with pytest.raises(ValueError, match="paper"):
            AlpacaPaperAdapter(base_url="https://api.alpaca.markets")

    def test_requests_ignore_base_url_overrides(self, alpaca_env) -> None:
        # The paper-only guarantee must survive attribute monkeying: request
        # URLs are built from a module-level constant, so assigning a live
        # endpoint to BASE_URL after construction changes nothing.
        urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            return httpx.Response(200, json=[])

        adapter = AlpacaPaperAdapter(client=_mock_client(handler))
        adapter.BASE_URL = "https://api.alpaca.markets"
        adapter.positions()
        assert urls == ["https://paper-api.alpaca.markets/v2/positions"]

    def test_missing_credentials_raise(self, monkeypatch) -> None:
        monkeypatch.delenv("ALPACA_KEY_ID", raising=False)
        monkeypatch.delenv("ALPACA_SECRET_KEY", raising=False)
        with pytest.raises(ValueError, match="ALPACA_KEY_ID"):
            AlpacaPaperAdapter()

    def test_repr_does_not_leak_credentials(self, alpaca_env) -> None:
        adapter = AlpacaPaperAdapter(client=_mock_client(lambda request: httpx.Response(200)))
        assert "test-key-id" not in repr(adapter)
        assert "test-secret" not in repr(adapter)

    def test_submit_order_sends_market_day_order_with_auth(self, alpaca_env) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["headers"] = request.headers
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "order-1", "status": "accepted"})

        adapter = AlpacaPaperAdapter(client=_mock_client(handler))
        result = adapter.submit_order(Order("AAPL", 10.0, "buy"))

        assert result == {"id": "order-1", "status": "accepted"}
        assert captured["url"] == "https://paper-api.alpaca.markets/v2/orders"
        assert captured["headers"]["APCA-API-KEY-ID"] == "test-key-id"
        assert captured["headers"]["APCA-API-SECRET-KEY"] == "test-secret"
        assert captured["body"] == {
            "symbol": "AAPL",
            "qty": "10.0",
            "side": "buy",
            "type": "market",
            "time_in_force": "day",
        }

    def test_submit_order_validates_before_sending(self, alpaca_env) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("an invalid order must not reach the API")

        adapter = AlpacaPaperAdapter(client=_mock_client(handler))
        with pytest.raises(ValueError):
            adapter.submit_order(Order("AAPL", -1.0, "buy"))

    def test_positions_parses_long_and_short(self, alpaca_env) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert str(request.url) == "https://paper-api.alpaca.markets/v2/positions"
            return httpx.Response(
                200,
                json=[
                    {"symbol": "AAPL", "qty": "10", "side": "long"},
                    {"symbol": "MSFT", "qty": "5", "side": "short"},
                ],
            )

        adapter = AlpacaPaperAdapter(client=_mock_client(handler))
        assert adapter.positions() == {"AAPL": 10.0, "MSFT": -5.0}

    def test_account_parses_cash_and_equity(self, alpaca_env) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert str(request.url) == "https://paper-api.alpaca.markets/v2/account"
            return httpx.Response(200, json={"cash": "25000.50", "equity": "100000.25"})

        adapter = AlpacaPaperAdapter(client=_mock_client(handler))
        account = adapter.account()
        assert account == Account(cash=25000.50, equity=100000.25)

    def test_http_errors_propagate(self, alpaca_env) -> None:
        adapter = AlpacaPaperAdapter(
            client=_mock_client(lambda request: httpx.Response(403, json={"message": "forbidden"}))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter.account()
