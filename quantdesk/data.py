"""Market data sourcing and caching.

The pieces that live here:

- ``YahooSource``: daily OHLCV bars from the unofficial Yahoo chart API.
- ``StooqSource``: daily OHLCV bars from the free Stooq CSV endpoint.
- ``ChainedSource``: tries sources in order until one yields bars.
- ``PriceCache``: a SQLite-backed bar cache keyed by (ticker, date).
- ``get_prices``: cache-first assembly of a wide close-price frame.

Network access happens only inside the source classes. Everything else
operates on an injected source object, which is how the test suite stays
fully offline.
"""

from __future__ import annotations

import calendar
import io
import json
import sqlite3
import time
from collections.abc import Sequence
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
from typing import Protocol

import httpx
import pandas as pd

__all__ = [
    "DataError",
    "OHLCVSource",
    "YahooSource",
    "StooqSource",
    "ChainedSource",
    "PriceCache",
    "get_prices",
    "OHLCV_COLUMNS",
    "MAX_FFILL_DAYS",
    "DEFAULT_CACHE_PATH",
]

OHLCV_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume")

MAX_FFILL_DAYS: int = 3

# Relative to the current working directory, like every default path in this
# project; running from a different directory uses (or creates) a different
# cache file.
DEFAULT_CACHE_PATH = Path("data") / "cache.sqlite"

_STOOQ_URL = "https://stooq.com/q/d/l/"

_YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"


class DataError(Exception):
    """Raised when market data cannot be fetched or fails validation."""


class OHLCVSource(Protocol):
    """Anything that can produce daily bars for one ticker.

    Implementations return a DataFrame with columns open, high, low, close,
    volume and an ascending DatetimeIndex, and raise ``DataError`` when no
    usable data exists for the requested window.
    """

    def fetch_ohlcv(self, ticker: str, start: date, end: date) -> pd.DataFrame: ...


class StooqSource:
    """Daily OHLCV bars from the public Stooq CSV endpoint.

    Limitations worth knowing: the endpoint is free and unauthenticated, so
    it can throttle or return empty bodies under load; tickers without an
    explicit exchange suffix are assumed to be US listings; and Stooq does
    not document its adjustment policy, so treat the values as
    research-grade rather than audited.
    """

    TIMEOUT_SECONDS: float = 20.0
    MAX_RETRIES: int = 2

    def __init__(
        self, client: httpx.Client | None = None, retry_delay: float = 1.0
    ) -> None:
        """An injected client replaces the default one and brings its own
        timeout configuration; ``retry_delay`` is the pause in seconds
        between retry attempts."""
        self._client = client
        self._retry_delay = retry_delay

    def fetch_ohlcv(self, ticker: str, start: date, end: date) -> pd.DataFrame:
        """Fetch daily bars for ``[start, end]`` inclusive.

        Raises ``DataError`` when the response is empty, malformed, or all
        attempts fail, and ``ValueError`` when ``start`` is after ``end``.
        """
        if start > end:
            raise ValueError(f"start {start} is after end {end}")
        params = {
            "s": self._symbol(ticker),
            "d1": start.strftime("%Y%m%d"),
            "d2": end.strftime("%Y%m%d"),
            "i": "d",
        }
        return _parse_stooq_csv(self._get(params), ticker)

    @staticmethod
    def _symbol(ticker: str) -> str:
        # Stooq expects US listings as e.g. "aapl.us". Tickers that already
        # carry an exchange suffix, such as "brk-b.us", pass through as-is.
        symbol = ticker.strip().lower()
        return symbol if "." in symbol else f"{symbol}.us"

    def _get(self, params: dict[str, str]) -> str:
        last_error: Exception | None = None
        for attempt in range(self.MAX_RETRIES + 1):
            if attempt > 0 and self._retry_delay > 0:
                time.sleep(self._retry_delay)
            try:
                response = self._request(params)
            except httpx.HTTPError as exc:
                last_error = exc
                continue
            if response.status_code >= 500:
                # Server-side failures are transient often enough to retry;
                # client errors below are not, so they fail fast.
                last_error = DataError(
                    f"Stooq returned HTTP {response.status_code}"
                )
                continue
            if response.status_code != 200:
                raise DataError(
                    f"Stooq returned HTTP {response.status_code} for symbol "
                    f"{params['s']!r}"
                )
            return response.text
        raise DataError(
            f"Stooq request for symbol {params['s']!r} failed after "
            f"{self.MAX_RETRIES + 1} attempts: {last_error}"
        ) from last_error

    def _request(self, params: dict[str, str]) -> httpx.Response:
        if self._client is not None:
            return self._client.get(_STOOQ_URL, params=params)
        with httpx.Client(
            timeout=self.TIMEOUT_SECONDS,
            headers={"User-Agent": "quantdesk/0.1"},
        ) as client:
            return client.get(_STOOQ_URL, params=params)


def _parse_stooq_csv(text: str, ticker: str) -> pd.DataFrame:
    body = text.strip()
    if not body or body.lower().startswith("no data"):
        raise DataError(f"Stooq returned no data for {ticker!r}")
    if body.startswith("<"):
        # Stooq sometimes serves an HTML interstitial (a browser-verification
        # or rate-limit page) in place of the CSV. Naming that case directly
        # beats the generic missing-columns error it would otherwise produce.
        raise DataError(
            f"Stooq returned an HTML page instead of CSV for {ticker!r}; the "
            "endpoint is likely behind a browser-verification or rate-limit "
            "interstitial right now"
        )
    try:
        frame = pd.read_csv(io.StringIO(body))
    except ValueError as exc:
        raise DataError(f"Stooq response for {ticker!r} is not parseable CSV") from exc
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    missing = {"date", *OHLCV_COLUMNS} - set(frame.columns)
    if missing:
        raise DataError(
            f"Stooq response for {ticker!r} is missing columns {sorted(missing)}"
        )
    if frame.empty:
        raise DataError(f"Stooq returned a header but no rows for {ticker!r}")
    try:
        index = pd.DatetimeIndex(
            pd.to_datetime(frame["date"], format="%Y-%m-%d"), name="date"
        )
    except (TypeError, ValueError) as exc:
        raise DataError(f"Stooq response for {ticker!r} has unparseable dates") from exc
    # Individual bad cells become NaN rather than failing the whole fetch,
    # but a close column with no numbers at all means the payload is junk.
    bars = frame[list(OHLCV_COLUMNS)].apply(pd.to_numeric, errors="coerce")
    bars.index = index
    if bars["close"].isna().all():
        raise DataError(f"Stooq response for {ticker!r} has no numeric close prices")
    bars = bars[~bars.index.duplicated(keep="last")]
    return bars.sort_index()


class YahooSource:
    """Daily OHLCV bars from the unofficial Yahoo Finance chart API.

    The v8 chart endpoint needs no key but is unofficial: Yahoo can
    rate-limit it (HTTP 429) or reshape the payload without notice. The
    close column uses Yahoo's adjusted close when present, which makes it
    comparable to Stooq's split-adjusted series; open, high, low, and
    volume stay unadjusted, which is acceptable here because the rest of
    the pipeline consumes closes only. Bar timestamps are converted to US
    Eastern trading dates, so non-US listings are out of scope.
    """

    TIMEOUT_SECONDS: float = 20.0
    MAX_RETRIES: int = 2

    def __init__(
        self, client: httpx.Client | None = None, retry_delay: float = 1.0
    ) -> None:
        """An injected client replaces the default one and brings its own
        timeout configuration; ``retry_delay`` is the pause in seconds
        between retry attempts."""
        self._client = client
        self._retry_delay = retry_delay

    def fetch_ohlcv(self, ticker: str, start: date, end: date) -> pd.DataFrame:
        """Fetch daily bars for ``[start, end]`` inclusive.

        Raises ``DataError`` when the response is malformed, empty, or all
        attempts fail, and ``ValueError`` when ``start`` is after ``end``.
        """
        if start > end:
            raise ValueError(f"start {start} is after end {end}")
        symbol = self._symbol(ticker)
        params = {
            # Yahoo treats period2 as exclusive, so one extra day keeps the
            # requested end date inside the window.
            "period1": str(calendar.timegm(start.timetuple())),
            "period2": str(calendar.timegm((end + timedelta(days=1)).timetuple())),
            "interval": "1d",
        }
        bars = _parse_yahoo_json(self._get(symbol, params), ticker)
        return bars.loc[str(start) : str(end)]

    @staticmethod
    def _symbol(ticker: str) -> str:
        # Yahoo wants plain uppercase US symbols ("BRK-B"), so the Stooq
        # ".us" suffix is stripped when callers share one ticker spelling.
        symbol = ticker.strip().upper()
        return symbol.removesuffix(".US")

    def _get(self, symbol: str, params: dict[str, str]) -> str:
        last_error: Exception | None = None
        for attempt in range(self.MAX_RETRIES + 1):
            if attempt > 0 and self._retry_delay > 0:
                time.sleep(self._retry_delay)
            try:
                response = self._request(symbol, params)
            except httpx.HTTPError as exc:
                last_error = exc
                continue
            if response.status_code >= 500 or response.status_code == 429:
                # Server failures and rate limits are transient often enough
                # to retry; other client errors below fail fast.
                last_error = DataError(
                    f"Yahoo returned HTTP {response.status_code}"
                )
                continue
            if response.status_code != 200:
                raise DataError(
                    f"Yahoo returned HTTP {response.status_code} for symbol "
                    f"{symbol!r}"
                )
            return response.text
        raise DataError(
            f"Yahoo request for symbol {symbol!r} failed after "
            f"{self.MAX_RETRIES + 1} attempts: {last_error}"
        ) from last_error

    def _request(self, symbol: str, params: dict[str, str]) -> httpx.Response:
        if self._client is not None:
            return self._client.get(_YAHOO_URL + symbol, params=params)
        with httpx.Client(
            timeout=self.TIMEOUT_SECONDS,
            headers={"User-Agent": "Mozilla/5.0 (compatible; quantdesk/0.1)"},
        ) as client:
            return client.get(_YAHOO_URL + symbol, params=params)


def _parse_yahoo_json(text: str, ticker: str) -> pd.DataFrame:
    try:
        payload = json.loads(text)
    except ValueError as exc:
        raise DataError(
            f"Yahoo response for {ticker!r} is not JSON; the endpoint may be "
            "rate-limiting or serving an interstitial page right now"
        ) from exc
    chart = payload.get("chart") or {}
    error = chart.get("error")
    if error:
        raise DataError(
            f"Yahoo returned an error for {ticker!r}: "
            f"{error.get('code')}: {error.get('description')}"
        )
    results = chart.get("result") or []
    if not results:
        raise DataError(f"Yahoo returned no result for {ticker!r}")
    result = results[0]
    timestamps = result.get("timestamp") or []
    if not timestamps:
        raise DataError(f"Yahoo returned no rows for {ticker!r}")
    indicators = result.get("indicators") or {}
    quote = (indicators.get("quote") or [{}])[0]
    missing = [column for column in OHLCV_COLUMNS if not quote.get(column)]
    if missing:
        raise DataError(
            f"Yahoo response for {ticker!r} is missing columns {missing}"
        )
    bars = pd.DataFrame(
        {
            column: pd.to_numeric(pd.Series(quote[column]), errors="coerce")
            for column in OHLCV_COLUMNS
        }
    )
    adjclose = (indicators.get("adjclose") or [{}])[0].get("adjclose")
    if adjclose is not None and len(adjclose) == len(timestamps):
        bars["close"] = pd.to_numeric(pd.Series(adjclose), errors="coerce")
    # Daily bar timestamps sit at the US market open in UTC, so converting
    # through US Eastern recovers the trading date.
    bars.index = pd.DatetimeIndex(
        pd.to_datetime(timestamps, unit="s", utc=True)
        .tz_convert("America/New_York")
        .normalize()
        .tz_localize(None),
        name="date",
    )
    if bars["close"].isna().all():
        raise DataError(f"Yahoo response for {ticker!r} has no numeric close prices")
    bars = bars[~bars.index.duplicated(keep="last")]
    return bars.sort_index()


class ChainedSource:
    """Tries each source in order until one returns bars.

    Only ``DataError`` falls through to the next source; programming errors
    propagate immediately. When every source fails, the raised ``DataError``
    names each source's failure so an outage is diagnosable from a single
    message.
    """

    def __init__(self, sources: Sequence[OHLCVSource]) -> None:
        if not sources:
            raise ValueError("sources must not be empty")
        self._sources = tuple(sources)

    def fetch_ohlcv(self, ticker: str, start: date, end: date) -> pd.DataFrame:
        errors: list[str] = []
        for source in self._sources:
            try:
                return source.fetch_ohlcv(ticker, start, end)
            except DataError as exc:
                errors.append(f"{type(source).__name__}: {exc}")
        raise DataError(
            f"all sources failed for {ticker!r} ({'; '.join(errors)})"
        )


class PriceCache:
    """SQLite-backed daily-bar cache.

    Tickers are normalized to lowercase before use as cache keys, so "AAPL"
    and "aapl" share rows. Coverage is tracked as a single [min, max] date
    span per ticker: dates missing inside an already-cached span are assumed
    to be non-trading days and are never re-fetched, so a span polluted with
    genuinely missing rows stays incomplete until the cache file is removed.
    """

    def __init__(self, db_path: str | Path = DEFAULT_CACHE_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ohlcv (
                    ticker TEXT NOT NULL,
                    date TEXT NOT NULL,
                    open REAL,
                    high REAL,
                    low REAL,
                    close REAL,
                    volume REAL,
                    PRIMARY KEY (ticker, date)
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    @staticmethod
    def _key(ticker: str) -> str:
        return ticker.strip().lower()

    def store(self, ticker: str, bars: pd.DataFrame) -> None:
        """Upsert bars; rows with the same (ticker, date) are replaced."""
        key = self._key(ticker)
        rows = []
        for timestamp, row in bars.iterrows():
            day = pd.Timestamp(timestamp).strftime("%Y-%m-%d")
            values = tuple(
                None if pd.isna(row[column]) else float(row[column])
                for column in OHLCV_COLUMNS
            )
            rows.append((key, day, *values))
        with closing(self._connect()) as conn, conn:
            conn.executemany(
                "INSERT OR REPLACE INTO ohlcv VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )

    def load(self, ticker: str, start: date, end: date) -> pd.DataFrame:
        """Return cached bars within ``[start, end]`` inclusive.

        Returns an empty frame with the usual columns and a DatetimeIndex
        when nothing is cached for the window.
        """
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT date, open, high, low, close, volume FROM ohlcv"
                " WHERE ticker = ? AND date BETWEEN ? AND ? ORDER BY date",
                (self._key(ticker), start.isoformat(), end.isoformat()),
            ).fetchall()
        if not rows:
            return pd.DataFrame(
                columns=list(OHLCV_COLUMNS),
                index=pd.DatetimeIndex([], name="date"),
                dtype=float,
            )
        frame = pd.DataFrame(rows, columns=["date", *OHLCV_COLUMNS])
        index = pd.DatetimeIndex(
            pd.to_datetime(frame.pop("date"), format="%Y-%m-%d"), name="date"
        )
        bars = frame.astype(float)
        bars.index = index
        return bars

    def coverage(self, ticker: str) -> tuple[date, date] | None:
        """Return the (first, last) cached dates for a ticker, or None."""
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT MIN(date), MAX(date) FROM ohlcv WHERE ticker = ?",
                (self._key(ticker),),
            ).fetchone()
        if row is None or row[0] is None:
            return None
        return date.fromisoformat(row[0]), date.fromisoformat(row[1])


def get_prices(
    tickers: list[str],
    start: date,
    end: date,
    source: OHLCVSource | None = None,
    cache: PriceCache | None = None,
) -> pd.DataFrame:
    """Assemble a wide frame of close prices, one column per ticker.

    Cache-first: only the date spans the cache does not yet cover are
    fetched from the source, then everything is read back from the cache.
    Gaps of up to ``MAX_FFILL_DAYS`` consecutive missing values are
    forward-filled; longer gaps get their first ``MAX_FFILL_DAYS`` rows
    filled and stay NaN afterwards. Rows where every ticker is still NaN
    (typically before the earliest listing) are dropped; a ticker that
    starts later than the others keeps NaN until its first observation and
    is never backfilled.

    A failed fetch for a missing span is tolerated whenever the cache still
    yields data for the ticker. The common case is a request whose end falls
    on a weekend or holiday with the cache warm through the last trading
    day: the source has no new bars yet, and the cached history is served
    instead of erroring. The same rule means a source outage degrades to
    cached data for already-cached tickers, with the frame simply ending at
    the cached coverage. A ticker with no usable data at all is dropped from
    the result rather than aborting the other tickers; ``DataError`` is
    raised only when every requested ticker fails.

    Honest caveats: cache coverage is a single [min, max] span per ticker,
    so dates absent inside an already-cached span are treated as non-trading
    days and not re-fetched; and a span the source cannot serve (for
    example, a window starting before the ticker's first listing) is retried
    on every call because coverage never advances over it.
    """
    if start > end:
        raise ValueError(f"start {start} is after end {end}")
    if not tickers:
        raise ValueError("tickers must not be empty")
    active_source: OHLCVSource = (
        source
        if source is not None
        else ChainedSource((YahooSource(), StooqSource()))
    )
    active_cache = cache if cache is not None else PriceCache()
    closes: dict[str, pd.Series] = {}
    failures: dict[str, DataError] = {}
    for ticker in tickers:
        spans = _missing_ranges(active_cache.coverage(ticker), start, end)
        fetch_error: DataError | None = None
        for span_start, span_end in spans:
            try:
                bars = active_source.fetch_ohlcv(ticker, span_start, span_end)
            except DataError as exc:
                fetch_error = exc
                continue
            active_cache.store(ticker, bars)
        series = active_cache.load(ticker, start, end)["close"]
        if series.empty and fetch_error is not None:
            failures[ticker] = fetch_error
            continue
        closes[ticker] = series
    if failures and not closes:
        details = "; ".join(f"{ticker}: {error}" for ticker, error in failures.items())
        raise DataError(f"no usable data for any requested ticker ({details})")
    wide = pd.DataFrame(closes).sort_index()
    wide = wide.ffill(limit=MAX_FFILL_DAYS)
    return wide.dropna(how="all")


def _missing_ranges(
    coverage: tuple[date, date] | None, start: date, end: date
) -> list[tuple[date, date]]:
    """Date spans inside ``[start, end]`` that the cache does not cover."""
    if coverage is None:
        return [(start, end)]
    cached_start, cached_end = coverage
    spans: list[tuple[date, date]] = []
    if start < cached_start:
        spans.append((start, cached_start - timedelta(days=1)))
    if end > cached_end:
        spans.append((cached_end + timedelta(days=1), end))
    return spans
