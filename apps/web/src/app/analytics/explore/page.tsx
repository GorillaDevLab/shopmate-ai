import type { Metadata } from "next";

import { AppearanceProvider } from "../../appearance-provider";
import { ExploreClient } from "./explore-client";

export const metadata: Metadata = {
  title: "AI 图表探索｜ShopMate AI",
};

export default function ExplorePage() {
  return (
    <AppearanceProvider>
      <ExploreClient />
    </AppearanceProvider>
  );
}
