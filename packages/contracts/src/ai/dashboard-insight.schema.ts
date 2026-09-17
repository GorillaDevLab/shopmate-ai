import { z } from "zod";

const titleSchema = z.string().trim().min(1).max(120);
const summarySchema = z.string().trim().min(1).max(1200);
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_:-]+$/u);

export const DashboardInsightDatasetSchema = z.enum(["sales", "products", "inventory"]);
export const DashboardInsightMetricSchema = z.enum([
  "revenue",
  "orderCount",
  "unitsSold",
  "averageOrderValue",
  "inventory",
  "productCount",
]);
export const DashboardInsightDimensionSchema = z.enum([
  "date",
  "product",
  "sku",
  "orderStatus",
  "inventoryRisk",
  "platform",
  "store",
]);
export const DashboardInsightAggregationSchema = z.enum(["sum", "count", "average"]);
export const DashboardInsightKindSchema = z.enum(["auto", "pie", "bar", "line", "area", "report"]);
export const DashboardChartViewSchema = DashboardInsightKindSchema.exclude(["auto"]);

const dateRangeSchema = z
  .strictObject({ start: z.iso.date(), end: z.iso.date() })
  .refine(({ start, end }) => start <= end, { message: "开始日期不能晚于结束日期" });

const filterSchema = z.strictObject({
  field: DashboardInsightDimensionSchema,
  operator: z.enum(["equals", "in"]),
  values: z.array(identifierSchema).min(1).max(20),
});

export const DashboardInsightQuerySchema = z
  .strictObject({
    dataset: DashboardInsightDatasetSchema,
    metric: DashboardInsightMetricSchema,
    aggregation: DashboardInsightAggregationSchema,
    groupBy: DashboardInsightDimensionSchema.nullable(),
    dateRange: dateRangeSchema,
    filters: z.array(filterSchema).max(8),
    order: z.enum(["asc", "desc"]),
    limit: z.number().int().min(1).max(12),
    visualization: DashboardInsightKindSchema.exclude(["auto"]),
  })
  .superRefine((query, context) => {
    if (query.visualization === "pie" && query.groupBy === null) {
      context.addIssue({ code: "custom", path: ["groupBy"], message: "饼图必须指定分组维度" });
    }
  });

export const DashboardInsightGenerateRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  kind: DashboardInsightKindSchema,
});

const pieResultSchema = z.strictObject({
  kind: z.literal("pie"),
  title: titleSchema,
  summary: summarySchema,
  unit: z.enum(["currencyMinor", "count", "ratio"]),
  slices: z
    .array(
      z.strictObject({
        key: identifierSchema,
        label: z.string().trim().min(1).max(80),
        value: z.number().finite().nonnegative(),
      }),
    )
    .max(12),
});

const reportResultSchema = z.strictObject({
  kind: z.literal("report"),
  title: titleSchema,
  summary: summarySchema,
  highlights: z.array(z.string().trim().min(1).max(280)).max(8),
  metrics: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(80),
        value: z.string().trim().min(1).max(80),
      }),
    )
    .max(8),
});

const seriesResultSchema = z.strictObject({
  kind: z.literal("series"),
  title: titleSchema,
  summary: summarySchema,
  unit: z.enum(["currencyMinor", "count", "ratio"]),
  points: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        value: z.number().finite().nonnegative(),
      }),
    )
    .max(366)
    .superRefine((points, context) => {
      for (let index = 1; index < points.length; index += 1) {
        if (points[index - 1]!.date >= points[index]!.date) {
          context.addIssue({
            code: "custom",
            path: [index, "date"],
            message: "序列日期必须唯一且严格升序",
          });
        }
      }
    }),
});

export const DashboardInsightResultSchema = z.discriminatedUnion("kind", [
  pieResultSchema,
  seriesResultSchema,
  reportResultSchema,
]);

export const DashboardInsightPreviewResponseSchema = z.strictObject({
  query: DashboardInsightQuerySchema,
  result: DashboardInsightResultSchema,
});

export const DashboardInsightExecuteRequestSchema = z.strictObject({
  query: DashboardInsightQuerySchema,
});

export const DashboardInsightExecuteResponseSchema = z.strictObject({
  result: DashboardInsightResultSchema,
});

export type DashboardInsightQuery = z.infer<typeof DashboardInsightQuerySchema>;
export type DashboardInsightKind = z.infer<typeof DashboardInsightKindSchema>;
export type DashboardChartView = z.infer<typeof DashboardChartViewSchema>;
export type DashboardInsightGenerateRequest = z.infer<typeof DashboardInsightGenerateRequestSchema>;
export type DashboardInsightResult = z.infer<typeof DashboardInsightResultSchema>;
export type DashboardInsightPreviewResponse = z.infer<typeof DashboardInsightPreviewResponseSchema>;
export type DashboardInsightExecuteRequest = z.infer<typeof DashboardInsightExecuteRequestSchema>;
export type DashboardInsightExecuteResponse = z.infer<typeof DashboardInsightExecuteResponseSchema>;

export function getDashboardInsightViews(
  query: DashboardInsightQuery,
): readonly DashboardChartView[] {
  if (query.dataset === "products") return query.groupBy === null ? ["report"] : [];
  if (query.groupBy === null) return ["report"];
  if (query.groupBy === "date") return ["line", "area", "bar"];
  if (query.aggregation === "average") return ["bar"];
  return ["pie", "bar"];
}
