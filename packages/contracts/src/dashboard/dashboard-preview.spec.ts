import { describe, expect, it } from "vitest";
import * as contracts from "../index.js";

const preview = {
  source: "demo",
  metrics: [{ label: "今日订单", value: "12", change: "+2%" }],
  products: [{ name: "台灯", sold: 3, sales: "¥300" }],
  inventoryAlerts: [{ name: "台灯", inventory: 0 }],
  trend: [{ label: "一", heightPercent: 45 }],
};

describe("看板预览共享契约（非 Analytics API 契约）", () => {
  it("导出预览 Schema 并接受合法演示数据", () => {
    expect(contracts).toHaveProperty("DashboardPreviewSchema");
    expect(contracts.DashboardPreviewSchema.parse(preview)).toEqual(preview);
  });

  it.each([
    { ...preview, source: "live" },
    { ...preview, products: [{ name: "台灯", sold: -1, sales: "¥300" }] },
    { ...preview, inventoryAlerts: [{ name: "台灯", inventory: 1.5 }] },
    { ...preview, trend: [{ label: "一", heightPercent: 101 }] },
    { ...preview, metrics: [{ label: "", value: "12", change: "+2%" }] },
    { ...preview, internalSecret: "占位符" },
  ])("拒绝非法预览字段 %#", (input) => {
    expect(contracts.DashboardPreviewSchema.safeParse(input).success).toBe(false);
  });

  it("允许空列表供空态展示使用", () => {
    expect(
      contracts.DashboardPreviewSchema.safeParse({
        source: "demo",
        metrics: [],
        products: [],
        inventoryAlerts: [],
        trend: [],
      }).success,
    ).toBe(true);
  });
});
