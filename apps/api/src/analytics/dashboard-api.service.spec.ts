import { BadRequestException } from "@nestjs/common";
import { AnalyticsDashboardResponseSchema } from "@shopmate/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { DashboardApiService } from "./dashboard-api.service.js";

describe("DashboardApiService", () => {
  const dashboardService = { summarize: vi.fn() };
  const lowStockService = { analyze: vi.fn() };
  const productPerformanceService = { analyze: vi.fn() };
  const service = new DashboardApiService(
    dashboardService as never,
    lowStockService as never,
    productPerformanceService as never,
  );
  const context = createAuthContext({
    userId: "user-1",
    merchantId: "merchant-1",
    permissions: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dashboardService.summarize.mockResolvedValue(summaryFixture);
    lowStockService.analyze.mockResolvedValue(inventoryFixture);
    productPerformanceService.analyze.mockResolvedValue(productsFixture);
  });

  it("用同一 Merchant 与截止日期并行聚合全部看板数据", async () => {
    const result = await service.get(context, { asOfDate: "2026-08-31" });

    expect(dashboardService.summarize).toHaveBeenCalledWith(context, "2026-08-31");
    expect(lowStockService.analyze).toHaveBeenCalledWith(context, "2026-08-31");
    expect(productPerformanceService.analyze).toHaveBeenCalledWith(context, "2026-08-31");
    expect(AnalyticsDashboardResponseSchema.safeParse(result).success).toBe(true);
  });

  it("映射七天指标、真实 SKU、趋势与库存预测状态", async () => {
    const result = await service.get(context, { asOfDate: "2026-08-31" });

    expect(result).toEqual({
      asOfDate: "2026-08-31",
      period: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
      metrics: [
        { key: "sales", value: 12_680_00, changeRatio: 0.186 },
        { key: "orders", value: 286, changeRatio: 0.124 },
        { key: "units", value: 320, changeRatio: null },
        { key: "averageOrderValue", value: 4_434, changeRatio: -0.052 },
      ],
      trend: [
        { date: "2026-08-25", revenueMinor: 520_00 },
        { date: "2026-08-26", revenueMinor: 680_00 },
        { date: "2026-08-27", revenueMinor: 610_00 },
        { date: "2026-08-28", revenueMinor: 890_00 },
        { date: "2026-08-29", revenueMinor: 760_00 },
        { date: "2026-08-30", revenueMinor: 1_100_00 },
        { date: "2026-08-31", revenueMinor: 1_268_00 },
      ],
      products: [
        {
          rank: 1,
          productId: "product-1",
          name: "云朵柔光台灯",
          skuCodes: ["LIGHT-BLACK", "LIGHT-WHITE"],
          sold: 86,
          salesMinor: 369_800,
        },
      ],
      inventoryAlerts: [
        {
          name: "售罄商品",
          sku: "SKU-EMPTY",
          inventory: 0,
          recentSold: 10,
          forecast: { status: "out_of_stock" },
        },
        {
          name: "无销量商品",
          sku: "SKU-IDLE",
          inventory: 8,
          recentSold: 0,
          forecast: { status: "no_sales" },
        },
        {
          name: "低库存商品",
          sku: "SKU-LOW",
          inventory: 6,
          recentSold: 21,
          forecast: { status: "estimated", days: 2 },
        },
      ],
    });
  });

  it("拒绝无效日期和额外查询参数", async () => {
    await expect(service.get(context, { asOfDate: "2026-02-30" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.get(context, { asOfDate: "2026-08-31", merchantId: "other" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(dashboardService.summarize).not.toHaveBeenCalled();
  });

  it("按稳定上游顺序限制展示数量而不让大商家整页失败", async () => {
    productPerformanceService.analyze.mockResolvedValue({
      hotSellers: [
        {
          ...productsFixture.hotSellers[0],
          skuCodes: Array.from(
            { length: 21 },
            (_, index) => `SKU-${String(index).padStart(2, "0")}`,
          ),
        },
      ],
    });
    lowStockService.analyze.mockResolvedValue({
      risks: Array.from({ length: 101 }, (_, index) => ({
        ...inventoryFixture.risks[2],
        code: `RISK-${String(index).padStart(3, "0")}`,
      })),
    });

    const result = await service.get(context, { asOfDate: "2026-08-31" });

    expect(result.products[0]?.skuCodes).toHaveLength(20);
    expect(result.products[0]?.skuCodes.at(-1)).toBe("SKU-19");
    expect(result.inventoryAlerts).toHaveLength(100);
    expect(result.inventoryAlerts.at(-1)?.sku).toBe("RISK-099");
  });
});

const summaryFixture = {
  asOfDate: "2026-08-31",
  recent: {
    currentWindow: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
    metrics: {
      revenueCents: 12_680_00,
      orderCount: 286,
      unitsSold: 320,
      averageOrderValueCents: 4_434,
    },
    changes: {
      revenue: { changePercent: 18.6 },
      orderCount: { changePercent: 12.4 },
      unitsSold: { changePercent: null },
      averageOrderValue: { changePercent: -5.2 },
    },
    dailyTrend: [
      { date: "2026-08-25", revenueCents: 520_00 },
      { date: "2026-08-26", revenueCents: 680_00 },
      { date: "2026-08-27", revenueCents: 610_00 },
      { date: "2026-08-28", revenueCents: 890_00 },
      { date: "2026-08-29", revenueCents: 760_00 },
      { date: "2026-08-30", revenueCents: 1_100_00 },
      { date: "2026-08-31", revenueCents: 1_268_00 },
    ],
  },
};

const productsFixture = {
  hotSellers: [
    {
      salesRank: 1,
      productId: "product-1",
      productName: "云朵柔光台灯",
      skuCodes: ["LIGHT-BLACK", "LIGHT-WHITE"],
      unitsSold: 86,
      revenueCents: 369_800,
    },
  ],
};

const inventoryFixture = {
  risks: [
    {
      productName: "售罄商品",
      code: "SKU-EMPTY",
      inventory: 0,
      soldUnits7d: 10,
      daysToStockout: 0,
      level: "OUT_OF_STOCK",
    },
    {
      productName: "无销量商品",
      code: "SKU-IDLE",
      inventory: 8,
      soldUnits7d: 0,
      daysToStockout: null,
      level: "WARNING",
    },
    {
      productName: "低库存商品",
      code: "SKU-LOW",
      inventory: 6,
      soldUnits7d: 21,
      daysToStockout: 2,
      level: "CRITICAL",
    },
  ],
};
