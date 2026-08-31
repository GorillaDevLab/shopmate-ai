import { describe, expect, it } from "vitest";
import { AnalyticsDashboardQuerySchema, AnalyticsDashboardResponseSchema } from "../index.js";

const response = {
  asOfDate: "2026-08-31",
  period: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
  metrics: [
    { key: "sales", value: 1268000, changeRatio: 0.186 },
    { key: "orders", value: 286, changeRatio: null },
    { key: "units", value: 420, changeRatio: -0.052 },
    { key: "averageOrderValue", value: 4434, changeRatio: 0 },
  ],
  trend: [
    { date: "2026-08-25", revenueMinor: 520000 },
    { date: "2026-08-26", revenueMinor: 680000 },
    { date: "2026-08-27", revenueMinor: 610000 },
    { date: "2026-08-28", revenueMinor: 890000 },
    { date: "2026-08-29", revenueMinor: 760000 },
    { date: "2026-08-30", revenueMinor: 1040000 },
    { date: "2026-08-31", revenueMinor: 1268000 },
  ],
  products: [
    {
      rank: 1,
      productId: "product-1",
      name: "云感纯棉短袖T恤",
      skuCodes: ["CN-DEMO-001"],
      sold: 86,
      salesMinor: 369800,
    },
  ],
  inventoryAlerts: [
    {
      name: "防晒冰丝袖套",
      sku: "CN-DEMO-003",
      inventory: 12,
      recentSold: 28,
      forecast: { status: "estimated", days: 3 },
    },
  ],
};

describe("Analytics Dashboard API 契约", () => {
  it("接受日期查询和完整响应", () => {
    expect(AnalyticsDashboardQuerySchema.parse({ asOfDate: "2026-08-31" })).toEqual({
      asOfDate: "2026-08-31",
    });
    expect(AnalyticsDashboardResponseSchema.parse(response)).toEqual(response);
  });

  it.each(["2026-8-31", "2026-02-30", "not-a-date", ""])("拒绝非法统计日期 %s", (asOfDate) => {
    expect(AnalyticsDashboardQuerySchema.safeParse({ asOfDate }).success).toBe(false);
  });

  it.each([
    { ...response, secret: "placeholder" },
    { ...response, period: { ...response.period, days: 0 } },
    { ...response, period: { ...response.period, days: Number.MAX_SAFE_INTEGER } },
    {
      ...response,
      metrics: response.metrics.map((metric) => ({ ...metric, key: "sales" })),
    },
    { ...response, trend: response.trend.slice(1) },
    {
      ...response,
      trend: response.trend.map((point, index) =>
        index === 1 ? { ...point, date: "2026-08-25" } : point,
      ),
    },
    {
      ...response,
      trend: response.trend.map((point, index) =>
        index === 0 ? { ...point, revenueMinor: -1 } : point,
      ),
    },
    { ...response, products: [{ ...response.products[0], skuCodes: [] }] },
    { ...response, products: [{ ...response.products[0], skuCodes: ["A", "A"] }] },
    { ...response, inventoryAlerts: [{ ...response.inventoryAlerts[0], inventory: Infinity }] },
  ])("拒绝非法或泄漏字段 %#", (input) => {
    expect(AnalyticsDashboardResponseSchema.safeParse(input).success).toBe(false);
  });
});
