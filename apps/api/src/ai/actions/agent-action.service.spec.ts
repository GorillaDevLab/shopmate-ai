import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { AGENT_ACTION_TTL_MS, DEFAULT_ANALYTICS_LAYOUT } from "@shopmate/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthPermission, createAuthContext } from "../../auth/contracts/auth-context.js";
import { AgentActionStore, type AgentActionPayload } from "./agent-action-store.js";
import { AgentActionService } from "./agent-action.service.js";

const context = createAuthContext({
  userId: "u1",
  merchantId: "m1",
  permissions: [
    AuthPermission.OrdersRead,
    AuthPermission.ProductsRead,
    AuthPermission.InventoryWrite,
  ],
});
const content = { title: "t", summary: "s", details: [] };
const query = {
  dataset: "sales" as const,
  metric: "revenue" as const,
  aggregation: "sum" as const,
  groupBy: "date" as const,
  dateRange: { start: "2026-08-01", end: "2026-08-31" },
  filters: [],
  order: "asc" as const,
  limit: 12,
  visualization: "line" as const,
};
const inventoryPayload: AgentActionPayload = {
  kind: "updateInventoryThreshold",
  skuId: "sku-1",
  expectedAlertThreshold: 10,
  expectedSkuUpdatedAt: "2026-09-01T00:00:00.000Z",
  targetAlertThreshold: 20,
};

describe("AgentActionService", () => {
  let now: number;
  let store: AgentActionStore;
  const inventory = { confirmAlertThreshold: vi.fn() };
  const monitoring = { create: vi.fn() };
  const layouts = { get: vi.fn(), save: vi.fn() };
  const service = () => new AgentActionService(store, inventory, monitoring, layouts);
  const propose = (payload: AgentActionPayload) => store.propose(context, content, payload).token;

  beforeEach(() => {
    vi.clearAllMocks();
    now = 0;
    store = new AgentActionStore(() => now);
  });

  it("rejects unknown, malformed, reused and expired tokens without executing", async () => {
    await expect(service().confirm(context, "not-a-uuid")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const token = propose(inventoryPayload);
    inventory.confirmAlertThreshold.mockResolvedValue({
      kind: "CONFIRMED",
      skuId: "sku-1",
      previousAlertThreshold: 10,
      newAlertThreshold: 20,
    });
    await service().confirm(context, token);
    await expect(service().confirm(context, token)).rejects.toBeInstanceOf(NotFoundException);
    const stale = propose(inventoryPayload);
    now += AGENT_ACTION_TTL_MS;
    await expect(service().confirm(context, stale)).rejects.toBeInstanceOf(GoneException);
    expect(inventory.confirmAlertThreshold).toHaveBeenCalledOnce();
  });

  it("re-checks permissions at confirmation time", async () => {
    const token = propose(inventoryPayload);
    const readOnly = createAuthContext({
      userId: "u1",
      merchantId: "m1",
      permissions: [AuthPermission.OrdersRead],
    });
    await expect(service().confirm(readOnly, token)).rejects.toBeInstanceOf(ForbiddenException);
    expect(inventory.confirmAlertThreshold).not.toHaveBeenCalled();
  });

  it("updates the inventory threshold only if the SKU is unchanged since the proposal", async () => {
    inventory.confirmAlertThreshold.mockResolvedValueOnce({
      kind: "CONFLICT",
      skuId: "sku-1",
      actualAlertThreshold: 12,
      actualSkuUpdatedAt: "2026-09-02T00:00:00.000Z",
    });
    await expect(service().confirm(context, propose(inventoryPayload))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(inventory.confirmAlertThreshold).toHaveBeenCalledWith({
      merchantId: "m1",
      skuId: "sku-1",
      expectedAlertThreshold: 10,
      expectedSkuUpdatedAt: "2026-09-01T00:00:00.000Z",
      targetAlertThreshold: 20,
    });
  });

  it("creates the proposed monitoring rule for the confirming merchant", async () => {
    const rule = {
      name: "库存预警",
      definition: {
        kind: "inventoryThreshold" as const,
        metric: "inventory" as const,
        operator: "below" as const,
        threshold: 5,
        scope: "allProducts" as const,
        productIds: [],
        frequency: "daily" as const,
      },
    };
    const result = await service().confirm(
      context,
      propose({ kind: "createMonitoringRule", rule }),
    );
    expect(monitoring.create).toHaveBeenCalledWith(context, rule);
    expect(result.message).toContain("库存预警");
  });

  it("appends the chart to 经营分析 against the revision it read", async () => {
    layouts.get.mockResolvedValue({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 4,
      updatedAt: null,
    });
    const result = await service().confirm(
      context,
      propose({ kind: "saveChartToAnalytics", title: "每日销售额", query }),
    );
    const [, body] = layouts.save.mock.calls[0];
    expect(body.expectedRevision).toBe(4);
    expect(body.layout.cards.at(-1)).toMatchObject({
      kind: "aiChart",
      title: "每日销售额",
      span: 2,
      query,
    });
    expect(body.layout.cards.at(-1).id).toMatch(/^ai-[a-f0-9]{24}$/);
    expect(result).toMatchObject({ status: "done", href: "/" });
  });

  it("refuses to exceed the saved AI chart limit", async () => {
    const aiCards = Array.from({ length: 12 }, (_, i) => ({
      id: `ai-${String(i).padStart(24, "0")}`,
      kind: "aiChart" as const,
      span: 1 as const,
      title: "图表",
      query,
    }));
    layouts.get.mockResolvedValue({
      layout: { version: 1, cards: aiCards },
      revision: 1,
      updatedAt: null,
    });
    await expect(
      service().confirm(context, propose({ kind: "saveChartToAnalytics", title: "x", query })),
    ).rejects.toBeInstanceOf(HttpException);
    expect(layouts.save).not.toHaveBeenCalled();
  });

  it("cancels by discarding the token", async () => {
    const token = propose(inventoryPayload);
    expect(service().cancel(context, token)).toEqual({ status: "cancelled" });
    await expect(service().confirm(context, token)).rejects.toBeInstanceOf(NotFoundException);
  });
});
