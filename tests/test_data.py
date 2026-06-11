"""Tests for quantdesk.data.

No test touches the network: StooqSource is exercised through
httpx.MockTransport, and the cache/assembly logic uses an in-memory
FakeSource.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import httpx
import numpy as np
import pandas as pd
import pytest

import json

from quantdesk.data import (
    ChainedSource,
    DataError,
    PriceCache,
    StooqSource,
    YahooSource,
    get_prices,
)

STOOQ_CSV = (
    "Date,Open,High,Low,Close,Volume\n"
    "2020-01-02,100.0,101.0,99.0,100.5,1000\n"
    "2020-01-03,100.5,102.0,100.0,101.5,1100\n"
)


def make_bars(start: str, periods: int, seed: int) -> pd.DataFrame:
    """Synthetic random-walk OHLCV bars on business days with a fixed seed."""
    rng = np.random.default_rng(seed)
    index = pd.bdate_range(start, periods=periods, name="date")
    close = pd.Series(
        100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.01, periods))), index=index
    )
    return pd.DataFrame(
        {
            "open": close * 0.995,
            "high": close * 1.01,
            "low": close * 0.99,
            "close": close,
            "volume": 1_000_000.0,
        }
    )


class FakeSource:
    """In-memory source backed by pre-built frames; records every fetch."""

    def __init__(self, frames: dict[str, pd.DataFrame]) -> None:
        self.frames = frames
        self.calls: list[tuple[str, date, date]] = []

    def fetch_ohlcv(self, ticker: str, start: date, end: date) -> pd.DataFrame:
        self.calls.append((ticker, start, end))
        frame = self.frames.get(ticker)
        if frame is None:
            raise DataError(f"unknown ticker {ticker!r}")
        window = frame.loc[str(start) : str(end)]
        if window.empty:
            raise DataError(f"no data for {ticker!r} between {start} and {end}")
        return window.copy()


@pytest.fixture
def cache(tmp_path: Path) -> PriceCache:
    return PriceCache(tmp_path / "cache.sqlite")


class TestGetPrices:
    def test_returns_wide_close_frame(self, cache: PriceCache) -> None:
        frames = {
            "MSFT": make_bars("2020-01-02", 15, seed=1),
            "AAPL": make_bars("2020-01-02", 15, seed=2),
        }
        source = FakeSource(frames)
        out = get_prices(
            ["MSFT", "AAPL"], date(2020, 1, 2), date(2020, 1, 22),
            source=source, cache=cache,
        )
        assert list(out.columns) == ["MSFT", "AAPL"]
        assert isinstance(out.index, pd.DatetimeIndex)
        pd.testing.assert_series_equal(
            out["MSFT"], frames["MSFT"]["close"], check_names=False, check_freq=False
        )
        pd.testing.assert_series_equal(
            out["AAPL"], frames["AAPL"]["close"], check_names=False, check_freq=False
        )

    def test_cache_first_second_call_uses_no_source(self, cache: PriceCache) -> None:
        frames = {"AAPL": make_bars("2020-01-02", 15, seed=3)}
        first_source = FakeSource(frames)
        first = get_prices(
            ["AAPL"], date(2020, 1, 2), date(2020, 1, 22),
            source=first_source, cache=cache,
        )
        assert len(first_source.calls) == 1
        # A source with no data at all proves the second call is served
        # entirely from the cache.
        empty_source = FakeSource({})
        second = get_prices(
            ["AAPL"], date(2020, 1, 2), date(2020, 1, 22),
            source=empty_source, cache=cache,
        )
        assert empty_source.calls == []
        pd.testing.assert_frame_equal(first, second)

    def test_fetches_only_missing_ranges(self, cache: PriceCache) -> None:
        bars = make_bars("2020-01-01", 260, seed=4)
        source = FakeSource({"NVDA": bars})
        get_prices(
            ["NVDA"], date(2020, 4, 1), date(2020, 6, 30),
            source=source, cache=cache,
        )
        get_prices(
            ["NVDA"], date(2020, 2, 3), date(2020, 8, 31),
            source=source, cache=cache,
        )
        assert source.calls == [
            ("NVDA", date(2020, 4, 1), date(2020, 6, 30)),
            ("NVDA", date(2020, 2, 3), date(2020, 3, 31)),
            ("NVDA", date(2020, 7, 1), date(2020, 8, 31)),
        ]
        # The stitched segments must reproduce the source series exactly,
        # and serving them must require no further fetches.
        out = get_prices(
            ["NVDA"], date(2020, 2, 3), date(2020, 8, 31),
            source=FakeSource({}), cache=cache,
        )
        expected = bars.loc["2020-02-03":"2020-08-31", "close"]
        pd.testing.assert_series_equal(
            out["NVDA"], expected, check_names=False, check_freq=False
        )

    def test_forward_fill_caps_at_three_rows(self, cache: PriceCache) -> None:
        full = make_bars("2020-01-02", 30, seed=5)
        idx = full.index
        gap2 = idx[10:12]
        gap5 = idx[20:25]
        partial = full.drop(gap2.union(gap5))
        source = FakeSource(
            {"FULL": make_bars("2020-01-02", 30, seed=6), "HOLEY": partial}
        )
        out = get_prices(
            ["FULL", "HOLEY"], idx[0].date(), idx[-1].date(),
            source=source, cache=cache,
        )
        last_before_gap2 = partial.loc[idx[9], "close"]
        assert (out.loc[gap2, "HOLEY"] == last_before_gap2).all()
        last_before_gap5 = partial.loc[idx[19], "close"]
        assert (out.loc[gap5[:3], "HOLEY"] == last_before_gap5).all()
        assert out.loc[gap5[3:], "HOLEY"].isna().all()
        assert out["FULL"].notna().all()

    def test_leading_all_nan_rows_are_dropped(self, cache: PriceCache) -> None:
        bars = make_bars("2020-01-02", 10, seed=7)
        bars.iloc[:2, bars.columns.get_loc("close")] = np.nan
        source = FakeSource({"NEWCO": bars})
        out = get_prices(
            ["NEWCO"], date(2020, 1, 2), date(2020, 1, 15),
            source=source, cache=cache,
        )
        assert out.index[0] == bars.index[2]
        assert len(out) == 8
        assert out["NEWCO"].notna().all()

    def test_later_listing_keeps_leading_nans_in_its_column(
        self, cache: PriceCache
    ) -> None:
        early = make_bars("2020-01-02", 20, seed=8)
        late = make_bars("2020-01-02", 20, seed=9).iloc[5:]
        source = FakeSource({"OLD": early, "NEW": late})
        out = get_prices(
            ["OLD", "NEW"], early.index[0].date(), early.index[-1].date(),
            source=source, cache=cache,
        )
        assert out.index[0] == early.index[0]
        assert out["NEW"].first_valid_index() == early.index[5]
        assert out.loc[: early.index[4], "NEW"].isna().all()

    def test_trailing_fetch_failure_serves_cached_data(self, cache: PriceCache) -> None:
        bars = make_bars("2020-01-02", 10, seed=20)
        source = FakeSource({"AAPL": bars})
        get_prices(
            ["AAPL"], date(2020, 1, 2), bars.index[-1].date(),
            source=source, cache=cache,
        )
        # Requesting past the cached end on a day with no new bars (the
        # weekend case: FakeSource raises for the empty trailing span) must
        # serve the cached history instead of erroring.
        out = get_prices(
            ["AAPL"], date(2020, 1, 2), bars.index[-1].date() + timedelta(days=2),
            source=source, cache=cache,
        )
        pd.testing.assert_series_equal(
            out["AAPL"], bars["close"], check_names=False, check_freq=False
        )

    def test_one_failing_ticker_does_not_abort_the_rest(self, cache: PriceCache) -> None:
        bars = make_bars("2020-01-02", 10, seed=21)
        source = FakeSource({"AAPL": bars})
        out = get_prices(
            ["AAPL", "NOPE"], date(2020, 1, 2), date(2020, 1, 15),
            source=source, cache=cache,
        )
        assert list(out.columns) == ["AAPL"]
        assert out["AAPL"].notna().all()

    def test_reversed_range_raises(self, cache: PriceCache) -> None:
        with pytest.raises(ValueError):
            get_prices(
                ["AAPL"], date(2020, 2, 1), date(2020, 1, 1),
                source=FakeSource({}), cache=cache,
            )

    def test_empty_tickers_raises(self, cache: PriceCache) -> None:
        with pytest.raises(ValueError):
            get_prices(
                [], date(2020, 1, 1), date(2020, 2, 1),
                source=FakeSource({}), cache=cache,
            )

    def test_source_error_propagates(self, cache: PriceCache) -> None:
        with pytest.raises(DataError):
            get_prices(
                ["NOPE"], date(2020, 1, 1), date(2020, 2, 1),
                source=FakeSource({}), cache=cache,
            )


class TestPriceCache:
    def test_store_load_roundtrip(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        bars = make_bars("2020-01-02", 5, seed=10)
        cache.store("AAPL", bars)
        loaded = cache.load("AAPL", date(2020, 1, 2), date(2020, 12, 31))
        pd.testing.assert_frame_equal(loaded, bars, check_freq=False)

    def test_keys_are_case_insensitive(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        cache.store("AAPL", make_bars("2020-01-02", 5, seed=11))
        loaded = cache.load("aapl", date(2020, 1, 2), date(2020, 12, 31))
        assert len(loaded) == 5

    def test_store_is_idempotent(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        bars = make_bars("2020-01-02", 5, seed=12)
        cache.store("AAPL", bars)
        cache.store("AAPL", bars)
        loaded = cache.load("AAPL", date(2020, 1, 2), date(2020, 12, 31))
        assert len(loaded) == 5

    def test_subrange_load(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        bars = make_bars("2020-01-02", 5, seed=13)
        cache.store("AAPL", bars)
        loaded = cache.load(
            "AAPL", bars.index[1].date(), bars.index[3].date()
        )
        assert len(loaded) == 3
        assert loaded.index[0] == bars.index[1]

    def test_coverage(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        bars = make_bars("2020-01-02", 5, seed=14)
        cache.store("AAPL", bars)
        assert cache.coverage("AAPL") == (date(2020, 1, 2), date(2020, 1, 8))
        assert cache.coverage("MSFT") is None

    def test_nan_values_roundtrip(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        bars = make_bars("2020-01-02", 5, seed=15)
        bars.iloc[2, bars.columns.get_loc("close")] = np.nan
        cache.store("AAPL", bars)
        loaded = cache.load("AAPL", date(2020, 1, 2), date(2020, 12, 31))
        assert np.isnan(loaded["close"].iloc[2])
        assert loaded["close"].drop(loaded.index[2]).notna().all()

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        path = tmp_path / "deep" / "nested" / "cache.sqlite"
        PriceCache(path)
        assert path.exists()

    def test_empty_load_shape(self, tmp_path: Path) -> None:
        cache = PriceCache(tmp_path / "cache.sqlite")
        out = cache.load("AAPL", date(2020, 1, 1), date(2020, 2, 1))
        assert out.empty
        assert list(out.columns) == ["open", "high", "low", "close", "volume"]
        assert isinstance(out.index, pd.DatetimeIndex)


def _source_with(handler) -> StooqSource:
    transport = httpx.MockTransport(handler)
    return StooqSource(client=httpx.Client(transport=transport), retry_delay=0.0)


class TestStooqSource:
    def test_url_and_parsing(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=STOOQ_CSV)

        source = _source_with(handler)
        frame = source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))
        assert dict(requests[0].url.params) == {
            "s": "aapl.us",
            "d1": "20200102",
            "d2": "20200103",
            "i": "d",
        }
        assert list(frame.columns) == ["open", "high", "low", "close", "volume"]
        assert isinstance(frame.index, pd.DatetimeIndex)
        assert frame.loc["2020-01-02", "close"] == 100.5
        assert frame.loc["2020-01-03", "volume"] == 1100.0

    def test_existing_suffix_not_doubled(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=STOOQ_CSV)

        source = _source_with(handler)
        source.fetch_ohlcv("BRK-B.US", date(2020, 1, 2), date(2020, 1, 3))
        assert dict(requests[0].url.params)["s"] == "brk-b.us"

    def test_empty_body_raises(self) -> None:
        source = _source_with(lambda request: httpx.Response(200, text=""))
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))

    def test_no_data_body_raises(self) -> None:
        source = _source_with(lambda request: httpx.Response(200, text="No data"))
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))

    def test_malformed_body_raises(self) -> None:
        source = _source_with(
            lambda request: httpx.Response(200, text="<html>busy</html>")
        )
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))

    def test_html_interstitial_names_the_problem(self) -> None:
        # Stooq fronts the CSV endpoint with a browser-verification page at
        # times; the error should say it got HTML rather than complain about
        # missing CSV columns.
        body = (
            "<!DOCTYPE html><html><head></head>"
            "<body>This site requires JavaScript.</body></html>"
        )
        source = _source_with(lambda request: httpx.Response(200, text=body))
        with pytest.raises(DataError, match="HTML"):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))

    def test_header_only_raises(self) -> None:
        source = _source_with(
            lambda request: httpx.Response(
                200, text="Date,Open,High,Low,Close,Volume\n"
            )
        )
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))

    def test_all_nonnumeric_close_raises(self) -> None:
        body = "Date,Open,High,Low,Close,Volume\n2020-01-02,100,101,99,abc,1000\n"
        source = _source_with(lambda request: httpx.Response(200, text=body))
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 2))

    def test_retries_transport_errors_then_succeeds(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) < 3:
                raise httpx.ConnectError("connection refused", request=request)
            return httpx.Response(200, text=STOOQ_CSV)

        source = _source_with(handler)
        frame = source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))
        assert len(attempts) == 3
        assert len(frame) == 2

    def test_raises_after_retries_exhausted(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ConnectError("connection refused", request=request)

        source = _source_with(handler)
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))
        assert len(attempts) == 3

    def test_server_errors_are_retried(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            return httpx.Response(500, text="oops")

        source = _source_with(handler)
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))
        assert len(attempts) == 3

    def test_client_error_fails_fast(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            return httpx.Response(404, text="not found")

        source = _source_with(handler)
        with pytest.raises(DataError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))
        assert len(attempts) == 1

    def test_reversed_range_raises_without_request(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            return httpx.Response(200, text=STOOQ_CSV)

        source = _source_with(handler)
        with pytest.raises(ValueError):
            source.fetch_ohlcv("AAPL", date(2020, 1, 3), date(2020, 1, 2))
        assert attempts == []


# Two trading days whose bar timestamps sit at the 14:30 UTC market open,
# which must come back as the Eastern trading dates 2020-01-02 and
# 2020-01-03. The adjusted closes deliberately differ from the raw closes so
# tests can prove which one the parser keeps.
YAHOO_JSON = json.dumps(
    {
        "chart": {
            "result": [
                {
                    "timestamp": [1577975400, 1578061800],
                    "indicators": {
                        "quote": [
                            {
                                "open": [100.0, 100.5],
                                "high": [101.0, 102.0],
                                "low": [99.0, 100.0],
                                "close": [100.5, 101.5],
                                "volume": [1000, 1100],
                            }
                        ],
                        "adjclose": [{"adjclose": [100.0, 101.0]}],
                    },
                }
            ],
            "error": None,
        }
    }
)


def _yahoo_with(handler) -> YahooSource:
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return YahooSource(client=client, retry_delay=0.0)


class TestYahooSource:
    def test_parses_chart_json(self) -> None:
        source = _yahoo_with(lambda request: httpx.Response(200, text=YAHOO_JSON))
        bars = source.fetch_ohlcv("aapl", date(2020, 1, 2), date(2020, 1, 3))
        assert list(bars.index) == [
            pd.Timestamp("2020-01-02"),
            pd.Timestamp("2020-01-03"),
        ]
        assert bars["close"].tolist() == [100.0, 101.0]
        assert bars["open"].tolist() == [100.0, 100.5]
        assert list(bars.columns) == ["open", "high", "low", "close", "volume"]

    def test_requests_uppercase_symbol_without_stooq_suffix(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200, text=YAHOO_JSON)

        source = _yahoo_with(handler)
        source.fetch_ohlcv("brk-b.us", date(2020, 1, 2), date(2020, 1, 3))
        assert "/v8/finance/chart/BRK-B?" in seen[0]

    def test_error_payload_raises(self) -> None:
        payload = json.dumps(
            {
                "chart": {
                    "result": None,
                    "error": {"code": "Not Found", "description": "No data found"},
                }
            }
        )
        source = _yahoo_with(lambda request: httpx.Response(200, text=payload))
        with pytest.raises(DataError, match="Not Found"):
            source.fetch_ohlcv("ZZZZ", date(2020, 1, 2), date(2020, 1, 3))

    def test_non_json_response_raises(self) -> None:
        source = _yahoo_with(
            lambda request: httpx.Response(200, text="<html>verify</html>")
        )
        with pytest.raises(DataError, match="not JSON"):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))

    def test_rate_limit_retries_then_fails(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            return httpx.Response(429, text="too many requests")

        source = _yahoo_with(handler)
        with pytest.raises(DataError, match="429"):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))
        assert len(attempts) == YahooSource.MAX_RETRIES + 1

    def test_missing_quote_columns_raise(self) -> None:
        payload = json.dumps(
            {
                "chart": {
                    "result": [
                        {
                            "timestamp": [1577975400],
                            "indicators": {"quote": [{"close": [100.5]}]},
                        }
                    ],
                    "error": None,
                }
            }
        )
        source = _yahoo_with(lambda request: httpx.Response(200, text=payload))
        with pytest.raises(DataError, match="missing columns"):
            source.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 3))


class TestChainedSource:
    def test_falls_back_to_next_source(self) -> None:
        bars = make_bars("2020-01-02", 5, seed=7)
        failing = FakeSource({})
        working = FakeSource({"AAPL": bars})
        chain = ChainedSource((failing, working))
        out = chain.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 10))
        assert not out.empty
        assert failing.calls and working.calls

    def test_aggregates_all_failures(self) -> None:
        chain = ChainedSource((FakeSource({}), FakeSource({})))
        with pytest.raises(DataError, match="all sources failed"):
            chain.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 10))

    def test_programming_errors_propagate(self) -> None:
        class Exploding:
            def fetch_ohlcv(self, ticker: str, start: date, end: date):
                raise RuntimeError("bug, not a data problem")

        chain = ChainedSource((Exploding(), FakeSource({})))
        with pytest.raises(RuntimeError):
            chain.fetch_ohlcv("AAPL", date(2020, 1, 2), date(2020, 1, 10))

    def test_empty_sources_rejected(self) -> None:
        with pytest.raises(ValueError):
            ChainedSource(())
