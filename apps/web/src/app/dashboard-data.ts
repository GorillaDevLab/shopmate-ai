export type DashboardState = "ready" | "loading" | "empty" | "error";

export const metrics = [
  { label: "今日销售额", value: "¥12,680", change: "+18.6%" },
  { label: "今日订单", value: "286", change: "+12.4%" },
  { label: "库存健康度", value: "92%", change: "良好" },
  { label: "待处理提醒", value: "08", change: "需要关注" },
] as const;

export const products = [
  { name: "轻量通勤双肩包", sold: 86, sales: "¥3,698" },
  { name: "云朵柔光台灯", sold: 68, sales: "¥2,816" },
  { name: "可折叠旅行水杯", sold: 51, sales: "¥1,934" },
] as const;

export const inventoryAlerts = ["云朵柔光台灯", "便携榨汁杯", "轻量通勤双肩包"];
