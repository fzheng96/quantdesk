import type { Metadata } from "next";
import Link from "next/link";
import { LiveBadge } from "@/components/livebadge/live-badge";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuantDesk",
  description:
    "A paper-trading companion: see what a systematic strategy would do today, follow it with pretend money, and check the evidence behind it.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <span className="brand">QuantDesk</span>
          <nav className="site-nav">
            <Link href="/">Today</Link>
            <Link href="/portfolio">Portfolio</Link>
            <Link href="/why">Why</Link>
            <Link href="/learn">Learn</Link>
          </nav>
          <LiveBadge />
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          Everything here is simulated trading with pretend money, computed
          from free market data. Nothing on this site is investment advice.
        </footer>
      </body>
    </html>
  );
}
