# QuantDesk

A small quantitative trading research platform: daily market data with a local
cache, a handful of classic systematic strategies, a cost-aware backtest engine
with walk-forward analysis, simple risk overlays, a paper-trading broker, and
self-contained HTML tearsheets — all driven from one CLI.

## Use it in the browser

The `web/` directory contains a browser app built on the same engine, aimed at
someone with no quant background. It recommends **simulated** trades into a
paper portfolio funded with pretend money; no real money is ever involved, and
nothing in it is investment advice.

- **Today** — answer two questions (pretend budget, risk level) and see the
  exact paper orders the strategy blend would place today, in plain English,
  with every number explained.
- **Portfolio** — track the paper portfolio over time against simply having
  bought SPY on the same start date.
- **Why** — the evidence: a backtest of the blend over the last five years of
  free market data, computed live in your browser, costs included, with the
  caveats spelled out.
- **Learn** — a plain-language guide to every screen and every term.

The TypeScript engine in `web/lib/engine/` is a port of the Python engine in
`quantdesk/`, held to it by parity tests: fixtures produced from the Python
engine must match the TypeScript output within 1e-8 relative tolerance
(`web/test/parity.test.ts`), including the same lookahead-canary convention.
Prices come from the same free sources (Yahoo first, Stooq fallback); when
both are unreachable the app falls back to a clearly labeled built-in demo
dataset.

To run it (requires Node 18+):

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

`npm test` runs the engine, parity, API, and store suites; `npm run build`
makes the production build.

## Disclaimer

**This is a research and learning tool, nothing more.**

- Everything here is **simulated or paper trading**. There is no live-trading
  path in this codebase: the only external broker integration is Alpaca's
  *paper* API, and the adapter rejects any other endpoint by construction.
- **Markets are largely efficient.** The strategies included (momentum, mean
  reversion, moving-average crossovers) are decades-old published ideas. Any
  edge they once had is widely known and may be fully arbitraged away,
  especially after realistic costs.
- **Backtests overstate.** Survivorship in the ticker list, optimistic fill
  assumptions, and parameter choices made with hindsight all flatter results.
  The default cost assumptions (1 bp commission, 2 bps slippage) are guesses
  that understate real frictions for anything less liquid than a megacap.
- **Past performance does not predict future results.**
- **Nothing here is investment advice.** Do not trade real money based on
  output from this software.

## Quickstart

Requires Python 3.10+.

```bash
git clone <repo-url>
cd quantdesk
pip install -e .
quantdesk demo
```

`quantdesk demo` downloads daily prices for a default universe of 20 large US
stocks (plus SPY as the benchmark) from the free data sources described under
[Data](#data), runs every strategy net of costs, prints a comparison table,
and writes a tearsheet to `reports/demo.html`. The first run is slow because
it populates the local cache; later runs reuse it. If no source can be
reached, the demo still finishes on seeded synthetic random walks, with every
table and the tearsheet title loudly labeled `SYNTHETIC DATA`.

To run the tests:

```bash
pip install -e ".[dev]"
pytest
```

No test touches the network.

## CLI commands

All commands accept `--help` for the full option list. `--tickers` takes a
comma-separated list (`--tickers AAPL,MSFT,NVDA`) and defaults to the built-in
universe. Dates are `YYYY-MM-DD`.

### `fetch`

Download daily close prices into the local SQLite cache and summarize coverage
per ticker.

```bash
quantdesk fetch AAPL MSFT NVDA --start 2018-01-01 --end 2024-12-31
quantdesk fetch                  # default universe plus SPY
```

### `backtest`

Run one strategy over the chosen universe, net of commission and slippage,
benchmarked against SPY. Optionally apply a 10% annualized volatility target
and write an HTML tearsheet.

```bash
quantdesk backtest --strategy tsmom --tickers AAPL,MSFT,NVDA --start 2018-01-01
quantdesk backtest --strategy xsmom --vol-target --report reports/xsmom.html
```

### `compare`

Run every registered strategy on identical data and print one table of
metrics, net of costs.

```bash
quantdesk compare --tickers AAPL,MSFT,NVDA,AMZN,GOOGL,META --start 2018-01-01
```

`--synthetic` replaces the fetch with seeded random-walk data for offline
smoke runs; the output is loudly labeled and meaningless as research.

### `scan`

Print the latest target weights for a strategy and the paper orders that would
rebalance the local paper portfolio into them. This only prints suggestions;
nothing is executed.

```bash
quantdesk scan --strategy dma
```

### `paper-apply`

Execute the suggested rebalance against the local paper broker at the latest
close, with slippage applied against you. State persists in
`data/paper.sqlite` across runs — but that path is relative to the directory
you run from, so always run from the same directory (or pass `--db` with an
absolute path) to keep one continuous portfolio.

```bash
quantdesk paper-apply --strategy dma
```

### `paper-status`

Show paper-broker cash, equity, open positions marked at the latest cached
close, and recent fills.

```bash
quantdesk paper-status
```

### `demo`

The full pipeline on the default universe: fetch, compare all strategies, and
render `reports/demo.html` for volatility-targeted time-series momentum.

```bash
quantdesk demo
```

## Strategies

| Key | Strategy | Idea |
| --- | --- | --- |
| `tsmom` | Time-series momentum | Long each asset whose own trailing return (skipping the most recent month) is positive. |
| `xsmom` | Cross-sectional momentum | Long the top N assets ranked by trailing return, equal weight. |
| `meanrev` | Mean reversion | Long assets whose short-term return z-score is deeply negative; exit when it normalizes. |
| `dma` | Dual moving average | Long where the fast moving average is above the slow one. |

Each strategy's docstring describes both the economic rationale and the known
failure modes — momentum crashes at sharp reversals, mean reversion loses when
a "dip" is actually new information, crossovers whipsaw in sideways markets.

## Architecture

```
quantdesk/
  data.py        Yahoo/Stooq downloaders, source chaining, SQLite price cache
  strategies.py  Signal generators that emit daily target weights
  risk.py        Volatility targeting, position caps, drawdown guard
  backtest.py    Execution-lag engine, cost model, walk-forward analysis
  metrics.py     CAGR, Sharpe, Sortino, max drawdown, Calmar, hit rate
  broker.py      SQLite paper broker and an Alpaca paper-only adapter
  report.py      Self-contained HTML tearsheets (inline SVG, no external assets)
  cli.py         Typer commands wiring the modules together
```

Data flows one way: prices come from `data.py`, strategies turn prices into
weights, `risk.py` optionally rescales those weights, `backtest.py` turns
prices plus weights into returns and metrics, and `report.py` renders the
result. The broker is a separate ledger fed by the same target weights.

## Engine convention: costs and the one-day lag

The backtest engine enforces a strict no-lookahead convention, documented here
because every strategy and overlay must respect it:

- `rets = prices.pct_change()` — simple daily returns.
- `weights_used = weights.shift(1)` (missing values filled with 0): a weight
  decided at the close of day *t* earns day *t+1*'s return. A signal can never
  profit from the same bar that produced it.
- `gross_t = sum(weights_used_t * rets_t)`
- `turnover_t = sum(|weights_t - weights_{t-1}|)`
- `cost_t = turnover_t * (commission_bps + slippage_bps) / 10000`, charged on
  day *t* (defaults: 1 bp commission, 2 bps slippage).
- `net = gross - cost`, and `equity = cumprod(1 + net)`.

The test suite includes a lookahead "canary": weights set to the sign of the
*next* day's return — a cheating oracle — must produce roughly zero
performance once run through the engine. If that test ever shows spectacular
returns, the engine is leaking tomorrow's information into today.

Strategy weights themselves must only use information up to and including the
row they are written on, and the sum of absolute weights per row must stay at
or below 1.0 before any risk overlay is applied.

## Data

Prices come from two free sources tried in order: Yahoo Finance's unofficial
v8 chart API first, then Stooq's daily CSV endpoint as a fallback. Both are
keyless; both can throttle or change without notice, which is exactly why
there are two. Yahoo's close column uses the adjusted close (comparable to
Stooq's split-adjusted series); its open/high/low/volume stay unadjusted,
which is fine here because every computation downstream consumes closes only.
Bars are cached in `data/cache.sqlite`, so repeated runs do not refetch. The
cache path is relative to the directory you run from — a run from elsewhere
starts a fresh cache — and `fetch` prints the resolved path it used. Tickers
are written in their plain exchange spelling (for example `BRK-B`); the data
layer maps them to each source's format (`BRK-B` for Yahoo, `brk-b.us` for
Stooq). Gaps are forward-filled up to 3 days; leading missing history is
dropped per ticker. When the sources have no new bars for an already-cached
ticker (a weekend or holiday run, or an outage), the cached history is served
instead of erroring, and a single failing ticker is dropped with a warning
rather than aborting the rest. Free data has errors and missing sessions —
treat results accordingly.

Both endpoints sometimes front their data with rate limits or
browser-verification pages, which this client does not attempt to bypass;
when every source fails, requests raise a `DataError` naming each source's
problem. Tickers with cached history fall back to the cache when that
happens; only when no requested ticker has any usable data does the error
propagate. The `demo` command falls back to clearly labeled synthetic data in
that case, and `compare --synthetic` runs offline by design. All other
commands report the error and exit.

## Paper trading

`PaperBroker` keeps cash, positions, and fill history in a local SQLite file
(`data/paper.sqlite` by default; override with `--db`). The default path is
relative to the current working directory, so each directory gets its own
ledger; `paper-status` prints the resolved path so a missing portfolio is
traceable to the directory it lives in. Fills are simulated at the latest
close with slippage applied against you.

The optional Alpaca adapter talks only to `https://paper-api.alpaca.markets`
and raises if constructed with any other base URL. Credentials are read from
the `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` environment variables (see
`.env.example`); they are never logged and must never be committed.

## License

MIT — see [LICENSE](LICENSE).
