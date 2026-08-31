import { z } from "zod";
import {
  DashboardHotProductSchema,
  DashboardInventoryAlertSchema,
} from "./dashboard-products.schema.js";

const text = z
  .string({ error: "展示文案必须是字符串" })
  .trim()
  .min(1, { error: "展示文案不能为空" })
  .max(120, { error: "展示文案不能超过 120 个字符" });
const count = z
  .number({ error: "数量必须是数字" })
  .int({ error: "数量必须是整数" })
  .min(0, { error: "数量不能为负数" });

// 金额指标使用整数分，计数指标使用整数；null 表示尚无数据，不等同于 0。
export const DashboardMetricSchema = z.strictObject(
  {
    key: z.enum(["sales", "orders", "units", "averageOrderValue"], { error: "未知经营指标" }),
    value: count.nullable(),
    // 由数据提供方计算：0.186 表示上升 18.6%；无可比基期时返回 null。
    changeRatio: z
      .number({ error: "变化比例必须是有限数字" })
      .min(-1, { error: "下降幅度不能超过 100%" })
      .nullable(),
  },
  { error: "指标包含未知字段" },
);
export type DashboardMetric = z.infer<typeof DashboardMetricSchema>;

const uniqueSkus = (items: { sku: string }[]) =>
  new Set(items.map((item) => item.sku)).size === items.length;

// F1/F2/F3 的展示模型，不作为 E 模块分析指标或 API 响应的定义。
export const DashboardPreviewSchema = z.strictObject({
  source: z.literal("demo", { error: "预览数据来源必须为 demo" }),
  metrics: z
    .array(DashboardMetricSchema)
    .max(4)
    .refine((metrics) => new Set(metrics.map((metric) => metric.key)).size === metrics.length, {
      error: "经营指标不能重复",
    }),
  products: z
    .array(DashboardHotProductSchema)
    .max(10)
    .refine(uniqueSkus, { error: "热销 SKU 不能重复" }),
  inventoryAlerts: z
    .array(DashboardInventoryAlertSchema)
    .max(10)
    .refine(uniqueSkus, { error: "库存 SKU 不能重复" }),
  trend: z
    .array(
      z.strictObject({
        label: text,
        heightPercent: z
          .number({ error: "图柱高度必须是数字" })
          .min(0, { error: "图柱高度不能小于 0" })
          .max(100, { error: "图柱高度不能超过 100" }),
      }),
    )
    .max(7),
});

export type DashboardPreview = z.infer<typeof DashboardPreviewSchema>;
