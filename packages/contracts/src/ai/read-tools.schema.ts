import { z } from "zod";

import type { JsonObject } from "./llm-provider.js";

const dateOnlySchema = z
  .string({ error: "日期必须是字符串" })
  .regex(/^\d{4}-\d{2}-\d{2}$/u, { error: "日期必须使用 YYYY-MM-DD 格式" })
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { error: "日期必须是有效日历日期" },
  );

const identifierSchema = z
  .string({ error: "ID 必须是字符串" })
  .trim()
  .min(1, { error: "ID 不能为空" })
  .max(100, { error: "ID 不能超过 100 个字符" })
  .regex(/^[A-Za-z0-9_-]+$/u, { error: "ID 格式无效" });

const countSchema = z
  .number({ error: "数量必须是数字" })
  .int({ error: "数量必须是整数" })
  .min(0, { error: "数量不能为负数" });

const limitSchema = z.number().int().min(1).max(100).default(20);

const periodInputSchema = z
  .strictObject({
    startDate: dateOnlySchema.optional(),
    endDate: dateOnlySchema.optional(),
  })
  .refine(({ startDate, endDate }) => !startDate || Boolean(endDate), {
    error: "提供开始日期时必须同时提供结束日期",
    path: ["endDate"],
  })
  .refine(({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate, {
    error: "开始日期不能晚于结束日期",
    path: ["startDate"],
  });

const periodSchema = z.strictObject({
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
  timezone: z.literal("Asia/Shanghai"),
});

export const AiReadToolErrorSchema = z.strictObject({
  status: z.literal("error"),
  error: z.strictObject({
    code: z.enum(["NOT_FOUND", "FORBIDDEN", "INVALID_RANGE", "UNAVAILABLE"]),
    message: z.string().trim().min(1).max(240),
    retryable: z.boolean(),
  }),
});

export const AiReadToolEmptySchema = z.strictObject({
  status: z.literal("empty"),
  reason: z.literal("NO_DATA"),
  message: z.string().trim().min(1).max(240),
});

const toolResultSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("ok"), data: dataSchema }),
    AiReadToolEmptySchema,
    AiReadToolErrorSchema,
  ]);

const productDetailsInputSchema = z.strictObject({ productId: identifierSchema });
const productDetailsDataSchema = z.strictObject({
  source: z.literal("ProductService"),
  productId: identifierSchema,
  name: z.string().trim().min(1).max(120),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  priceMinor: countSchema,
  currency: z.literal("CNY"),
  totalInventory: countSchema,
  skus: z.array(
    z.strictObject({
      skuId: identifierSchema,
      code: z.string().trim().min(1).max(64),
      inventory: countSchema,
      alertThreshold: countSchema,
    }),
  ),
});

const inventoryRisksInputSchema = periodInputSchema.extend({ limit: limitSchema });
const inventoryRisksDataSchema = z.strictObject({
  source: z.literal("LowStockService"),
  period: periodSchema,
  items: z.array(
    z.strictObject({
      productId: identifierSchema,
      productName: z.string().trim().min(1).max(120),
      skuId: identifierSchema,
      skuCode: z.string().trim().min(1).max(64),
      inventory: countSchema,
      alertThreshold: countSchema,
      soldUnits: countSchema,
      averageDailyUnits: z.number().min(0),
      daysToStockout: z.number().min(0).nullable(),
      riskLevel: z.enum(["OUT_OF_STOCK", "CRITICAL", "WARNING"]),
    }),
  ),
});

const salesSummaryInputSchema = periodInputSchema;
// 所有金额均来自对应 Service 的聚合结果并使用人民币最小单位“分”；数量为非负整数。
const salesSummaryDataSchema = z.strictObject({
  source: z.literal("DashboardService"),
  period: periodSchema,
  revenueMinor: countSchema,
  currency: z.literal("CNY"),
  orderCount: countSchema,
  unitsSold: countSchema,
  averageOrderValueMinor: countSchema,
});

const bestSellersInputSchema = periodInputSchema.extend({ limit: limitSchema });
const bestSellersDataSchema = z.strictObject({
  source: z.literal("ProductPerformanceService"),
  period: periodSchema,
  items: z.array(
    z.strictObject({
      rank: countSchema.min(1),
      productId: identifierSchema,
      productName: z.string().trim().min(1).max(120),
      unitsSold: countSchema,
      revenueMinor: countSchema,
      currency: z.literal("CNY"),
    }),
  ),
});

const salesTrendInputSchema = periodInputSchema.extend({
  granularity: z.literal("day").default("day"),
});
const salesTrendDataSchema = z.strictObject({
  source: z.literal("DashboardService"),
  period: periodSchema,
  currency: z.literal("CNY"),
  points: z.array(z.strictObject({ date: dateOnlySchema, revenueMinor: countSchema })),
});

const productPerformanceInputSchema = periodInputSchema.extend({
  productId: identifierSchema.optional(),
  limit: limitSchema,
});
const productPerformanceDataSchema = z.strictObject({
  source: z.literal("ProductPerformanceService"),
  period: periodSchema,
  currency: z.literal("CNY"),
  items: z.array(
    z.strictObject({
      productId: identifierSchema,
      productName: z.string().trim().min(1).max(120),
      unitsSold: countSchema,
      revenueMinor: countSchema,
      previousUnitsSold: countSchema.nullable(),
      previousRevenueMinor: countSchema.nullable(),
      unitChangeRatio: z.number().nullable(),
      revenueChangeRatio: z.number().nullable(),
    }),
  ),
});

export interface AiReadToolSchema<T> {
  readonly jsonSchema: JsonObject;
  parse(value: unknown): T;
}

export interface AiReadToolContract<TInput, TOutput> {
  readonly name: AiReadToolName;
  readonly description: string;
  readonly input: AiReadToolSchema<TInput>;
  readonly output: AiReadToolSchema<TOutput>;
}

const registrySchema = <T>(schema: z.ZodType<T>): AiReadToolSchema<T> => ({
  jsonSchema: z.toJSONSchema(schema) as JsonObject,
  parse: (value) => schema.parse(value),
});

const defineTool = <TInput, TOutput>(
  name: AiReadToolName,
  description: string,
  input: z.ZodType<TInput>,
  output: z.ZodType<TOutput>,
): AiReadToolContract<TInput, TOutput> => ({
  name,
  description,
  input: registrySchema(input),
  output: registrySchema(output),
});

export const AI_READ_TOOL_NAMES = [
  "get_product_details",
  "get_inventory_risks",
  "get_sales_summary",
  "get_best_sellers",
  "get_sales_trend",
  "get_product_performance",
] as const;
export type AiReadToolName = (typeof AI_READ_TOOL_NAMES)[number];

export const GetProductDetailsTool = defineTool(
  "get_product_details",
  "读取当前 Merchant 下指定商品及 SKU 的详情。",
  productDetailsInputSchema,
  toolResultSchema(productDetailsDataSchema),
);

export const GetInventoryRisksTool = defineTool(
  "get_inventory_risks",
  "读取当前 Merchant 的低库存风险；日期可省略，省略时使用服务端默认最近周期。",
  inventoryRisksInputSchema,
  toolResultSchema(inventoryRisksDataSchema),
);

export const GetSalesSummaryTool = defineTool(
  "get_sales_summary",
  "读取当前 Merchant 的销售汇总；日期可省略，省略时使用服务端默认最近周期。",
  salesSummaryInputSchema,
  toolResultSchema(salesSummaryDataSchema),
);

export const GetBestSellersTool = defineTool(
  "get_best_sellers",
  "读取当前 Merchant 的热销商品排行；日期可省略，省略时使用服务端默认最近周期。",
  bestSellersInputSchema,
  toolResultSchema(bestSellersDataSchema),
);

export const GetSalesTrendTool = defineTool(
  "get_sales_trend",
  "读取当前 Merchant 的每日销售额趋势；日期可省略，省略时使用服务端默认最近周期。",
  salesTrendInputSchema,
  toolResultSchema(salesTrendDataSchema),
);

export const GetProductPerformanceTool = defineTool(
  "get_product_performance",
  "读取当前 Merchant 的商品销售表现；日期可省略，省略时使用服务端默认最近周期。",
  productPerformanceInputSchema,
  toolResultSchema(productPerformanceDataSchema),
);

export const AI_READ_TOOL_CONTRACTS = [
  GetProductDetailsTool,
  GetInventoryRisksTool,
  GetSalesSummaryTool,
  GetBestSellersTool,
  GetSalesTrendTool,
  GetProductPerformanceTool,
] as const;

export type AiReadToolError = z.infer<typeof AiReadToolErrorSchema>;
export type AiReadToolEmpty = z.infer<typeof AiReadToolEmptySchema>;
