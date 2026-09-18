import { describe, expect, it } from "vitest";
import {
  DASHBOARD_COMPONENT_REGISTRY,
  DashboardLayoutSchema,
  DEFAULT_DASHBOARD_LAYOUT,
  parseDashboardLayout,
} from "../index.js";

describe("用户看板布局契约", () => {
  it("默认布局可复现并通过严格校验", () => {
    expect(DashboardLayoutSchema.parse(DEFAULT_DASHBOARD_LAYOUT)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(DEFAULT_DASHBOARD_LAYOUT.version).toBe(3);
    expect(DEFAULT_DASHBOARD_LAYOUT.cards).toHaveLength(7);
    expect(DEFAULT_DASHBOARD_LAYOUT.cards.map(({ size }) => size)).toEqual([
      "1x1",
      "1x1",
      "1x1",
      "1x1",
      "2x1",
      "2x1",
      "2x1",
    ]);
  });

  it("注册表覆盖所有可用组件", () => {
    for (const card of DEFAULT_DASHBOARD_LAYOUT.cards) {
      expect(DASHBOARD_COMPONENT_REGISTRY[card.component]).toBeDefined();
    }
  });

  it.each([
    { ...DEFAULT_DASHBOARD_LAYOUT, version: 2 },
    {
      ...DEFAULT_DASHBOARD_LAYOUT,
      cards: [{ ...DEFAULT_DASHBOARD_LAYOUT.cards[0], component: "unknown" }],
    },
    {
      ...DEFAULT_DASHBOARD_LAYOUT,
      cards: [{ ...DEFAULT_DASHBOARD_LAYOUT.cards[0], size: "quarter" }],
    },
    {
      ...DEFAULT_DASHBOARD_LAYOUT,
      cards: [
        DEFAULT_DASHBOARD_LAYOUT.cards[0],
        { ...DEFAULT_DASHBOARD_LAYOUT.cards[0], id: DEFAULT_DASHBOARD_LAYOUT.cards[0].id },
      ],
    },
    {
      ...DEFAULT_DASHBOARD_LAYOUT,
      cards: [{ ...DEFAULT_DASHBOARD_LAYOUT.cards[0], config: { metric: "sales", secret: true } }],
    },
    { ...DEFAULT_DASHBOARD_LAYOUT, internalSecret: "forbidden" },
  ])("拒绝未知版本、组件、尺寸、配置或越权字段 %#", (input) => {
    expect(DashboardLayoutSchema.safeParse(input).success).toBe(false);
  });

  it("允许空布局，供用户删除全部卡片后保存", () => {
    expect(DashboardLayoutSchema.parse({ version: 3, cards: [] })).toEqual({
      version: 3,
      cards: [],
    });
  });

  it("接受受支持的 AI 组件尺寸并拒绝组件不支持的尺寸", () => {
    const insightQuery = {
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
    expect(
      DashboardLayoutSchema.safeParse({
        version: 3,
        cards: [
          {
            id: "ai-pie-1",
            component: "pieChart",
            size: "1x1",
            config: { title: "商品销售额占比", query: insightQuery },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      DashboardLayoutSchema.safeParse({
        version: 3,
        cards: [
          {
            id: "trend",
            component: "salesTrend",
            size: "1x1",
            config: { range: "7d" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("AI 图表保留 pieChart key 并校验可切换视图兼容性", () => {
    expect(DASHBOARD_COMPONENT_REGISTRY.pieChart.label).toBe("AI 图表");
    const dateQuery = {
      dataset: "sales",
      metric: "revenue",
      aggregation: "sum",
      groupBy: "date",
      dateRange: { start: "2026-08-01", end: "2026-08-31" },
      filters: [],
      order: "asc",
      limit: 12,
      visualization: "line",
    } as const;
    expect(
      DashboardLayoutSchema.safeParse({
        version: 3,
        cards: [
          {
            id: "date-chart",
            component: "pieChart",
            size: "2x1",
            config: { title: "销售趋势", query: dateQuery, view: "area" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      DashboardLayoutSchema.safeParse({
        version: 3,
        cards: [
          {
            id: "bad-date-chart",
            component: "pieChart",
            size: "2x1",
            config: { title: "销售趋势", query: dateQuery, view: "pie" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("旧版按日期饼图仍可保存为环形图", () => {
    const legacyDatePie = {
      dataset: "sales",
      metric: "revenue",
      aggregation: "sum",
      groupBy: "date",
      dateRange: { start: "2026-08-01", end: "2026-08-31" },
      filters: [],
      order: "asc",
      limit: 12,
      visualization: "pie",
    } as const;
    expect(
      DashboardLayoutSchema.safeParse({
        version: 3,
        cards: [
          {
            id: "legacy-date-pie",
            component: "pieChart",
            size: "2x1",
            config: { title: "每日销售额占比", query: legacyDatePie, view: "pie" },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("迁移 version 1 和 version 2 布局并保留卡片内容与顺序", () => {
    expect(parseDashboardLayout({ version: 1, cards: [] })).toEqual({ version: 3, cards: [] });
    expect(
      parseDashboardLayout({
        version: 2,
        cards: [
          { id: "metric", component: "metric", size: "1/3", config: { metric: "sales" } },
          { id: "trend", component: "salesTrend", size: "2/3", config: { range: "7d" } },
          { id: "products", component: "hotProducts", size: "full", config: { limit: 3 } },
        ],
      }),
    ).toEqual({
      version: 3,
      cards: [
        { id: "metric", component: "metric", size: "1x1", config: { metric: "sales" } },
        { id: "trend", component: "salesTrend", size: "2x1", config: { range: "7d" } },
        { id: "products", component: "hotProducts", size: "2x1", config: { limit: 3 } },
      ],
    });
  });
});
