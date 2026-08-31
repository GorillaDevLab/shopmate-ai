import { z } from "zod";

const text = z
  .string({ error: "展示文案必须是字符串" })
  .trim()
  .min(1, { error: "展示文案不能为空" })
  .max(120, { error: "展示文案不能超过 120 个字符" });
const count = z
  .number({ error: "数量必须是数字" })
  .int({ error: "数量必须是整数" })
  .min(0, { error: "数量不能为负数" });

// F1 的展示模型，不作为 E 模块分析指标或 API 响应的定义。
export const DashboardPreviewSchema = z.strictObject({
  source: z.literal("demo", { error: "预览数据来源必须为 demo" }),
  metrics: z.array(z.strictObject({ label: text, value: text, change: text })).max(4),
  products: z.array(z.strictObject({ name: text, sold: count, sales: text })).max(10),
  inventoryAlerts: z.array(z.strictObject({ name: text, inventory: count })).max(10),
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
