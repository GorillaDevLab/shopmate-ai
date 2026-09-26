import { describe, expect, it, vi } from "vitest";

import { LLMProviderError, type LLMGenerationRequest } from "@shopmate/contracts";

import {
  DeepSeekLLMProvider,
  type DeepSeekChatCompletionsClient,
} from "./deepseek-llm.provider.js";

describe("DeepSeekLLMProvider", () => {
  it("把取消信号传给 SDK，不增加重试",async()=>{
    const create=vi.fn<DeepSeekChatCompletionsClient["create"]>().mockResolvedValue(textResponse("已完成。"));
    const provider=new DeepSeekLLMProvider({env:{},client:{create}});
    const controller=new AbortController();
    await provider.generate({messages:[{role:"user",content:"你好"}],signal:controller.signal});
    expect(create.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(provider.generate({messages:[{role:"user",content:"你好"}],signal:controller.signal})).rejects.toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("缺少 API Key 时给出清晰配置错误", () => {
    expect(
      () =>
        new DeepSeekLLMProvider({
          env: {},
        }),
    ).toThrow("DeepSeek Provider 配置不完整");
  });

  it("把 Provider 消息、模型和参数映射到 DeepSeek 请求", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    create.mockResolvedValue(textResponse("这是中文测试回答。"));

    const provider = new DeepSeekLLMProvider({
      env: {
        DEEPSEEK_MODEL: "deepseek-v4-flash",
      },
      client: {
        create,
      },
    });

    const request: LLMGenerationRequest = {
      messages: [
        {
          role: "user",
          content: "请用中文介绍商品。",
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 300,
    };

    const result = await provider.generate(request);

    expect(create).toHaveBeenCalledTimes(1);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        stream: false,
        temperature: 0.2,
        max_tokens: 300,
        thinking: {
          type: "disabled",
        },
      }),
    );

    const sentRequest = create.mock.calls[0]?.[0];

    expect(sentRequest?.messages[0]).toEqual(
      expect.objectContaining({
        role: "system",
      }),
    );

    expect(sentRequest?.messages[1]).toEqual({
      role: "user",
      content: "请用中文介绍商品。",
    });

    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "这是中文测试回答。",
      },
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
      requestId: "request-fixture-001",
    });
  });

  it("把工具定义映射成 function tools", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    create.mockResolvedValue(textResponse("完成"));

    const provider = fixtureProvider(create);

    await provider.generate({
      messages: [
        {
          role: "user",
          content: "查询库存风险",
        },
      ],
      tools: [
        {
          name: "get_inventory_risks",
          description: "查询库存风险",
          inputSchema: {
            type: "object",
            properties: {
              asOfDate: {
                type: "string",
              },
            },
            required: ["asOfDate"],
          },
        },
      ],
    });

    expect(create.mock.calls[0]?.[0].tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_inventory_risks",
          description: "查询库存风险",
          parameters: {
            type: "object",
            properties: {
              asOfDate: {
                type: "string",
              },
            },
            required: ["asOfDate"],
          },
        },
      },
    ]);
  });

  it("把 DeepSeek Tool Call 转成供应商无关格式", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    create.mockResolvedValue({
      id: "completion-tool",
      _request_id: "request-tool",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-001",
                type: "function",
                function: {
                  name: "get_inventory_risks",
                  arguments: '{"asOfDate":"2026-08-31"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    const provider = fixtureProvider(create);

    const result = await provider.generate({
      messages: [
        {
          role: "user",
          content: "查询库存风险",
        },
      ],
    });

    expect(result).toEqual({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-001",
            name: "get_inventory_risks",
            arguments: {
              asOfDate: "2026-08-31",
            },
          },
        ],
      },
      finishReason: "tool_calls",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      requestId: "request-tool",
    });
  });

  it("拒绝非法 Tool Call JSON", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    create.mockResolvedValue({
      id: "invalid-tool",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-invalid",
                type: "function",
                function: {
                  name: "get_sales_summary",
                  arguments: "{not-json",
                },
              },
            ],
          },
        },
      ],
    });

    const provider = fixtureProvider(create);

    await expect(
      provider.generate({
        messages: [
          {
            role: "user",
            content: "查询销售",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("拒绝不支持的请求模型", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    const provider = fixtureProvider(create);

    await expect(
      provider.generate({
        model: "fake-model",
        messages: [
          {
            role: "user",
            content: "测试",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });

    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "AuthenticationError",
      status: 401,
      expectedCode: "AUTHENTICATION",
      retryable: false,
    },
    {
      name: "RateLimitError",
      status: 429,
      expectedCode: "RATE_LIMIT",
      retryable: true,
    },
    {
      name: "APIConnectionTimeoutError",
      status: undefined,
      expectedCode: "TIMEOUT",
      retryable: true,
    },
    {
      name: "APIConnectionError",
      status: undefined,
      expectedCode: "NETWORK",
      retryable: true,
    },
  ])("映射 $name Provider 错误", async ({ name, status, expectedCode, retryable }) => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    const provider = fixtureProvider(create);

    const providerError = Object.assign(new Error("upstream fixture"), {
      name,
      ...(status !== undefined
        ? {
            status,
          }
        : {}),
    });

    create.mockRejectedValue(providerError);

    const error = await provider
      .generate({
        messages: [
          {
            role: "user",
            content: "测试",
          },
        ],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMProviderError);

    expect(error).toMatchObject({
      code: expectedCode,
      retryable,
    });
  });

  it("映射后的错误不会包含原始 API Key", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    const provider = fixtureProvider(create);

    create.mockRejectedValue(
      Object.assign(new Error("Authorization Bearer SUPER_SECRET_TEST_KEY"), {
        name: "AuthenticationError",
        status: 401,
      }),
    );

    const error = await provider
      .generate({
        messages: [
          {
            role: "user",
            content: "测试",
          },
        ],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMProviderError);

    if (!(error instanceof LLMProviderError)) {
      throw new Error("Expected LLMProviderError");
    }

    expect(error.message).not.toContain("SUPER_SECRET_TEST_KEY");
  });

  it("空 choices 返回 INVALID_RESPONSE", async () => {
    const create = vi.fn<DeepSeekChatCompletionsClient["create"]>();

    create.mockResolvedValue({
      id: "empty-response",
      choices: [],
    });

    const provider = fixtureProvider(create);

    await expect(
      provider.generate({
        messages: [
          {
            role: "user",
            content: "测试",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

function fixtureProvider(create: DeepSeekChatCompletionsClient["create"]) {
  return new DeepSeekLLMProvider({
    env: {
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    },
    client: {
      create,
    },
  });
}

function textResponse(content: string) {
  return {
    id: "completion-fixture-001",
    _request_id: "request-fixture-001",

    choices: [
      {
        finish_reason: "stop",
        message: {
          content,
        },
      },
    ],

    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    },
  };
}
