import { describe, expect, it, vi } from "vitest";

import { LLMProviderError, type LLMGenerationRequest } from "@shopmate/contracts";

import { MOCK_LLM_ERROR_FIXTURES, MockLLMProvider } from "./mock-llm.provider.js";

describe("MockLLMProvider", () => {
  it("相同库存输入始终返回完全一致结果", async () => {
    const provider = new MockLLMProvider();

    const request = userRequest("哪些商品快没库存了？");

    const first = await provider.generate(request);

    const second = await provider.generate(request);

    expect(first).toEqual(second);

    expect(first).toEqual({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "mock-call-inventory-001",
            name: "get_inventory_risks",
            arguments: {
              startDate: "2026-08-25",
              endDate: "2026-08-31",
            },
          },
        ],
      },
      finishReason: "tool_calls",
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
      },
      requestId: "mock-request-inventory",
    });
  });

  it("库存意图返回固定库存工具调用", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(userRequest("帮我看看库存和缺货风险"));

    expect(result.message.toolCalls).toEqual([
      {
        id: "mock-call-inventory-001",
        name: "get_inventory_risks",
        arguments: {
          startDate: "2026-08-25",
          endDate: "2026-08-31",
        },
      },
    ]);

    expect(result.finishReason).toBe("tool_calls");
  });

  it("销售意图返回固定销售工具调用", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(userRequest("最近销售额和订单怎么样？"));

    expect(result.message.toolCalls).toEqual([
      {
        id: "mock-call-sales-001",
        name: "get_sales_summary",
        arguments: {
          startDate: "2026-08-25",
          endDate: "2026-08-31",
        },
      },
    ]);

    expect(result.finishReason).toBe("tool_calls");
  });

  it("热销排行意图优先选择热销商品工具", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(userRequest("最近哪些商品最热销？给我销量排行"));

    expect(result.message.toolCalls).toEqual([
      {
        id: "mock-call-best-sellers-001",
        name: "get_best_sellers",
        arguments: {
          startDate: "2026-08-25",
          endDate: "2026-08-31",
          limit: 20,
        },
      },
    ]);
  });

  it("销售趋势意图优先选择销售趋势工具", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(userRequest("最近销售额的每日趋势怎么样？"));

    expect(result.message.toolCalls).toEqual([
      {
        id: "mock-call-sales-trend-001",
        name: "get_sales_trend",
        arguments: {
          startDate: "2026-08-25",
          endDate: "2026-08-31",
          granularity: "day",
        },
      },
    ]);
  });

  it("文案意图返回固定中文回答", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(userRequest("帮我写一个商品推广文案"));

    expect(result.finishReason).toBe("stop");

    expect(result.message.content).toBe(
      "这款商品主打实用、易用与高性价比，适合日常使用。建议结合真实商品参数、目标人群和已验证卖点进一步完善文案。",
    );
  });

  it("收到已验证工具结果后停止调用并返回中文解释", async () => {
    const provider = new MockLLMProvider();
    const toolContent = JSON.stringify({
      status: "ok",
      data: {
        revenueMinor: 174200,
        orderCount: 5,
      },
    });

    const result = await provider.generate({
      messages: [
        { role: "user", content: "最近销售额和订单怎么样？" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "mock-call-sales-001",
              name: "get_sales_summary",
              arguments: {
                startDate: "2026-08-25",
                endDate: "2026-08-31",
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "mock-call-sales-001",
          name: "get_sales_summary",
          content: toolContent,
        },
      ],
    });

    expect(result.finishReason).toBe("stop");
    expect(result.message.toolCalls).toBeUndefined();
    expect(result.message.content).toContain("经过验证的工具结果");
    expect(result.message.content).toContain(toolContent);
  });

  it("无法识别意图时明确说明数据不足而不是编造经营数据", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate(userRequest("帮我分析一下"));

    expect(result.message.content).toContain("没有足够信息");

    expect(result.message.content).toContain("可验证");
  });

  it("为 Demo 生成受限的看板查询工具调用", async () => {
    const provider = new MockLLMProvider();
    const result = await provider.generate({
      messages: [
        { role: "system", content: "你是经营看板查询规划器，只能调用 propose_dashboard_insight。" },
        { role: "user", content: "目标组件：pie\n经营问题：按商品生成销量饼图" },
      ],
    });
    expect(result.message.toolCalls?.[0]).toMatchObject({
      name: "propose_dashboard_insight",
      arguments: { metric: "unitsSold", groupBy: "product", visualization: "pie" },
    });
  });

  it("没有 user message 时安全返回固定兜底回答", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate({
      messages: [
        {
          role: "system",
          content: "测试系统消息",
        },
      ],
    });

    expect(result.finishReason).toBe("stop");

    expect(result.message.content).toContain("没有足够信息");
  });

  it("监听规则会采用用户提供的库存阈值", async () => {
    const provider = new MockLLMProvider();

    const result = await provider.generate({
      messages: [
        { role: "system", content: "只能调用 propose_monitoring_rule。" },
        { role: "user", content: "库存低于 5 件时提醒我" },
      ],
    });

    expect(result.message.toolCalls?.[0]).toMatchObject({
      name: "propose_monitoring_rule",
      arguments: { kind: "inventoryThreshold", threshold: 5 },
    });
  });

  it("调用过程中不会发出网络请求", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Mock Provider 不允许访问网络");
    });

    vi.stubGlobal("fetch", fetchSpy);

    try {
      const provider = new MockLLMProvider();

      await provider.generate(userRequest("最近销售情况怎么样？"));

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["AUTHENTICATION", "RATE_LIMIT", "TIMEOUT"] as const)(
    "支持 %s 错误 Fixture",
    async (fixtureName) => {
      const fixture = MOCK_LLM_ERROR_FIXTURES[fixtureName];

      const provider = new MockLLMProvider({
        errorFixture: fixtureName,
      });

      const error = await provider
        .generate(userRequest("测试错误"))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(LLMProviderError);

      if (!(error instanceof LLMProviderError)) {
        throw new Error(`Expected LLMProviderError for ${fixtureName}`);
      }

      expect(error.code).toBe(fixture.code);

      expect(error.retryable).toBe(fixture.retryable);

      expect(error.message).toBe(fixture.message);
    },
  );
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
