import { DashboardInsightQuerySchema, type DashboardInsightQuery } from "@shopmate/contracts";

import { getInsightDimension, getInsightMetric } from "./dashboard-insight-registry.js";

export function validateDashboardInsightQuery(raw: unknown): DashboardInsightQuery {
  const query = DashboardInsightQuerySchema.parse(raw);
  const metric = getInsightMetric(query.metric);
  if (metric.dataset !== query.dataset) throw new Error("指标不属于所选数据集");
  if (metric.aggregation !== query.aggregation) throw new Error("该指标不支持所选聚合方式");
  if (query.groupBy && !metric.dimensions.includes(query.groupBy)) {
    throw new Error("该指标不支持所选分组维度");
  }
  for (const filter of query.filters) validateFilter(query.dataset, filter.field);
  return query;
}

function validateFilter(
  dataset: DashboardInsightQuery["dataset"],
  field: NonNullable<DashboardInsightQuery["groupBy"]>,
): void {
  const dimension = getInsightDimension(field);
  if (!dimension.enabled) throw new Error("该数据源尚未连接");
  if (!dimension.datasets.includes(dataset)) throw new Error("筛选字段不属于所选数据集");
  if (field !== "product" && field !== "sku" && field !== "inventoryRisk") {
    throw new Error("当前版本暂不支持该筛选字段");
  }
}
