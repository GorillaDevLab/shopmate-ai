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

  it("拒绝超过 366 天、平均值饼图和不兼容的显式图表", () => {
    expect(() =>
      validateDashboardInsightQuery({
        ...query,
        dateRange: { start: "2025-01-01", end: "2026-01-02" },
      }),
    ).toThrow("366");
    expect(() =>
      validateDashboardInsightQuery({
        ...query,
        metric: "averageOrderValue",
        aggregation: "average",
        groupBy: "store",
        visualization: "pie",
      }),
    ).toThrow("平均值");
    expect(() => validateDashboardInsightQuery({ ...query, visualization: "line" })).toThrow(
      "日期",
    );
  });

  it("保留旧版按日期饼图读取兼容性", () => {
    expect(
      validateDashboardInsightQuery({ ...query, groupBy: "date", visualization: "pie" }),
    ).toMatchObject({ groupBy: "date", visualization: "pie" });
  });

  it("仅在显式兼容选项下接受旧版分组报告", () => {
    const groupedReport = { ...query, groupBy: "store", visualization: "report" } as const;
    expect(() => validateDashboardInsightQuery(groupedReport)).toThrow("报告");
    expect(
      validateDashboardInsightQuery(groupedReport, { allowLegacyGroupedReport: true }),
    ).toEqual(groupedReport);
  });
});
