import type { Metadata } from "next";

import { PortfolioClient } from "@/components/portfolio/portfolio-client";

export const metadata: Metadata = {
  title: "Portfolio · QuantDesk",
  description:
    "Your simulated paper portfolio: positions, trade history, and performance against simply buying SPY.",
};

export default function PortfolioPage() {
  return <PortfolioClient />;
}
