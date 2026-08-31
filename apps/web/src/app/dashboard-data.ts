import { DashboardPreviewSchema } from "@shopmate/contracts";

export type DashboardState = "ready" | "loading" | "empty" | "error";

export const dashboardPreview = DashboardPreviewSchema.parse({
  source: "demo",
  metrics: [
    { label: "今日销售额", value: "¥12,680", change: "+18.6%" },
    { label: "今日订单", value: "286", change: "+12.4%" },
    { label: "库存健康度", value: "92%", change: "良好" },
    { label: "待处理提醒", value: "08", change: "需要关注" },
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
