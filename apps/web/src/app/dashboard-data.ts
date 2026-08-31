import { DashboardPreviewSchema } from "@shopmate/contracts";

export type DashboardState = "ready" | "loading" | "empty" | "error";

export const dashboardPreview = DashboardPreviewSchema.parse({
  source: "demo",
  metrics: [
    { key: "sales", value: 1268000, changeRatio: 0.186 },
    { key: "orders", value: 286, changeRatio: 0.124 },
    { key: "units", value: 420, changeRatio: -0.052 },
    { key: "averageOrderValue", value: 4434, changeRatio: 0.055 },
  ],

  products: [
    { rank: 1, name: "轻量通勤双肩包", sku: "BAG-BLACK", sold: 86, salesMinor: 369800 },
    { rank: 2, name: "云朵柔光台灯", sku: "LAMP-WHITE", sold: 68, salesMinor: 281600 },
    { rank: 3, name: "可折叠旅行水杯", sku: "CUP-BLUE", sold: 51, salesMinor: 193400 },
  ],

  inventoryAlerts: [
    {
      name: "云朵柔光台灯",
      sku: "LAMP-WHITE",
      inventory: 12,
      recentSold: 28,
      forecast: { status: "estimated", days: 3 },
    },
    {
      name: "便携榨汁杯",
      sku: "JUICER-GREEN",
      inventory: 0,
      recentSold: 5,
      forecast: { status: "out_of_stock" },
    },
    {
      name: "轻量通勤双肩包",
      sku: "BAG-GRAY",
      inventory: 12,
      recentSold: 0,
      forecast: { status: "no_sales" },
    },
  ],
  trend: [
    { label: "一", heightPercent: 45 },
    { label: "二", heightPercent: 62 },
    { label: "三", heightPercent: 52 },
    { label: "四", heightPercent: 78 },
    { label: "五", heightPercent: 68 },
    { label: "六", heightPercent: 88 },
    { label: "今", heightPercent: 96 },
  ],
});

export const { metrics, products, inventoryAlerts, trend } = dashboardPreview;
