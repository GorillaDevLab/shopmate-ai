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
    expect(DEFAULT_DASHBOARD_LAYOUT.cards).toHaveLength(7);
  });

  it("注册表覆盖所有可用组件", () => {
    for (const card of DEFAULT_DASHBOARD_LAYOUT.cards) {
      expect(DASHBOARD_COMPONENT_REGISTRY[card.component]).toBeDefined();
    }
  });

  it.each([
    { ...DEFAULT_DASHBOARD_LAYOUT, version: 3 },
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
    expect(DashboardLayoutSchema.parse({ version: 2, cards: [] })).toEqual({
      version: 2,
      cards: [],
    });
  });

  it("接受饼图和报告配置，并迁移已有 version 1 布局", () => {
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
        version: 2,
        cards: [
          {
            id: "ai-pie-1",
            component: "pieChart",
            size: "1/2",
            config: { title: "商品销售额占比", query: insightQuery },
          },
        ],
      }).success,
    ).toBe(true);

    expect(parseDashboardLayout({ version: 1, cards: [] })).toEqual({ version: 2, cards: [] });
  });
});
