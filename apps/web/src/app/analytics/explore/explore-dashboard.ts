import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";

import { fetchDashboardLayout, saveDashboardLayout } from "../../dashboard-layout-api";
import { createInsightDashboardCard } from "../../dashboard-layout-state";

const MAX_CARDS = 24;

/**
 * 把当前图表追加到已保存的看板末尾。带上读取时的 revision 保存，
 * 其他设备同时改过看板会得到 409，而不是悄悄覆盖对方的改动。
 */
export async function addInsightToDashboard(
  query: DashboardInsightQuery,
  result: DashboardInsightResult,
): Promise<void> {
  const { layout, revision } = await fetchDashboardLayout();
  if (layout.cards.length >= MAX_CARDS)
    throw new Error("看板最多包含 24 张卡片，请先在经营看板移除一些卡片");
  const isReport = result.kind === "report";
  const card = createInsightDashboardCard(
    isReport ? "report" : "pieChart",
    result.title,
    query,
    layout.cards,
    undefined,
    isReport || query.visualization === "report" ? undefined : query.visualization,
  );
  await saveDashboardLayout({
    layout: { ...layout, cards: [...layout.cards, card] },
    expectedRevision: revision,
  });
}
