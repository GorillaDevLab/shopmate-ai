import { z } from "zod";

import {
  DashboardChartViewSchema,
  DashboardInsightQuerySchema,
  getDashboardInsightViews,
} from "../ai/dashboard-insight.schema.js";

export const DashboardLayoutVersionSchema = z.literal(3, {
  error: "不支持的看板布局版本",
});
export type DashboardLayoutVersion = z.infer<typeof DashboardLayoutVersionSchema>;

export const DashboardLayoutSizeSchema = z.enum(["1x1", "2x1", "2x2"], {
  error: "卡片尺寸必须是 1x1、2x1 或 2x2",
});
export type DashboardLayoutSize = z.infer<typeof DashboardLayoutSizeSchema>;

const metricKeySchema = z.enum(["sales", "orders", "units", "averageOrderValue"]);
const cardIdSchema = z
  .string({ error: "卡片 ID 必须是字符串" })
  .trim()
  .min(1, { error: "卡片 ID 不能为空" })
  .max(64, { error: "卡片 ID 不能超过 64 个字符" })
  .regex(/^[a-zA-Z0-9_-]+$/, { error: "卡片 ID 只能包含字母、数字、下划线和连字符" });

export const DashboardLayoutComponentSchema = z.enum(
  ["metric", "salesTrend", "inventoryAlerts", "hotProducts", "pieChart", "report"],
  { error: "未知看板组件" },
);
export type DashboardLayoutComponent = z.infer<typeof DashboardLayoutComponentSchema>;

export const DASHBOARD_COMPONENT_REGISTRY = {
  metric: { label: "经营指标", defaultSize: "1x1", allowedSizes: ["1x1", "2x1"] },
  salesTrend: { label: "销售趋势", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
  inventoryAlerts: { label: "库存提醒", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
  hotProducts: { label: "热销商品", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
  pieChart: {
    label: "AI 图表",
    defaultSize: "1x1",
    allowedSizes: ["1x1", "2x1", "2x2"],
  },
  report: { label: "AI 经营报告", defaultSize: "2x1", allowedSizes: ["2x1", "2x2"] },
} as const satisfies Record<
  DashboardLayoutComponent,
  {
    label: string;
    defaultSize: DashboardLayoutSize;
    allowedSizes: readonly DashboardLayoutSize[];
  }
>;

const metricConfigSchema = z.strictObject({
  metric: metricKeySchema,
});
const salesTrendConfigSchema = z.strictObject({
  range: z.enum(["7d", "30d", "custom"]),
  view: z.enum(["line", "area"]).optional(),
});
const inventoryAlertsConfigSchema = z.strictObject({
  limit: z.number().int().min(1).max(10),
});
const hotProductsConfigSchema = z.strictObject({
  limit: z.number().int().min(1).max(10),
});
const insightTitleSchema = z.string().trim().min(1).max(120);
const pieChartConfigSchema = z
  .strictObject({
    title: insightTitleSchema,
    query: DashboardInsightQuerySchema.refine((query) => query.visualization !== "report"),
    view: DashboardChartViewSchema.exclude(["report"]).optional(),
  })
  .superRefine(({ query, view }, context) => {
    if (view && !getDashboardInsightViews(query).some((candidate) => candidate === view)) {
      context.addIssue({ code: "custom", path: ["view"], message: "图表视图与查询不兼容" });
    }
  });
const reportConfigSchema = z.strictObject({
  title: insightTitleSchema,
  query: DashboardInsightQuerySchema.refine((query) => query.visualization === "report"),
});

const dashboardLayoutCardSchema = z.discriminatedUnion("component", [
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("metric"),
    size: DashboardLayoutSizeSchema,
    config: metricConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("salesTrend"),
    size: DashboardLayoutSizeSchema,
    config: salesTrendConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("inventoryAlerts"),
    size: DashboardLayoutSizeSchema,
    config: inventoryAlertsConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("hotProducts"),
    size: DashboardLayoutSizeSchema,
    config: hotProductsConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("pieChart"),
    size: DashboardLayoutSizeSchema,
    config: pieChartConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("report"),
    size: DashboardLayoutSizeSchema,
    config: reportConfigSchema,
  }),
]);

export const DashboardLayoutCardSchema = dashboardLayoutCardSchema.superRefine((card, context) => {
  const allowedSizes = DASHBOARD_COMPONENT_REGISTRY[card.component].allowedSizes;
  if (!allowedSizes.some((size) => size === card.size)) {
    context.addIssue({
      code: "custom",
      path: ["size"],
      message: `该组件不支持尺寸 ${card.size}`,
    });
  }
});
export type DashboardLayoutCard = z.infer<typeof DashboardLayoutCardSchema>;

const uniqueCardIds = (cards: DashboardLayoutCard[]) =>
  new Set(cards.map((card) => card.id)).size === cards.length;

export const DashboardLayoutSchema = z.strictObject({
  version: DashboardLayoutVersionSchema,
  cards: z
    .array(DashboardLayoutCardSchema)
    .max(24, { error: "看板最多包含 24 张卡片" })
    .refine(uniqueCardIds, { error: "卡片 ID 不能重复" }),
});
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: 3,
  cards: [
    { id: "metric-sales", component: "metric", size: "1x1", config: { metric: "sales" } },
    { id: "metric-orders", component: "metric", size: "1x1", config: { metric: "orders" } },
    { id: "metric-units", component: "metric", size: "1x1", config: { metric: "units" } },
    {
      id: "metric-average-order-value",
      component: "metric",
      size: "1x1",
      config: { metric: "averageOrderValue" },
    },
    { id: "sales-trend", component: "salesTrend", size: "2x1", config: { range: "7d" } },
    { id: "inventory-alerts", component: "inventoryAlerts", size: "2x1", config: { limit: 4 } },
    { id: "hot-products", component: "hotProducts", size: "2x1", config: { limit: 3 } },
  ],
};

DashboardLayoutSchema.parse(DEFAULT_DASHBOARD_LAYOUT);

const LegacyDashboardLayoutSizeSchema = z.enum(["1/3", "1/2", "2/3", "full"]);
type LegacyDashboardLayoutSize = z.infer<typeof LegacyDashboardLayoutSizeSchema>;

const legacyCardSchema = z.discriminatedUnion("component", [
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("metric"),
    size: LegacyDashboardLayoutSizeSchema,
    config: metricConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("salesTrend"),
    size: LegacyDashboardLayoutSizeSchema,
    config: salesTrendConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("inventoryAlerts"),
    size: LegacyDashboardLayoutSizeSchema,
    config: inventoryAlertsConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("hotProducts"),
    size: LegacyDashboardLayoutSizeSchema,
    config: hotProductsConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("pieChart"),
    size: LegacyDashboardLayoutSizeSchema,
    config: pieChartConfigSchema,
  }),
  z.strictObject({
    id: cardIdSchema,
    component: z.literal("report"),
    size: LegacyDashboardLayoutSizeSchema,
    config: reportConfigSchema,
  }),
]);

const legacyLayoutSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  cards: z.array(legacyCardSchema).max(24),
});

function migrateSize(
  component: DashboardLayoutComponent,
  size: LegacyDashboardLayoutSize,
): DashboardLayoutSize {
  const allowedSizes = DASHBOARD_COMPONENT_REGISTRY[component].allowedSizes;
  return size === "1/3" && allowedSizes.some((candidate) => candidate === "1x1") ? "1x1" : "2x1";
}

export function parseDashboardLayout(value: unknown): DashboardLayout {
  const current = DashboardLayoutSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyLayoutSchema.parse(value);
  return DashboardLayoutSchema.parse({
    version: 3,
    cards: legacy.cards.map((card) => ({
      ...card,
      size: migrateSize(card.component, card.size),
    })),
  });
}
