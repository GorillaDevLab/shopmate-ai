import { z } from "zod";

const dateOnly = z
  .string({ error: "日期必须是字符串" })
  .regex(/^\d{4}-\d{2}-\d{2}$/u, { error: "日期必须使用 YYYY-MM-DD 格式" });
const count = z
  .number({ error: "数量必须是数字" })
  .int({ error: "数量必须是整数" })
  .min(0, { error: "数量不能为负数" });
const period = z.strictObject({
  startDate: dateOnly,
  endDate: dateOnly,
  days: count.min(1, { error: "统计周期必须大于 0" }),
});
const totals = z.strictObject({ revenueMinor: count, orders: count, units: count });

/** 经营分析页最长统计 366 天，避免一次请求返回过长的日序列。 */
export const ANALYTICS_OVERVIEW_MAX_DAYS = 366;
export const ANALYTICS_OVERVIEW_MAX_CHANNELS = 20;
export const ANALYTICS_OVERVIEW_TOP_PRODUCTS = 5;

export const AnalyticsChannelSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(100),
  // null: 订单未关联任何门店或店铺。
  platform: z.string().min(1).max(40).nullable(),
  revenueMinor: count,
  previousRevenueMinor: count,
  orders: count,
  units: count,
  dailyRevenueMinor: z.array(count),
});

export const AnalyticsProductSchema = z.strictObject({
  productId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  units: count,
  revenueMinor: count,
  previousRevenueMinor: count,
});

export const AnalyticsOverviewResponseSchema = z
  .strictObject({
    period,
    comparisonPeriod: period,
    totals: z.strictObject({ current: totals, previous: totals }),
    daily: z.array(
      z.strictObject({ date: dateOnly, revenueMinor: count, orders: count, units: count }),
    ),
    previousDaily: z.array(z.strictObject({ date: dateOnly, revenueMinor: count })),
    channels: z.array(AnalyticsChannelSchema).max(ANALYTICS_OVERVIEW_MAX_CHANNELS),
    products: z.array(AnalyticsProductSchema).max(ANALYTICS_OVERVIEW_TOP_PRODUCTS),
  })
  .superRefine((value, context) => {
    const days = value.period.days;
    if (value.comparisonPeriod.days !== days) {
      context.addIssue({
        code: "custom",
        path: ["comparisonPeriod"],
        message: "对比周期必须与统计周期等长",
      });
    }
    if (value.daily.length !== days || value.previousDaily.length !== days) {
      context.addIssue({ code: "custom", path: ["daily"], message: "日序列必须完整覆盖统计周期" });
    }
    if (value.channels.some((channel) => channel.dailyRevenueMinor.length !== days)) {
      context.addIssue({
        code: "custom",
        path: ["channels"],
        message: "渠道日序列必须完整覆盖统计周期",
      });
    }
  });

export type AnalyticsChannel = z.infer<typeof AnalyticsChannelSchema>;
export type AnalyticsProduct = z.infer<typeof AnalyticsProductSchema>;
export type AnalyticsOverviewResponse = z.infer<typeof AnalyticsOverviewResponseSchema>;
