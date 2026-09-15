import { DashboardInsightQuerySchema, type DashboardInsightQuery } from "@shopmate/contracts";

import { getInsightDimension, getInsightMetric } from "./dashboard-insight-registry.js";

export function validateDashboardInsightQuery(raw: unknown): DashboardInsightQuery {
  const query = DashboardInsightQuerySchema.parse(raw);
  if (Date.parse(query.dateRange.end) - Date.parse(query.dateRange.start) > 365 * 86400000)
    throw new Error("分析范围最多 366 天");
  const metric = getInsightMetric(query.metric);
  if (metric.dataset !== query.dataset) throw new Error("指标不属于所选数据集");
  if (metric.aggregation !== query.aggregation) throw new Error("该指标不支持所选聚合方式");
  if (query.groupBy && !metric.dimensions.includes(query.groupBy)) {
    throw new Error("该指标不支持所选分组维度");
  }
  for (const filter of query.filters) validateFilter(query.dataset, filter.field);
  for (const filter of query.filters) {
    if (filter.operator === "equals" && filter.values.length !== 1)
      throw new Error("equals 仅接受一个值");
    if (
      filter.field === "platform" &&
      filter.values.some((value) => !["OFFLINE", "TAOBAO", "DOUYIN", "XIAOHONGSHU"].includes(value))
    )
      throw new Error("未知渠道");
  }
  return query;
}

function validateFilter(
  dataset: DashboardInsightQuery["dataset"],
  field: NonNullable<DashboardInsightQuery["groupBy"]>,
): void {
  const dimension = getInsightDimension(field);
  if (dataset === "sales" && !["product", "store", "platform"].includes(field))
    throw new Error("销售暂不支持该筛选字段");
  if (!dimension.enabled) throw new Error("该数据源尚未连接");
  if (!dimension.datasets.includes(dataset)) throw new Error("筛选字段不属于所选数据集");
  if (
    field !== "product" &&
    field !== "sku" &&
    field !== "inventoryRisk" &&
    field !== "store" &&
    field !== "platform"
  ) {
    throw new Error("当前版本暂不支持该筛选字段");
  }
}
