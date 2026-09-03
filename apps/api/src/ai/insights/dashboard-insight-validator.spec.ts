import { describe, expect, it } from "vitest";

import { validateDashboardInsightQuery } from "./dashboard-insight-validator.js";

const query = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "product",
  dateRange: { start: "2026-01-01", end: "2026-08-31" },
  filters: [],
  order: "desc",
  limit: 8,
  visualization: "pie",
} as const;

describe("AI 查询语义校验", () => {
  it("允许注册表支持的长日期范围", () => {
    expect(validateDashboardInsightQuery(query)).toEqual(query);
  });

  it.each([
    { ...query, dataset: "inventory" },
    { ...query, aggregation: "average" },
    { ...query, groupBy: "inventoryRisk" },
    {
      ...query,
      filters: [{ field: "platform", operator: "equals", values: ["taobao"] }],
    },
  ])("拒绝未注册的组合或尚未接入的数据源 %#", (input) => {
    expect(() => validateDashboardInsightQuery(input)).toThrow();
  });
});
