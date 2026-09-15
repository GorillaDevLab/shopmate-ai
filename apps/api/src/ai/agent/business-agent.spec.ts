import {
  GetInventoryRisksTool,
  GetSalesSummaryTool,
  type LLMGenerationRequest,
  type LLMGenerationResult,
  type LLMProvider,
} from "@shopmate/contracts";
import { describe, expect, it, vi } from "vitest";

import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { ToolRegistry, type ToolInvocationContext } from "../tools/tool-registry.js";
import { BusinessAgent, BusinessAgentError } from "./business-agent.js";

const context: ToolInvocationContext = {
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [AuthPermission.OrdersRead],
};

const inventoryContext: ToolInvocationContext = {
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
};

const period = {
  startDate: "2026-08-25",
  endDate: "2026-08-31",
};

const salesResult = {
  status: "ok" as const,
  data: {
    source: "DashboardService" as const,
    period: { ...period, timezone: "Asia/Shanghai" as const },
    revenueMinor: 174_200,
    currency: "CNY" as const,
    orderCount: 5,
    unitsSold: 27,
    averageOrderValueMinor: 34_840,
  },
};

const inventoryResult = {
  status: "ok" as const,
  data: {
    source: "LowStockService" as const,
    period: { ...period, timezone: "Asia/Shanghai" as const },
    items: [
      {
        productId: "product-1",
        productName: "商品 A",
        skuId: "sku-1",
        skuCode: "SKU-001",
        inventory: 3,
        alertThreshold: 10,
        soldUnits: 0,
        averageDailyUnits: 0,
        daysToStockout: null,
        riskLevel: "WARNING" as const,
      },
      {
        productId: "product-2",
        productName: "商品 B",
        skuId: "sku-2",
        skuCode: "SKU-002",
        inventory: 4,
        alertThreshold: 10,
        soldUnits: 0,
        averageDailyUnits: 0,
        daysToStockout: null,
        riskLevel: "WARNING" as const,
      },
      {
        productId: "product-3",
        productName: "商品 C",
        skuId: "sku-3",
        skuCode: "SKU-003",
        inventory: 6,
        alertThreshold: 12,
        soldUnits: 0,
        averageDailyUnits: 0,
        daysToStockout: null,
        riskLevel: "WARNING" as const,
      },
      {
        productId: "product-4",
        productName: "商品 D",
        skuId: "sku-4",
        skuCode: "SKU-004",
        inventory: 9,
        alertThreshold: 12,
        soldUnits: 0,
        averageDailyUnits: 0,
        daysToStockout: null,
        riskLevel: "WARNING" as const,
      },
    ],
  },
};

type InventoryRisksOutput = ReturnType<typeof GetInventoryRisksTool.output.parse>;

type SalesSummaryOutput = ReturnType<typeof GetSalesSummaryTool.output.parse>;

describe("BusinessAgent", () => {
  it("历史中的数字不成为本轮经营证据", async () => {
    const provider = scriptedProvider([
      finalResult("销售额为 999 元。"),
      finalResult("销售额为 999 元。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry());
    const result = await agent.run({
      question: "继续",
      context,
      history: [
        { role: "user", content: "销售额？" },
        { role: "assistant", content: "销售额为 999 元。" },
      ],
    });
    expect(result.failureCode).toBe("AI_RESPONSE_REJECTED");
    expect(result.answer).not.toContain("999");
  });
  it("追问保留选项上下文，并使用当前认证身份重新查询", async () => {
    const provider = scriptedProvider([
      toolCallResult("follow-up", "get_sales_summary", period),
      finalResult("销售额为 1,742 元，共 5 单。"),
    ]);
    const handler = vi.fn(() => salesResult);
    const history = [
      { role: "user" as const, content: "分析趋势" },
      { role: "assistant" as const, content: "回复 1 查询销售汇总。" },
    ];
    const result = await new BusinessAgent(provider, salesRegistry(handler)).run({
      question: "1",
      context,
      history,
    });
    expect(provider.requests[0]?.messages.slice(1, 4)).toEqual([
      ...history,
      { role: "user", content: "1" },
    ]);
    expect(result.status).toBe("completed");
    expect(handler).toHaveBeenCalledOnce();
  });
  it("把允许的工具交给 Provider，并把已验证结果注入中文回答", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales-1", "get_sales_summary", period),
      finalResult("销售额为 1,742 元，共 5 单。"),
    ]);
    const handler = vi.fn(() => salesResult);
    const registry = salesRegistry(handler);
    const agent = new BusinessAgent(provider, registry);

    const result = await agent.run({
      question: "2026年8月25日到31日销售情况怎么样？",
      context,
    });

    expect(result).toEqual({
      status: "completed",
      answer: "销售额为 1,742 元，共 5 单。",
      usedTools: ["get_sales_summary"],
      rounds: 2,
    });
    expect(handler).toHaveBeenCalledOnce();

    const firstRequest = provider.requests[0];
    const secondRequest = provider.requests[1];
    expect(firstRequest?.tools).toEqual(registry.listDefinitions());
    expect(firstRequest?.messages[0]).toMatchObject({ role: "system" });
    expect(firstRequest?.messages[1]).toEqual({
      role: "user",
      content: "2026年8月25日到31日销售情况怎么样？",
    });
    expect(secondRequest?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-sales-1",
      name: "get_sales_summary",
      content: JSON.stringify(salesResult),
    });
  });

  it("允许 Markdown 有序列表编号而不把编号视为经营数字", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult("1. 销售额为 1,742 元。\n2. 共 5 单。"),
    ]);

    const agent = new BusinessAgent(provider, salesRegistry());

    const result = await agent.run({
      question: "查询销售额和订单数",
      context,
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("1. 销售额为 1,742 元。\n2. 共 5 单。");
  });

  it("忽略列表编号后仍拒绝来源不明的经营数字", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult("1. 销售额为 1,742 元。\n2. 订单数为 999 单。"),
    ]);

    const agent = new BusinessAgent(provider, salesRegistry());

    const result = await agent.run({
      question: "查询销售额和订单数",
      context,
    });

    expect(result.status).toBe("limited");
    expect(result.answer).not.toContain("999");
  });

  it("无须经营工具的中文回答可直接完成", async () => {
    const provider = scriptedProvider([finalResult("请告诉我你想分析的商品或时段。")]);
    const agent = new BusinessAgent(provider, salesRegistry());

    await expect(agent.run({ question: "你好", context })).resolves.toEqual({
      status: "completed",
      answer: "请告诉我你想分析的商品或时段。",
      usedTools: [],
      rounds: 1,
    });
  });

  it("未注册工具不会被执行，并可由 Provider 给出安全解释", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-unknown", "run_sql", { query: "SELECT 1" }),
      finalResult("该查询不在允许的工具范围内，无法执行。"),
    ]);
    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler));

    const result = await agent.run({ question: "执行任意查询", context });

    expect(result.status).toBe("completed");
    expect(result.usedTools).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "run_sql",
    });
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("NOT_REGISTERED");
    expect(provider.requests[1]?.messages.at(-1)?.content).not.toContain("SELECT 1");
  });

  it("重复的相同工具调用复用已有结果而不重复执行工具", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales-1", "get_sales_summary", period),
      toolCallResult("call-sales-2", "get_sales_summary", period),
      finalResult("销售额为 1,742 元，共 5 单。"),
    ]);

    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler));

    const result = await agent.run({ question: "查询销售额", context });

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("销售额为 1,742 元，共 5 单。");
    expect(result.rounds).toBe(3);

    // 相同工具和参数只真正执行一次。
    expect(handler).toHaveBeenCalledOnce();
    expect(provider.generate).toHaveBeenCalledTimes(3);

    expect(provider.requests[2]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-sales-2",
      name: "get_sales_summary",
      content: JSON.stringify(salesResult),
    });
  });

  it("持续重复相同工具调用时仍受工具轮次上限保护", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales-1", "get_sales_summary", period),
      toolCallResult("call-sales-2", "get_sales_summary", period),
      toolCallResult("call-sales-3", "get_sales_summary", period),
    ]);

    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler), {
      maxToolRounds: 2,
    });

    const result = await agent.run({ question: "查询销售额", context });

    expect(result.status).toBe("limited");
    expect(result.answer).toContain("无法继续安全查询");
    expect(result.rounds).toBe(3);

    // 第二轮复用缓存，第三轮在执行前被轮次上限拦截。
    expect(handler).toHaveBeenCalledOnce();
    expect(provider.generate).toHaveBeenCalledTimes(3);
  });

  it("达到工具轮次上限后停止，不会继续调用 Provider", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-1", "get_sales_summary", {
        startDate: "2026-08-25",
        endDate: "2026-08-25",
      }),
      toolCallResult("call-2", "get_sales_summary", {
        startDate: "2026-08-26",
        endDate: "2026-08-26",
      }),
    ]);
    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler), { maxToolRounds: 1 });

    const result = await agent.run({ question: "逐日查询销售额", context });

    expect(result.status).toBe("limited");
    expect(result.rounds).toBe(2);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("最后一个允许的工具轮次之后仍可生成最终解释", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-1", "get_sales_summary", period),
      finalResult("已根据工具结果完成销售分析。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry(), { maxToolRounds: 1 });

    const result = await agent.run({ question: "查询销售额", context });

    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
  });

  it("Provider 异常时返回中文安全结果且不泄漏异常信息", async () => {
    const provider: LLMProvider = {
      name: "failing",
      generate: vi.fn(() => Promise.reject(new Error("secret upstream detail"))),
    };
    const agent = new BusinessAgent(provider, salesRegistry());

    const result = await agent.run({ question: "查询销售额", context });

    expect(result.status).toBe("limited");
    expect(result.answer).toContain("暂时无法完成");
    expect(result.answer).not.toContain("secret");
  });

  it("拒绝空问题和超长问题", async () => {
    const agent = new BusinessAgent(scriptedProvider([]), salesRegistry());

    await expect(agent.run({ question: "   ", context })).rejects.toMatchObject({
      code: "INVALID_QUESTION",
    } satisfies Partial<BusinessAgentError>);
    await expect(agent.run({ question: "问".repeat(2001), context })).rejects.toMatchObject({
      code: "INVALID_QUESTION",
    } satisfies Partial<BusinessAgentError>);
    await expect(agent.run({ question: 123 as unknown as string, context })).rejects.toMatchObject({
      code: "INVALID_QUESTION",
    } satisfies Partial<BusinessAgentError>);
  });

  it("拒绝无中文内容的最终回答", async () => {
    const agent = new BusinessAgent(
      scriptedProvider([finalResult("Revenue unavailable")]),
      salesRegistry(),
    );

    const result = await agent.run({ question: "查询销售额", context });

    expect(result.status).toBe("limited");
    expect(result.answer).toContain("中文");
  });

  it("没有成功工具结果时拒绝包含经营数字的回答", async () => {
    const agent = new BusinessAgent(
      scriptedProvider([finalResult("销售额是 999 元。")]),
      salesRegistry(),
    );

    const result = await agent.run({ question: "销售额怎么样？", context });

    expect(result.status).toBe("limited");
    expect(result.answer).not.toContain("999");
  });

  it("工具返回 empty 时允许回答引用已查询的 ISO 日期范围", async () => {
    const emptyResult: SalesSummaryOutput = {
      status: "empty",
      reason: "NO_DATA",
      message: "当前时段没有销售数据。",
    };
    const provider = scriptedProvider([
      toolCallResult("call-empty", "get_sales_summary", period),
      finalResult("2026-08-25 到 2026-08-31 暂无销售数据。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry(vi.fn(() => emptyResult)));

    const result = await agent.run({
      question: "查询 2026-08-25 到 2026-08-31 的销售情况",
      context,
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("2026-08-25 到 2026-08-31 暂无销售数据。");
  });

  it("允许已查询日期后仍拒绝模型编造经营数字", async () => {
    const emptyResult: SalesSummaryOutput = {
      status: "empty",
      reason: "NO_DATA",
      message: "当前时段没有销售数据。",
    };
    const provider = scriptedProvider([
      toolCallResult("call-empty", "get_sales_summary", period),
      finalResult("2026-08-25 到 2026-08-31 暂无数据，但共有 999 单。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry(vi.fn(() => emptyResult)));

    const result = await agent.run({
      question: "查询 2026-08-25 到 2026-08-31 的销售情况",
      context,
    });

    expect(result.status).toBe("limited");
    expect(result.answer).not.toContain("999");
  });

  it("拒绝回答中出现未经工具调用验证的 ISO 日期", async () => {
    const emptyResult: SalesSummaryOutput = {
      status: "empty",
      reason: "NO_DATA",
      message: "当前时段没有销售数据。",
    };
    const provider = scriptedProvider([
      toolCallResult("call-empty", "get_sales_summary", period),
      finalResult("2026-08-20 到 2026-08-31 暂无销售数据。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry(vi.fn(() => emptyResult)));

    const result = await agent.run({
      question: "查询 2026-08-25 到 2026-08-31 的销售情况",
      context,
    });

    expect(result.status).toBe("limited");
  });

  it("工具只返回 empty 时仍拒绝模型编造经营数字", async () => {
    const emptyResult: SalesSummaryOutput = {
      status: "empty",
      reason: "NO_DATA",
      message: "当前时段没有销售数据。",
    };
    const provider = scriptedProvider([
      toolCallResult("call-empty", "get_sales_summary", period),
      finalResult("该时段仍有 999 单。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry(vi.fn(() => emptyResult)));

    const result = await agent.run({ question: "该时段销售情况？", context });

    expect(result.status).toBe("limited");
    expect(result.answer).not.toContain("999");
  });

  it("中文列表编号不是销售证据，不应触发额外修正请求", async () => {
    const answer = "1、销售额为 1,742 元。\n2、订单数为 5 单。";
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult(answer),
      finalResult(answer),
    ]);
    const result = await new BusinessAgent(provider, salesRegistry()).run({
      question: "查销售",
      context,
    });
    expect(result.status).toBe("completed");
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it("中文列表正文中的无依据数字仍被拒绝", async () => {
    const answer = "1、销售额为 999 元。\n2、订单数为 888 单。";
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult(answer),
      finalResult(answer),
    ]);
    const result = await new BusinessAgent(provider, salesRegistry()).run({
      question: "查销售",
      context,
    });
    expect(result.failureCode).toBe("AI_RESPONSE_REJECTED");
    expect(result.answer).not.toContain("999");
  });

  it("行首数字并列不是列表编号，不能隐藏无依据数字", async () => {
    const answer = "999、5 单分别是两家店的订单量。";
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult(answer),
      finalResult(answer),
    ]);
    const result = await new BusinessAgent(provider, salesRegistry()).run({
      question: "查销售",
      context,
    });
    expect(result.failureCode).toBe("AI_RESPONSE_REJECTED");
  });

  it("最终回答数据校验失败后自动 repair 一次并返回修正结果", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult("销售额为 1,742 元，但订单数为 999 单。"),
      finalResult("销售额为 1,742 元，共 5 单。"),
    ]);
    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler));

    const result = await agent.run({
      question: "查询销售额和订单数",
      context,
    });

    expect(result).toEqual({
      status: "completed",
      answer: "销售额为 1,742 元，共 5 单。",
      usedTools: ["get_sales_summary"],
      rounds: 3,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(provider.generate).toHaveBeenCalledTimes(3);

    const repairRequest = provider.requests[2];
    expect(repairRequest?.tools).toEqual([]);
    expect(repairRequest?.messages.at(-1)).toMatchObject({
      role: "user",
    });
  });

  it("自动 repair 后仍包含来源不明数字时保持拒绝", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult("销售额为 1,742 元，但订单数为 999 单。"),
      finalResult("销售额为 1,742 元，但订单数为 888 单。"),
    ]);
    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler));

    const result = await agent.run({
      question: "查询销售额和订单数",
      context,
    });

    expect(result.status).toBe("limited");
    expect(result.failureCode).toBe("AI_RESPONSE_REJECTED");
    expect(result.answer).not.toContain("999");
    expect(result.answer).not.toContain("888");
    expect(handler).toHaveBeenCalledOnce();
    expect(provider.generate).toHaveBeenCalledTimes(3);
    expect(provider.requests[2]?.tools).toEqual([]);
  });

  it("默认最近周期允许引用工具输出中的实际日期范围", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", {}),
      finalResult("2026-08-25 到 2026-08-31 销售额为 1,742 元，共 5 单。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry());

    const result = await agent.run({
      question: "最近销售情况怎么样？",
      context,
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toContain("2026-08-25 到 2026-08-31");
  });

  it("允许使用已验证 items 数量说明低库存商品数量", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-inventory", "get_inventory_risks", {}),
      finalResult("共有 4 款商品库存不足。"),
    ]);
    const agent = new BusinessAgent(provider, inventoryRegistry());

    const result = await agent.run({
      question: "最近哪些商品库存不足？",
      context: inventoryContext,
    });

    expect(result).toEqual({
      status: "completed",
      answer: "共有 4 款商品库存不足。",
      usedTools: ["get_inventory_risks"],
      rounds: 2,
    });
  });

  it("允许统计 items 数量但仍拒绝编造补货数量", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-inventory", "get_inventory_risks", {}),
      finalResult("共有 4 款商品库存不足，建议每款补货 999 件。"),
      finalResult("共有 4 款商品库存不足，建议每款补货 999 件。"),
    ]);
    const handler = vi.fn(() => inventoryResult);
    const agent = new BusinessAgent(provider, inventoryRegistry(handler));

    const result = await agent.run({
      question: "最近哪些商品值得补货？",
      context: inventoryContext,
    });

    expect(result.status).toBe("limited");
    expect(result.failureCode).toBe("AI_RESPONSE_REJECTED");
    expect(result.answer).not.toContain("999");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("成功工具结果存在时仍拒绝混入来源不明的经营数字", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult("销售额为 1,742 元，但订单数为 999 单。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry());

    const result = await agent.run({ question: "查询销售额和订单", context });

    expect(result.status).toBe("limited");
    expect(result.answer).not.toContain("999");
  });

  it("拒绝用中文数字绕过经营数字来源校验", async () => {
    const provider = scriptedProvider([
      toolCallResult("call-sales", "get_sales_summary", period),
      finalResult("订单数为九百单。"),
    ]);
    const agent = new BusinessAgent(provider, salesRegistry());

    const result = await agent.run({ question: "查询订单数", context });

    expect(result.status).toBe("limited");
  });

  it("单轮工具调用超过上限时一个也不执行", async () => {
    const provider = scriptedProvider([
      multiToolCallResult([
        { id: "call-1", name: "get_sales_summary", arguments: period },
        { id: "call-2", name: "get_sales_summary", arguments: period },
      ]),
    ]);
    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler), { maxCallsPerRound: 1 });

    const result = await agent.run({ question: "查询两个时段", context });

    expect(result.status).toBe("limited");
    expect(handler).not.toHaveBeenCalled();
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("累计工具调用超过上限时停止后续执行", async () => {
    const provider = scriptedProvider([
      multiToolCallResult([
        {
          id: "call-1",
          name: "get_sales_summary",
          arguments: { startDate: "2026-08-25", endDate: "2026-08-25" },
        },
        {
          id: "call-2",
          name: "get_sales_summary",
          arguments: { startDate: "2026-08-26", endDate: "2026-08-26" },
        },
      ]),
      toolCallResult("call-3", "get_sales_summary", {
        startDate: "2026-08-27",
        endDate: "2026-08-27",
      }),
    ]);
    const handler = vi.fn(() => salesResult);
    const agent = new BusinessAgent(provider, salesRegistry(handler), {
      maxCallsPerRound: 2,
      maxTotalCalls: 2,
    });

    const result = await agent.run({ question: "查询三个时段", context });

    expect(result.status).toBe("limited");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it("拒绝越界的循环配置", () => {
    const provider = scriptedProvider([]);
    const registry = salesRegistry();

    expect(() => new BusinessAgent(provider, registry, { maxToolRounds: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
    expect(() => new BusinessAgent(provider, registry, { maxCallsPerRound: 5 })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
    expect(() => new BusinessAgent(provider, registry, { maxTotalCalls: 9 })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
  });

  it("内容过滤响应不会被当作成功回答", async () => {
    const filtered = {
      ...finalResult("这是被过滤的中文内容。"),
      finishReason: "content_filter" as const,
    };
    const agent = new BusinessAgent(scriptedProvider([filtered]), salesRegistry());

    const result = await agent.run({ question: "查询销售额", context });

    expect(result.status).toBe("limited");
  });
});

function inventoryRegistry(
  handler: () => InventoryRisksOutput = vi.fn(() => inventoryResult),
): ToolRegistry {
  const registry = new ToolRegistry({
    allowedToolNames: [GetInventoryRisksTool.name],
  });
  registry.register({
    ...GetInventoryRisksTool,
    requiredPermissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
    handler,
  });
  return registry;
}

function salesRegistry(handler: () => SalesSummaryOutput = vi.fn(() => salesResult)): ToolRegistry {
  const registry = new ToolRegistry({ allowedToolNames: [GetSalesSummaryTool.name] });
  registry.register({
    ...GetSalesSummaryTool,
    requiredPermissions: [AuthPermission.OrdersRead],
    handler,
  });
  return registry;
}

function toolCallResult(
  id: string,
  name: string,
  argumentsValue: Record<string, string>,
): LLMGenerationResult {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [{ id, name, arguments: argumentsValue }],
    },
    finishReason: "tool_calls",
  };
}

function multiToolCallResult(
  toolCalls: NonNullable<LLMGenerationResult["message"]["toolCalls"]>,
): LLMGenerationResult {
  return {
    message: { role: "assistant", content: null, toolCalls },
    finishReason: "tool_calls",
  };
}

function finalResult(content: string): LLMGenerationResult {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
  };
}

function scriptedProvider(results: readonly LLMGenerationResult[]) {
  const queue = [...results];
  const requests: LLMGenerationRequest[] = [];
  const generate = vi.fn(async (request: LLMGenerationRequest) => {
    requests.push(request);
    const result = queue.shift();
    if (!result) {
      throw new Error("Scripted Provider 没有更多响应");
    }
    return result;
  });
  return { name: "scripted", generate, requests } satisfies LLMProvider & {
    requests: LLMGenerationRequest[];
  };
}
