import { z } from "zod";
import { DashboardMetricSchema } from "../dashboard/dashboard-preview.schema.js";
import {
  DashboardHotProductSchema,
  DashboardInventoryAlertSchema,
} from "../dashboard/dashboard-products.schema.js";

const dateOnly = z
  .string({ error: "日期必须是字符串" })
  .regex(/^\d{4}-\d{2}-\d{2}$/u, { error: "日期必须使用 YYYY-MM-DD 格式" })
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { error: "日期必须是有效日历日期" },
  );
const count = z
  .number({ error: "数量必须是数字" })
  .int({ error: "数量必须是安全整数" })
  .min(0, { error: "数量不能为负数" });

const queryDate = dateOnly.refine((value) => value >= "1000-01-01", "日期年份不能小于 1000");
export const AnalyticsDashboardQuerySchema = z
  .strictObject({
    asOfDate: queryDate,
    startDate: queryDate.optional(),
  })
  .refine(
    ({ asOfDate, startDate }) => {
      if (startDate === undefined) return true;
      const days = (Date.parse(asOfDate) - Date.parse(startDate)) / 86_400_000 + 1;
      return days >= 1 && days <= 31;
    },
    { error: "开始日期不能晚于结束日期，且最多选择 31 天", path: ["startDate"] },
  );

const analyticsDashboardResponse = z.strictObject({
  asOfDate: dateOnly,
  period: z.strictObject({
    startDate: dateOnly,
    endDate: dateOnly,
    days: count
      .min(1, { error: "统计周期必须大于 0" })
      .max(31, { error: "统计周期不能超过 31 天" }),
  }),
  metrics: z.array(DashboardMetricSchema).length(4, { error: "必须返回四项经营指标" }),
  trend: z
    .array(z.strictObject({ date: dateOnly, revenueMinor: count }))
    .min(1)
    .max(31),
  products: z.array(DashboardHotProductSchema).max(10),
  inventoryAlerts: z.array(DashboardInventoryAlertSchema).max(100),
});

export const AnalyticsDashboardResponseSchema = analyticsDashboardResponse.superRefine(
  (response, context) => {
    const metricKeys = new Set(response.metrics.map((metric) => metric.key));
    if (metricKeys.size !== 4) addIssue(context, ["metrics"], "四项经营指标必须各出现一次");

    if (response.asOfDate !== response.period.endDate) {
      addIssue(context, ["period", "endDate"], "统计截止日期必须与周期结束日期一致");
    }

    if (response.period.days > 31 || !dateOnly.safeParse(response.period.startDate).success) {
      return;
    }

    const expectedDates = createDateRange(response.period.startDate, response.period.days);
    if (
      expectedDates.at(-1) !== response.period.endDate ||
      response.trend.length !== expectedDates.length ||
      response.trend.some((point, index) => point.date !== expectedDates[index])
    ) {
      addIssue(context, ["trend"], "趋势必须完整覆盖统计周期且按日期升序排列");
    }

    if (
      new Set(response.products.map((product) => product.productId)).size !==
      response.products.length
    ) {
      addIssue(context, ["products"], "热销商品不能重复");
    }
    if (
      new Set(response.inventoryAlerts.map((item) => item.sku)).size !==
      response.inventoryAlerts.length
    ) {
      addIssue(context, ["inventoryAlerts"], "库存 SKU 不能重复");
    }
  },
);

export type AnalyticsDashboardQuery = z.infer<typeof AnalyticsDashboardQuerySchema>;
export type AnalyticsDashboardResponse = z.infer<typeof AnalyticsDashboardResponseSchema>;

function createDateRange(startDate: string, days: number): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}
