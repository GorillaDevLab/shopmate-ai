import { describe, expect, it } from "vitest";

import {
  DashboardInsightGenerateRequestSchema,
  DashboardInsightQuerySchema,
  DashboardInsightResultSchema,
  getDashboardInsightViews,
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

  it.each(["auto", "pie", "bar", "line", "area", "report"])("生成请求接受 %s 图表意图", (kind) => {
    expect(DashboardInsightGenerateRequestSchema.parse({ question: "查询", kind })).toEqual({
      question: "查询",
      kind,
    });
  });

  it("查询不接受 auto，但接受具体图表类型", () => {
    for (const visualization of ["pie", "bar", "line", "area", "report"] as const) {
      expect(
        DashboardInsightQuerySchema.safeParse({
          ...query,
          groupBy: visualization === "report" ? null : query.groupBy,
          visualization,
        }).success,
      ).toBe(true);
    }
    expect(DashboardInsightQuerySchema.safeParse({ ...query, visualization: "auto" }).success).toBe(
      false,
    );
  });

  it("从查询纯函数推导兼容视图", () => {
    expect(getDashboardInsightViews(query)).toEqual(["pie", "bar"]);
    expect(
      getDashboardInsightViews({
        ...query,
        metric: "averageOrderValue",
        aggregation: "average",
        groupBy: "store",
        visualization: "bar",
      }),
    ).toEqual(["bar"]);
    expect(getDashboardInsightViews({ ...query, groupBy: "date", visualization: "line" })).toEqual([
      "line",
      "area",
      "bar",
    ]);
    expect(getDashboardInsightViews({ ...query, groupBy: null, visualization: "report" })).toEqual([
      "report",
    ]);
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

  it("接受最多 366 个日期唯一且升序的序列结果", () => {
    const points = Array.from({ length: 366 }, (_, index) => {
      const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
      return { date, value: index };
    });
    expect(
      DashboardInsightResultSchema.parse({
        kind: "series",
        title: "每日销售额",
        summary: "全年趋势",
        unit: "currencyMinor",
        points,
      }),
    ).toBeTruthy();
    expect(
      DashboardInsightResultSchema.safeParse({
        kind: "series",
        title: "每日销售额",
        summary: "错误顺序",
        unit: "currencyMinor",
        points: [points[1], points[0]],
      }).success,
    ).toBe(false);
  });
});
