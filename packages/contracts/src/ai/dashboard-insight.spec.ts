import { describe, expect, it } from "vitest";

import {
  DashboardInsightGenerateRequestSchema,
  DashboardInsightQuerySchema,
  DashboardInsightResultSchema,
} from "../index.js";

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

describe("AI 经营查询 DSL", () => {
  it("接受不受 31 天限制的严格业务查询", () => {
    expect(DashboardInsightQuerySchema.parse(query)).toEqual(query);
  });

  it.each([
    { ...query, sql: "select * from orders" },
    { ...query, userId: "other-user" },
    { ...query, merchantId: "other-merchant" },
    { ...query, metric: "creditCardNumber" },
    { ...query, limit: 100 },
    { ...query, dateRange: { start: "2026-09-01", end: "2026-08-01" } },
    { ...query, visualization: "pie", groupBy: null },
  ])("拒绝越权、未知或无界查询 %#", (input) => {
    expect(DashboardInsightQuerySchema.safeParse(input).success).toBe(false);
  });

  it("生成请求只接受自然语言问题和目标组件", () => {
    expect(
      DashboardInsightGenerateRequestSchema.parse({ question: "按商品显示销售占比", kind: "pie" }),
    ).toEqual({ question: "按商品显示销售占比", kind: "pie" });
    expect(
      DashboardInsightGenerateRequestSchema.safeParse({
        question: "查询",
        kind: "pie",
        merchantId: "other",
      }).success,
    ).toBe(false);
  });

  it("饼图与报告结果只能携带受限结构化内容", () => {
    expect(
      DashboardInsightResultSchema.parse({
        kind: "pie",
        title: "商品销售额占比",
        summary: "近 30 天",
        unit: "currencyMinor",
        slices: [{ key: "p-1", label: "云感纯棉短袖", value: 120000 }],
      }),
    ).toBeTruthy();

    expect(
      DashboardInsightResultSchema.safeParse({
        kind: "report",
        title: "经营报告",
        summary: "<script>alert(1)</script>",
        highlights: [],
        metrics: [],
        html: "<script>alert(1)</script>",
      }).success,
    ).toBe(false);
  });
});
