import { describe, expect, it, vi } from "vitest";

import { AuthPermission, createAuthContext } from "../auth/contracts/index.js";
import { MonitoringEvaluator } from "./monitoring-evaluator.js";

const context = createAuthContext({
  userId: "user-1",
  merchantId: "merchant-1",
  permissions: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
});
const now = new Date("2026-09-03T08:00:00.000Z");

describe("监听规则求值", () => {
  it("命中销售阈值并把 Merchant Scope 传给领域服务", async () => {
    const dashboard = dashboardReader({
      revenueCents: 80_000,
      orderCount: 5,
      unitsSold: 9,
      averageOrderValueCents: 16_000,
    });
    const evaluator = new MonitoringEvaluator(dashboard, inventoryReader([]));

    await expect(
      evaluator.evaluate(
        context,
        {
          kind: "salesThreshold",
          metric: "revenue",
          operator: "below",
          threshold: 100_000,
          window: "30d",
          frequency: "daily",
        },
        now,
      ),
    ).resolves.toMatchObject({
      matched: true,
      matches: [{ resourceType: "MERCHANT", resourceId: "merchant-1" }],
    });
    expect(dashboard.summarize).toHaveBeenCalledWith(context, "2026-09-03", "2026-08-05");
  });

  it("库存规则按商品过滤并把结果限制为 20 条", async () => {
    const risks = Array.from({ length: 25 }, (_, index) => ({
      productId: index === 24 ? "other" : "product-1",
      productName: "测试商品",
      skuId: `sku-${index}`,
      code: `SKU-${index}`,
      inventory: index,
      alertThreshold: 30,
      recentSold: 1,
      forecast: { status: "estimated" as const, days: 1 },
    }));
    const evaluator = new MonitoringEvaluator(dashboardReader(), inventoryReader(risks));

    const result = await evaluator.evaluate(
      context,
      {
        kind: "inventoryThreshold",
        metric: "inventory",
        operator: "below",
        threshold: 30,
        scope: "allProducts",
        productIds: ["product-1"],
        frequency: "daily",
      },
      now,
    );

    expect(result.matches).toHaveLength(20);
    expect(result.matches.every((match) => match.resourceId !== "sku-24")).toBe(true);
  });

  it("未命中时返回稳定空结果", async () => {
    const evaluator = new MonitoringEvaluator(dashboardReader(), inventoryReader([]));
    await expect(
      evaluator.evaluate(
        context,
        {
          kind: "inventoryThreshold",
          metric: "inventory",
          operator: "below",
          threshold: 10,
          scope: "allProducts",
          productIds: [],
          frequency: "daily",
        },
        now,
      ),
    ).resolves.toMatchObject({ matched: false, matches: [] });
  });
});

function dashboardReader(
  metrics = { revenueCents: 0, orderCount: 0, unitsSold: 0, averageOrderValueCents: 0 },
) {
  return { summarize: vi.fn().mockResolvedValue({ recent: { metrics } }) };
}

function inventoryReader(risks: readonly object[]) {
  return { analyze: vi.fn().mockResolvedValue({ risks }) };
}
