import type { AnalyticsOverviewResponse, JsonObject } from "@shopmate/contracts";
import { z } from "zod";

import type { AnalyticsOverviewService } from "../../analytics/analytics-overview.service.js";
import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { shanghaiDateKey } from "./read-tool-period.js";
import type { ToolRegistration, ToolSchema } from "./tool-registry.js";

export const BUSINESS_OVERVIEW_TOOL_NAME = "get_business_overview";
const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;

const date = z.iso.date();
const InputSchema = z
  .strictObject({ startDate: date.optional(), endDate: date.optional() })
  .refine(({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate, {
    message: "开始日期不能晚于结束日期",
  });

const totals = z.strictObject({
  revenueYuan: z.number(),
  orders: z.number().int(),
  units: z.number().int(),
  averageOrderValueYuan: z.number(),
});
const change = z.number().nullable();
const OutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    data: z.strictObject({
      source: z.literal("AnalyticsOverview"),
      period: z.strictObject({ startDate: date, endDate: date }),
      comparisonPeriod: z.strictObject({ startDate: date, endDate: date }),
      current: totals,
      previous: totals,
      revenueChangeRatio: change,
      ordersChangeRatio: change,
      unitsChangeRatio: change,
      channels: z.array(
        z.strictObject({
          name: z.string(),
          platform: z.string().nullable(),
          revenueYuan: z.number(),
          previousRevenueYuan: z.number(),
          revenueChangeRatio: change,
          revenueShareRatio: z.number(),
          orders: z.number().int(),
        }),
      ),
      topProducts: z.array(
        z.strictObject({
          name: z.string(),
          units: z.number().int(),
          revenueYuan: z.number(),
          previousRevenueYuan: z.number(),
          revenueChangeRatio: change,
        }),
      ),
    }),
  }),
  z.strictObject({ status: z.literal("empty"), reason: z.literal("NO_DATA"), message: z.string() }),
]);
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function schema<T>(value: z.ZodType<T>): ToolSchema<T> {
  return { jsonSchema: z.toJSONSchema(value) as JsonObject, parse: (input) => value.parse(input) };
}

export function createBusinessOverviewTool(
  service: Pick<AnalyticsOverviewService, "get">,
): ToolRegistration<Input, Output> {
  return {
    name: BUSINESS_OVERVIEW_TOOL_NAME,
    description: [
      "经营全貌：本期与上一等长周期的销售额、订单、销量、客单价对比，各门店/渠道与 Top 5 商品的本期、上期和变化。",
      "回答“最近经营怎么样”“为什么下降/增长”“哪个门店/商品拖累或拉动”时优先使用。",
      "日期可省略，默认最近 30 天。金额单位为元；以 Ratio 结尾的字段是比例（-0.12 表示下降 12%）。",
    ].join(""),
    requiredPermissions: [AuthPermission.OrdersRead],
    input: schema(InputSchema),
    output: schema(OutputSchema),
    handler: async (input, context) => {
      const endDate = input.endDate ?? shanghaiDateKey(new Date());
      const startDate = input.startDate ?? daysBefore(endDate, DEFAULT_DAYS - 1);
      const overview = await service.get(context, { asOfDate: endDate, startDate });
      return toOutput(overview);
    },
  };
}

/** 金额换算成元、预先算好变化比例，减少模型自行换算和心算。 */
export function toOutput(overview: AnalyticsOverviewResponse): Output {
  const { current, previous } = overview.totals;
  if (current.orders === 0 && previous.orders === 0) {
    return { status: "empty", reason: "NO_DATA", message: "本期和上一周期都没有订单。" };
  }
  return {
    status: "ok",
    data: {
      source: "AnalyticsOverview",
      period: pickPeriod(overview.period),
      comparisonPeriod: pickPeriod(overview.comparisonPeriod),
      current: summarize(current),
      previous: summarize(previous),
      revenueChangeRatio: ratio(current.revenueMinor, previous.revenueMinor),
      ordersChangeRatio: ratio(current.orders, previous.orders),
      unitsChangeRatio: ratio(current.units, previous.units),
      channels: overview.channels.map((channel) => ({
        name: channel.name,
        platform: channel.platform,
        revenueYuan: yuan(channel.revenueMinor),
        previousRevenueYuan: yuan(channel.previousRevenueMinor),
        revenueChangeRatio: ratio(channel.revenueMinor, channel.previousRevenueMinor),
        revenueShareRatio: current.revenueMinor
          ? round(channel.revenueMinor / current.revenueMinor)
          : 0,
        orders: channel.orders,
      })),
      topProducts: overview.products.map((product) => ({
        name: product.name,
        units: product.units,
        revenueYuan: yuan(product.revenueMinor),
        previousRevenueYuan: yuan(product.previousRevenueMinor),
        revenueChangeRatio: ratio(product.revenueMinor, product.previousRevenueMinor),
      })),
    },
  };
}

function summarize(t: { revenueMinor: number; orders: number; units: number }) {
  return {
    revenueYuan: yuan(t.revenueMinor),
    orders: t.orders,
    units: t.units,
    averageOrderValueYuan: t.orders ? yuan(Math.round(t.revenueMinor / t.orders)) : 0,
  };
}

function pickPeriod(period: { startDate: string; endDate: string }) {
  return { startDate: period.startDate, endDate: period.endDate };
}

function ratio(current: number, previous: number): number | null {
  return previous === 0 ? null : round((current - previous) / previous);
}

function yuan(minor: number): number {
  return minor / 100;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function daysBefore(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}
