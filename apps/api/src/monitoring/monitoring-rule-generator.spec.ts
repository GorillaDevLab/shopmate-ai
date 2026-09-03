import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { MonitoringRuleGenerator } from "./monitoring-rule-generator.js";

const context = createAuthContext({ userId: "user-1", merchantId: "merchant-1", permissions: [] });
const definition = {
  kind: "inventoryThreshold",
  metric: "inventory",
  operator: "below",
  threshold: 10,
  scope: "allProducts",
  productIds: [],
  frequency: "daily",
} as const;

describe("MonitoringRuleGenerator", () => {
  it("严格校验工具参数后用认证上下文预览", async () => {
    const provider = providerStub(definition);
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({
        matched: false,
        periodStart: "2026-09-03T00:00:00.000Z",
        periodEnd: "2026-09-03T23:59:59.999Z",
        matches: [],
      }),
    };
    const generator = new MonitoringRuleGenerator(provider, evaluator);

    await expect(
      generator.generate(context, { question: "库存低于 10 件提醒" }),
    ).resolves.toMatchObject({
      definition,
      suggestedName: "库存低于 10 件",
    });
    expect(evaluator.evaluate).toHaveBeenCalledWith(context, definition, expect.any(Date));
  });

  it("客户端身份字段在调用模型前被拒绝", async () => {
    const provider = providerStub(definition);
    const generator = new MonitoringRuleGenerator(provider, { evaluate: vi.fn() });
    await expect(
      generator.generate(context, { question: "库存提醒", merchantId: "other" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("模型返回越界规则时不进入求值器", async () => {
    const evaluator = { evaluate: vi.fn() };
    const generator = new MonitoringRuleGenerator(
      providerStub({ ...definition, frequency: "hourly" }),
      evaluator,
    );
    await expect(generator.generate(context, { question: "每小时提醒" })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });
});

function providerStub(argumentsValue: object) {
  return {
    name: "test",
    generate: vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call-1", name: "propose_monitoring_rule", arguments: argumentsValue }],
      },
      finishReason: "tool_calls",
    }),
  };
}
