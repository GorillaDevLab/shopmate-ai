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
    { name: "轻量通勤双肩包", sold: 86, sales: "¥3,698" },
    { name: "云朵柔光台灯", sold: 68, sales: "¥2,816" },
    { name: "可折叠旅行水杯", sold: 51, sales: "¥1,934" },
  ],

  inventoryAlerts: [
    { name: "云朵柔光台灯", inventory: 12 },
    { name: "便携榨汁杯", inventory: 12 },
    { name: "轻量通勤双肩包", inventory: 12 },
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
