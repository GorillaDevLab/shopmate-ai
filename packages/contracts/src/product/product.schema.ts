import { z } from "zod";

const boundedText = (fieldName: string, maximum: number) =>
  z
    .string({ error: `${fieldName}必须是字符串` })
    .trim()
    .min(1, { error: `${fieldName}不能为空` })
    .max(maximum, { error: `${fieldName}不能超过 ${maximum} 个字符` });

const identifier = (fieldName: string) =>
  boundedText(fieldName, 100).regex(/^[A-Za-z0-9_-]+$/u, {
    error: `${fieldName}只能包含字母、数字、下划线和连字符`,
  });

const nonNegativeInteger = (fieldName: string) =>
  z
    .number({ error: `${fieldName}必须是数字` })
    .int({ error: `${fieldName}必须是整数` })
    .min(0, { error: `${fieldName}不能小于 0` });

const positiveHttpInteger = (fieldName: string, maximum?: number) => {
  const numberSchema = z
    .number({ error: `${fieldName}必须是十进制整数` })
    .int({ error: `${fieldName}必须是整数` })
    .min(1, { error: `${fieldName}必须大于等于 1` });
  const boundedSchema = maximum
    ? numberSchema.max(maximum, { error: `${fieldName}不能超过 ${maximum}` })
    : numberSchema;
  return z.preprocess(
    (value) => (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value) ? Number(value) : value),
    boundedSchema,
  );
};

const isoDateTime = (fieldName: string) =>
  z.iso.datetime({ error: `${fieldName}必须是 ISO 8601 日期时间` });

export const ProductStatusSchema = z.enum(["ACTIVE", "INACTIVE"], {
  error: "商品状态必须是 ACTIVE 或 INACTIVE",
});

export const ProductStatusFilterSchema = z.enum(["ALL", "ACTIVE", "INACTIVE"], {
  error: "商品状态必须是 ALL、ACTIVE 或 INACTIVE",
});

export const MoneySchema = z.strictObject({
  amountMinor: nonNegativeInteger("金额"),
  currency: z.literal("CNY", { error: "币种必须为 CNY" }),
});

export const ProductListQuerySchema = z.strictObject(
  {
    page: positiveHttpInteger("页码").default(1),
    pageSize: positiveHttpInteger("每页数量", 100).default(20),
    status: ProductStatusFilterSchema.default("ALL"),
  },
  { error: "商品列表查询包含未知字段" },
);

export const ProductDetailParamsSchema = z.strictObject(
  {
    productId: identifier("商品 ID"),
  },
  { error: "商品详情参数包含未知字段" },
);

export const ProductSummarySchema = z.strictObject({
  id: identifier("商品 ID"),
  name: boundedText("商品名称", 120),
  status: ProductStatusSchema,
  price: MoneySchema,
  totalInventory: nonNegativeInteger("总库存"),
  skuCount: nonNegativeInteger("SKU 数量"),
  updatedAt: isoDateTime("更新时间"),
});

export const ProductSkuSchema = z
  .strictObject({
    id: identifier("SKU ID"),
    code: boundedText("SKU 编码", 64),
    inventory: nonNegativeInteger("库存"),
    cost: MoneySchema,
    alertThreshold: nonNegativeInteger("库存预警值"),
    isLowStock: z.boolean({ error: "低库存状态必须是布尔值" }),
  })
  .superRefine((sku, context) => {
    if (sku.isLowStock !== sku.inventory <= sku.alertThreshold) {
      context.addIssue({
        code: "custom",
        path: ["isLowStock"],
        message: "低库存状态与库存数量不一致",
      });
    }
  });

export const ProductDetailSchema = ProductSummarySchema.extend({
  description: boundedText("商品描述", 2_000),
  features: z.array(boundedText("商品特点", 100)).max(20, { error: "商品特点不能超过 20 项" }),
  sellingPoints: z.array(boundedText("商品卖点", 100)).max(20, { error: "商品卖点不能超过 20 项" }),
  skus: z.array(ProductSkuSchema).min(1, { error: "商品至少需要一个 SKU" }).max(100, {
    error: "商品 SKU 不能超过 100 个",
  }),
  createdAt: isoDateTime("创建时间"),
}).superRefine((product, context) => {
  const inventory = product.skus.reduce((total, sku) => total + sku.inventory, 0);
  if (product.totalInventory !== inventory) {
    context.addIssue({
      code: "custom",
      path: ["totalInventory"],
      message: "总库存与 SKU 库存不一致",
    });
  }
  if (product.skuCount !== product.skus.length) {
    context.addIssue({ code: "custom", path: ["skuCount"], message: "SKU 数量与列表不一致" });
  }
});

export const PaginationSchema = z
  .strictObject({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: nonNegativeInteger("商品总数"),
    totalPages: nonNegativeInteger("总页数"),
  })
  .superRefine((pagination, context) => {
    if (pagination.totalPages !== Math.ceil(pagination.total / pagination.pageSize)) {
      context.addIssue({ code: "custom", path: ["totalPages"], message: "总页数与商品总数不一致" });
    }
  });

export const ProductListResponseSchema = z
  .strictObject({
    items: z.array(ProductSummarySchema).max(100, { error: "单页商品不能超过 100 件" }),
    pagination: PaginationSchema,
  })
  .superRefine((response, context) => {
    if (response.items.length > response.pagination.pageSize) {
      context.addIssue({ code: "custom", path: ["items"], message: "商品数量超过每页限制" });
    }
    if (response.items.length > response.pagination.total) {
      context.addIssue({ code: "custom", path: ["items"], message: "商品数量超过商品总数" });
    }
    if (response.pagination.page > response.pagination.totalPages && response.items.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "超出总页数时商品列表必须为空",
      });
    }
  });

export type ProductStatus = z.infer<typeof ProductStatusSchema>;
export type ProductStatusFilter = z.infer<typeof ProductStatusFilterSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;
export type ProductDetailParams = z.infer<typeof ProductDetailParamsSchema>;
export type ProductSummary = z.infer<typeof ProductSummarySchema>;
export type ProductSku = z.infer<typeof ProductSkuSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;
