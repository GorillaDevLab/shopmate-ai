import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { DashboardService } from "../../analytics/dashboard.service.js";
import type { ProductPerformanceService } from "../../analytics/product-performance.service.js";
import { AuthPermission } from "../../auth/contracts/auth-context.js";

import {
  createBestSellersToolRegistration,
  createProductPerformanceToolRegistration,
  createSalesSummaryToolRegistration,
  createSalesTrendToolRegistration,
} from "./sales-dashboard-read.tools.js";
import { ToolRegistry, type ToolInvocationContext } from "./tool-registry.js";

const context: Readonly<ToolInvocationContext> = {
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
};

describe("销售与 Dashboard AI 读取工具", () => {
  it("销售汇总调用 DashboardService 并保持金额和数量", async () => {
    const summarize = vi.fn(async () => dashboardFixture());
    const registry = dashboardRegistry(summarize);

    const result = await registry.invoke(
      "get_sales_summary",
      { startDate: "2026-08-25", endDate: "2026-08-31" },
      context,
    );

    expect(summarize).toHaveBeenCalledWith(context, "2026-08-31", "2026-08-25");
    expect(result).toMatchObject({
      status: "ok",
      data: { revenueMinor: 174200, orderCount: 5, unitsSold: 27 },
    });
  });

  it("销售趋势返回按日结构化金额", async () => {
    const registry = dashboardRegistry(vi.fn(async () => dashboardFixture()));

    const result = await registry.invoke(
      "get_sales_trend",
      { startDate: "2026-08-25", endDate: "2026-08-31" },
      context,
    );

    expect(result).toMatchObject({
      status: "ok",
      data: {
        points: [
          { date: "2026-08-25", revenueMinor: 59370 },
          { date: "2026-08-26", revenueMinor: 51470 },
        ],
      },
    });
  });

  it("无订单时汇总与趋势返回明确空结果", async () => {
    const summarize = vi.fn(async () => ({
      ...dashboardFixture(),
      recent: {
        ...dashboardFixture().recent,
        metrics: salesMetrics(0, 0, 0, 0),
      },
    }));
    const registry = dashboardRegistry(summarize);

    await expect(
      registry.invoke(
        "get_sales_summary",
        { startDate: "2026-08-25", endDate: "2026-08-31" },
        context,
      ),
    ).resolves.toMatchObject({ status: "empty", reason: "NO_DATA" });
  });

  it("热销排行省略开始日期时使用 Service 默认最近周期", async () => {
    const analyze = vi.fn(async () => performanceFixture());
    const registry = performanceRegistry(analyze);

    const result = await registry.invoke(
      "get_best_sellers",
      { endDate: "2026-08-31", limit: 1 },
      context,
    );

    expect(analyze).toHaveBeenCalledWith(context, "2026-08-31", undefined);
    expect(result).toMatchObject({
      status: "ok",
      data: {
        items: [{ rank: 1, productId: "product-1" }],
      },
    });
  });

  it("热销排行调用 ProductPerformanceService 并应用 limit", async () => {
    const analyze = vi.fn(async () => performanceFixture());
    const registry = performanceRegistry(analyze);

    const result = await registry.invoke(
      "get_best_sellers",
      { startDate: "2026-08-25", endDate: "2026-08-31", limit: 1 },
      context,
    );

    expect(analyze).toHaveBeenCalledWith(context, "2026-08-31", "2026-08-25");
    expect(result).toMatchObject({
      status: "ok",
      data: { items: [{ rank: 1, productId: "product-1", revenueMinor: 120000 }] },
    });
  });

  it("商品表现按商品筛选并把百分比转换成比例", async () => {
    const registry = performanceRegistry(vi.fn(async () => performanceFixture()));

    const result = await registry.invoke(
      "get_product_performance",
      { startDate: "2026-08-25", endDate: "2026-08-31", productId: "product-2" },
      context,
    );

    expect(result).toMatchObject({
      status: "ok",
      data: {
        items: [{ productId: "product-2", unitChangeRatio: -0.3, revenueChangeRatio: -0.25 }],
      },
    });
  });

  it("当前 Merchant 不存在的商品返回不泄露外部数据的安全错误", async () => {
    const registry = performanceRegistry(vi.fn(async () => performanceFixture()));

    const result = await registry.invoke(
      "get_product_performance",
      { startDate: "2026-08-25", endDate: "2026-08-31", productId: "other-product" },
      context,
    );

    expect(JSON.stringify(result)).not.toContain("other-product");
    expect(result).toMatchObject({ status: "error", error: { code: "NOT_FOUND" } });
  });

  it("缺少权限时不会调用 Service", async () => {
    const summarize = vi.fn(async () => dashboardFixture());
    const registry = dashboardRegistry(summarize);

    await expect(
      registry.invoke(
        "get_sales_summary",
        { startDate: "2026-08-25", endDate: "2026-08-31" },
        { ...context, permissions: [] },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("Service 权限错误转换为结构化安全结果", async () => {
    const summarize = vi.fn(async () => Promise.reject(new ForbiddenException()));
    const registry = dashboardRegistry(summarize);

    await expect(
      registry.invoke(
        "get_sales_summary",
        { startDate: "2026-08-25", endDate: "2026-08-31" },
        context,
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "FORBIDDEN" } });
  });
});

function dashboardRegistry(summarize: DashboardService["summarize"]) {
  const registry = new ToolRegistry({
    allowedToolNames: ["get_sales_summary", "get_sales_trend"],
  });
  registry.register(createSalesSummaryToolRegistration({ summarize }));
  registry.register(createSalesTrendToolRegistration({ summarize }));
  return registry;
}

function performanceRegistry(analyze: ProductPerformanceService["analyze"]) {
  const registry = new ToolRegistry({
    allowedToolNames: ["get_best_sellers", "get_product_performance"],
  });
  registry.register(createBestSellersToolRegistration({ analyze }));
  registry.register(createProductPerformanceToolRegistration({ analyze }));
  return registry;
}

function dashboardFixture() {
  const current = salesMetrics(174200, 5, 27, 34840);
  const zero = salesMetrics(0, 0, 0, 0);
  return {
    asOfDate: "2026-08-31",
    today: zero,
    monthToDate: { startDate: "2026-08-01", endDate: "2026-08-31", metrics: current },
    recent: {
      currentWindow: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
      previousWindow: { startDate: "2026-08-18", endDate: "2026-08-24", days: 7 },
      metrics: current,
      previousMetrics: zero,
      changes: {
        revenue: trend(174200, 0, null),
        orderCount: trend(5, 0, null),
        unitsSold: trend(27, 0, null),
        averageOrderValue: trend(34840, 0, null),
      },
      dailyTrend: [
        { date: "2026-08-25", ...salesMetrics(59370, 1, 5, 59370) },
        { date: "2026-08-26", ...salesMetrics(51470, 1, 4, 51470) },
      ],
    },
  };
}

function performanceFixture() {
  const products = [
    performanceProduct("product-1", "商品一", 12, 120000, 6, 60000, 1, 100, 100),
    performanceProduct("product-2", "商品二", 7, 70000, 10, 93333, 2, -30, -25),
  ];
  return {
    currentWindow: { startDate: "2026-08-25", endDate: "2026-08-31", days: 7 },
    previousWindow: { startDate: "2026-08-18", endDate: "2026-08-24", days: 7 },
    products,
    hotSellers: products,
    risingProducts: [products[0]],
    decliningProducts: [products[1]],
    lowPerformers: [products[1]],
  };
}

function performanceProduct(
  productId: string,
  productName: string,
  unitsSold: number,
  revenueCents: number,
  previousUnitsSold: number,
  previousRevenueCents: number,
  rank: number,
  unitChange: number,
  revenueChange: number,
) {
  return {
    productId,
    productName,
    skuCodes: [`SKU-${rank}`],
    unitsSold,
    revenueCents,
    revenue: (revenueCents / 100).toFixed(2),
    previousUnitsSold,
    previousRevenueCents,
    previousRevenue: (previousRevenueCents / 100).toFixed(2),
    salesRank: rank,
    revenueRank: rank,
    isHotSeller: true,
    unitTrend: trend(unitsSold, previousUnitsSold, unitChange),
    revenueTrend: trend(revenueCents, previousRevenueCents, revenueChange),
    performance: unitChange <= -30 ? ("LOW" as const) : ("NORMAL" as const),
    lowPerformanceReasons:
      unitChange <= -30 ? (["DECLINED_AT_LEAST_30_PERCENT"] as const) : ([] as const),
  };
}

function salesMetrics(
  revenueCents: number,
  orderCount: number,
  unitsSold: number,
  averageOrderValueCents: number,
) {
  return {
    revenueCents,
    revenue: (revenueCents / 100).toFixed(2),
    orderCount,
    unitsSold,
    averageOrderValueCents,
    averageOrderValue: (averageOrderValueCents / 100).toFixed(2),
  };
}

function trend(current: number, previous: number, changePercent: number | null) {
  return {
    current,
    previous,
    direction:
      changePercent === null
        ? ("NEW" as const)
        : current < previous
          ? ("DOWN" as const)
          : ("UP" as const),
    changePercent,
  };
}
