import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonitoringRule, deleteMonitoringRule, previewMonitoringRule } from "./monitoring-api";

describe("monitoring API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("预览自然语言规则时携带登录 Cookie 且不提交商家 ID", async () => {
    const response = previewResponse();
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(previewMonitoringRule("库存低于 5 件时提醒我")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/monitoring/rules/preview",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ question: "库存低于 5 件时提醒我" }),
      }),
    );
  });

  it("保存经过共享 Schema 校验的规则", async () => {
    const rule = ruleResponse();
    const fetchMock = vi.fn(async () => jsonResponse(rule, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createMonitoringRule({ name: rule.rule.name, definition: rule.rule.definition })).resolves.toEqual(rule);
  });

  it("删除规则接受 204 空响应", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteMonitoringRule("rule-1")).resolves.toBeUndefined();
  });

  it("错误响应只显示安全中文文案", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "database secret" }, 500)));

    await expect(previewMonitoringRule("检查销售额")).rejects.toMatchObject({
      status: 500,
      message: "监听服务暂时不可用，请稍后重试",
    });
  });
});

function previewResponse() {
  return {
    suggestedName: "低库存提醒",
    definition: {
      kind: "inventoryThreshold" as const,
      metric: "inventory" as const,
      operator: "below" as const,
      threshold: 5,
      scope: "allProducts" as const,
      productIds: [],
      frequency: "daily" as const,
    },
    evaluation: {
      matched: false,
      periodStart: "2026-09-03T00:00:00.000Z",
      periodEnd: "2026-09-03T23:59:59.999Z",
      matches: [],
    },
  };
}

function ruleResponse() {
  return {
    rule: {
      id: "rule-1",
      name: "低库存提醒",
      definition: previewResponse().definition,
      status: "ACTIVE" as const,
      lastRunAt: null,
      nextRunAt: "2026-09-04T00:00:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
