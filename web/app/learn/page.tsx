import type { Metadata } from "next";

import doc from "@/components/why/doc.module.css";

export const metadata: Metadata = {
  title: "Learn — QuantDesk",
  description:
    "How to read every screen, a guided first session, how to not fool yourself with backtests, and a plain-English glossary. Written for people who have never traded.",
};

const REPO_URL = "https://github.com/fzheng96/quantdesk";

export default function LearnPage() {
  return (
    <div className={doc.page}>
      <header className={doc.pageHeader}>
        <h1>Learn</h1>
        <p className="muted">
          For people who have never traded and want to understand what any of this means. Plain
          words throughout; every term of art is in the <a href="#glossary">glossary</a>.
        </p>
      </header>

      <nav className={doc.toc} aria-label="Contents">
        <strong>Contents</strong>
        <ol>
          <li>
            <a href="#what">What is this, really?</a>
          </li>
          <li>
            <a href="#screens">How to read each screen</a>
          </li>
          <li>
            <a href="#first-session">Your first five minutes</a>
          </li>
          <li>
            <a href="#honesty">How to not fool yourself</a>
          </li>
          <li>
            <a href="#glossary">Glossary</a>
          </li>
        </ol>
      </nav>

      {/* ============================================================ */}
      <section className={doc.section} id="what">
        <p className={doc.kicker}>Part 1</p>
        <h2>What is this, really?</h2>

        <p>QuantDesk does two things, and it helps to keep them separate in your head:</p>
        <ol>
          <li>
            <strong>Paper trading</strong> — &ldquo;let me follow a systematic rule starting
            today, with pretend money, and see how it goes.&rdquo; You get an imaginary account
            (the default is $100,000 of imaginary cash), the app tells you each day what the rule
            would trade, and it keeps a ledger of what you&rsquo;d own and what it would be worth.
          </li>
          <li>
            <strong>Backtesting</strong> — &ldquo;if I had followed this rule for the last five
            years, what would have happened?&rdquo; The <a href="/why">Why page</a> runs that
            simulation live in your browser: real historical prices, the rule applied day by day,
            estimated trading costs subtracted.
          </li>
        </ol>

        <h3>Paper trading vs. real trading</h3>
        <p>
          When you trade for real, you send orders to a brokerage, real dollars move, and you can
          lose them. Paper trading is the flight-simulator version: the prices are real, the
          decisions are real, but the money is made up. Every simulated trade is recorded in your
          browser&rsquo;s local storage, on your device — nothing is sent anywhere. If a strategy
          loses 30% in paper trading, you have learned something valuable and it cost you nothing.
        </p>
        <p>
          Professionals validate ideas this way too, because following a strategy forward in time
          catches things a backtest cannot: you experience the waiting, the drawdowns, and the
          days the data source is down — in calendar order, without the ability to peek ahead.
        </p>

        <h3>Why this app refuses to touch real money</h3>
        <p>
          This is a deliberate design decision, not a missing feature. There is no code path in
          this app that can place a real order: the portfolio is a ledger in your browser, and the
          only network requests the app makes are for free price data. Why so strict? Because the
          strategies here are decades-old published ideas. Whatever edge they once had is known to
          every professional on Earth and has likely been competed away, especially after costs. A
          tool like this is for <em>learning how strategy evaluation works</em> — what the metrics
          mean, where the traps are — not for making money. Wiring it to real money would mostly
          be a machine for converting overconfidence into losses.
        </p>

        <p className={doc.calloutWarn}>
          Everything this app shows is simulated, computed from free market data. Nothing on this
          site is investment advice. If you take one sentence away from this page:{" "}
          <strong>a good backtest is a reason to be suspicious, not a reason to invest.</strong>{" "}
          Part 4 explains why.
        </p>
      </section>

      {/* ============================================================ */}
      <section className={doc.section} id="screens">
        <p className={doc.kicker}>Part 2</p>
        <h2>How to read each screen</h2>

        <h3>Today — the plan</h3>
        <p>
          The first visit asks two questions. The <strong>budget</strong> is pretend money — it
          only sets the scale of the simulation, so the default is fine. The{" "}
          <strong>risk dial</strong> sets how bumpy a ride the strategy aims for. Measured against
          the stock market itself, which has historically run near 16–20% annualized bumpiness:
          &ldquo;conservative&rdquo; targets roughly half that, &ldquo;balanced&rdquo; roughly two
          thirds, and &ldquo;aggressive&rdquo; close to the market&rsquo;s own level. The strategy
          hits these targets only approximately — they are aims, not promises — and you can change
          the setting any time on the Today page.
        </p>
        <p>
          After setup, the page shows <strong>today&rsquo;s plan</strong>: the gap between what
          the strategy wants to hold and what your paper portfolio currently holds, written as
          concrete orders — &ldquo;Buy 17 shares of AAPL — about $5,000.&rdquo; Two things worth
          knowing:
        </p>
        <ul>
          <li>
            <strong>Cash is a position.</strong> If the plan leaves half the account in cash, that
            is the strategy finding only half the stocks worth holding today — caution, not a bug.
          </li>
          <li>
            <strong>One click follows the whole plan.</strong> All orders are applied to your
            paper portfolio at the latest quoted prices — the same prices shown on the order list,
            which the free source can delay by about 15 minutes (the most recent daily close
            stands in when no quote is available). Paper fills pay no commission or slippage;
            only the backtest on the Why page charges those costs. That makes the paper ledger a
            touch friendlier than reality — worth remembering when its numbers look good.
          </li>
        </ul>
        <p>
          Signals update once per day, after the market closes. Checking more often than daily
          changes nothing, and trading much more often than weekly mostly pays costs for no edge.
          The app says this on the page because it is the single most common beginner mistake.
        </p>

        <h3>Portfolio — the ledger</h3>
        <p>
          Positions (shares, current value, weight, profit or loss since purchase), the full trade
          history, and your account&rsquo;s value over time next to one honest comparison:{" "}
          <strong>what if you had just bought SPY on the same start date?</strong> SPY is a fund
          that tracks the S&amp;P 500 — the do-nothing-clever alternative. Over days or weeks the
          difference between the two lines is mostly noise; it starts meaning something after
          months. The reset button wipes the paper ledger and starts over — it asks first.
        </p>

        <h3>Why — the evidence</h3>
        <p>
          The trust page. It reruns the exact engine behind the plan over five years of prices,
          live in your browser, and shows the growth-of-$1 chart against SPY, the drawdown chart
          (how far below its own peak the account sat, day by day — look at the width of the
          valleys, not just the depth), and seven metric cards. Every card has a{" "}
          <strong>?</strong> that explains it in plain English. It also lists what could go wrong,
          and the parity proof that the browser engine matches the repository&rsquo;s audited
          engine to eight decimal places.
        </p>

        <h3>The prices badge</h3>
        <p>
          The badge in the header shows when prices were last refreshed and whether the market is
          open. The honest model behind it: recommendations are computed once per day from closing
          prices, while live quotes — which the free source may delay by up to about 15 minutes —
          keep valuations and order sizes current between closes. If the badge turns amber and
          says &ldquo;stale,&rdquo; quotes have stopped refreshing and values may be minutes old.
        </p>
      </section>

      {/* ============================================================ */}
      <section className={doc.section} id="first-session">
        <p className={doc.kicker}>Part 3</p>
        <h2>Your first five minutes</h2>
        <p>A guided first session, start to finish:</p>
        <ol>
          <li>
            <strong>Set up (1 minute).</strong> On <a href="/">Today</a>, accept the default
            pretend budget and pick a risk level — &ldquo;balanced&rdquo; if unsure. Nothing here
            is binding; you can reset anytime.
          </li>
          <li>
            <strong>Read the plan before following it (2 minutes).</strong> Notice how many
            stocks the strategy wants, the dollar size of each order, and how much stays in cash.
            Hover any number you don&rsquo;t understand — every figure has a plain-English
            explanation one click away.
          </li>
          <li>
            <strong>Follow the plan (1 click).</strong> Every order fills instantly at the quoted
            price; your cash turns into positions and your total value stays exactly the same.
            Notice what did <em>not</em> happen: no commission, no worse-than-quoted price. Real
            orders pay both, and the Why page&rsquo;s backtest charges them on every trade — your
            first, tiny lesson in why paper results flatter and why costs matter.
          </li>
          <li>
            <strong>Visit <a href="/why">Why</a> (2 minutes).</strong> Find the deepest valley in
            the drawdown chart and ask the only question that matters: would I genuinely keep
            following the rules while down that much? Most people would not — they sell at the
            bottom, which converts a temporary drawdown into a permanent loss.
          </li>
          <li>
            <strong>Come back tomorrow, after the market closes.</strong> The plan will usually be
            nearly unchanged — that is normal. Most days the right trade is no trade, and watching
            yourself get bored is part of the lesson.
          </li>
        </ol>
      </section>

      {/* ============================================================ */}
      <section className={doc.section} id="honesty">
        <p className={doc.kicker}>Part 4</p>
        <h2>How to not fool yourself</h2>
        <p>
          The first principle is that you must not fool yourself — and in backtesting, you are the
          easiest person to fool. Great-looking backtests are easy to produce by accident. Here
          are the standard ways, and what this app does (and cannot do) about each.
        </p>

        <h3>1. Ignoring costs</h3>
        <p>
          Every trade pays a commission and pays <em>slippage</em> — the gap between the price on
          your screen and the price you actually get. Three basis points sounds like nothing: $3
          per $10,000 traded. But a strategy that turns over its whole portfolio 20 times a year
          pays 0.6% of the account annually — and that is the <em>optimistic</em> assumption,
          calibrated to huge liquid stocks. Many published &ldquo;anomalies&rdquo; earn 1–2% a
          year on paper and die completely once realistic costs are charged. The backtest on the
          Why page always nets out costs; your job is to remember the assumed number is a floor,
          not an estimate. (Your paper ledger&rsquo;s fills are cost-free — one more reason to
          read its results generously.)
        </p>

        <h3>2. Lookahead bias — trading on tomorrow&rsquo;s newspaper</h3>
        <p>
          The most dangerous bug in backtesting: accidentally letting the simulation use
          information that did not exist yet. The classic version is using today&rsquo;s closing
          price to decide to buy at today&rsquo;s close — in reality, by the time you know the
          close, the market is shut. Results from a leaky backtest look fantastic and mean
          nothing. The engine here enforces a one-day lag by construction: a decision made from
          day <em>t</em>&rsquo;s prices earns day <em>t+1</em>&rsquo;s return, no exceptions. The
          test suite includes a canary — a deliberately cheating strategy that must come out with
          roughly zero profit, or the build fails. Demand this kind of self-test from any
          backtesting tool you trust.
        </p>

        <h3>3. Overfitting — torturing the data until it confesses</h3>
        <p>
          Try 50 variations of a strategy and pick the one with the best historical numbers, and
          you have mostly selected for luck. Warning signs: performance collapses when a parameter
          changes slightly; the pitch needs many qualifiers (&ldquo;only on Tuesdays, except
          December&rdquo;); the backtest improves every time you add a rule. The strategies here
          deliberately have only two or three parameters each, set to the boring values from
          decades-old literature — fewer knobs, less room to fool yourself. The defaults are still
          choices made with hindsight, which is why a good backtest at one setting is weak
          evidence by itself.
        </p>

        <h3>4. Survivorship bias</h3>
        <p>
          The universe here is 20 of today&rsquo;s biggest US companies — companies we already
          know turned out to be winners. Enron, Lehman Brothers, and a hundred forgotten
          near-misses are not on the list. This quietly inflates every number in the app, and
          there is no fix within free data. There is only remembering it every time a result
          impresses you.
        </p>

        <h3>5. Why great backtests usually disappoint live</h3>
        <p>
          Put it together: a backtest is the strategy&rsquo;s best possible self — selected (you
          only ever see the ideas that backtested well), fitted to one specific past, trading at
          optimistic costs with perfect discipline, on a universe of known survivors. Following it
          forward strips away every one of those advantages. The practical rule professionals use:{" "}
          <strong>
            take the backtest Sharpe and cut it in half; assume the live drawdown will be deeper
            than the worst one in the backtest.
          </strong>{" "}
          If the idea still looks worth following — with pretend money — under those assumptions,
          it might be interesting. If it only looks good at full backtest glory, it never was.
        </p>

        <p className={doc.callout}>
          None of this means backtesting is useless. It means a backtest is a filter for
          discarding bad ideas, not a forecast of profits. This app exists to let you run that
          filter honestly — and to let you feel, with pretend money, what the surviving ideas are
          actually like to live with.
        </p>
      </section>

      {/* ============================================================ */}
      <section className={doc.section} id="glossary">
        <p className={doc.kicker}>Part 5</p>
        <h2>Glossary</h2>

        <dl className={doc.gloss}>
          <dt id="g-backtest">Backtest</dt>
          <dd>
            A simulation of how a trading rule would have performed on historical prices. Always
            an overestimate of live performance; see Part 4.
          </dd>

          <dt id="g-basis-point">Basis point (bp)</dt>
          <dd>
            One hundredth of a percent. 1 bp = 0.01%; on $10,000, one basis point is $1. Costs are
            quoted in basis points because they are tiny per trade and deadly in aggregate.
          </dd>

          <dt id="g-benchmark">Benchmark</dt>
          <dd>
            The simple alternative you must beat to justify your complexity. Here: SPY, a fund
            tracking the S&amp;P 500 index of large US stocks.
          </dd>

          <dt id="g-cagr">CAGR (compound annual growth rate)</dt>
          <dd>
            The steady yearly growth rate that would turn the starting value into the ending value
            over the same period. $10,000 → $20,000 in 5 years ≈ 14.9% CAGR.
          </dd>

          <dt id="g-calmar">Calmar ratio</dt>
          <dd>CAGR divided by maximum drawdown — growth per unit of worst-case pain.</dd>

          <dt id="g-close">Close / closing price</dt>
          <dd>
            The last traded price of the day. All recommendations here are computed from daily
            closes.
          </dd>

          <dt id="g-drawdown">Drawdown</dt>
          <dd>
            How far the portfolio currently sits below its own highest point so far.{" "}
            <strong>Maximum drawdown</strong> is the deepest such valley over the whole period —
            shown as a positive number (&ldquo;30%&rdquo; = a 30% peak-to-trough loss).
          </dd>

          <dt id="g-equity">Equity / equity curve</dt>
          <dd>
            The total value of the account (cash + positions) over time. The equity curve is its
            chart, usually normalized to a starting value of $1.
          </dd>

          <dt id="g-fill">Fill</dt>
          <dd>
            An executed order: the moment &ldquo;buy 17 shares&rdquo; becomes a recorded position,
            at a specific price. Here, fills happen in the paper ledger at the latest quoted price
            (possibly delayed about 15 minutes), or at the most recent daily close when no quote
            is available.
          </dd>

          <dt id="g-hit-rate">Hit rate</dt>
          <dd>
            The share of invested days the strategy made money. Good strategies are often barely
            above 50% — that is normal and fine.
          </dd>

          <dt id="g-lookahead">Lookahead bias</dt>
          <dd>
            A simulation accidentally using information not yet available at decision time.
            Produces spectacular, meaningless backtests. The engine guards against it with a
            forced one-day lag and a tripwire test.
          </dd>

          <dt id="g-long-only">Long / long-only</dt>
          <dd>
            Owning something, profiting if it rises. A long-only strategy never bets on declines;
            its only defensive move is holding cash. Everything in this app is long-only.
          </dd>

          <dt id="g-momentum">Momentum</dt>
          <dd>
            The tendency of recent winners to keep winning over months. <em>Time-series</em>{" "}
            momentum compares an asset to its own past; <em>cross-sectional</em> momentum compares
            it to its peers. Two of the blend&rsquo;s three rules are momentum rules.
          </dd>

          <dt id="g-moving-average">Moving average</dt>
          <dd>
            The average price over the last N days, recomputed daily — a smoothed version of the
            price used to read trends through the noise. The blend&rsquo;s third rule holds a
            stock while its 50-day average is above its 200-day average.
          </dd>

          <dt id="g-paper">Paper trading</dt>
          <dd>
            Trading with simulated money at real prices. All trading in this app is paper trading.
          </dd>

          <dt id="g-weight">Portfolio weight</dt>
          <dd>
            The fraction of the account in one asset. &ldquo;AAPL at 5%&rdquo; = $5,000 of a
            $100,000 account in Apple. Unallocated weight sits in cash.
          </dd>

          <dt id="g-rebalance">Rebalance</dt>
          <dd>Trading the portfolio back to its target weights after prices and signals drift.</dd>

          <dt id="g-sharpe">Sharpe ratio</dt>
          <dd>
            Return per unit of volatility. The standard quality score for strategies: ~1 is good
            for daily-data backtests, 3+ usually means an error.
          </dd>

          <dt id="g-slippage">Slippage</dt>
          <dd>
            The gap between the price you expected and the price you actually got, on average
            against you. The simulation assumes 2 bps per trade, on top of 1 bp commission.
          </dd>

          <dt id="g-sortino">Sortino ratio</dt>
          <dd>Like Sharpe, but only penalizing downside volatility.</dd>

          <dt id="g-spy">SPY</dt>
          <dd>An exchange-traded fund tracking the S&amp;P 500. The benchmark throughout.</dd>

          <dt id="g-survivorship">Survivorship bias</dt>
          <dd>
            Testing on assets known today to have survived and thrived, which inflates results.
            The universe here has it; remember that.
          </dd>

          <dt id="g-ticker">Ticker</dt>
          <dd>
            A stock&rsquo;s short exchange symbol: AAPL is Apple, KO is Coca-Cola, SPY is the
            S&amp;P 500 fund.
          </dd>

          <dt id="g-turnover">Turnover</dt>
          <dd>
            How much of the portfolio is traded. Annualized turnover of 5× means a year&rsquo;s
            trades total five times the account value. Turnover × cost-per-trade = the
            strategy&rsquo;s friction bill.
          </dd>

          <dt id="g-universe">Universe</dt>
          <dd>
            The set of assets a strategy is allowed to choose from. Here: 20 large US stocks.
          </dd>

          <dt id="g-vol">Volatility (vol)</dt>
          <dd>
            How much returns wobble, annualized. 15% vol ≈ ±15% swings in an ordinary year, with
            worse entirely possible.
          </dd>

          <dt id="g-vol-target">Volatility targeting</dt>
          <dd>
            Automatically shrinking positions when markets get turbulent and re-expanding when
            they calm, aiming for a steadier ride. The risk dial sets the target: 8%, 12%, or 16%
            annualized.
          </dd>

          <dt id="g-walk-forward">Walk-forward analysis</dt>
          <dd>
            Repeatedly tuning a strategy on one stretch of history and grading it only on the
            following, unseen stretch — the honest way to test. The engine in the repository ships
            it as a library function.
          </dd>
        </dl>
      </section>

      {/* ============================================================ */}
      <section className={doc.section} id="power-users">
        <p className={doc.fineprint}>
          <strong>For power users:</strong> the same engine ships as an open-source Python CLI —
          backtests with full tearsheets, walk-forward analysis, strategy comparisons, and a local
          paper-trading ledger, all from the terminal. Setup instructions are in{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            the repository
          </a>
          .
        </p>
      </section>
    </div>
  );
}
