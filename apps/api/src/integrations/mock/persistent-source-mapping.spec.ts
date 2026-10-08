import { describe, expect, it } from "vitest";
import { mapPersistentSourceVersion } from "./persistent-source-mapping.js";

const scope = {
  organizationId: "org-a",
  workspaceId: "ws-a",
  storeId: "store-a",
  connectionId: "conn-a",
  externalStoreId: "mock-a",
  sessionId: "session-a",
  generation: 2,
};
const occurredAt = "2026-01-01T00:00:00.000Z";
const source = {
  version: "mock-runtime-v2:g:2:e:3",
  updatedAt: occurredAt,
  quality: { state: "COMPLETE", issues: [] },
};
const common = { externalStoreId: "mock-a", source };
const fixtures = [
  {
    kind: "STORE",
    key: ["STORE", "mock-a"],
    payload: {
      ...common,
      name: "Synthetic store",
      category: "Accessories",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
  },
  {
    kind: "PRODUCT",
    key: ["PRODUCT", "product-a"],
    payload: {
      ...common,
      externalProductId: "product-a",
      title: "Synthetic product",
      description: null,
      category: "Accessories",
      brand: null,
      status: "ACTIVE",
      skus: [
        {
          externalSkuId: "sku-a",
          externalProductId: "product-a",
          attributes: [],
          salePriceMinor: 100,
          costPriceMinor: 40,
          originalPriceMinor: null,
          status: "ACTIVE",
        },
      ],
    },
  },
  {
    kind: "ORDER",
    key: ["ORDER", "order-a"],
    payload: {
      ...common,
      externalOrderId: "order-a",
      status: "PAID",
      orderedAt: occurredAt,
      paidAt: occurredAt,
      currency: "CNY",
      items: [
        {
          externalLineId: "line-a",
          externalProductId: "product-a",
          externalSkuId: "sku-a",
          quantity: 1,
          unitPriceMinor: 100,
          grossMinor: 100,
          discountMinor: 0,
          netMinor: 100,
        },
      ],
      grossMinor: 100,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: 100,
      paidMinor: 100,
      refundedMinor: 0,
    },
  },
  {
    kind: "REFUND",
    key: ["REFUND", "refund-a"],
    payload: {
      ...common,
      externalRefundId: "refund-a",
      externalOrderId: "order-a",
      externalSkuId: "sku-a",
      status: "SUCCEEDED",
      requestedMinor: 100,
      succeededMinor: 100,
      requestedAt: occurredAt,
      succeededAt: occurredAt,
      currency: "CNY",
    },
  },
  {
    kind: "INVENTORY",
    key: ["INVENTORY", "sku-a", "location-a"],
    payload: {
      ...common,
      externalSkuId: "sku-a",
      externalLocationId: "location-a",
      available: 7,
      reserved: 3,
      onHand: 10,
      safetyStock: 2,
      leadTimeDays: 4,
    },
  },
  {
    kind: "MARKETING",
    key: ["MARKETING", "campaign-a", "2026-01-01"],
    payload: {
      ...common,
      externalCampaignId: "campaign-a",
      date: "2026-01-01",
      impressions: 20,
      clicks: 10,
      attributedOrders: 1,
      spendMinor: 40,
      attributedRevenueMinor: 100,
      currency: "CNY",
    },
  },
] as const;
function version(fixture = fixtures[0]) {
  return {
    kind: fixture.kind,
    entityKey: JSON.stringify(fixture.key),
    eventSeq: "3",
    releaseRevision: "1",
    occurredAt,
    payload: fixture.payload,
    versionHash: "a".repeat(64),
  };
}

describe("persistent source DTO mapping", () => {
  it.each(fixtures)("maps $kind without inventing or losing source fields", (fixture) => {
    const input = {
      ...version(),
      kind: fixture.kind,
      entityKey: JSON.stringify(fixture.key),
      payload: fixture.payload,
    };
    const result = mapPersistentSourceVersion(scope, input);
    expect(result).toEqual({ ok: true, data: { kind: fixture.kind, record: fixture.payload } });
    if (result.ok) {
      expect(Object.isFrozen(result.data.record)).toBe(true);
      expect(result.data.record).not.toBe(input.payload);
    }
  });

  it.each([
    { entityKey: '["STORE", "other-store"]' },
    { entityKey: "not-json" },
    { eventSeq: "03" },
    { eventSeq: "not-an-integer" },
    { eventSeq: "0" },
    { eventSeq: "9223372036854775808" },
    { releaseRevision: "0" },
    { versionHash: "not-a-hash" },
    { kind: "UNKNOWN" },
    { occurredAt: "2026-01-01T00:00:00+00:00" },
    { occurredAt: "not-a-date" },
    { extra: "unexpected" },
    { payload: { ...fixtures[0].payload, externalStoreId: "mock-b" } },
    {
      payload: {
        ...fixtures[0].payload,
        source: { ...source, version: "mock-runtime-v2:g:1:e:3" },
      },
    },
    {
      payload: {
        ...fixtures[0].payload,
        source: { ...source, version: "mock-runtime-v2:g:2:e:4" },
      },
    },
    {
      payload: {
        ...fixtures[0].payload,
        source: { ...source, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    },
    { payload: { ...fixtures[0].payload, privateToken: "never-forward" } },
  ])("rejects malformed or mismatched version %#", (change) => {
    expect(mapPersistentSourceVersion(scope, { ...version(), ...change })).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });

  it("rejects invalid trusted scope separately from invalid source responses", () => {
    expect(mapPersistentSourceVersion({ ...scope, generation: -1 }, version())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("preserves explicitly unknown inventory without synthesizing zero balances", () => {
    const fixture = fixtures[4];
    const payload = {
      ...fixture.payload,
      available: null,
      reserved: null,
      onHand: null,
      source: { ...source, quality: { state: "PARTIAL", issues: ["INVENTORY_UNKNOWN"] } },
    };
    const result = mapPersistentSourceVersion(scope, {
      ...version(),
      kind: fixture.kind,
      entityKey: '["INVENTORY", "sku-a", "location-a"]',
      payload,
    });
    expect(result).toEqual({ ok: true, data: { kind: "INVENTORY", record: payload } });
  });

  it("rejects inconsistent financial DTOs through the contracts validators", () => {
    const fixture = fixtures[2];
    expect(
      mapPersistentSourceVersion(scope, {
        ...version(),
        kind: fixture.kind,
        entityKey: JSON.stringify(fixture.key),
        payload: { ...fixture.payload, payableMinor: 101 },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  it("keeps PostgreSQL bigint sequence values exact beyond JavaScript safe integers", () => {
    const eventSeq = "9223372036854775807";
    const payload = {
      ...fixtures[0].payload,
      source: { ...source, version: `mock-runtime-v2:g:2:e:${eventSeq}` },
    };
    expect(mapPersistentSourceVersion(scope, { ...version(), eventSeq, payload })).toEqual({
      ok: true,
      data: { kind: "STORE", record: payload },
    });
  });
});
