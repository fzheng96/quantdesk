# QuantDesk SPEC (authoritative module contracts)

Python >= 3.10, package name quantdesk. Runtime deps: pandas, numpy, typer, rich, httpx. Dev deps: pytest.
Console script: quantdesk = quantdesk.cli:app

## quantdesk/data.py
- class DataError(Exception).
- class StooqSource: fetch_ohlcv(ticker: str, start: date, end: date) -> DataFrame with columns open, high, low, close, volume and a DatetimeIndex. Uses the Stooq CSV endpoint https://stooq.com/q/d/l/?s=<ticker, lowercased, suffixed .us>&d1=<YYYYMMDD>&d2=<YYYYMMDD>&i=d via httpx with a 20s timeout and 2 retries. Validates the CSV schema and raises DataError on empty or malformed responses.
- class PriceCache: SQLite at data/cache.sqlite (path injectable). Table ohlcv(ticker TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY(ticker, date)).
- get_prices(tickers: list[str], start, end, source=None, cache=None) -> wide DataFrame of close prices (columns = tickers). Cache-first; fetches only missing ranges; forward-fills gaps up to 3 days; drops leading NaNs per column. A failed fetch degrades to cached data when the cache yields anything for the ticker (the weekend/no-new-bars case); a ticker with no usable data is dropped from the result, and DataError is raised only when every requested ticker fails.
- All tests inject a FakeSource; tests never touch the network.

## quantdesk/strategies.py
- Strategy protocol: attribute name: str; method generate_weights(prices: DataFrame) -> DataFrame with the same index/columns. The weight in row t may use information up to and including t only; the engine applies it from t+1. Row-wise sum of absolute weights must be <= 1.0.
- TimeSeriesMomentum(lookback=252, skip=21): per asset, weight 1/N if the return over the window ending "skip" days ago and starting "lookback" days ago is positive, else 0.
- CrossSectionalMomentum(lookback=252, skip=21, top_n=5): equal weight on the top_n assets by skip-adjusted momentum, long only.
- MeanReversion(z_window=60, short_window=5, entry_z=-1.5): go long (equal weight among signaled assets) when the z-score of the short_window return relative to its z_window history is below entry_z; exit when the z-score crosses above 0.
- DualMovingAverage(fast=50, slow=200): weight 1/N where the fast moving average exceeds the slow.
- ALL_STRATEGIES: dict[str, type] registry keyed by CLI-friendly names (tsmom, xsmom, meanrev, dma).
- Every strategy docstring explains the economic rationale AND known failure modes, honestly.

## quantdesk/backtest.py and quantdesk/metrics.py
- run_backtest(prices, weights, commission_bps=1.0, slippage_bps=2.0, benchmark_prices=None) -> BacktestResult. Leading NaNs in a price column (late listings) are allowed; NaNs after a column's first observation raise ValueError instead of being flattened into zero returns.
- Engine convention (document and test it): rets = prices.pct_change(); weights_used = weights.shift(1) filled with 0, so a weight decided at the close of day t earns day t+1 returns; gross_t = sum(weights_used_t * rets_t); turnover_t = sum(abs(weights_t - weights_{t-1})); cost_t = turnover_t * (commission_bps + slippage_bps) / 10000 charged on day t; net = gross - cost; equity = cumulative product of (1 + net).
- BacktestResult dataclass: net_returns, equity, weights_used, turnover, costs, metrics: dict, benchmark_equity (optional).
- metrics.py pure functions: cagr, ann_vol, sharpe (rf=0), sortino, max_drawdown returning depth plus peak/trough dates plus duration in days, calmar, hit_rate, monthly_returns table (years x months).
- walk_forward(prices, strategy_grid: dict[str, list[Strategy]], train_years=3, test_years=1): pick the best param set on each training window by Sharpe, apply it to the following test window, stitch the out-of-sample test segments into one BacktestResult per strategy family, and return the per-window parameter choices alongside.
- REQUIRED test (lookahead canary): construct weights equal to the sign of the NEXT day return (a cheating oracle). Run through the engine. Because of the shift, the realized performance must be near zero, not spectacular. This proves the engine cannot leak tomorrow into today.
- Known-answer tests: constant daily return series gives an exactly computable Sharpe; a hand-crafted price path gives an exactly known max drawdown.

## quantdesk/risk.py
- vol_target(weights, prices, target_annual_vol=0.10, lookback=20, max_leverage=1.0): scale each day by target vol over realized annualized vol of the strategy gross returns up to that day (shift so no lookahead), clipped to max_leverage.
- cap_weights(weights, max_weight=0.25): per-position cap with row renormalization only downward (never scale up).
- drawdown_guard(equity, threshold=0.15, resume_at=0.075): exposure multiplier series that goes to 0 while drawdown exceeds threshold and returns to 1 once drawdown recovers above resume_at. Docstring must state honestly that this reduces both risk and, often, long-run return.

## quantdesk/broker.py
- dataclasses Order(symbol, qty: float, side: str), Fill(symbol, qty, side, price, cost, timestamp).
- PaperBroker(db_path="data/paper.sqlite", starting_cash=100000.0): submit(order, price, slippage_bps=2.0) -> Fill (buys fill above price, sells below); positions() -> dict[str, float]; account(prices: dict[str, float]) -> Account(cash, equity); history() -> list[Fill]. State persists in SQLite across runs.
- suggest_orders(positions, target_weights: dict[str, float], prices: dict[str, float], equity: float, min_notional=50.0) -> list[Order]: the rebalance diff between current and target.
- AlpacaPaperAdapter: reads ALPACA_KEY_ID and ALPACA_SECRET_KEY from the environment. BASE_URL is the constant https://paper-api.alpaca.markets and the constructor raises ValueError if any other base URL is supplied — by construction there is no live-trading path in this codebase. Never logs credentials. Methods: submit_order, positions, account, all via httpx.

## quantdesk/report.py
- render_tearsheet(result: BacktestResult, path: str, title: str): writes a fully self-contained HTML file — inline CSS, hand-built inline SVG, zero external requests of any kind. Sections: headline metric cards (CAGR, Sharpe, Sortino, max DD, Calmar, ann. vol, hit rate), equity curve vs benchmark, drawdown area chart, rolling 60-day Sharpe, monthly-return heatmap table, turnover summary, and a footer disclaimer that this is research output from simulated trading, not investment advice. Headline cards are computed via quantdesk.metrics so they match the CLI tables for the same run. Dark theme, system font stack, looks professional.
- Test asserts the output exists, contains expected SVG elements, and contains no http:// or https:// references.

## quantdesk/cli.py (typer app)
- Commands: fetch (tickers, --start, --end); backtest (--strategy, --tickers, --start, --vol-target/--no-vol-target, --report PATH); compare (--tickers, --start) printing a rich table of all strategies net of costs; scan (--strategy, --tickers) printing latest target weights and suggested paper orders; paper-apply (executes suggested orders against PaperBroker at latest close); paper-status; demo (runs the full pipeline on the default universe and writes reports/demo.html).
- DEFAULT_UNIVERSE constant: 20 liquid US megacaps (AAPL MSFT NVDA AMZN GOOGL META TSLA BRK-B JPM V UNH XOM LLY PG MA HD COST ABBV CRM KO; for Stooq use brk-b.us form) plus SPY as benchmark.

## tests/
- pytest, no network anywhere, FakeSource fixtures and synthetic random-walk frames with a fixed seed, the canary and known-answer tests above, broker accounting round-trip (cash + position value conserved up to costs), CLI smoke tests via typer CliRunner with injected fake data, report rendering test.
