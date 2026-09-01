import { z } from "zod";

const identifier = z
  .string({ error: "商品 ID 必须是字符串" })
  .trim()
  .min(1, { error: "商品 ID 不能为空" })
  .max(100, { error: "商品 ID 过长" })
  .regex(/^[A-Za-z0-9_-]+$/u, {
    error: "商品 ID 格式无效",
  });

const copyTitle = z
  .string({ error: "文案标题必须是字符串" })
  .trim()
  .min(1, { error: "文案标题不能为空" })
  .max(80, {
    error: "文案标题不能超过 80 个字符",
  });

const copyBody = z
  .string({ error: "文案正文必须是字符串" })
  .trim()
  .min(1, { error: "文案正文不能为空" })
  .max(1_200, {
    error: "文案正文不能超过 1200 个字符",
  });

const copyTag = z
  .string({ error: "文案标签必须是字符串" })
  .trim()
  .min(1, { error: "文案标签不能为空" })
  .max(30, {
    error: "单个文案标签不能超过 30 个字符",
  });

export const ProductCopyTypeSchema = z.enum([
  "TITLE",
  "DESCRIPTION",
  "XIAOHONGSHU",
  "DOUYIN",
  "GENERAL",
]);

export const ProductCopyRequestSchema = z.strictObject({
  productId: identifier,
  copyType: ProductCopyTypeSchema,
});

export const ProductCopyContentSchema = z.strictObject({
  title: copyTitle,
  body: copyBody,
  tags: z.array(copyTag).max(10, {
    error: "文案标签不能超过 10 个",
  }),
});

const ProductCopyBaseSchema = ProductCopyContentSchema.extend({
  productId: identifier,
});

export const ProductTitleCopySchema = ProductCopyBaseSchema.extend({
  copyType: z.literal("TITLE"),
});

export const ProductDescriptionCopySchema = ProductCopyBaseSchema.extend({
  copyType: z.literal("DESCRIPTION"),
});

export const XiaohongshuProductCopySchema = ProductCopyBaseSchema.extend({
  copyType: z.literal("XIAOHONGSHU"),
});

export const DouyinProductCopySchema = ProductCopyBaseSchema.extend({
  copyType: z.literal("DOUYIN"),
});

export const GeneralProductCopySchema = ProductCopyBaseSchema.extend({
  copyType: z.literal("GENERAL"),
});

export const ProductCopyOutputSchema = z.discriminatedUnion("copyType", [
  ProductTitleCopySchema,
  ProductDescriptionCopySchema,
  XiaohongshuProductCopySchema,
  DouyinProductCopySchema,
  GeneralProductCopySchema,
]);

export type ProductCopyType = z.infer<typeof ProductCopyTypeSchema>;

export type ProductCopyRequest = z.infer<typeof ProductCopyRequestSchema>;

export type ProductCopyContent = z.infer<typeof ProductCopyContentSchema>;

export type ProductCopyOutput = z.infer<typeof ProductCopyOutputSchema>;
