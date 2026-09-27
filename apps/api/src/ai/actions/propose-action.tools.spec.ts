import { describe, expect, it, vi } from "vitest";

import { AuthPermission } from "../../auth/contracts/auth-context.js";
import { AgentActionStore } from "./agent-action-store.js";
import {
  createProposeInventoryThresholdTool,
  createProposeMonitoringRuleTool,
  createProposeSaveChartTool,
  toRule,
} from "./propose-action.tools.js";

const context = {
  userId: "u1",
  merchantId: "m1",
  permissions: [AuthPermission.OrdersRead, AuthPermission.InventoryWrite],
};

describe("propose action tools", () => {
  it("converts money thresholds from yuan to the 分 the monitoring evaluator compares", () => {
    const sales = toRule({
      kind: "salesThreshold",
      name: "客单价过低",
      metric: "averageOrderValue",
      operator: "below",
      threshold: 88.5,
      window: "30d",
      frequency: "weekly",
    });
    expect(sales.definition).toMatchObject({ metric: "averageOrderValue", threshold: 8850 });
    const orders = toRule({
      kind: "salesThreshold",
      name: "订单过少",
      metric: "orderCount",
      operator: "below",
      threshold: 20,
      window: "7d",
      frequency: "daily",
    });
    expect(orders.definition).toMatchObject({ threshold: 20 });
    const inventory = toRule({
      kind: "inventoryThreshold",
      name: "缺货",
      threshold: 5,
      frequency: "daily",
    });
    expect(inventory.definition).toMatchObject({
      kind: "inventoryThreshold",
      scope: "allProducts",
      threshold: 5,
    });
  });

  it("proposes an inventory threshold change from the current SKU snapshot without writing", async () => {
    const store = new AgentActionStore();
    const repository = {
      findSkuSnapshot: vi.fn(async () => ({
        skuId: "sku-1",
        alertThreshold: 10,
        updatedAt: "2026-09-01T00:00:00.000Z",
      })),
    };
    const tool = createProposeInventoryThresholdTool(store, repository);
    const output = await tool.handler(
      { skuId: "sku-1", targetAlertThreshold: 25, reason: "近 7 天销量翻倍" },
      context,
    );
    expect(repository.findSkuSnapshot).toHaveBeenCalledWith("m1", "sku-1");
    expect(output.status).toBe("ok");
    if (output.status !== "ok") return;
    expect(output.data.note).toContain("尚未执行");
    expect(output.data.proposal.details).toEqual([
      { label: "SKU", value: "sku-1" },
      { label: "当前阈值", value: "10" },
      { label: "调整为", value: "25" },
    ]);
    expect(store.take(output.data.proposal.token, context)).toMatchObject({
      kind: "ok",
      action: { payload: { expectedAlertThreshold: 10, targetAlertThreshold: 25 } },
    });
    expect(tool.requiredPermissions).toEqual([AuthPermission.InventoryWrite]);
  });

  it("reports unknown SKUs instead of proposing", async () => {
    const tool = createProposeInventoryThresholdTool(new AgentActionStore(), {
      findSkuSnapshot: vi.fn(async () => null),
    });
    const output = await tool.handler(
      { skuId: "missing", targetAlertThreshold: 5, reason: "x" },
      context,
    );
    expect(output).toMatchObject({ status: "error", error: { code: "NOT_FOUND" } });
  });

  it("describes monitoring rules and charts in plain Chinese", async () => {
    const store = new AgentActionStore();
    const rule = await createProposeMonitoringRuleTool(store).handler(
      {
        kind: "salesThreshold",
        name: "周销售额过低提醒",
        metric: "revenue",
        operator: "below",
        threshold: 5000,
        window: "7d",
        frequency: "daily",
      },
      context,
    );
    expect(rule).toMatchObject({
      status: "ok",
      data: {
        proposal: {
          details: [
            { label: "条件", value: "近 7 天销售额低于 ¥5,000.00" },
            { label: "检查频率", value: "每天" },
          ],
        },
      },
    });
    const chart = await createProposeSaveChartTool(store).handler(
      {
        title: "各门店销售额",
        query: {
          dataset: "sales",
          metric: "revenue",
          aggregation: "sum",
          groupBy: "store",
          dateRange: { start: "2026-08-01", end: "2026-08-31" },
          filters: [],
          order: "desc",
          limit: 8,
          visualization: "bar",
        },
      },
      context,
    );
    expect(chart).toMatchObject({
      status: "ok",
      data: { proposal: { kind: "saveChartToAnalytics", summary: "各门店销售额" } },
    });
  });
});
