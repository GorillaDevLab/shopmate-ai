import { describe, expect, it } from "vitest";

import {
  DouyinProductCopySchema,
  GeneralProductCopySchema,
  ProductCopyOutputSchema,
  ProductCopyRequestSchema,
  ProductDescriptionCopySchema,
  ProductTitleCopySchema,
  XiaohongshuProductCopySchema,
} from "../index.js";

const baseCopy = {
  productId: "product-001",
  title: "轻量随行保温杯",
  body: "轻巧便携，适合日常通勤和外出使用。",
  tags: ["通勤", "随行杯"],
};

describe("I4 商品营销文案 Contract", () => {
  it.each([
    ["TITLE", ProductTitleCopySchema],
    ["DESCRIPTION", ProductDescriptionCopySchema],
    ["XIAOHONGSHU", XiaohongshuProductCopySchema],
    ["DOUYIN", DouyinProductCopySchema],
    ["GENERAL", GeneralProductCopySchema],
  ] as const)("%s 文案通过对应 Schema", (copyType, schema) => {
    const value = {
      ...baseCopy,
      copyType,
    };

    expect(schema.parse(value)).toEqual(value);

    expect(ProductCopyOutputSchema.parse(value)).toEqual(value);
  });

  it("请求不接受客户端伪造商品详情", () => {
    const result = ProductCopyRequestSchema.safeParse({
      productId: "product-001",
      copyType: "GENERAL",

      name: "伪造商品",
      description: "伪造商品详情",
      price: 1,
    });

    expect(result.success).toBe(false);
  });
});
