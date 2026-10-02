import {
  ConnectorInventorySchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorCampaignMetricSchema,
} from "@shopmate/contracts";
import { describe, expect, it } from "vitest";
import { generateMockSource } from "./mock-source.js";

const config = {
  binding: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "mock-a",
  },
  seed: 42,
  profile: "growing",
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 21,
  productCount: 10,
  variantsPerProduct: 2,
  dailyOrders: 20,
};
const end = "2026-01-21T16:00:00Z";

describe("causal mock source", () => {
  it("includes events exactly at opening without changing the historical prefix later", () => {
    const boundary = {
      ...config,
      seed: 980,
      profile: "mature",
      days: 2,
      productCount: 1,
      variantsPerProduct: 1,
      dailyOrders: 300,
    };
    const at = "2025-12-31T16:00:00Z";
    const early = generateMockSource(boundary, at);
    const later = generateMockSource(boundary, "2025-12-31T16:00:01Z");
    expect(later.ledger.filter((entry) => Date.parse(entry.at) <= Date.parse(at))).toEqual(
      early.ledger,
    );
    expect(early.orders.some((order) => order.externalOrderId === "mock-a:order:0:234")).toBe(true);
  });
  it("settles known orders after the history horizon without creating new demand", () => {
    const atEnd = generateMockSource(config, end);
    const later = generateMockSource(config, "2026-01-28T16:00:00Z");
    expect(later.orders.map((order) => order.externalOrderId)).toEqual(
      atEnd.orders.map((order) => order.externalOrderId),
    );
    expect(
      later.orders.some((order) => ["PAID", "FULFILLED", "PENDING_PAYMENT"].includes(order.status)),
    ).toBe(false);
    expect(later.inventory.every((item) => item.reserved === 0)).toBe(true);
  });

  it("supports observation at exactly opening for every profile", () => {
    for (const profile of ["growing", "problematic", "mature", "new"]) {
      const source = generateMockSource({ ...config, profile, days: 1 }, config.historyStart);
      expect(source.catalog).toHaveLength(10);
      expect(source.inventory).toHaveLength(20);
      expect(source.orders).toHaveLength(0);
      expect(source.marketing).toHaveLength(0);
    }
  });

  it("keeps ledger prefixes stable when the clock advances", () => {
    const at = "2026-01-01T10:00:00Z";
    const early = generateMockSource(config, at);
    const late = generateMockSource(config, end);
    expect(late.ledger.filter((entry) => Date.parse(entry.at) <= Date.parse(at))).toEqual(
      early.ledger,
    );
  });

  it("rejects external store IDs too long for derived source IDs", () => {
    expect(() =>
      generateMockSource(
        { ...config, binding: { ...config.binding, externalStoreId: "a".repeat(256) } },
        end,
      ),
    ).toThrow();
  });
  it("reproduces a hash and immutable facts for the same seed/time", () => {
    const first = generateMockSource(config, end);
    expect(generateMockSource(config, end)).toEqual(first);
    expect(generateMockSource({ ...config, seed: 43 }, end).datasetHash).not.toBe(
      first.datasetHash,
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.orders[0])).toBe(true);
    expect(Object.isFrozen(first.orders[0]!.items)).toBe(true);
    expect(first.orders.length).toBeGreaterThan(50);
  });

  it("validates normalized DTOs and correlates money/refunds to paid orders", () => {
    const source = generateMockSource({ ...config, refundBps: 5000 }, end);
    for (const order of source.orders)
      expect(ConnectorOrderSchema.safeParse(order).success).toBe(true);
    for (const refund of source.refunds) {
      expect(ConnectorRefundSchema.safeParse(refund).success).toBe(true);
      const order = source.orders.find((item) => item.externalOrderId === refund.externalOrderId)!;
      expect(refund.succeededMinor).toBeLessThanOrEqual(order.paidMinor!);
      expect(order.refundedMinor).toBe(refund.succeededMinor);
    }
    expect(source.refunds.length).toBeGreaterThan(0);
    expect(source.economics).toHaveLength(source.orders.length);
  });

  it("reconstructs inventory from a unique, chronological event ledger", () => {
    const source = generateMockSource({ ...config, refundBps: 5000 }, end);
    const balances = new Map<string, { onHand: number; reserved: number }>();
    expect(new Set(source.ledger.map((entry) => entry.eventId)).size).toBe(source.ledger.length);
    for (const entry of source.ledger) {
      const state = balances.get(entry.externalSkuId) ?? { onHand: 0, reserved: 0 };
      state.onHand += entry.onHandDelta;
      state.reserved += entry.reservedDelta;
      expect(state.onHand).toBeGreaterThanOrEqual(state.reserved);
      expect(state.reserved).toBeGreaterThanOrEqual(0);
      balances.set(entry.externalSkuId, state);
    }
    for (const inventory of source.inventory) {
      expect(ConnectorInventorySchema.safeParse(inventory).success).toBe(true);
      const state = balances.get(inventory.externalSkuId)!;
      expect(inventory.onHand).toBe(state.onHand);
      expect(inventory.reserved).toBe(state.reserved);
      expect(inventory.available).toBe(state.onHand - state.reserved);
    }
    expect(source.ledger.some((event) => event.kind === "RETURN")).toBe(true);
    expect(source.ledger.some((event) => event.kind === "RELEASE")).toBe(true);
  });

  it("never leaks future payments/refunds/stock or mutates an earlier snapshot", () => {
    const at = "2026-01-01T10:00:00Z";
    const early = generateMockSource({ ...config, growthBps: 0, refundBps: 5000 }, at);
    const json = JSON.stringify(early);
    expect(early.refunds).toHaveLength(0);
    for (const order of early.orders) {
      expect(Date.parse(order.orderedAt)).toBeLessThanOrEqual(Date.parse(at));
      if (order.paidAt) expect(Date.parse(order.paidAt)).toBeLessThanOrEqual(Date.parse(at));
      expect(Date.parse(order.source.updatedAt!)).toBeLessThanOrEqual(Date.parse(at));
    }
    for (const entry of early.ledger)
      expect(Date.parse(entry.at)).toBeLessThanOrEqual(Date.parse(at));
    for (const metric of early.marketing)
      expect(Date.parse(metric.source.updatedAt!)).toBeLessThanOrEqual(Date.parse(at));
    generateMockSource(config, end);
    expect(JSON.stringify(early)).toBe(json);
  });

  it("returns no operations before opening and never invents new-store history", () => {
    const before = generateMockSource(config, "2025-12-31T12:00:00Z");
    expect(before.orders).toHaveLength(0);
    expect(before.catalog).toHaveLength(0);
    expect(before.inventory).toHaveLength(0);
    const newer = generateMockSource(
      { ...config, profile: "new", days: 180, dailyOrders: 6 },
      "2026-06-29T16:00:00Z",
    );
    expect(
      newer.orders.every(
        (order) => Date.parse(order.orderedAt) >= Date.parse("2026-06-15T16:00:00Z"),
      ),
    ).toBe(true);
    expect(newer.orders.length).toBeLessThan(140);
    expect(newer.economics.some((fact) => fact.costMinor === null)).toBe(true);
  });

  it("keeps marketing attribution equal to observed paid facts", () => {
    const source = generateMockSource(config, end);
    for (const metric of source.marketing) {
      expect(ConnectorCampaignMetricSchema.safeParse(metric).success).toBe(true);
      const facts = source.economics.filter(
        (fact) =>
          fact.campaignId === metric.externalCampaignId &&
          source.orders.some(
            (order) => order.externalOrderId === fact.externalOrderId && order.paidMinor! > 0,
          ),
      );
      expect(metric.attributedOrders).toBe(facts.length);
      const total = facts.reduce(
        (sum, fact) =>
          sum +
          source.orders.find((order) => order.externalOrderId === fact.externalOrderId)!.paidMinor!,
        0,
      );
      expect(metric.attributedRevenueMinor).toBe(total);
      expect(metric.impressions!).toBeGreaterThanOrEqual(metric.clicks!);
      expect(metric.clicks!).toBeGreaterThanOrEqual(metric.attributedOrders!);
    }
  });

  it("rejects invalid observation time and unsafe generation budget", () => {
    expect(() => generateMockSource(config, "bad")).toThrow();
    expect(() => generateMockSource({ ...config, unknown: "secret" }, end)).toThrow();
    expect(() => generateMockSource({ ...config, days: 365, dailyOrders: 300 }, end)).not.toThrow();
  });

  it("scopes all source facts and hashes to the supplied binding", () => {
    const first = generateMockSource(config, end);
    const other = generateMockSource(
      { ...config, binding: { ...config.binding, externalStoreId: "mock-b", storeId: "store-b" } },
      end,
    );
    expect(other.datasetHash).not.toBe(first.datasetHash);
    expect(other.orders.every((order) => order.externalStoreId === "mock-b")).toBe(true);
    expect(
      other.orders.some((order) =>
        first.orders.some((item) => item.externalOrderId === order.externalOrderId),
      ),
    ).toBe(false);
  });
});
