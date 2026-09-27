import { DEFAULT_DASHBOARD_LAYOUT, type DashboardInsightQuery } from "@shopmate/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const layoutApi = vi.hoisted(() => ({
  fetchDashboardLayout: vi.fn(),
  saveDashboardLayout: vi.fn(),
}));
vi.mock("../../dashboard-layout-api", () => layoutApi);

import { addInsightToDashboard } from "./explore-dashboard";

const query: DashboardInsightQuery = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "store",
  dateRange: { start: "2026-08-02", end: "2026-08-31" },
  filters: [],
  order: "desc",
  limit: 8,
  visualization: "bar",
};
const result = {
  kind: "pie" as const,
  title: "各门店销售额",
  summary: "s",
  unit: "currencyMinor" as const,
  slices: [],
};

describe("addInsightToDashboard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends a chart card and saves against the revision it read", async () => {
    layoutApi.fetchDashboardLayout.mockResolvedValue({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      revision: 3,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await addInsightToDashboard(query, result);
    const [request] = layoutApi.saveDashboardLayout.mock.calls[0];
    expect(request.expectedRevision).toBe(3);
    expect(request.layout.cards).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.cards.length + 1);
    expect(request.layout.cards.at(-1)).toMatchObject({
      component: "pieChart",
      config: { title: "各门店销售额", query, view: "bar" },
    });
  });

  it("refuses to exceed the 24-card limit", async () => {
    const card = DEFAULT_DASHBOARD_LAYOUT.cards[0];
    const cards = Array.from({ length: 24 }, (_, i) => ({ ...card, id: `${card.id}-${i}` }));
    layoutApi.fetchDashboardLayout.mockResolvedValue({
      layout: { ...DEFAULT_DASHBOARD_LAYOUT, cards },
      revision: 1,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await expect(addInsightToDashboard(query, result)).rejects.toThrow("最多包含 24 张卡片");
    expect(layoutApi.saveDashboardLayout).not.toHaveBeenCalled();
  });
});
