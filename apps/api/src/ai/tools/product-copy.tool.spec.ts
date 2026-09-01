import { describe, expect, it, vi } from "vitest";

import {
  ProductCopyOutputSchema,
  type LLMGenerationRequest,
  type LLMGenerationResult,
  type LLMProvider,
  type ProductCopyType,
  type ProductDetail,
} from "@shopmate/contracts";

import { AuthPermission } from "../../auth/contracts/auth-context.js";

import { ProductCopyService } from "./product-copy.tool.js";

const productFixture: ProductDetail = {
  id: "product-001",

  name: "轻量随行保温杯",

  status: "ACTIVE",

  price: {
    amountMinor: 9900,
    currency: "CNY",
  },

  totalInventory: 35,
  skuCount: 1,

  updatedAt: "2026-09-01T08:00:00.000Z",

  description: "适合日常通勤使用的轻量随行保温杯。",

  features: ["轻量设计", "便于携带"],

  sellingPoints: ["适合通勤", "日常使用方便"],

  skus: [
    {
      id: "sku-001",
      code: "CUP-001",
      inventory: 35,

      cost: {
        amountMinor: 4500,
        currency: "CNY",
      },

      alertThreshold: 10,
      isLowStock: false,
    },
  ],

  createdAt: "2026-08-01T08:00:00.000Z",
};

describe("I4 generateProductCopy", () => {
  it("不接受客户端伪造商品详情", async () => {
    const { productService, provider, service } = createHarness();

    await expect(
      service.generateProductCopy(context(), {
        productId: "product-001",

        copyType: "GENERAL",

        name: "伪造商品名称",

        sellingPoints: ["伪造卖点"],
      }),
    ).rejects.toBeDefined();

    expect(productService.findById).not.toHaveBeenCalled();

    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("不存在商品时不会调用模型", async () => {
    const { productService, provider, service } = createHarness();

    productService.findById.mockRejectedValueOnce(new Error("RESOURCE_NOT_FOUND"));

    await expect(
      service.generateProductCopy(context(), {
        productId: "missing-product",

        copyType: "GENERAL",
      }),
    ).rejects.toBeDefined();

    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("模型输入来自 ProductService 的真实商品信息", async () => {
    const { provider, service } = createHarness();

    await service.generateProductCopy(context(), {
      productId: "product-001",

      copyType: "DESCRIPTION",
    });

    expect(provider.generate).toHaveBeenCalledTimes(1);

    const request = provider.generate.mock.calls[0]?.[0];

    expect(request).toBeDefined();

    const serialized = JSON.stringify(request);

    expect(serialized).toContain("轻量随行保温杯");

    expect(serialized).toContain("轻量设计");

    expect(serialized).toContain("适合通勤");
  });

  it.each([
    "TITLE",
    "DESCRIPTION",
    "XIAOHONGSHU",
    "DOUYIN",
    "GENERAL",
  ] satisfies readonly ProductCopyType[])("%s 文案生成结果通过 Schema", async (copyType) => {
    const { service } = createHarness();

    const result = await service.generateProductCopy(context(), {
      productId: "product-001",

      copyType,
    });

    expect(result.productId).toBe(productFixture.id);

    expect(result.copyType).toBe(copyType);

    expect(ProductCopyOutputSchema.parse(result)).toEqual(result);
  });

  it("模型返回非法 JSON 时拒绝结果", async () => {
    const { provider, service } = createHarness();

    provider.generate.mockResolvedValueOnce(generationResult("这不是 JSON"));

    await expect(
      service.generateProductCopy(context(), {
        productId: "product-001",

        copyType: "GENERAL",
      }),
    ).rejects.toThrow("模型返回的商品文案不是有效 JSON。");
  });

  it("模型返回不符合 Schema 的文案时拒绝结果", async () => {
    const { provider, service } = createHarness();

    provider.generate.mockResolvedValueOnce(
      generationResult(
        JSON.stringify({
          title: "",
          body: "",
          tags: [],
        }),
      ),
    );

    await expect(
      service.generateProductCopy(context(), {
        productId: "product-001",

        copyType: "GENERAL",
      }),
    ).rejects.toBeDefined();
  });
});

function createHarness() {
  const productService = {
    findById: vi.fn(async () => productFixture),
  };

  const generate = vi.fn(async (request: LLMGenerationRequest): Promise<LLMGenerationResult> => {
    void request;

    return generationResult(
      JSON.stringify({
        title: "轻量随行保温杯",

        body: "轻巧便携，适合日常通勤使用。",

        tags: ["通勤", "随行杯"],
      }),
    );
  });

  const provider = {
    name: "fixture-provider",
    generate,
  } satisfies LLMProvider;

  const service = new ProductCopyService(productService, provider);

  return {
    productService,
    provider: {
      ...provider,
      generate,
    },
    service,
  };
}

function generationResult(content: string): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content,
    },

    finishReason: "stop",
  };
}

function context() {
  return {
    userId: "user-001",
    merchantId: "merchant-001",

    permissions: [AuthPermission.ProductsRead],
  } as const;
}
