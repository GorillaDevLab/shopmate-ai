import { describe, expect, it } from "vitest";

import {
  MonitoringNotificationListResponseSchema,
  MonitoringRuleCreateRequestSchema,
  MonitoringRulePreviewRequestSchema,
  MonitoringRuleViewSchema,
} from "./monitoring-api.schema.js";

const definition = {
  kind: "salesThreshold",
  metric: "revenue",
  operator: "below",
  threshold: 100_000,
  window: "30d",
  frequency: "daily",
} as const;

describe("监听 API 合约", () => {
  it("拒绝预览请求中的客户端身份字段", () => {
    expect(() =>
      MonitoringRulePreviewRequestSchema.parse({
        question: "销售额低于 1000 元时提醒",
        merchantId: "other",
      }),
    ).toThrow();
  });

  it("严格校验创建请求和安全规则视图", () => {
    expect(MonitoringRuleCreateRequestSchema.parse({ name: "销售预警", definition })).toEqual({
      name: "销售预警",
      definition,
    });
    expect(
      MonitoringRuleViewSchema.parse({
        id: "rule-1",
        name: "销售预警",
        definition,
        status: "ACTIVE",
        lastRunAt: null,
        nextRunAt: "2026-09-04T00:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toMatchObject({ id: "rule-1", status: "ACTIVE" });
  });

  it("提醒列表不接受 HTML 或身份字段", () => {
    expect(() =>
      MonitoringNotificationListResponseSchema.parse({
        items: [{ merchantId: "leak", title: "<script>" }],
      }),
    ).toThrow();
  });
});
