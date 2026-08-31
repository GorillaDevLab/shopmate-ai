import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LLM_LOCALE,
  DEFAULT_LLM_SYSTEM_POLICY_ZH_CN,
  LLMProviderError,
  type LLMGenerationRequest,
  type LLMGenerationResult,
  type LLMProvider,
  type LLMToolDefinition,
} from "./llm-provider.js";

describe("LLM Provider contracts", () => {
  it("使用 zh-CN 作为默认语言", () => {
    expect(DEFAULT_LLM_LOCALE).toBe("zh-CN");
  });

  it("中文默认策略明确禁止编造经营数据", () => {
    expect(DEFAULT_LLM_SYSTEM_POLICY_ZH_CN).toContain("不得编造");

    expect(DEFAULT_LLM_SYSTEM_POLICY_ZH_CN).toContain("销售额");

    expect(DEFAULT_LLM_SYSTEM_POLICY_ZH_CN).toContain("订单");

    expect(DEFAULT_LLM_SYSTEM_POLICY_ZH_CN).toContain("库存");

    expect(DEFAULT_LLM_SYSTEM_POLICY_ZH_CN).toContain("数据不足");
  });

  it("支持供应商无关的消息与生成结果", async () => {
    const generate = vi.fn<(request: LLMGenerationRequest) => Promise<LLMGenerationResult>>();

    generate.mockResolvedValue({
      message: {
        role: "assistant",
        content: "当前库存数据不足。",
      },
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
      },
    });

    const provider: LLMProvider = {
      name: "fixture-provider",
      generate,
    };

    const request: LLMGenerationRequest = {
      messages: [
        {
          role: "system",
          content: DEFAULT_LLM_SYSTEM_POLICY_ZH_CN,
        },
        {
          role: "user",
          content: "帮我看看哪些商品快没库存了",
        },
      ],
    };

    const result = await provider.generate(request);

    expect(generate).toHaveBeenCalledWith(request);

    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "当前库存数据不足。",
      },
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
      },
    });
  });

  it("支持供应商无关的工具定义与工具调用", () => {
    const tool: LLMToolDefinition = {
      name: "get_inventory_risks",
      description: "查询当前商家的库存风险",
      inputSchema: {
        type: "object",
        properties: {
          asOfDate: {
            type: "string",
          },
        },
        required: ["asOfDate"],
        additionalProperties: false,
      },
    };

    const result: LLMGenerationResult = {
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: tool.name,
            arguments: {
              asOfDate: "2026-08-31",
            },
          },
        ],
      },
      finishReason: "tool_calls",
    };

    expect(result.message.toolCalls).toEqual([
      {
        id: "call-1",
        name: "get_inventory_risks",
        arguments: {
          asOfDate: "2026-08-31",
        },
      },
    ]);
  });

  it("工具结果可以通过 tool message 回传给模型", () => {
    const request: LLMGenerationRequest = {
      messages: [
        {
          role: "user",
          content: "查询库存风险",
        },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_inventory_risks",
              arguments: {},
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "get_inventory_risks",
          content: '{"items":[]}',
        },
      ],
    };

    expect(request.messages[2]).toEqual({
      role: "tool",
      toolCallId: "call-1",
      name: "get_inventory_risks",
      content: '{"items":[]}',
    });
  });

  it.each([
    {
      code: "CONFIGURATION",
      retryable: false,
    },
    {
      code: "AUTHENTICATION",
      retryable: false,
    },
    {
      code: "RATE_LIMIT",
      retryable: true,
    },
    {
      code: "TIMEOUT",
      retryable: true,
    },
    {
      code: "NETWORK",
      retryable: true,
    },
    {
      code: "INVALID_REQUEST",
      retryable: false,
    },
    {
      code: "INVALID_RESPONSE",
      retryable: false,
    },
    {
      code: "CONTENT_FILTER",
      retryable: false,
    },
    {
      code: "UNKNOWN",
      retryable: false,
    },
  ] as const)("支持 $code 错误分类", ({ code, retryable }) => {
    const error = new LLMProviderError({
      code,
      message: "Provider 调用失败",
      retryable,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LLMProviderError");
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toBe("Provider 调用失败");
  });
});
