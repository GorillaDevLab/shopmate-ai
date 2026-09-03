import type { DashboardInsightQuery } from "@shopmate/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeDashboardInsight, generateDashboardInsight } from "./dashboard-insight-api";

const query = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "product",
  dateRange: { start: "2026-08-01", end: "2026-08-31" },
  filters: [],
  order: "desc",
  limit: 8,
  visualization: "pie",
} as DashboardInsightQuery;

const result = {
  kind: "pie",
  title: "商品销售额占比",
  summary: "近 30 天",
  unit: "currencyMinor",
  slices: [],
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("Dashboard Insight API", () => {
  it("使用认证 Cookie 生成预览", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ query, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateDashboardInsight("按商品生成销售额饼图", "pie")).resolves.toEqual({
      query,
      result,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/ai/dashboard-insights/preview",
      expect.objectContaining({ credentials: "include", method: "POST" }),
    );
  });

  it("重新执行已保存的受限查询", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(executeDashboardInsight(query)).resolves.toEqual(result);
  });
});
