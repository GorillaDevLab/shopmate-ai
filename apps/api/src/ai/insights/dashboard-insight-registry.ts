import type { DashboardInsightQuery } from "@shopmate/contracts";

type MetricKey = DashboardInsightQuery["metric"];
type DimensionKey = NonNullable<DashboardInsightQuery["groupBy"]>;
type Dataset = DashboardInsightQuery["dataset"];
type Aggregation = DashboardInsightQuery["aggregation"];
type ResultUnit = "currencyMinor" | "count" | "ratio";

export interface InsightMetricDefinition {
  readonly dataset: Dataset;
  readonly aggregation: Aggregation;
  readonly unit: ResultUnit;
  readonly dimensions: readonly DimensionKey[];
}

interface InsightDimensionDefinition {
  readonly datasets: readonly Dataset[];
  readonly enabled: boolean;
}

const metrics = {
  revenue: salesMetric("sum", "currencyMinor", ["date", "product"]),
  orderCount: salesMetric("count", "count", []),
  unitsSold: salesMetric("sum", "count", ["product"]),
  averageOrderValue: salesMetric("average", "currencyMinor", []),
  inventory: inventoryMetric("sum", "count", ["product", "sku", "inventoryRisk"]),
  productCount: productMetric("count", "count", ["product"]),
} as const satisfies Record<MetricKey, InsightMetricDefinition>;

const dimensions = {
  date: dimension(["sales"]),
  product: dimension(["sales", "products", "inventory"]),
  sku: dimension(["sales", "inventory"]),
  orderStatus: dimension(["sales"]),
  inventoryRisk: dimension(["inventory"]),
  platform: dimension(["sales", "products", "inventory"], false),
  store: dimension(["sales", "products", "inventory"], false),
} as const satisfies Record<DimensionKey, InsightDimensionDefinition>;

export const DASHBOARD_INSIGHT_FIELDS = { metrics, dimensions } as const;

export function getInsightMetric(value: string): InsightMetricDefinition {
  if (!Object.hasOwn(metrics, value)) throw new Error("未知经营指标");
  return metrics[value as MetricKey];
}

export function getInsightDimension(value: DimensionKey): InsightDimensionDefinition {
  return dimensions[value];
}

function salesMetric(
  aggregation: Aggregation,
  unit: ResultUnit,
  allowed: readonly DimensionKey[],
): InsightMetricDefinition {
  return { dataset: "sales", aggregation, unit, dimensions: allowed };
}

function inventoryMetric(
  aggregation: Aggregation,
  unit: ResultUnit,
  allowed: readonly DimensionKey[],
): InsightMetricDefinition {
  return { dataset: "inventory", aggregation, unit, dimensions: allowed };
}

function productMetric(
  aggregation: Aggregation,
  unit: ResultUnit,
  allowed: readonly DimensionKey[],
): InsightMetricDefinition {
  return { dataset: "products", aggregation, unit, dimensions: allowed };
}

function dimension(datasets: readonly Dataset[], enabled = true): InsightDimensionDefinition {
  return { datasets, enabled };
}
