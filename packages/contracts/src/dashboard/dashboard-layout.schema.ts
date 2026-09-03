import { z } from "zod";

import { DashboardInsightQuerySchema } from "../ai/dashboard-insight.schema.js";

export const DashboardLayoutVersionSchema = z.literal(2, {
  error: "不支持的看板布局版本",
});
export type DashboardLayoutVersion = z.infer<typeof DashboardLayoutVersionSchema>;

export const DashboardLayoutSizeSchema = z.enum(["1/3", "1/2", "2/3", "full"], {
  error: "卡片尺寸必须是 1/3、1/2、2/3 或 full",
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

const metricConfigSchema = z.strictObject({
  metric: metricKeySchema,
});
const salesTrendConfigSchema = z.strictObject({
  range: z.enum(["7d", "30d", "custom"]),
});
const inventoryAlertsConfigSchema = z.strictObject({
  limit: z.number().int().min(1).max(10),
});
const hotProductsConfigSchema = z.strictObject({
  limit: z.number().int().min(1).max(10),
});
const insightTitleSchema = z.string().trim().min(1).max(120);
const pieChartConfigSchema = z.strictObject({
  title: insightTitleSchema,
  query: DashboardInsightQuerySchema.refine((query) => query.visualization === "pie"),
});
const reportConfigSchema = z.strictObject({
  title: insightTitleSchema,
  query: DashboardInsightQuerySchema.refine((query) => query.visualization === "report"),
});

export const DashboardLayoutCardSchema = z.discriminatedUnion("component", [
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

export const DASHBOARD_COMPONENT_REGISTRY = {
  metric: { label: "经营指标", defaultSize: "1/3" },
  salesTrend: { label: "销售趋势", defaultSize: "2/3" },
  inventoryAlerts: { label: "库存提醒", defaultSize: "1/3" },
  hotProducts: { label: "热销商品", defaultSize: "full" },
  pieChart: { label: "AI 饼图", defaultSize: "1/2" },
  report: { label: "AI 经营报告", defaultSize: "1/2" },
} as const satisfies Record<
  DashboardLayoutComponent,
  { label: string; defaultSize: DashboardLayoutSize }
>;

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: 2,
  cards: [
    { id: "metric-sales", component: "metric", size: "1/3", config: { metric: "sales" } },
    { id: "metric-orders", component: "metric", size: "1/3", config: { metric: "orders" } },
    { id: "metric-units", component: "metric", size: "1/3", config: { metric: "units" } },
    {
      id: "metric-average-order-value",
      component: "metric",
      size: "1/3",
      config: { metric: "averageOrderValue" },
    },
    { id: "sales-trend", component: "salesTrend", size: "2/3", config: { range: "7d" } },
    { id: "inventory-alerts", component: "inventoryAlerts", size: "1/3", config: { limit: 4 } },
    { id: "hot-products", component: "hotProducts", size: "full", config: { limit: 3 } },
  ],
};

DashboardLayoutSchema.parse(DEFAULT_DASHBOARD_LAYOUT);

const legacyLayoutSchema = z.strictObject({
  version: z.literal(1),
  cards: z
    .array(
      z.discriminatedUnion("component", [
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
      ]),
    )
    .max(24),
});

export function parseDashboardLayout(value: unknown): DashboardLayout {
  const current = DashboardLayoutSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyLayoutSchema.parse(value);
  return DashboardLayoutSchema.parse({ version: 2, cards: legacy.cards });
}
