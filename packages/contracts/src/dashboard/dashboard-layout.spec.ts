import { describe, expect, it } from "vitest";
import {
  DASHBOARD_COMPONENT_REGISTRY,
  DashboardLayoutSchema,
  DEFAULT_DASHBOARD_LAYOUT,
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
    expect(DashboardLayoutSchema.parse({ version: 1, cards: [] })).toEqual({
      version: 1,
      cards: [],
    });
  });
});
