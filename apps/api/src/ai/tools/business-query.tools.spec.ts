import { describe, expect, it, vi } from "vitest";
import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { createBusinessQueryTool, createStoreCatalogTool } from "./business-query.tools.js";
import { ToolRegistry } from "./tool-registry.js";
import { BusinessAgent } from "../agent/business-agent.js";

const context = {
  userId: "u1",
  merchantId: "merchant-a",
  permissions: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
};
const query = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "store",
  dateRange: { start: "2026-09-01", end: "2026-09-25" },
  filters: [],
  order: "desc",
  limit: 8,
  visualization: "bar",
};

describe("自然语言经营查询工具", () => {
  it("完整 Agent 能通过门店工具回答数量，且只使用查询结果", async () => {
    const registry = new ToolRegistry({ allowedToolNames: ["get_store_catalog"] });
    registry.register(
      createStoreCatalogTool({
        catalog: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(150),
      }),
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "stores", name: "get_store_catalog", arguments: {} }],
        },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "当前登记了 150 家店铺。" },
        finishReason: "stop",
      });
    const result = await new BusinessAgent({ name: "offline", generate }, registry).run({
      question: "我有几个店铺",
      context,
    });
    expect(result).toMatchObject({
      status: "completed",
      answer: "当前登记了 150 家店铺。",
      usedTools: ["get_store_catalog"],
    });
  });

  it("图表追问重新执行查询，金额换算及日期通过证据校验", async () => {
    const registry = new ToolRegistry({ allowedToolNames: ["query_business_data"] });
    const execute = vi.fn().mockResolvedValue({
      kind: "pie",
      title: "门店销售额",
      summary: "本期",
      unit: "currencyMinor",
      slices: [{ key: "s1", label: "朝阳店", value: 12345 }],
    });
    registry.register(createBusinessQueryTool({ execute }));
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "query", name: "query_business_data", arguments: query }],
        },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "2026-09-01 至 2026-09-25，朝阳店销售额为 123.45 元。",
        },
        finishReason: "stop",
      });
    const agent = new BusinessAgent({ name: "offline", generate }, registry);
    const result = await agent.run({
      question: "这个门店销售额多少",
      context,
      insightQuery: createBusinessQueryTool({ execute }).input.parse(query),
    });
    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledWith(context, query);
    expect(generate.mock.calls[0]?.[0].messages[1].content).toContain("上一张图的查询条件");
  });
  it("门店总数不受目录上限影响，身份来自服务端", async () => {
    const reader = {
      catalog: vi.fn().mockResolvedValue([{ id: "s1", name: "北京店", platform: "OFFLINE" }]),
      count: vi.fn().mockResolvedValue(150),
    };
    const registry = new ToolRegistry({ allowedToolNames: ["get_store_catalog"] });
    registry.register(createStoreCatalogTool(reader));
    expect(await registry.invoke("get_store_catalog", {}, context)).toMatchObject({
      status: "ok",
      data: { total: 150, listed: 1 },
    });
    expect(reader.count).toHaveBeenCalledWith(context);
    expect(reader.catalog).toHaveBeenCalledWith(context);
    await expect(
      registry.invoke("get_store_catalog", { merchantId: "merchant-b" }, context),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      registry.invoke("get_store_catalog", {}, { ...context, permissions: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reader.count).toHaveBeenCalledTimes(1);
    expect(registry.listDefinitions({ ...context, permissions: [] })).toEqual([]);
  });

  it("复用已有查询执行器并拒绝模型注入商家字段和 SQL", async () => {
    const execute = vi.fn().mockResolvedValue({
      kind: "pie",
      title: "销售",
      summary: "本期",
      unit: "currencyMinor",
      slices: [],
    });
    const registry = new ToolRegistry({ allowedToolNames: ["query_business_data"] });
    registry.register(createBusinessQueryTool({ execute }));
    await registry.invoke("query_business_data", query, context);
    expect(execute).toHaveBeenCalledWith(context, query);
    for (const input of [{ ...query, merchantId: "merchant-b" }, { sql: "SELECT * FROM orders" }]) {
      await expect(registry.invoke("query_business_data", input, context)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    await expect(
      registry.invoke("query_business_data", query, { ...context, permissions: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
