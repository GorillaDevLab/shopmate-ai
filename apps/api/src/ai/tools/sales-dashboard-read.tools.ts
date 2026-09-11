import { ForbiddenException } from "@nestjs/common";
import {
  GetBestSellersTool,
  GetProductPerformanceTool,
  GetSalesSummaryTool,
  GetSalesTrendTool,
} from "@shopmate/contracts";

import {
  DashboardService,
  type DashboardSummaryResult,
} from "../../analytics/dashboard.service.js";
import {
  ProductPerformanceService,
  type ProductPerformanceRecord,
  type ProductPerformanceResult,
} from "../../analytics/product-performance.service.js";
import { AuthPermission } from "../../auth/contracts/auth-context.js";

import { resolveReadToolPeriod } from "./read-tool-period.js";
import type { ToolInvocationContext, ToolRegistration } from "./tool-registry.js";

type DashboardReader = Pick<DashboardService, "summarize">;
type PerformanceReader = Pick<ProductPerformanceService, "analyze">;
type SalesSummaryInput = ReturnType<typeof GetSalesSummaryTool.input.parse>;
type SalesSummaryOutput = ReturnType<typeof GetSalesSummaryTool.output.parse>;
type SalesTrendInput = ReturnType<typeof GetSalesTrendTool.input.parse>;
type SalesTrendOutput = ReturnType<typeof GetSalesTrendTool.output.parse>;
type BestSellersInput = ReturnType<typeof GetBestSellersTool.input.parse>;
type BestSellersOutput = ReturnType<typeof GetBestSellersTool.output.parse>;
type ProductPerformanceInput = ReturnType<typeof GetProductPerformanceTool.input.parse>;
type ProductPerformanceOutput = ReturnType<typeof GetProductPerformanceTool.output.parse>;

export function createSalesSummaryToolRegistration(
  service: DashboardReader,
): ToolRegistration<SalesSummaryInput, SalesSummaryOutput> {
  return registration(GetSalesSummaryTool, [AuthPermission.OrdersRead], (input, context) =>
    readSalesSummary(service, input, context),
  );
}

export function createSalesTrendToolRegistration(
  service: DashboardReader,
): ToolRegistration<SalesTrendInput, SalesTrendOutput> {
  return registration(GetSalesTrendTool, [AuthPermission.OrdersRead], (input, context) =>
    readSalesTrend(service, input, context),
  );
}

export function createBestSellersToolRegistration(
  service: PerformanceReader,
): ToolRegistration<BestSellersInput, BestSellersOutput> {
  return registration(
    GetBestSellersTool,
    [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
    (input, context) => readBestSellers(service, input, context),
  );
}

export function createProductPerformanceToolRegistration(
  service: PerformanceReader,
): ToolRegistration<ProductPerformanceInput, ProductPerformanceOutput> {
  return registration(
    GetProductPerformanceTool,
    [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
    (input, context) => readProductPerformance(service, input, context),
  );
}

function registration<TInput, TOutput>(
  contract: Omit<ToolRegistration<TInput, TOutput>, "handler" | "requiredPermissions">,
  requiredPermissions: readonly AuthPermission[],
  handler: ToolRegistration<TInput, TOutput>["handler"],
): ToolRegistration<TInput, TOutput> {
  return { ...contract, requiredPermissions, handler };
}

async function readSalesSummary(
  service: DashboardReader,
  input: SalesSummaryInput,
  context: Readonly<ToolInvocationContext>,
): Promise<SalesSummaryOutput> {
  try {
    const period = resolveReadToolPeriod(input);
    const summary = await service.summarize(context, period.endDate, period.startDate);
    if (summary.recent.metrics.orderCount === 0)
      return empty(GetSalesSummaryTool, "没有销售数据。");
    return GetSalesSummaryTool.output.parse({ status: "ok", data: mapSalesSummary(summary) });
  } catch (error: unknown) {
    return GetSalesSummaryTool.output.parse(safeError(error, "销售汇总暂时无法读取。"));
  }
}

async function readSalesTrend(
  service: DashboardReader,
  input: SalesTrendInput,
  context: Readonly<ToolInvocationContext>,
): Promise<SalesTrendOutput> {
  try {
    const period = resolveReadToolPeriod(input);
    const summary = await service.summarize(context, period.endDate, period.startDate);
    if (summary.recent.metrics.orderCount === 0) return empty(GetSalesTrendTool, "没有趋势数据。");
    return GetSalesTrendTool.output.parse({ status: "ok", data: mapSalesTrend(summary) });
  } catch (error: unknown) {
    return GetSalesTrendTool.output.parse(safeError(error, "销售趋势暂时无法读取。"));
  }
}

async function readBestSellers(
  service: PerformanceReader,
  input: BestSellersInput,
  context: Readonly<ToolInvocationContext>,
): Promise<BestSellersOutput> {
  try {
    const period = resolveReadToolPeriod(input);
    const result = await service.analyze(context, period.endDate, period.startDate);
    const sellers = result.hotSellers
      .filter((product) => product.unitsSold > 0)
      .slice(0, input.limit);
    if (sellers.length === 0) return empty(GetBestSellersTool, "没有热销商品数据。");
    return GetBestSellersTool.output.parse({
      status: "ok",
      data: mapBestSellers(result, sellers),
    });
  } catch (error: unknown) {
    return GetBestSellersTool.output.parse(safeError(error, "热销排行暂时无法读取。"));
  }
}

async function readProductPerformance(
  service: PerformanceReader,
  input: ProductPerformanceInput,
  context: Readonly<ToolInvocationContext>,
): Promise<ProductPerformanceOutput> {
  try {
    const period = resolveReadToolPeriod(input);
    const result = await service.analyze(context, period.endDate, period.startDate);
    const products = selectProducts(result.products, input.productId).slice(0, input.limit);
    if (input.productId && products.length === 0) return productNotFound();
    if (products.length === 0) return empty(GetProductPerformanceTool, "没有商品表现数据。");
    return GetProductPerformanceTool.output.parse({
      status: "ok",
      data: mapProductPerformance(result, products),
    });
  } catch (error: unknown) {
    return GetProductPerformanceTool.output.parse(safeError(error, "商品表现暂时无法读取。"));
  }
}

function mapSalesSummary(summary: DashboardSummaryResult) {
  const metrics = summary.recent.metrics;
  return {
    source: "DashboardService" as const,
    period: period(summary.recent.currentWindow),
    revenueMinor: metrics.revenueCents,
    currency: "CNY" as const,
    orderCount: metrics.orderCount,
    unitsSold: metrics.unitsSold,
    averageOrderValueMinor: metrics.averageOrderValueCents,
  };
}

function mapSalesTrend(summary: DashboardSummaryResult) {
  return {
    source: "DashboardService" as const,
    period: period(summary.recent.currentWindow),
    currency: "CNY" as const,
    points: summary.recent.dailyTrend.map((point) => ({
      date: point.date,
      revenueMinor: point.revenueCents,
    })),
  };
}

function mapBestSellers(
  result: ProductPerformanceResult,
  sellers: readonly ProductPerformanceRecord[],
) {
  return {
    source: "ProductPerformanceService" as const,
    period: period(result.currentWindow),
    items: sellers.map((product) => ({
      rank: product.salesRank,
      productId: product.productId,
      productName: product.productName,
      unitsSold: product.unitsSold,
      revenueMinor: product.revenueCents,
      currency: "CNY" as const,
    })),
  };
}

function mapProductPerformance(
  result: ProductPerformanceResult,
  products: readonly ProductPerformanceRecord[],
) {
  return {
    source: "ProductPerformanceService" as const,
    period: period(result.currentWindow),
    currency: "CNY" as const,
    items: products.map((product) => ({
      productId: product.productId,
      productName: product.productName,
      unitsSold: product.unitsSold,
      revenueMinor: product.revenueCents,
      previousUnitsSold: product.previousUnitsSold,
      previousRevenueMinor: product.previousRevenueCents,
      unitChangeRatio: percentToRatio(product.unitTrend.changePercent),
      revenueChangeRatio: percentToRatio(product.revenueTrend.changePercent),
    })),
  };
}

function selectProducts(products: readonly ProductPerformanceRecord[], productId?: string) {
  return productId ? products.filter((product) => product.productId === productId) : products;
}

function period(window: { readonly startDate: string; readonly endDate: string }) {
  return {
    startDate: window.startDate,
    endDate: window.endDate,
    timezone: "Asia/Shanghai" as const,
  };
}

function percentToRatio(value: number | null): number | null {
  return value === null ? null : value / 100;
}

function empty<T>(contract: { output: { parse(value: unknown): T } }, message: string): T {
  return contract.output.parse({ status: "empty", reason: "NO_DATA", message });
}

function productNotFound(): ProductPerformanceOutput {
  return GetProductPerformanceTool.output.parse({
    status: "error",
    error: { code: "NOT_FOUND", message: "未找到当前商家范围内的商品。", retryable: false },
  });
}

function safeError(error: unknown, unavailableMessage: string) {
  if (error instanceof ForbiddenException) {
    return {
      status: "error" as const,
      error: { code: "FORBIDDEN", message: "当前身份无权读取销售数据。", retryable: false },
    };
  }
  if (error instanceof RangeError) {
    return {
      status: "error" as const,
      error: { code: "INVALID_RANGE", message: "销售日期范围无效。", retryable: false },
    };
  }
  return {
    status: "error" as const,
    error: { code: "UNAVAILABLE", message: unavailableMessage, retryable: true },
  };
}
