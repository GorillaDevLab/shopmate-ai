import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  AnalyticsDashboardQuerySchema,
  AnalyticsDashboardResponseSchema,
  type AnalyticsDashboardResponse,
  type DashboardInventoryAlert,
  type DashboardMetric,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";
import { DashboardService, type DashboardSummaryResult } from "./dashboard.service.js";
import { LowStockService, type LowStockRiskRecord } from "./low-stock.service.js";
import {
  ProductPerformanceService,
  type ProductPerformanceRecord,
} from "./product-performance.service.js";

@Injectable()
export class DashboardApiService {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly lowStockService: LowStockService,
    private readonly productPerformanceService: ProductPerformanceService,
  ) {}

  async get(context: AuthContext, rawQuery: unknown): Promise<AnalyticsDashboardResponse> {
    const query = AnalyticsDashboardQuerySchema.safeParse(rawQuery);
    if (!query.success) throwInvalidInput();

    try {
      const [summary, inventory, products] = await Promise.all([
        this.dashboardService.summarize(context, query.data.asOfDate),
        this.lowStockService.analyze(context, query.data.asOfDate),
        this.productPerformanceService.analyze(context, query.data.asOfDate),
      ]);

      return AnalyticsDashboardResponseSchema.parse({
        asOfDate: summary.asOfDate,
        period: summary.recent.currentWindow,
        metrics: toMetrics(summary),
        trend: summary.recent.dailyTrend.map(({ date, revenueCents }) => ({
          date,
          revenueMinor: revenueCents,
        })),
        products: products.hotSellers.slice(0, 10).map(toHotProduct),
        inventoryAlerts: inventory.risks.slice(0, 100).map(toInventoryAlert),
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throwUnavailable();
    }
  }
}

function toMetrics(summary: DashboardSummaryResult): DashboardMetric[] {
  const { metrics, changes } = summary.recent;
  return [
    metric("sales", metrics.revenueCents, changes.revenue.changePercent),
    metric("orders", metrics.orderCount, changes.orderCount.changePercent),
    metric("units", metrics.unitsSold, changes.unitsSold.changePercent),
    metric(
      "averageOrderValue",
      metrics.averageOrderValueCents,
      changes.averageOrderValue.changePercent,
    ),
  ];
}

function metric(
  key: DashboardMetric["key"],
  value: number,
  changePercent: number | null,
): DashboardMetric {
  return {
    key,
    value,
    changeRatio: changePercent === null ? null : Math.round(changePercent * 10) / 1_000,
  };
}

function toHotProduct(product: ProductPerformanceRecord) {
  return {
    rank: product.salesRank,
    productId: product.productId,
    name: product.productName,
    skuCodes: product.skuCodes.slice(0, 20),
    sold: product.unitsSold,
    salesMinor: product.revenueCents,
  };
}

function toInventoryAlert(risk: LowStockRiskRecord): DashboardInventoryAlert {
  return {
    name: risk.productName,
    sku: risk.code,
    inventory: risk.inventory,
    recentSold: risk.soldUnits7d,
    forecast: toForecast(risk),
  };
}

function toForecast(risk: LowStockRiskRecord): DashboardInventoryAlert["forecast"] {
  if (risk.inventory === 0 || risk.level === "OUT_OF_STOCK") return { status: "out_of_stock" };
  if (risk.soldUnits7d === 0) return { status: "no_sales" };
  if (risk.daysToStockout !== null && risk.daysToStockout > 0) {
    return { status: "estimated", days: risk.daysToStockout };
  }
  return { status: "insufficient_data" };
}

function throwInvalidInput(): never {
  throw new BadRequestException({
    statusCode: 400,
    error: "请求参数无效",
    message: "请求参数校验失败",
  });
}

function throwUnavailable(): never {
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "ANALYTICS_SERVICE_UNAVAILABLE",
    message: "经营分析服务暂不可用，请稍后重试",
  });
}
