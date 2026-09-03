import { ForbiddenException } from "@nestjs/common";
import {
  MonitoringEvaluationSchema,
  type MonitoringEvaluation,
  type MonitoringMatch,
  type MonitoringRuleDefinition,
} from "@shopmate/contracts";

import { AuthPermission, type AuthContext } from "../auth/contracts/index.js";
import { inventoryPeriod, monitoringPeriod } from "./monitoring-schedule.js";

interface DashboardReader {
  summarize(
    context: AuthContext,
    endDate: string,
    startDate?: string,
  ): Promise<{ readonly recent: { readonly metrics: SalesMetrics } }>;
}

interface InventoryReader {
  inventorySnapshot(context: AuthContext): Promise<readonly InventoryRisk[]>;
}

interface SalesMetrics {
  readonly revenueCents: number;
  readonly orderCount: number;
  readonly unitsSold: number;
  readonly averageOrderValueCents: number;
}

interface InventoryRisk {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly code: string;
  readonly inventory: number;
}

export class MonitoringEvaluator {
  constructor(
    private readonly dashboard: DashboardReader,
    private readonly inventory: InventoryReader,
  ) {}

  async evaluate(
    context: AuthContext,
    definition: MonitoringRuleDefinition,
    now: Date,
  ): Promise<MonitoringEvaluation> {
    assertPermission(context, definition);
    const result =
      definition.kind === "salesThreshold"
        ? await this.evaluateSales(context, definition, now)
        : await this.evaluateInventory(context, definition, now);
    return MonitoringEvaluationSchema.parse(result);
  }

  private async evaluateSales(
    context: AuthContext,
    definition: Extract<MonitoringRuleDefinition, { kind: "salesThreshold" }>,
    now: Date,
  ) {
    const period = monitoringPeriod(definition.window, now);
    const summary = await this.dashboard.summarize(context, period.endDate, period.startDate);
    const value = salesMetric(summary.recent.metrics, definition.metric);
    const match = compares(value, definition.operator, definition.threshold)
      ? [salesMatch(context.merchantId, definition, value)]
      : [];
    return evaluation(period, match);
  }

  private async evaluateInventory(
    context: AuthContext,
    definition: Extract<MonitoringRuleDefinition, { kind: "inventoryThreshold" }>,
    now: Date,
  ) {
    const period = inventoryPeriod(now);
    const inventory = await this.inventory.inventorySnapshot(context);
    const allowed = definition.productIds.length > 0 ? new Set(definition.productIds) : undefined;
    const matches = inventory
      .filter(
        (risk) =>
          (!allowed || allowed.has(risk.productId)) && risk.inventory < definition.threshold,
      )
      .sort((left, right) => left.inventory - right.inventory)
      .slice(0, 20)
      .map(inventoryMatch);
    return evaluation(period, matches);
  }
}

function evaluation(
  period: { periodStart: string; periodEnd: string },
  matches: readonly MonitoringMatch[],
) {
  return {
    matched: matches.length > 0,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    matches,
  };
}

function salesMetric(metrics: SalesMetrics, metric: string): number {
  if (metric === "revenue") return metrics.revenueCents;
  if (metric === "orderCount") return metrics.orderCount;
  if (metric === "unitsSold") return metrics.unitsSold;
  return metrics.averageOrderValueCents;
}

function compares(value: number, operator: "above" | "below", threshold: number): boolean {
  return operator === "above" ? value > threshold : value < threshold;
}

function salesMatch(
  merchantId: string,
  definition: Extract<MonitoringRuleDefinition, { kind: "salesThreshold" }>,
  value: number,
): MonitoringMatch {
  const label = salesMetricLabel(definition.metric);
  return {
    resourceType: "MERCHANT",
    resourceId: merchantId,
    title: `${label}达到监听条件`,
    message: `${label}当前为 ${formatMetric(definition.metric, value)}，已${definition.operator === "above" ? "高于" : "低于"}设定阈值。`,
    severity: "WARNING",
  };
}

function inventoryMatch(risk: InventoryRisk): MonitoringMatch {
  return {
    resourceType: "SKU",
    resourceId: risk.id,
    title: `${risk.productName}库存不足`,
    message: `${risk.code} 当前库存 ${risk.inventory} 件，请及时检查。`,
    severity: risk.inventory === 0 ? "CRITICAL" : "WARNING",
  };
}

function salesMetricLabel(metric: string): string {
  if (metric === "revenue") return "销售额";
  if (metric === "orderCount") return "订单量";
  if (metric === "unitsSold") return "销量";
  return "客单价";
}

function formatMetric(metric: string, value: number): string {
  return metric === "revenue" || metric === "averageOrderValue"
    ? `¥${(value / 100).toFixed(2)}`
    : `${value}`;
}

function assertPermission(context: AuthContext, definition: MonitoringRuleDefinition): void {
  const permission =
    definition.kind === "salesThreshold" ? AuthPermission.OrdersRead : AuthPermission.ProductsRead;
  if (!context.permissions.includes(permission)) {
    throw new ForbiddenException("当前身份无权读取监听所需数据");
  }
}
