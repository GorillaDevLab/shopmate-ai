import { describe, expect, it, vi } from "vitest";
import { SimulationClock } from "./business-clock.js";
import { PersistentCommerceConnector } from "./persistent-commerce-connector.js";
import type { PersistentReadPort } from "./persistent-read-port.js";
import { generateMockSource } from "./mock-source.js";

const scope = {
  organizationId: "org-a",
  workspaceId: "ws-a",
  storeId: "store-a",
  connectionId: "conn-a",
  externalStoreId: "mock-a",
  sessionId: "session-a",
  generation: 2,
};
const at = "2026-01-01T00:00:00.000Z";
const source = {
  version: "mock-runtime-v2:g:2:e:3",
  updatedAt: at,
  quality: { state: "COMPLETE", issues: [] },
};
const product = {
  externalStoreId: "mock-a",
  externalProductId: "product-a",
  title: "Product",
  description: null,
  category: "Accessories",
  brand: null,
  status: "DELETED",
  source,
  skus: [
    {
      externalSkuId: "sku-a",
      externalProductId: "product-a",
      attributes: [],
      salePriceMinor: 100,
      costPriceMinor: 40,
      originalPriceMinor: null,
      status: "INACTIVE",
    },
  ],
};
const version = {
  kind: "PRODUCT",
  entityKey: '["PRODUCT", "product-a"]',
  eventSeq: "3",
  releaseRevision: "1",
  occurredAt: at,
  versionHash: "a".repeat(64),
  payload: product,
};
const publication = {
  scope,
  revision: "1",
  targetClockRevision: 0,
  targetTime: at,
  baseRevision: "0",
  baseHighEventSeq: "0",
  highEventSeq: "3",
  eventCount: "3",
  versionCount: "3",
  processedThrough: at,
  generatorVersion: "mock-source-v1",
  runtimeVersion: "mock-runtime-v2",
  codec: "source-snapshot-v1",
  publishedAt: at,
  certificateHash: "b".repeat(64),
};
const page = () => ({ publication, items: [version], nextCursor: null, effectiveUntil: at });
const options = () => ({
  requestId: "request-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
const fixtureAt = "2026-01-14T16:00:00.000Z";
const fixture = generateMockSource(
  {
    binding: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      storeId: scope.storeId,
      connectionId: scope.connectionId,
      externalStoreId: scope.externalStoreId,
    },
    seed: 42,
    profile: "growing",
    historyStart: "2026-01-01T00:00:00+08:00",
    days: 14,
    productCount: 10,
    variantsPerProduct: 2,
    dailyOrders: 20,
  },
  fixtureAt,
);
function create(response: unknown = page()) {
  const read = vi.fn<PersistentReadPort["read"]>(async () => response);
  const access = vi.fn(async () => true);
  const clock = new SimulationClock(at);
  const connector = new PersistentCommerceConnector(scope, clock, access, { read });
  return { connector, read, access, clock };
}

describe("persistent CommerceConnector", () => {
  it.each([
    {
      kind: "STORE",
      payload: fixture.store,
      key: ["STORE", scope.externalStoreId],
      call: (c: PersistentCommerceConnector) => c.getStore(options()),
    },
    {
      kind: "ORDER",
      payload: fixture.orders[0],
      key: ["ORDER", fixture.orders[0]!.externalOrderId],
      call: (c: PersistentCommerceConnector) =>
        c.listOrders({ until: fixtureAt, limit: 1 }, options()),
    },
    {
      kind: "REFUND",
      payload: fixture.refunds[0],
      key: ["REFUND", fixture.refunds[0]!.externalRefundId],
      call: (c: PersistentCommerceConnector) =>
        c.listRefunds({ until: fixtureAt, limit: 1 }, options()),
    },
    {
      kind: "INVENTORY",
      payload: fixture.inventory[0],
      key: [
        "INVENTORY",
        fixture.inventory[0]!.externalSkuId,
        fixture.inventory[0]!.externalLocationId,
      ],
      call: (c: PersistentCommerceConnector) =>
        c.getInventory({ until: fixtureAt, limit: 1 }, options()),
    },
    {
      kind: "MARKETING",
      payload: fixture.marketing[0],
      key: ["MARKETING", fixture.marketing[0]!.externalCampaignId, fixture.marketing[0]!.date],
      call: (c: PersistentCommerceConnector) =>
        c.getMarketingMetrics(
          { until: fixtureAt, since: "2026-01-01T00:00:00+08:00", limit: 1 },
          options(),
        ),
    },
  ])("validates and serves the $kind stream", async ({ kind, payload, key, call }) => {
    const record = { ...payload, source: { ...source, updatedAt: fixtureAt } };
    const read = vi.fn<PersistentReadPort["read"]>(async () => ({
      ...page(),
      effectiveUntil: fixtureAt,
      publication: { ...publication, targetTime: fixtureAt, processedThrough: fixtureAt },
      items: [
        {
          ...version,
          kind,
          entityKey: JSON.stringify(key),
          occurredAt: fixtureAt,
          payload: record,
        },
      ],
    }));
    const connector = new PersistentCommerceConnector(
      scope,
      new SimulationClock(fixtureAt),
      async () => true,
      { read },
    );
    expect(await call(connector)).toMatchObject({ ok: true });
    expect(read.mock.calls[0][0].kind).toBe(kind);
  });
  it("reads only the bounded injected source and preserves deleted records", async () => {
    const { connector, read, access } = create();
    expect(await connector.listProducts({ until: at, limit: 200 }, options())).toMatchObject({
      ok: true,
      data: { items: [product], sourceWatermark: at, nextCursor: null },
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0]).toMatchObject({
      kind: "PRODUCT",
      limit: 200,
      requestedUntil: at,
      businessNow: at,
      contextHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(access).toHaveBeenCalledTimes(2);
  });
  it("uses structured exact keys for point reads", async () => {
    const { connector, read } = create();
    expect(await connector.getProduct({ externalProductId: "product-a" }, options())).toMatchObject(
      { ok: true, data: product },
    );
    expect(read.mock.calls[0][0]).toMatchObject({ entityKey: ["PRODUCT", "product-a"], limit: 1 });
  });
  it("does not turn an absent publication into a successful empty page or NOT_FOUND", async () => {
    const { connector } = create(null);
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: "TEMPORARY" },
    });
    expect(await connector.getProduct({ externalProductId: "product-a" }, options())).toMatchObject(
      { ok: false, error: { code: "TEMPORARY" } },
    );
  });
  it("allows a certified empty page and certified point absence", async () => {
    const { connector } = create({ ...page(), items: [] });
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: true,
      data: { items: [], sourceWatermark: at },
    });
    expect(await connector.getProduct({ externalProductId: "missing" }, options())).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
  it.each([
    { publication: { ...publication, scope: { ...scope, sessionId: "foreign" } } },
    { publication: { ...publication, highEventSeq: "2" } },
    { publication: { ...publication, revision: "0" } },
    { items: [{ ...version, payload: { ...product, externalStoreId: "foreign" } }] },
    { items: [{ ...version, entityKey: '["PRODUCT","other"]' }] },
    { items: [{ ...version, releaseRevision: "2" }] },
    { nextCursor: "x".repeat(1025) },
    { effectiveUntil: "2026-01-02T00:00:00.000Z" },
  ])("rejects malformed or uncorrelated source evidence %j", async (change) => {
    const { connector } = create({ ...page(), ...change });
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });
  it("does not return data after authorization is revoked during source I/O", async () => {
    const { connector, access } = create();
    access.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
  it("preserves a bounded empty intermediate page instead of manufacturing completion", async () => {
    const { connector } = create({ ...page(), items: [], nextCursor: "cursor-b" });
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: true,
      data: { items: [], nextCursor: "cursor-b", sourceWatermark: at },
    });
  });
  it("reports publication lag as temporarily unavailable", async () => {
    const old = "2025-12-31T00:00:00.000Z";
    const { connector } = create({
      ...page(),
      items: [],
      publication: { ...publication, targetTime: old, processedThrough: old },
    });
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: "TEMPORARY" },
    });
  });
  it("preserves partial unknown cost rather than inventing zero", async () => {
    const partial = {
      ...product,
      skus: [{ ...product.skus[0], costPriceMinor: null }],
      source: { ...source, quality: { state: "PARTIAL", issues: ["COST_MISSING"] } },
    };
    const { connector } = create({ ...page(), items: [{ ...version, payload: partial }] });
    expect(await connector.getProduct({ externalProductId: "product-a" }, options())).toMatchObject(
      { ok: true, data: partial },
    );
  });
  it("rejects a repeated cursor and preserves inclusive source-time filtering", async () => {
    const { connector } = create({ ...page(), nextCursor: "cursor-a" });
    expect(
      await connector.listProducts({ until: at, since: at, limit: 1 }, options()),
    ).toMatchObject({ ok: true, data: { items: [product] } });
    expect(
      await connector.listProducts({ until: at, cursor: "cursor-a", limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("normalizes offsets and rejects source times outside the storage year boundary", async () => {
    const { connector, read } = create();
    await connector.listProducts({ until: "2026-01-01T08:00:00+08:00", limit: 1 }, options());
    expect(read.mock.calls[0][0].requestedUntil).toBe(at);
    expect(
      await connector.listProducts({ until: "9999-12-31T23:59:59-14:00", limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
  it("passes cancellation into I/O and returns no late result", async () => {
    const { connector, read } = create();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | undefined;
    read.mockImplementation(async (_request, call) => {
      signal = call.signal;
      entered();
      return new Promise<never>(() => {
        /* The call gate bounds a stalled injected port. */
      });
    });
    const controller = new AbortController();
    const pending = connector.listProducts(
      { until: at, limit: 1 },
      { ...options(), signal: controller.signal },
    );
    await started;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "ABORTED" } });
    expect(signal?.aborted).toBe(true);
  });
  it("binds the original query to continuations while the business clock advances", async () => {
    const { connector, read, clock } = create({ ...page(), nextCursor: "cursor-a" });
    const query = { until: "2026-01-03T00:00:00Z", since: "2025-12-31T00:00:00Z", limit: 2 };
    await connector.listProducts(query, options());
    clock.advance(86400000);
    await connector.listProducts({ ...query, cursor: "cursor-a" }, options());
    expect(read.mock.calls[0][0].contextHash).toBe(read.mock.calls[1][0].contextHash);
    expect(read.mock.calls[1][0].businessNow).toBe("2026-01-02T00:00:00.000Z");
  });
  it("validates input and fresh access before starting any source query", async () => {
    const { connector, read, access } = create();
    expect(await connector.listProducts({ until: "bad", limit: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    access.mockResolvedValue(false);
    expect(await connector.listProducts({ until: at, limit: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects writes with their original execution ID and does not touch the source", async () => {
    const { connector, read } = create();
    expect(
      await connector.updatePrice(
        {
          executionId: "exec-a",
          idempotencyKey: "key-a",
          externalSkuId: "sku-a",
          expectedVersion: "v1",
          oldPriceMinor: 100,
          newPriceMinor: 200,
          currency: "CNY",
        },
        options(),
      ),
    ).toMatchObject({ executionId: "exec-a", outcome: "REJECTED", failureCode: "UNSUPPORTED" });
    expect(read).not.toHaveBeenCalled();
    connector.dispose();
    expect(await connector.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "AUTH_EXPIRED" },
    });
  });
});
