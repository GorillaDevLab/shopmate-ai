import { z } from "zod";

const text = z
  .string({ error: "展示文案必须是字符串" })
  .trim()
  .min(1, { error: "展示文案不能为空" })
  .max(120, { error: "展示文案不能超过 120 个字符" });
const count = z
  .number({ error: "数量必须是数字" })
  .int({ error: "数量必须是安全整数" })
  .min(0, { error: "数量不能为负数" });

// F3 展示契约：排名、风险和预计天数均由数据提供方给出，不在界面计算。
export const DashboardHotProductSchema = z.strictObject(
  {
    rank: count.min(1, { error: "排名必须大于 0" }),
    name: text,
    sku: text,
    sold: count.nullable(),
    salesMinor: count.nullable(),
  },
  { error: "热销条目包含未知字段" },
);

export const DashboardStockForecastSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("estimated"),
      days: z.number({ error: "预计天数必须是有限数字" }).positive({ error: "预计天数必须大于 0" }),
    }),
    z.strictObject({ status: z.literal("out_of_stock") }),
    z.strictObject({ status: z.literal("no_sales") }),
    z.strictObject({ status: z.literal("insufficient_data") }),
  ],
  { error: "未知库存预测状态" },
);

export const DashboardInventoryAlertSchema = z
  .strictObject(
    {
      name: text,
      sku: text,
      inventory: count,
      recentSold: count.nullable(),
      forecast: DashboardStockForecastSchema,
    },
    { error: "库存条目包含未知字段" },
  )
  .refine(
    (item) => {
      if (item.forecast.status === "out_of_stock") return item.inventory === 0;
      if (item.inventory === 0) return false;
      if (item.forecast.status === "no_sales") return item.recentSold === 0;
      if (item.forecast.status === "estimated")
        return item.recentSold !== null && item.recentSold > 0;
      return true;
    },
    { error: "库存预测状态与库存或销量不一致", path: ["forecast"] },
  );

export type DashboardHotProduct = z.infer<typeof DashboardHotProductSchema>;
export type DashboardInventoryAlert = z.infer<typeof DashboardInventoryAlertSchema>;
export type DashboardStockForecast = z.infer<typeof DashboardStockForecastSchema>;
