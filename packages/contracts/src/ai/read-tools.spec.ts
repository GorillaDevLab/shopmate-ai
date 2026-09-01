import { describe, expect, it } from "vitest";

import {
  AI_READ_TOOL_CONTRACTS,
  AI_READ_TOOL_NAMES,
  GetInventoryRisksTool,
  GetProductDetailsTool,
  GetSalesSummaryTool,
} from "./read-tools.schema.js";

describe("AI 只读工具契约", () => {
  it("冻结工具名称并提供 Registry 兼容的输入输出 Schema", () => {
    expect(AI_READ_TOOL_CONTRACTS.map((tool) => tool.name)).toEqual(AI_READ_TOOL_NAMES);

    for (const tool of AI_READ_TOOL_CONTRACTS) {
      expect(tool.input.jsonSchema).toMatchObject({ type: "object" });
      expect(tool.output.jsonSchema).toHaveProperty("oneOf");
      expect(typeof tool.input.parse).toBe("function");
      expect(typeof tool.output.parse).toBe("function");
    }
  });

  it("严格拒绝自由 SQL、身份字段和未知输入", () => {
    for (const input of [
      { startDate: "2026-08-25", endDate: "2026-08-31", sql: "SELECT * FROM orders" },
      { startDate: "2026-08-25", endDate: "2026-08-31", merchantId: "other" },
      { startDate: "2026-08-25", endDate: "2026-08-31", userId: "other" },
    ]) {
      expect(GetSalesSummaryTool.input.parse.bind(null, input)).toThrow();
    }
  });

  it("校验有效日期范围和分页上限", () => {
    expect(() =>
      GetInventoryRisksTool.input.parse({
        startDate: "2026-09-01",
        endDate: "2026-08-31",
      }),
    ).toThrow();

    expect(() =>
      GetInventoryRisksTool.input.parse({
        startDate: "2026-02-30",
        endDate: "2026-08-31",
      }),
    ).toThrow();

    expect(() =>
      GetInventoryRisksTool.input.parse({
        startDate: "2026-08-25",
        endDate: "2026-08-31",
        limit: 101,
      }),
    ).toThrow();
  });

  it("金额使用人民币分，库存和销量使用非负整数", () => {
    const result = GetSalesSummaryTool.output.parse({
      status: "ok",
      data: {
        source: "DashboardService",
        period: {
          startDate: "2026-08-25",
          endDate: "2026-08-31",
          timezone: "Asia/Shanghai",
        },
        revenueMinor: 174200,
        currency: "CNY",
        orderCount: 5,
        unitsSold: 27,
        averageOrderValueMinor: 34840,
      },
    });

    expect(result).toMatchObject({ status: "ok", data: { revenueMinor: 174200 } });
    expect(() =>
      GetSalesSummaryTool.output.parse({
        status: "ok",
        data: {
          source: "DashboardService",
          period: {
            startDate: "2026-08-25",
            endDate: "2026-08-31",
            timezone: "Asia/Shanghai",
          },
          revenueMinor: 1742.5,
          currency: "CNY",
          orderCount: 5,
          unitsSold: 27,
          averageOrderValueMinor: 34840,
        },
      }),
    ).toThrow();
  });

  it.each([
    { status: "empty", reason: "NO_DATA", message: "指定范围内没有销售数据。" },
    {
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "不能读取其他 Merchant 的商品。",
        retryable: false,
      },
    },
  ])("统一接受无数据和安全错误结果 %#", (result) => {
    expect(GetProductDetailsTool.output.parse(result)).toEqual(result);
  });

  it("拒绝结构化输出中的未知或越权字段", () => {
    expect(() =>
      GetProductDetailsTool.output.parse({
        status: "empty",
        reason: "NO_DATA",
        message: "未找到商品。",
        merchantId: "secret",
      }),
    ).toThrow();
  });
});
