import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";

import { fetchAnalyticsLayout, saveAnalyticsLayout } from "../analytics-layout-api";
import { addAiCard, createAiCardId } from "../analytics-layout";

/**
 * 把当前图表追加到经营分析末尾。读最新布局后带 revision 保存：
 * 其他设备同时改过布局会得到 409，而不是覆盖对方的改动。
 */
export async function saveChartToAnalytics(
  query: DashboardInsightQuery,
  result: DashboardInsightResult,
): Promise<void> {
  const { layout, revision } = await fetchAnalyticsLayout();
  const next = addAiCard(layout, {
    id: createAiCardId(),
    kind: "aiChart",
    // 时间走势默认占两列，横轴不至于太挤。
    span: result.kind === "series" ? 2 : 1,
    title: result.title,
    query,
  });
  await saveAnalyticsLayout(next, revision);
}
