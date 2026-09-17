import { DashboardInsightQuerySchema, type DashboardInsightQuery } from "@shopmate/contracts";

import { getInsightDimension, getInsightMetric } from "./dashboard-insight-registry.js";

interface ValidationOptions {
  readonly allowLegacyAveragePie?: boolean;
  readonly allowLegacyGroupedReport?: boolean;
}

export function validateDashboardInsightQuery(
  raw: unknown,
  options: ValidationOptions = {},
): DashboardInsightQuery {
  const query = DashboardInsightQuerySchema.parse(raw);
  if (Date.parse(query.dateRange.end) - Date.parse(query.dateRange.start) > 365 * 86400000)
    throw new Error("分析范围最多 366 天");
  const metric = getInsightMetric(query.metric);
  if (metric.dataset !== query.dataset) throw new Error("指标不属于所选数据集");
  if (metric.aggregation !== query.aggregation) throw new Error("该指标不支持所选聚合方式");
  if (query.groupBy && !metric.dimensions.includes(query.groupBy)) {
    throw new Error("该指标不支持所选分组维度");
  }
  if (
    query.visualization === "pie" &&
    query.aggregation === "average" &&
    !options.allowLegacyAveragePie
  ) {
    throw new Error("平均值不适合饼图，请改用柱状图");
  }
  if (
    (query.visualization === "line" || query.visualization === "area") &&
    query.groupBy !== "date"
  ) {
    throw new Error("折线图和面积图必须按日期分组");
  }
  if (
    query.visualization === "report" &&
    query.groupBy !== null &&
    !options.allowLegacyGroupedReport
  ) {
    throw new Error("报告查询不能包含分组维度");
  }
  if (query.visualization !== "report" && query.groupBy === null) {
    throw new Error("图表查询必须包含分组维度");
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
