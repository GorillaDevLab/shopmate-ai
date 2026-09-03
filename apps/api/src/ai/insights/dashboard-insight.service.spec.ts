import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { DashboardInsightService } from "./dashboard-insight.service.js";

const context = {
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [],
} as const;

const query = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "product",
  dateRange: { start: "2026-08-01", end: "2026-08-31" },
  filters: [],
  order: "desc",
  limit: 8,
  visualization: "pie",
} as const;

describe("AI 看板组件生成服务", () => {
  it("严格校验模型 DSL 后在服务端身份范围执行", async () => {
    const provider = scriptedProvider(query);
    const executor = {
      execute: vi.fn().mockResolvedValue({
        kind: "pie",
        title: "商品销售额占比",
        summary: "近 30 天",
        unit: "currencyMinor",
        slices: [],
      }),
    };
    const service = new DashboardInsightService(provider, executor);

    await expect(
      service.preview(context, { question: "按商品生成销售额饼图", kind: "pie" }),
    ).resolves.toMatchObject({ query, result: { kind: "pie" } });
    expect(executor.execute).toHaveBeenCalledWith(context, query);
  });

  it("客户端身份字段被拒绝", async () => {
    const service = new DashboardInsightService(scriptedProvider(query), { execute: vi.fn() });
    await expect(
      service.preview(context, { question: "查询", kind: "pie", merchantId: "other" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("模型返回越权或错误类型 DSL 时不进入执行器", async () => {
    const executor = { execute: vi.fn() };
    const service = new DashboardInsightService(
      scriptedProvider({ ...query, merchantId: "other" }),
      executor,
    );
    await expect(
      service.preview(context, { question: "查询", kind: "pie" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

function scriptedProvider(argumentsValue: object) {
  return {
    name: "test",
    generate: vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call-1", name: "propose_dashboard_insight", arguments: argumentsValue }],
      },
      finishReason: "tool_calls",
    }),
  };
}
