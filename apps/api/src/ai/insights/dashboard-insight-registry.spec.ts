import { describe, expect, it } from "vitest";

import { DASHBOARD_INSIGHT_FIELDS, getInsightMetric } from "./dashboard-insight-registry.js";

describe("AI 查询字段注册表", () => {
  it("注册经营指标并启用销售门店和渠道维度", () => {
    expect(getInsightMetric("revenue")).toMatchObject({
      dataset: "sales",
      aggregation: "sum",
      unit: "currencyMinor",
    });
    expect(DASHBOARD_INSIGHT_FIELDS.dimensions.platform.enabled).toBe(true);
    expect(DASHBOARD_INSIGHT_FIELDS.dimensions.store.enabled).toBe(true);
    expect(DASHBOARD_INSIGHT_FIELDS.dimensions.store.datasets).toEqual(["sales"]);
  });

  it("未知指标不能解析为执行来源", () => {
    expect(() => getInsightMetric("unknown")).toThrow("未知经营指标");
  });
});
