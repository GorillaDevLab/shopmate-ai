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
  it("auto 只调用一次模型并按日期形状确定为折线图", async () => {
    const dateQuery = { ...query, groupBy: "date", visualization: "line" } as const;
    const provider = scriptedProvider(dateQuery);
    const executor = {
      execute: vi.fn().mockResolvedValue({
        kind: "series",
        title: "每日销售额",
        summary: "近 30 天",
        unit: "currencyMinor",
        points: [],
      }),
    };
    await expect(
      new DashboardInsightService(provider, executor).preview(context, {
        question: "最近每天销售额趋势",
        kind: "auto",
      }),
    ).resolves.toMatchObject({ query: dateQuery, result: { kind: "series" } });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("auto 类目构成意图确定为饼图，普通类目确定为柱状图", async () => {
    for (const [question, visualization] of [
      ["各商品销售额占比构成", "pie"],
      ["各商品销售额对比", "bar"],
    ] as const) {
      const planned = { ...query, visualization };
      const provider = scriptedProvider(planned);
      const executor = {
        execute: vi.fn().mockResolvedValue({
          kind: "pie",
          title: "商品销售额",
          summary: "近 30 天",
          unit: "currencyMinor",
          slices: [],
        }),
      };
      await new DashboardInsightService(provider, executor).preview(context, {
        question,
        kind: "auto",
      });
      expect(executor.execute).toHaveBeenCalledWith(context, planned);
    }
  });

  it("显式不兼容图表给出清晰中文 400", async () => {
    const provider = scriptedProvider({ ...query, visualization: "line" });
    const service = new DashboardInsightService(provider, { execute: vi.fn() });
    await expect(
      service.preview(context, { question: "商品销售额", kind: "line" }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: "INSIGHT_VIEW_INCOMPATIBLE",
        message: expect.stringContaining("请选择兼容视图"),
        allowedViews: ["pie", "bar"],
      },
    });
  });
  it("模型工具声明门店、渠道分组和筛选结构，并传入当前商家目录", async () => {
    const storeQuery = { ...query, groupBy: "store" };
    const provider = scriptedProvider(storeQuery);
    const catalog = [{ id: "s1", name: "朝阳店", platform: "OFFLINE" }];
    const executor = {
      catalog: vi.fn().mockResolvedValue(catalog),
      execute: vi.fn().mockResolvedValue({
        kind: "pie",
        title: "门店销售额",
        summary: "近30天",
        unit: "currencyMinor",
        slices: [],
      }),
    };
    await new DashboardInsightService(provider, executor).preview(context, {
      question: "各门店销售额",
      kind: "pie",
    });
    expect(executor.catalog).toHaveBeenCalledWith(context);
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining(JSON.stringify(catalog)),
          }),
        ]),
        tools: [
          expect.objectContaining({
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                groupBy: expect.objectContaining({
                  enum: expect.arrayContaining(["store", "platform"]),
                }),
                filters: expect.objectContaining({
                  items: expect.objectContaining({ required: ["field", "operator", "values"] }),
                }),
              }),
            }),
          }),
        ],
      }),
    );
    expect(executor.execute).toHaveBeenCalledWith(context, storeQuery);
  });
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
