import type { Metadata } from "next";

import doc from "@/components/why/doc.module.css";
import { WhyBacktest } from "@/components/why/why-backtest";

export const metadata: Metadata = {
  title: "Why trust this? — QuantDesk",
  description:
    "A live, in-browser backtest of the exact engine behind the daily plan: equity curve vs SPY, drawdowns, what could go wrong, and the parity proof.",
};

const REPO_URL = "https://github.com/fzheng96/quantdesk";

export default function WhyPage() {
  return (
    <div className={doc.page}>
      <header className={doc.pageHeader}>
        <h1>Why trust this?</h1>
        <p className="muted">
          This page does not ask you to take the strategy on faith. It reruns the exact engine
          behind the Today plan over five years of real prices, in your browser, right now — then
          tells you what could still go wrong.
        </p>
      </header>

      <section className={doc.section}>
        <p className={doc.kicker}>The evidence</p>
        <h2>The exact engine, run on your machine</h2>
        <p>
          Most strategy pitches show a polished chart someone prepared earlier. Here, your own
          browser fetches the raw daily closes and pushes them through the same code that will
          write tomorrow&rsquo;s order list. If the data source returns different prices, you will
          see different results — there is no curated version.
        </p>
        <WhyBacktest />
      </section>

      <section className={doc.section} id="what-could-go-wrong">
        <p className={doc.kicker}>The honest part</p>
        <h2>What could go wrong</h2>
        <p>
          Everything above describes one specific past. Here is how the same rules could
          disappoint in the future — not edge cases, but the standard ways strategies like this
          fail.
        </p>

        <h3>The future may not rhyme with this past</h3>
        <p>
          All three rules in the blend are trend-followers at heart. They were rewarded over the
          last five years because big stocks spent most of that time in long trends. In a choppy,
          sideways market the signals flip back and forth, every flip pays trading costs, and the
          blend can bleed for months while doing exactly what it is supposed to do. Nothing
          guarantees the next five years look like the last five.
        </p>

        <h3>A 2022-style year for momentum</h3>
        <p>
          Imagine a year where market leadership flips every few weeks: last year&rsquo;s winners
          fall hardest, the bounces are violent, and nothing trends for long. Long-only momentum
          rules ride the old winners down, finally step aside into cash — and then sit out the
          sharpest rebound days because the signals are still dark. 2022 was that kind of year for
          momentum strategies, and years like it will happen again. The drawdown chart above is a
          rehearsal, not a worst case.
        </p>

        <h3>Costs are assumed, and assumed kindly</h3>
        <p>
          The simulation charges 3 basis points per trade — 0.03%, or $3 per $10,000 traded —
          which is calibrated to huge, liquid stocks on a calm day. Real costs are usually worse,
          and worst exactly when it matters: in fast markets, when everyone is trading the same
          direction. Treat the assumed cost as a floor, and remember that any edge smaller than a
          couple of times that floor is not really an edge.
        </p>

        <h3>These ideas are public, and crowded</h3>
        <p>
          Momentum and moving-average rules have been published for decades. Every professional on
          Earth knows them, which means whatever advantage they once had has likely been competed
          away. Crowding has a second, sharper cost: when many funds hold the same positions and
          de-risk at the same moment, exits get expensive precisely when the rules say to exit.
          The volatility targeting in the blend raises exposure in calm markets — exactly when
          crowded trades are most fragile.
        </p>

        <h3>The universe flatters every number</h3>
        <p>
          The 20-stock universe is made of companies we know <em>today</em> turned out to be
          winners. A backtest over them quietly asks &ldquo;how would these rules have done on
          stocks that already succeeded?&rdquo; — the Enrons and Lehmans of the period are not on
          the list. This survivorship flavor inflates every figure above, and there is no fix
          within free data. There is only remembering it every time a number impresses you.
        </p>

        <p>
          The takeaway, in one sentence: <strong>a good backtest is a reason to be suspicious,
          not a reason to invest</strong> — which is why this app only ever recommends simulated
          trades with pretend money. The <a href="/learn#honesty">Learn page</a> walks through
          each of these traps in more depth.
        </p>
      </section>

      <section className={doc.section} id="parity">
        <p className={doc.kicker}>The proof</p>
        <h2>This engine is the audited engine</h2>
        <p>
          You do not have to trust that the code running in your browser matches the research
          engine in the repository — a test proves it. The Python engine generates a fixture: a
          seeded synthetic price panel together with every target weight, daily net return, equity
          value, and summary metric it computes for each strategy and for the full blend pipeline.
          The browser engine must reproduce <strong>every one of those numbers within a relative
          tolerance of 1e-8</strong> — eight decimal places — or its test suite fails.
        </p>
        <p>
          The Python engine itself carries a tripwire worth knowing about: a deliberately cheating
          strategy that bets on tomorrow&rsquo;s known return is fed through the backtester, and
          the test demands it come out with roughly zero profit. If the engine ever leaked future
          information, that canary would light up and the build would break.
        </p>
        <p>
          Both test suites are public: the browser parity tests live under <code>web/test</code>{" "}
          and the Python engine tests under <code>tests/</code> in{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            the open-source repository
          </a>
          . You can run them yourself.
        </p>
      </section>
    </div>
  );
}
