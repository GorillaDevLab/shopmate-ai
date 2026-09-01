import {
  ProductCopyContentSchema,
  ProductCopyOutputSchema,
  ProductCopyRequestSchema,
  type LLMGenerationRequest,
  type LLMProvider,
  type ProductCopyOutput,
  type ProductCopyRequest,
  type ProductCopyType,
  type ProductDetail,
} from "@shopmate/contracts";

import { AuthPermission } from "../../auth/contracts/auth-context.js";
import type { ProductService } from "../../products/product.service.js";

import type { ToolInvocationContext, ToolRegistration, ToolSchema } from "./tool-registry.js";

export const GENERATE_PRODUCT_COPY_TOOL_NAME = "generate_product_copy";

type ProductReader = Pick<ProductService, "findById">;

export class ProductCopyService {
  constructor(
    private readonly productService: ProductReader,
    private readonly provider: LLMProvider,
  ) {}

  async generateProductCopy(
    context: Readonly<ToolInvocationContext>,
    rawInput: unknown,
  ): Promise<ProductCopyOutput> {
    const input = ProductCopyRequestSchema.parse(rawInput);

    /*
     * 商品必须首先由 ProductService 按当前 Merchant 查询。
     *
     * 如果商品不存在、属于其他 Merchant 或商品服务失败，
     * await 会在这里抛出，因此绝不会进入 provider.generate。
     */
    const product = await this.productService.findById(context, {
      productId: input.productId,
    });

    const result = await this.provider.generate(createGenerationRequest(product, input.copyType));

    const rawContent = result.message.content?.trim();

    if (!rawContent) {
      throw new Error("模型未返回商品文案。");
    }

    const modelPayload = ProductCopyContentSchema.parse(parseModelJson(rawContent));

    /*
     * productId 和 copyType 不采用模型输出。
     *
     * 它们完全由服务端真实商品和已校验请求确定，
     * 防止模型修改商品身份。
     */
    return ProductCopyOutputSchema.parse({
      productId: product.id,
      copyType: input.copyType,
      ...modelPayload,
    });
  }
}

export function createGenerateProductCopyToolRegistration(
  service: ProductCopyService,
): ToolRegistration<ProductCopyRequest, ProductCopyOutput> {
  return {
    name: GENERATE_PRODUCT_COPY_TOOL_NAME,

    description: "基于当前 Merchant 的真实商品信息生成结构化中文营销文案。",

    input: productCopyInputToolSchema,

    output: productCopyOutputToolSchema,

    requiredPermissions: [AuthPermission.ProductsRead],

    handler: (input, context) => service.generateProductCopy(context, input),
  };
}

const productCopyInputToolSchema: ToolSchema<ProductCopyRequest> = {
  jsonSchema: {
    type: "object",

    properties: {
      productId: {
        type: "string",
        description: "必须是当前 Merchant 下真实存在的商品 ID。",
      },

      copyType: {
        type: "string",
        enum: ["TITLE", "DESCRIPTION", "XIAOHONGSHU", "DOUYIN", "GENERAL"],
      },
    },

    required: ["productId", "copyType"],

    additionalProperties: false,
  },

  parse(value: unknown) {
    return ProductCopyRequestSchema.parse(value);
  },
};

const productCopyOutputToolSchema: ToolSchema<ProductCopyOutput> = {
  jsonSchema: {
    type: "object",

    properties: {
      productId: {
        type: "string",
      },

      copyType: {
        type: "string",
        enum: ["TITLE", "DESCRIPTION", "XIAOHONGSHU", "DOUYIN", "GENERAL"],
      },

      title: {
        type: "string",
      },

      body: {
        type: "string",
      },

      tags: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },

    required: ["productId", "copyType", "title", "body", "tags"],

    additionalProperties: false,
  },

  parse(value: unknown) {
    return ProductCopyOutputSchema.parse(value);
  },
};

function createGenerationRequest(
  product: ProductDetail,
  copyType: ProductCopyType,
): LLMGenerationRequest {
  const safeProductContext = {
    id: product.id,
    name: product.name,
    description: product.description,
    features: product.features,
    sellingPoints: product.sellingPoints,

    price: product.price,

    status: product.status,

    skuCount: product.skuCount,
    totalInventory: product.totalInventory,

    skus: product.skus.map((sku) => ({
      code: sku.code,
      inventory: sku.inventory,
    })),
  };

  return {
    locale: "zh-CN",

    temperature: 0.6,

    maxOutputTokens: 800,

    messages: [
      {
        role: "system",

        content: [
          "你是中国电商商品营销文案助手。",
          "只能根据系统提供的真实商品 JSON 生成内容。",
          "严禁编造商品材质、尺寸、功效、销量、折扣、认证、赠品或其他未提供事实。",
          "缺失的信息不得猜测。",
          "所有内容必须使用简体中文。",
          "只返回 JSON，不要使用 Markdown 代码块。",
          'JSON 格式必须严格为：{"title":"...","body":"...","tags":["..."]}',
          "title 最长 80 字符，body 最长 1200 字符，tags 最多 10 个。",
        ].join("\n"),
      },

      {
        role: "user",

        content: JSON.stringify({
          task: getCopyInstruction(copyType),

          product: safeProductContext,
        }),
      },
    ],
  };
}

function getCopyInstruction(copyType: ProductCopyType): string {
  switch (copyType) {
    case "TITLE":
      return "生成简洁明确的中文商品标题，同时给出简短正文和相关标签。";

    case "DESCRIPTION":
      return "生成适合商品详情页使用的中文商品描述，突出真实特点和卖点。";

    case "XIAOHONGSHU":
      return "生成自然、有生活场景感的小红书风格中文商品文案，不夸大事实。";

    case "DOUYIN":
      return "生成节奏简洁、适合短视频商品介绍的抖音风格中文文案，不夸大事实。";

    case "GENERAL":
      return "生成适合常规电商推广场景的通用中文营销文案。";
  }
}

function parseModelJson(content: string): unknown {
  const normalized = stripMarkdownFence(content);

  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error("模型返回的商品文案不是有效 JSON。");
  }
}

function stripMarkdownFence(content: string): string {
  const trimmed = content.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}
