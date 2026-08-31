import { describe, expect, it } from "vitest";
import { DashboardPreviewSchema } from "../index.js";

const product = {
  rank: 2,
  productId: "product-lamp",
  name: "台灯",
  skuCodes: ["LAMP-WHITE"],
  sold: 3,
  salesMinor: 30000,
};
const alert = {
  name: "台灯",
  sku: "LAMP-WHITE",
  inventory: 12,
  recentSold: 28,
  forecast: { status: "estimated", days: 3 },
};
const preview = {
  source: "demo",
  metrics: [],
  products: [product],
  inventoryAlerts: [alert],
  trend: [],
};

describe("热销与库存展示边界", () => {
  it("接受上游提供的排名、金额分和预测，不重算", () => {
    expect(DashboardPreviewSchema.safeParse(preview).success).toBe(true);
  });
  it.each([
    { ...alert, inventory: 0, recentSold: 0, forecast: { status: "out_of_stock" } },
    { ...alert, recentSold: 0, forecast: { status: "no_sales" } },
    { ...alert, recentSold: null, forecast: { status: "insufficient_data" } },
    { ...alert, forecast: { status: "estimated", days: 0.03 } },
  ])("接受明确的库存预测状态 %#", (inventoryAlert) => {
    expect(
      DashboardPreviewSchema.safeParse({ ...preview, inventoryAlerts: [inventoryAlert] }).success,
    ).toBe(true);
  });
  it("允许未知热销数值，不用零冒充缺失数据", () => {
    expect(
      DashboardPreviewSchema.safeParse({
        ...preview,
        products: [{ ...product, sold: null, salesMinor: null }],
      }).success,
    ).toBe(true);
  });
  it.each([
    { ...product, rank: 0 },
    { ...product, sold: -1 },
    { ...product, sold: 1.5 },
    { ...product, salesMinor: Infinity },
    { ...product, skuCodes: [] },
    { ...product, salesMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...product, secret: "placeholder" },
  ])("拒绝非法热销条目 %#", (item) => {
    expect(DashboardPreviewSchema.safeParse({ ...preview, products: [item] }).success).toBe(false);
  });
  it.each([
    { ...alert, inventory: -1 },
    { ...alert, inventory: 1.5 },
    { ...alert, recentSold: -1 },
    { ...alert, inventory: 0 },
    { ...alert, recentSold: 0 },
    { ...alert, recentSold: null },
    { ...alert, forecast: { status: "estimated", days: 0 } },
    { ...alert, forecast: { status: "estimated", days: Infinity } },
    { ...alert, forecast: { status: "estimated", days: -1 } },
    { ...alert, forecast: { status: "no_sales", days: 0 } },
    { ...alert, forecast: { status: "no_sales" } },
    { ...alert, forecast: { status: "out_of_stock" } },
    { ...alert, forecast: { status: "unknown" } },
  ])("拒绝误导性的预测和非法数值 %#", (item) => {
    expect(DashboardPreviewSchema.safeParse({ ...preview, inventoryAlerts: [item] }).success).toBe(
      false,
    );
  });
  it("拒绝热销商品重复 productId", () => {
    expect(
      DashboardPreviewSchema.safeParse({
        ...preview,
        products: [...preview.products, ...preview.products],
      }).success,
    ).toBe(false);
  });

  it("拒绝库存条目重复 SKU", () => {
    expect(
      DashboardPreviewSchema.safeParse({
        ...preview,
        inventoryAlerts: [...preview.inventoryAlerts, ...preview.inventoryAlerts],
      }).success,
    ).toBe(false);
  });
});
