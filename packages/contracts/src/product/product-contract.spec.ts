import { describe, expect, it } from "vitest";

import {
  MoneySchema,
  ProductDetailParamsSchema,
  ProductDetailSchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  type Pagination,
} from "./product.schema.js";

const paginationTypeCheck: Pagination = { page: 1, pageSize: 20, total: 0, totalPages: 0 };

const validSummary = {
  id: "demo-product-001",
  name: "云感纯棉短袖T恤",
  status: "ACTIVE",
  price: { amountMinor: 7900, currency: "CNY" },
  totalInventory: 120,
  skuCount: 1,
  updatedAt: "2026-08-30T00:00:00.000Z",
} as const;

const validDetail = {
  ...validSummary,
  totalInventory: 8,
  description: "柔软亲肤的基础款纯棉短袖。",
  features: ["100%纯棉"],
  sellingPoints: ["基础百搭"],
  skus: [
    {
      id: "demo-sku-001",
      code: "CN-DEMO-001",
      inventory: 8,
      cost: { amountMinor: 2800, currency: "CNY" },
      alertThreshold: 10,
      isLowStock: true,
    },
  ],
  createdAt: "2026-08-01T00:00:00.000Z",
} as const;

describe("商品列表查询契约", () => {
  it("为 HTTP 查询字符串提供默认值并转换数字", () => {
    expect(ProductListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20, status: "ALL" });
    expect(ProductListQuerySchema.parse({ page: "2", pageSize: "50", status: "INACTIVE" })).toEqual(
      { page: 2, pageSize: 50, status: "INACTIVE" },
    );
  });

  it.each([
    [{ page: "0" }, "页码必须大于等于 1"],
    [{ page: "1.5" }, "页码必须是十进制整数"],
    [{ pageSize: "101" }, "每页数量不能超过 100"],
    [{ status: "DELETED" }, "商品状态必须是 ALL、ACTIVE 或 INACTIVE"],
    [{ unknown: "value" }, "商品列表查询包含未知字段"],
  ])("拒绝越界查询 %#", (input, message) => {
    const result = ProductListQuerySchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(message);
  });

  it.each([
    { page: true },
    { pageSize: ["20"] },
    { page: "0x10" },
    { pageSize: "1e2" },
    { page: " 2 " },
  ])("拒绝非十进制标量分页输入 %#", (input) => {
    expect(ProductListQuerySchema.safeParse(input).success).toBe(false);
  });

  it("限制详情商品 ID 的字符与长度", () => {
    expect(ProductDetailParamsSchema.parse({ productId: "demo-product_001" })).toEqual({
      productId: "demo-product_001",
    });
    expect(ProductDetailParamsSchema.safeParse({ productId: "../other" }).success).toBe(false);
    expect(ProductDetailParamsSchema.safeParse({ productId: "x".repeat(101) }).success).toBe(false);
  });
});

describe("商品响应契约", () => {
  it("导出分页类型", () => {
    expect(paginationTypeCheck).toEqual({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  });
  it("使用整数分表示金额", () => {
    expect(MoneySchema.parse({ amountMinor: 12900, currency: "CNY" })).toEqual({
      amountMinor: 12900,
      currency: "CNY",
    });
    expect(MoneySchema.safeParse({ amountMinor: 12.9, currency: "CNY" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: -1, currency: "CNY" }).success).toBe(false);
  });

  it("验证商品详情及 SKU 库存结构", () => {
    expect(ProductDetailSchema.parse(validDetail)).toEqual(validDetail);
  });

  it("拒绝与库存阈值不一致的低库存标记", () => {
    const inconsistent = {
      ...validDetail,
      skus: [{ ...validDetail.skus[0], isLowStock: false }],
    };
    const result = ProductDetailSchema.safeParse(inconsistent);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("低库存状态与库存数量不一致");
  });

  it.each([
    [{ totalInventory: 9 }, "总库存与 SKU 库存不一致"],
    [{ skuCount: 2 }, "SKU 数量与列表不一致"],
  ])("拒绝不一致的商品库存摘要 %#", (override, message) => {
    const result = ProductDetailSchema.safeParse({ ...validDetail, ...override });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(message);
  });

  it("验证分页元数据与商品列表", () => {
    const response = {
      items: [validSummary],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    };
    expect(ProductListResponseSchema.parse(response)).toEqual(response);
  });

  it("拒绝不一致的总页数", () => {
    const result = ProductListResponseSchema.safeParse({
      items: [validSummary],
      pagination: { page: 1, pageSize: 20, total: 21, totalPages: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("总页数与商品总数不一致");
  });

  it.each([
    {
      items: [validSummary, { ...validSummary, id: "demo-product-002" }],
      pagination: { page: 1, pageSize: 1, total: 2, totalPages: 2 },
    },
    {
      items: [validSummary],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    },
    {
      items: [validSummary],
      pagination: { page: 3, pageSize: 20, total: 21, totalPages: 2 },
    },
  ])("拒绝列表数据与分页元数据矛盾 %#", (response) => {
    expect(ProductListResponseSchema.safeParse(response).success).toBe(false);
  });
});
