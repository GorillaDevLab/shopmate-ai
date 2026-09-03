import { describe, expect, it } from "vitest";

import { MonitoringRuleDefinitionSchema } from "./monitoring-rule.schema.js";

describe("监听规则 DSL", () => {
  it("接受受限销售阈值规则", () => {
    expect(
      MonitoringRuleDefinitionSchema.parse({
        kind: "salesThreshold",
        metric: "revenue",
        operator: "below",
        threshold: 100_000,
        window: "30d",
        frequency: "daily",
      }),
    ).toMatchObject({ kind: "salesThreshold", threshold: 100_000 });
  });

  it("接受带有限商品范围的库存规则", () => {
    expect(
      MonitoringRuleDefinitionSchema.parse({
        kind: "inventoryThreshold",
        metric: "inventory",
        operator: "below",
        threshold: 10,
        scope: "allProducts",
        productIds: ["product-1"],
        frequency: "weekly",
      }),
    ).toMatchObject({ kind: "inventoryThreshold", productIds: ["product-1"] });
  });

  it.each([
    {
      kind: "salesThreshold",
      metric: "revenue",
      operator: "below",
      threshold: 1,
      window: "1d",
      frequency: "hourly",
    },
    {
      kind: "inventoryThreshold",
      metric: "inventory",
      operator: "below",
      threshold: -1,
      scope: "allProducts",
      productIds: [],
      frequency: "daily",
    },
    {
      kind: "salesThreshold",
      metric: "revenue",
      operator: "below",
      threshold: 1,
      window: "7d",
      frequency: "daily",
      merchantId: "attacker",
    },
  ])("拒绝越界、过频或额外字段 %#", (input) => {
    expect(() => MonitoringRuleDefinitionSchema.parse(input)).toThrow();
  });
});
