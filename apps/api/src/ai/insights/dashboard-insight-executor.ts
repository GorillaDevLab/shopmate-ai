import {
  DashboardInsightResultSchema,
  type DashboardInsightQuery,
  type DashboardInsightResult,
} from "@shopmate/contracts";
import { ForbiddenException } from "@nestjs/common";

import type { ToolInvocationContext } from "../tools/tool-registry.js";
import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { getInsightMetric } from "./dashboard-insight-registry.js";
import { validateDashboardInsightQuery } from "./dashboard-insight-validator.js";

interface DashboardReader {
  summarize(
    context: ToolInvocationContext,
    endDate: string,
    startDate?: string,
  ): Promise<{
    readonly recent: {
      readonly metrics: SalesMetrics;
      readonly dailyTrend: readonly { readonly date: string; readonly revenueCents: number }[];
    };
  }>;
}

interface PerformanceReader {
  analyze(
    context: ToolInvocationContext,
    endDate: string,
    startDate?: string,
  ): Promise<{
    readonly products: readonly ProductPerformance[];
  }>;
}

interface InventoryReader {
  analyze(
    context: ToolInvocationContext,
    endDate: string,
    startDate?: string,
  ): Promise<{
    readonly risks: readonly InventoryRisk[];
  }>;
}

interface SalesMetrics {
  readonly revenueCents: number;
  readonly orderCount: number;
  readonly unitsSold: number;
  readonly averageOrderValueCents: number;
}

interface ProductPerformance {
  readonly productId: string;
  readonly productName: string;
  readonly unitsSold: number;
  readonly revenueCents: number;
}

interface InventoryRisk {
  readonly productId: string;
  readonly productName: string;
  readonly skuId: string;
  readonly code: string;
  readonly inventory: number;
  readonly level: string;
}

export class DashboardInsightExecutor {
  constructor(
    private readonly dashboard: DashboardReader,
    private readonly performance: PerformanceReader,
    private readonly inventory: InventoryReader,
  ) {}

  async execute(
    context: ToolInvocationContext,
    rawQuery: unknown,
  ): Promise<DashboardInsightResult> {
    const query = validateDashboardInsightQuery(rawQuery);
    assertReadPermissions(context, query);
    const result =
      query.visualization === "report"
        ? await this.report(context, query)
        : await this.pie(context, query);
    return DashboardInsightResultSchema.parse(result);
  }

  private async pie(context: ToolInvocationContext, query: DashboardInsightQuery) {
    if (query.dataset === "sales" && query.groupBy === "product") {
      return this.productPie(context, query);
    }
    if (query.dataset === "sales" && query.groupBy === "date") {
      return this.datePie(context, query);
    }
    if (query.dataset === "inventory") return this.inventoryPie(context, query);
    throw new Error("当前查询暂不支持饼图");
  }

  private async productPie(context: ToolInvocationContext, query: DashboardInsightQuery) {
    const data = await this.performance.analyze(
      context,
      query.dateRange.end,
      query.dateRange.start,
    );
    const value = query.metric === "unitsSold" ? "unitsSold" : "revenueCents";
    return pieResult(
      query,
      filterProducts(data.products, query).map((item) => ({
        key: item.productId,
        label: item.productName,
        value: item[value],
      })),
    );
  }

  private async datePie(context: ToolInvocationContext, query: DashboardInsightQuery) {
    const data = await this.dashboard.summarize(
      context,
      query.dateRange.end,
      query.dateRange.start,
    );
    return pieResult(
      query,
      data.recent.dailyTrend.map((item) => ({
        key: item.date,
        label: item.date,
        value: item.revenueCents,
      })),
    );
  }

  private async inventoryPie(context: ToolInvocationContext, query: DashboardInsightQuery) {
    const data = await this.inventory.analyze(context, query.dateRange.end, query.dateRange.start);
    const slices = filterInventory(data.risks, query).map((item) => ({
      key: query.groupBy === "sku" ? item.skuId : item.productId,
      label: query.groupBy === "sku" ? item.code : item.productName,
      value: item.inventory,
    }));
    return pieResult(query, slices);
  }

  private async report(context: ToolInvocationContext, query: DashboardInsightQuery) {
    if (query.dataset === "inventory") return this.inventoryReport(context, query);
    if (query.dataset === "products") return this.productReport(context, query);
    return this.salesReport(context, query);
  }

  private async salesReport(context: ToolInvocationContext, query: DashboardInsightQuery) {
    const data = await this.dashboard.summarize(
      context,
      query.dateRange.end,
      query.dateRange.start,
    );
    const metrics = data.recent.metrics;
    return {
      kind: "report" as const,
      title: "经营数据报告",
      summary: `${query.dateRange.start} 至 ${query.dateRange.end} 的经营概览`,
      highlights: reportHighlights(metrics),
      metrics: reportMetrics(metrics),
    };
  }

  private async inventoryReport(context: ToolInvocationContext, query: DashboardInsightQuery) {
    const data = await this.inventory.analyze(context, query.dateRange.end, query.dateRange.start);
    const risks = filterInventory(data.risks, query);
    const inventory = risks.reduce((sum, item) => sum + item.inventory, 0);
    return {
      kind: "report" as const,
      title: "库存风险报告",
      summary: `${query.dateRange.start} 至 ${query.dateRange.end} 的库存风险概览`,
      highlights: risks.length === 0 ? ["当前没有低库存风险。"] : ["建议优先检查库存最低的 SKU。"],
      metrics: [
        { label: "风险 SKU", value: `${risks.length} 项` },
        { label: "风险库存合计", value: `${inventory} 件` },
      ],
    };
  }

  private async productReport(context: ToolInvocationContext, query: DashboardInsightQuery) {
    const data = await this.performance.analyze(
      context,
      query.dateRange.end,
      query.dateRange.start,
    );
    const products = filterProducts(data.products, query);
    return {
      kind: "report" as const,
      title: "商品表现报告",
      summary: `${query.dateRange.start} 至 ${query.dateRange.end} 的商品表现概览`,
      highlights:
        products.length === 0 ? ["所选时段暂无商品销售数据。"] : ["可继续关注头部商品贡献。"],
      metrics: [{ label: "有销售商品", value: `${products.length} 项` }],
    };
  }
}

function pieResult(query: DashboardInsightQuery, rawSlices: readonly PieSlice[]) {
  const direction = query.order === "desc" ? -1 : 1;
  const slices = [...rawSlices]
    .filter((slice) => Number.isFinite(slice.value) && slice.value >= 0)
    .sort((left, right) => direction * (left.value - right.value))
    .slice(0, query.limit);
  return {
    kind: "pie" as const,
    title: insightTitle(query),
    summary: `${query.dateRange.start} 至 ${query.dateRange.end}`,
    unit: getInsightMetric(query.metric).unit,
    slices,
  };
}

interface PieSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

function insightTitle(query: DashboardInsightQuery): string {
  const metric = query.metric === "unitsSold" ? "销量" : "销售额";
  const dimension = query.groupBy === "date" ? "日期" : query.groupBy === "sku" ? "SKU" : "商品";
  return `${dimension}${metric}占比`;
}

function reportMetrics(metrics: SalesMetrics) {
  return [
    { label: "销售额", value: formatCurrency(metrics.revenueCents) },
    { label: "订单量", value: `${metrics.orderCount} 单` },
    { label: "销量", value: `${metrics.unitsSold} 件` },
    { label: "客单价", value: formatCurrency(metrics.averageOrderValueCents) },
  ];
}

function reportHighlights(metrics: SalesMetrics): string[] {
  if (metrics.orderCount === 0) return ["所选时段暂无销售数据。"];
  return [`共完成 ${metrics.orderCount} 笔订单，售出 ${metrics.unitsSold} 件商品。`];
}

function formatCurrency(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

function filterProducts(
  products: readonly ProductPerformance[],
  query: DashboardInsightQuery,
): readonly ProductPerformance[] {
  const values = filterValues(query, "product");
  return values ? products.filter((product) => values.has(product.productId)) : products;
}

function filterInventory(
  risks: readonly InventoryRisk[],
  query: DashboardInsightQuery,
): readonly InventoryRisk[] {
  const products = filterValues(query, "product");
  const skus = filterValues(query, "sku");
  const levels = filterValues(query, "inventoryRisk");
  return risks.filter(
    (risk) =>
      (!products || products.has(risk.productId)) &&
      (!skus || skus.has(risk.skuId)) &&
      (!levels || levels.has(risk.level)),
  );
}

function filterValues(
  query: DashboardInsightQuery,
  field: DashboardInsightQuery["filters"][number]["field"],
): ReadonlySet<string> | undefined {
  const filter = query.filters.find((candidate) => candidate.field === field);
  return filter ? new Set(filter.values) : undefined;
}

function assertReadPermissions(context: ToolInvocationContext, query: DashboardInsightQuery): void {
  const required: AuthPermission[] = [AuthPermission.OrdersRead];
  if (query.dataset !== "sales" || query.groupBy === "product") {
    required.push(AuthPermission.ProductsRead);
  }
  if (required.some((permission) => !context.permissions.includes(permission))) {
    throw new ForbiddenException("当前身份无权读取所需经营数据");
  }
}
