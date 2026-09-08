import { describe, expect, it, vi } from "vitest";

import {
  ProductCopyOutputSchema,
  LLMProviderError,
  type LLMGenerationRequest,
  type LLMGenerationResult,
  type LLMProvider,
  type ProductCopyType,
  type ProductDetail,
} from "@shopmate/contracts";

import { AuthPermission } from "../../auth/contracts/auth-context.js";

import {
  ProductCopyService,
  createGenerateProductCopyToolRegistration,
} from "./product-copy.tool.js";
import { ToolRegistry } from "./tool-registry.js";
import { AiChatService } from "../chat/ai-chat.service.js";
import { createAuthContext } from "../../auth/contracts/index.js";
import { BusinessAgent } from "../agent/business-agent.js";

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
  it("直接生成仍验证权限，拒绝后不调用模型", async () => {
    const { service, provider } = createHarness();
    const registry = new ToolRegistry({ allowedToolNames: ["generate_product_copy"] });
    registry.register(createGenerateProductCopyToolRegistration(service));
    const chat = new AiChatService({ run: vi.fn() }, registry);
    await expect(
      chat.chat(createAuthContext({ ...context(), permissions: [] }), {
        message: { role: "user", content: "标题" },
        productCopy: { productId: "product-001", copyType: "TITLE" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("直接生成超时穿过工具层返回 504 且只调用一次模型", async () => {
    const { service, provider } = createHarness();
    provider.generate.mockRejectedValue(
      new LLMProviderError({ code: "TIMEOUT", message: "private", retryable: true }),
    );
    const registry = new ToolRegistry({ allowedToolNames: ["generate_product_copy"] });
    registry.register(createGenerateProductCopyToolRegistration(service));
    const chat = new AiChatService({ run: vi.fn() }, registry);
    await expect(
      chat.chat(createAuthContext(context()), {
        message: { role: "user", content: "标题" },
        productCopy: { productId: "product-001", copyType: "TITLE" },
      }),
    ).rejects.toMatchObject({ status: 504, response: { code: "AI_TIMEOUT", retryable: false } });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
  it("结构化文案请求只生成一次，跳过选工具和结束语", async () => {
    const { service, provider } = createHarness();
    const registry = new ToolRegistry({ allowedToolNames: ["generate_product_copy"] });
    registry.register(createGenerateProductCopyToolRegistration(service));
    const run = vi.fn();
    const chat = new AiChatService({ run }, registry);
    const result = await chat.chat(createAuthContext(context()), {
      message: { role: "user", content: "生成标题" },
      productCopy: { productId: "product-001", copyType: "TITLE" },
    });
    expect(result.message.productCopy?.productId).toBe("product-001");
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("聊天选中工具后保留生成结果，不再请求结束语", async () => {
    const { service, provider } = createHarness();
    const registry = new ToolRegistry({ allowedToolNames: ["generate_product_copy"] });
    registry.register(createGenerateProductCopyToolRegistration(service));
    const selectTool = vi.fn(async () => ({
      message: {
        role: "assistant" as const,
        content: null,
        toolCalls: [
          {
            id: "copy",
            name: "generate_product_copy",
            arguments: { productId: "product-001", copyType: "TITLE" },
          },
        ],
      },
      finishReason: "tool_calls" as const,
    }));
    const result = await new BusinessAgent({ name: "test", generate: selectTool }, registry).run({
      question: "生成文案",
      context: context(),
    });
    expect(result.status).toBe("completed");
    expect(result.toolOutputs).toHaveLength(1);
    expect(selectTool).toHaveBeenCalledTimes(1);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
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
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
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
