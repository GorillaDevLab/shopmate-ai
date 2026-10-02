import {
  getDashboardInsightViews,
  type DashboardChartView,
  type DashboardInsightQuery,
  type DashboardInsightResult,
} from "@shopmate/contracts";

import { formatYuan, formatYuanShort } from "../analytics-model";

type Metric = DashboardInsightQuery["metric"];
type Dimension = NonNullable<DashboardInsightQuery["groupBy"]>;

/**
 * 与 API 端 dashboard-insight-registry 的可选组合保持一致，只用于生成下拉选项；
 * 服务端仍会逐项校验，前端选项过期时最多得到一个 400 提示，不会越权查询。
 */
export const METRIC_OPTIONS: readonly {
  readonly value: Metric;
  readonly label: string;
  readonly dataset: DashboardInsightQuery["dataset"];
  readonly aggregation: DashboardInsightQuery["aggregation"];
  readonly dimensions: readonly Dimension[];
}[] = [
  {
    value: "revenue",
    label: "销售额",
    dataset: "sales",
    aggregation: "sum",
    dimensions: ["date", "product", "store", "platform"],
  },
  {
    value: "orderCount",
    label: "订单数",
    dataset: "sales",
    aggregation: "count",
    dimensions: ["store", "platform"],
  },
  {
    value: "unitsSold",
    label: "销量",
    dataset: "sales",
    aggregation: "sum",
    dimensions: ["product", "store", "platform"],
  },
  {
    value: "averageOrderValue",
    label: "客单价",
    dataset: "sales",
    aggregation: "average",
    dimensions: ["store", "platform"],
  },
  {
    value: "inventory",
    label: "库存",
    dataset: "inventory",
    aggregation: "sum",
    dimensions: ["product", "sku", "inventoryRisk"],
  },
];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  date: "按日期",
  product: "按商品",
  sku: "按 SKU",
  orderStatus: "按订单状态",
  inventoryRisk: "按库存风险",
  platform: "按平台",
  store: "按门店 / 店铺",
};

export const VIEW_LABELS: Record<DashboardChartView, string> = {
  line: "折线图",
  area: "面积图",
  bar: "柱状图",
  pie: "环形图",
  report: "文字报告",
};

export const LIMIT_OPTIONS = [5, 8, 12] as const;

export type ConfigPatch = Partial<
  Pick<DashboardInsightQuery, "metric" | "groupBy" | "visualization" | "order" | "limit">
> & { readonly dateRange?: DashboardInsightQuery["dateRange"] };

/** 改一个字段后把其余字段拉回合法组合：指标决定数据集与聚合方式，分组决定可用图表。 */
export function applyConfig(
  query: DashboardInsightQuery,
  patch: ConfigPatch,
): DashboardInsightQuery {
  const next = { ...query, ...patch };
  const metric = METRIC_OPTIONS.find((option) => option.value === next.metric) ?? METRIC_OPTIONS[0];
  const groupBy =
    next.groupBy === null || metric.dimensions.includes(next.groupBy)
      ? next.groupBy
      : metric.dimensions[0];
  const shaped: DashboardInsightQuery = {
    ...next,
    metric: metric.value,
    dataset: metric.dataset,
    aggregation: metric.aggregation,
    groupBy,
    // 旧查询里的筛选项可能引用已不适用的维度，重新配置时一律清空。
    filters: patch.metric || "groupBy" in patch ? [] : next.filters,
  };
  const views = getDashboardInsightViews(shaped);
  const visualization = views.includes(shaped.visualization) ? shaped.visualization : views[0];
  return { ...shaped, visualization: visualization ?? "report" };
}

export function formatValue(value: number, unit: "currencyMinor" | "count" | "ratio"): string {
  if (unit === "currencyMinor") return formatYuan(value);
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString("zh-CN");
}

/** 坐标轴用紧凑格式，避免长金额挤占绘图区。 */
export function formatAxisValue(value: number, unit: "currencyMinor" | "count" | "ratio"): string {
  if (unit === "currencyMinor") return value === 0 ? "¥0" : formatYuanShort(value);
  if (unit === "ratio") return `${Math.round(value * 100)}%`;
  return value >= 10_000 ? `${(value / 10_000).toFixed(1).replace(/\.0$/, "")}万` : String(value);
}

export type ResultRow = { readonly key: string; readonly label: string; readonly value: string };

export function resultRows(result: DashboardInsightResult): ResultRow[] {
  if (result.kind === "pie") {
    return result.slices.map((slice) => ({
      key: slice.key,
      label: slice.label,
      value: formatValue(slice.value, result.unit),
    }));
  }
  if (result.kind === "series") {
    return result.points.map((point) => ({
      key: point.date,
      label: point.date,
      value: formatValue(point.value, result.unit),
    }));
  }
  return result.metrics.map((metric) => ({
    key: metric.label,
    label: metric.label,
    value: metric.value,
  }));
}

export function isEmptyResult(result: DashboardInsightResult): boolean {
  if (result.kind === "pie") return result.slices.every((slice) => slice.value === 0);
  if (result.kind === "series") return result.points.every((point) => point.value === 0);
  return result.metrics.length === 0 && result.highlights.length === 0;
}

export const EXAMPLE_PROMPTS = [
  "近 30 天各门店和店铺的销售额对比",
  "近 30 天销量最高的 8 个商品",
  "各平台的客单价对比",
  "近 30 天每天的销售额走势",
] as const;
