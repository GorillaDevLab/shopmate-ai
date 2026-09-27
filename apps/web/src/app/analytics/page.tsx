import type { Metadata } from "next";

import { AppearanceProvider } from "../appearance-provider";
import { AnalyticsClient } from "./analytics-client";

export const metadata: Metadata = {
  title: "经营分析｜ShopMate AI",
};

export default function AnalyticsPage() {
  return (
    <AppearanceProvider>
      <AnalyticsClient />
    </AppearanceProvider>
  );
}
