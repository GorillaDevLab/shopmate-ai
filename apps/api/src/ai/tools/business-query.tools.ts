import { z } from "zod";
import {
  DashboardInsightQuerySchema,
  DashboardInsightResultSchema,
  type JsonObject,
} from "@shopmate/contracts";
import { AuthPermission } from "../../auth/contracts/auth-context.js";
import type { DashboardInsightExecutor } from "../insights/dashboard-insight-executor.js";
import type { StoreSalesReader } from "../insights/store-sales-reader.js";
import type { ToolSchema } from "./tool-registry.js";

function schema<T>(value: z.ZodType<T>): ToolSchema<T> {
  return { jsonSchema: z.toJSONSchema(value) as JsonObject, parse: (input) => value.parse(input) };
}

const storesOutput = z.strictObject({
  status: z.literal("ok"),
  data: z.strictObject({
    total: z.number().int().nonnegative(),
    listed: z.number().int().nonnegative(),
    items: z
      .array(z.strictObject({ id: z.string(), name: z.string(), platform: z.string() }))
      .max(100),
  }),
});

export function createStoreCatalogTool(reader: Pick<StoreSalesReader, "catalog" | "count">) {
  return {
    name: "get_store_catalog",
    description:
      "查询当前商家的店铺总数、名称、门店 ID 和渠道。包括实体门店和已登记的平台店铺。total 是完整总数，items 最多列出 100 家；不得把列表长度当成完整总数。",
    requiredPermissions: [AuthPermission.OrdersRead],
    input: schema(z.strictObject({})),
    output: schema(storesOutput),
    handler: async (
      _input: Record<string, never>,
      context: Parameters<StoreSalesReader["catalog"]>[0],
    ) => {
      const [items, total] = await Promise.all([reader.catalog(context), reader.count(context)]);
      return { status: "ok" as const, data: { total, listed: items.length, items } };
    },
  };
}

export function createBusinessQueryTool(executor: Pick<DashboardInsightExecutor, "execute">) {
  return {
    name: "query_business_data",
    description:
      "查询经营数据，支持日期、门店、平台、商品分组及过滤，用于自然语言追问和重新核实上一张图。仅接受结构化查询，不执行 SQL。金额单位 currencyMinor 为分。实时性仅表示请求时读取系统数据库，不保证外部平台实时同步。",
    requiredPermissions: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
    input: schema(DashboardInsightQuerySchema),
    output: schema(
      z.strictObject({
        status: z.literal("ok"),
        data: DashboardInsightResultSchema,
        query: DashboardInsightQuerySchema,
        period: z.strictObject({ startDate: z.iso.date(), endDate: z.iso.date() }),
      }),
    ),
    handler: async (
      query: z.infer<typeof DashboardInsightQuerySchema>,
      context: Parameters<DashboardInsightExecutor["execute"]>[0],
    ) => ({
      status: "ok" as const,
      data: await executor.execute(context, query),
      query,
      period: { startDate: query.dateRange.start, endDate: query.dateRange.end },
    }),
  };
}

export function createBusinessChartTool(executor: Pick<DashboardInsightExecutor, "execute">) {
  return {
    ...createBusinessQueryTool(executor),
    name: "create_business_chart",
    description:
      "用户要求画图、报告或更改图表筛选时使用。沿用对话日期与指标，除非用户明确改变。使用结构化查询生成可预览的图表；不会保存到看板。名称筛选先查门店目录；歧义先澄清，不猜 ID。",
  };
}
