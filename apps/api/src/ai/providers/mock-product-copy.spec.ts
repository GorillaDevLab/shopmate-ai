import { ProductCopyContentSchema, type LLMGenerationRequest } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { MockLLMProvider } from "./mock-llm.provider.js";

const copyCases = [
  ["标题文案", "TITLE"],
  ["商品描述", "DESCRIPTION"],
  ["小红书文案", "XIAOHONGSHU"],
  ["抖音文案", "DOUYIN"],
  ["通用文案", "GENERAL"],
] as const;

describe("I5 Mock 商品文案交互", () => {
  it.each(copyCases)("%s 会调用 generate_product_copy", async (label, copyType) => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(
      userRequest(
        `请为商品 product-001 生成${label}。商品 ID：product-001；文案类型：${copyType}。请使用真实商品信息。`,
      ),
    );

    expect(result.finishReason).toBe("tool_calls");

    expect(result.message.toolCalls).toEqual([
      {
        id: `mock-call-product-copy-${copyType.toLowerCase()}`,
        name: "generate_product_copy",
        arguments: {
          productId: "product-001",
          copyType,
        },
      },
    ]);
  });

  it("ProductCopyService 风格请求返回合法结构化 JSON", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate({
      messages: [
        {
          role: "system",
          content: [
            "你是中国电商商品营销文案助手。",
            "只能根据系统提供的真实商品 JSON 生成内容。",
            "只返回 JSON，不要使用 Markdown 代码块。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "生成适合商品详情页使用的中文商品描述。",
            product: {
              id: "product-001",
              name: "轻量随行保温杯",
            },
          }),
        },
      ],
    });

    expect(result.finishReason).toBe("stop");

    expect(result.message.content).not.toBeNull();

    const payload = JSON.parse(result.message.content ?? "");

    expect(ProductCopyContentSchema.safeParse(payload).success).toBe(true);

    expect(payload.title).toContain("轻量随行保温杯");
  });

  it("收到商品文案工具结果后停止工具调用并返回中文完成提示", async () => {
    const provider = new MockLLMProvider();

    const productCopy = {
      productId: "product-001",
      copyType: "XIAOHONGSHU",
      title: "轻量随行保温杯",
      body: "适合日常通勤使用。",
      tags: ["通勤", "实用"],
    };

    const result = await provider.generate({
      messages: [
        {
          role: "user",
          content:
            "请为商品 product-001 生成小红书文案。商品 ID：product-001；文案类型：XIAOHONGSHU。请使用真实商品信息。",
        },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "mock-call-product-copy-xiaohongshu",
              name: "generate_product_copy",
              arguments: {
                productId: "product-001",
                copyType: "XIAOHONGSHU",
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "mock-call-product-copy-xiaohongshu",
          name: "generate_product_copy",
          content: JSON.stringify(productCopy),
        },
      ],
    });

    expect(result.finishReason).toBe("stop");

    expect(result.message.toolCalls).toBeUndefined();

    expect(result.message.content).toBe("商品文案已生成，请查看下方标题、正文和标签。");
  });
});

function userRequest(content: string): LLMGenerationRequest {
  return {
    messages: [
      {
        role: "user",
        content,
      },
    ],
  };
}
