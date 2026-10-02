import { DEFAULT_ANALYTICS_LAYOUT, type DashboardInsightQuery } from "@shopmate/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const layoutApi = vi.hoisted(() => ({
  fetchAnalyticsLayout: vi.fn(),
  saveAnalyticsLayout: vi.fn(),
}));
vi.mock("../analytics-layout-api", () => layoutApi);

import { saveChartToAnalytics } from "./explore-save";

const query: DashboardInsightQuery = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "date",
  dateRange: { start: "2026-08-02", end: "2026-08-31" },
  filters: [],
  order: "asc",
  limit: 12,
  visualization: "line",
};
const series = {
  kind: "series" as const,
  title: "每日销售额",
  summary: "s",
  unit: "currencyMinor" as const,
  points: [],
};

describe("saveChartToAnalytics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends the chart as an AI card and saves against the revision it read", async () => {
    layoutApi.fetchAnalyticsLayout.mockResolvedValue({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 5,
      updatedAt: "2026-09-28T00:00:00.000Z",
    });
    await saveChartToAnalytics(query, series);
    const [layout, revision] = layoutApi.saveAnalyticsLayout.mock.calls[0];
    expect(revision).toBe(5);
    expect(layout.cards.at(-1)).toMatchObject({
      kind: "aiChart",
      title: "每日销售额",
      span: 2,
      query,
    });
    expect(layout.cards.at(-1).id).toMatch(/^ai-[a-f0-9]{24}$/);
  });

  it("does not save when the AI chart limit is reached", async () => {
    const cards = Array.from({ length: 12 }, (_, i) => ({
      id: `ai-${String(i).padStart(24, "0")}`,
      kind: "aiChart" as const,
      span: 1 as const,
      title: "图表",
      query,
    }));
    layoutApi.fetchAnalyticsLayout.mockResolvedValue({
      layout: { version: 1, cards },
      revision: 1,
      updatedAt: "2026-09-28T00:00:00.000Z",
    });
    await expect(saveChartToAnalytics(query, series)).rejects.toThrow("最多保存 12 张 AI 图表");
    expect(layoutApi.saveAnalyticsLayout).not.toHaveBeenCalled();
  });
});
