import { describe, expect, it } from "vitest";
import * as contracts from "../index.js";

const preview = {
  source: "demo",
  metrics: [{ key: "orders", value: 12, changeRatio: 0.02 }],
  products: [
    {
      rank: 1,
      productId: "product-lamp",
      name: "台灯",
      skuCodes: ["LAMP"],
      sold: 3,
      salesMinor: 30000,
    },
  ],
  inventoryAlerts: [
    {
      name: "台灯",
      sku: "LAMP",
      inventory: 0,
      recentSold: 3,
      forecast: { status: "out_of_stock" },
    },
  ],
  trend: [{ label: "一", heightPercent: 45 }],
};

describe("看板预览共享契约（非 Analytics API 契约）", () => {
  it("导出预览 Schema 并接受合法演示数据", () => {
    expect(contracts).toHaveProperty("DashboardPreviewSchema");
    expect(contracts.DashboardPreviewSchema.parse(preview)).toEqual(preview);
  });

  it.each([
    { ...preview, source: "live" },
    { ...preview, products: [{ ...preview.products[0], sold: -1 }] },
    { ...preview, inventoryAlerts: [{ ...preview.inventoryAlerts[0], inventory: 1.5 }] },
    { ...preview, trend: [{ label: "一", heightPercent: 101 }] },
    { ...preview, metrics: [{ key: "unknown", value: 12, changeRatio: 0.02 }] },
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

describe("指标卡片展示契约", () => {
  it.each([0, 1, 1268000, null])("接受整数数值或空值 %s", (value) => {
    expect(
      contracts.DashboardMetricSchema.parse({ key: "sales", value, changeRatio: null }),
    ).toEqual({ key: "sales", value, changeRatio: null });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"])(
    "拒绝非法数值 %s",
    (value) => {
      expect(
        contracts.DashboardMetricSchema.safeParse({ key: "sales", value, changeRatio: 0 }).success,
      ).toBe(false);
    },
  );

  it.each([-1, -0.052, 0, 0.186, 2, null])("接受变化比例 %s", (changeRatio) => {
    expect(
      contracts.DashboardMetricSchema.safeParse({ key: "orders", value: 0, changeRatio }).success,
    ).toBe(true);
  });

  it.each([-1.01, NaN, Infinity, "18.6%"])("拒绝非法变化比例 %s", (changeRatio) => {
    expect(
      contracts.DashboardMetricSchema.safeParse({ key: "orders", value: 0, changeRatio }).success,
    ).toBe(false);
  });

  it("拒绝重复指标", () => {
    expect(
      contracts.DashboardPreviewSchema.safeParse({
        ...preview,
        metrics: [...preview.metrics, ...preview.metrics],
      }).success,
    ).toBe(false);
  });
});
