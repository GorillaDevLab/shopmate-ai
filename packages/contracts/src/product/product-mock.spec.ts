import { describe, expect, it } from "vitest";

import { ProductDetailSchema, ProductListResponseSchema } from "./product.schema.js";
import { mockProductDetails, mockProductListResponse } from "./product.mock.js";

describe("商品契约 Mock", () => {
  it("所有 Mock 均通过正式 Schema", () => {
    expect(ProductListResponseSchema.safeParse(mockProductListResponse).success).toBe(true);
    expect(
      mockProductDetails.every((product) => ProductDetailSchema.safeParse(product).success),
    ).toBe(true);
  });

  it("覆盖启用、停用、低库存和多 SKU 场景", () => {
    expect(mockProductListResponse.items.some((product) => product.status === "ACTIVE")).toBe(true);
    expect(mockProductListResponse.items.some((product) => product.status === "INACTIVE")).toBe(
      true,
    );
    expect(mockProductDetails.some((product) => product.skus.some((sku) => sku.isLowStock))).toBe(
      true,
    );
    expect(mockProductDetails.some((product) => product.skus.length > 1)).toBe(true);
  });

  it("提供至少三件中文商品和不同价格区间", () => {
    expect(mockProductDetails.length).toBeGreaterThanOrEqual(3);
    expect(mockProductDetails.every((product) => /[\u4e00-\u9fff]/u.test(product.name))).toBe(true);
    expect(
      new Set(mockProductDetails.map((product) => product.price.amountMinor)).size,
    ).toBeGreaterThan(1);
  });
});
