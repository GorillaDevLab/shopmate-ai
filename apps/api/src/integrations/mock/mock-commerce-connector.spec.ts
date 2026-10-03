import {
  ConnectorOrderSchema,
  ConnectorPageSchema,
  ConnectorProductSchema,
  WriteReceiptSchema,
  type CommerceConnector,
  type ConnectorResult,
} from "@shopmate/contracts";
import { describe, expect, it, vi, afterEach } from "vitest";
import { SimulationClock } from "./business-clock.js";
import { MockCommerceConnector } from "./mock-commerce-connector.js";
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
  days: 14,
  productCount: 10,
  variantsPerProduct: 2,
  dailyOrders: 20,
};
const now = "2026-01-14T16:00:00Z";
const options = () => ({
  requestId: "request-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
const query = { until: now, limit: 3 };
function create(input: unknown = config, at = now) {
  const clock = new SimulationClock(at);
  const connector = new MockCommerceConnector(input, clock, async () => true);
  return { clock, connector };
}
function value<T>(result: ConnectorResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}
afterEach(() => vi.useRealTimers());

describe("read-only CommerceConnector conformance", () => {
  it("implements the common port and exposes frozen truthful capabilities", async () => {
    const port: CommerceConnector = create().connector;
    expect(port.capabilities).toMatchObject({
      readProducts: true,
      readOrders: true,
      readInventory: true,
      readRefunds: true,
      readMarketing: true,
      writePrice: false,
      writeInventory: false,
      publishProduct: false,
      preconditionMode: "UNSUPPORTED",
    });
    expect(Object.isFrozen(port.binding)).toBe(true);
    expect(Object.isFrozen(port.capabilities)).toBe(true);
    expect(value(await port.getStore(options())).externalStoreId).toBe("mock-a");
  });

  it("reads by ID only within the bound visible source", async () => {
    const { connector } = create();
    const products = value(await connector.listProducts(query, options()));
    expect(ConnectorPageSchema(ConnectorProductSchema).safeParse(products).success).toBe(true);
    expect(
      value(
        await connector.getProduct(
          { externalProductId: products.items[0]!.externalProductId },
          options(),
        ),
      ),
    ).toEqual(products.items[0]);
    const orders = value(await connector.listOrders(query, options()));
    expect(ConnectorPageSchema(ConnectorOrderSchema).safeParse(orders).success).toBe(true);
    expect(
      value(
        await connector.getOrder({ externalOrderId: orders.items[0]!.externalOrderId }, options()),
      ),
    ).toEqual(orders.items[0]);
    for (const id of ["unknown", "mock-b:product:0"])
      expect(await connector.getProduct({ externalProductId: id }, options())).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    expect(
      await connector.getOrder({ externalOrderId: "mock-b:order:0:0" }, options()),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("paginates a complete source without missing or duplicating records", async () => {
    const { connector } = create();
    const expected = generateMockSource(config, now)
      .orders.map((order) => order.externalOrderId)
      .sort();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = value(await connector.listOrders({ ...query, limit: 20, cursor }, options()));
      ids.push(...page.items.map((order) => order.externalOrderId));
      expect(page.items.length).toBeLessThanOrEqual(20);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pins retries and later pages when business time advances", async () => {
    const { connector, clock } = create(config, "2026-01-02T16:00:00Z");
    const futureQuery = { until: now, limit: 2 };
    const first = value(await connector.listOrders(futureQuery, options()));
    const nextQuery = { ...futureQuery, cursor: first.nextCursor! };
    const next = value(await connector.listOrders(nextQuery, options()));
    clock.advance(2 * 86_400_000);
    expect(value(await connector.listOrders(nextQuery, options()))).toEqual(next);
    expect(next.observedAt).toBe(first.observedAt);
    expect(value(await connector.listOrders(futureQuery, options())).observedAt).not.toBe(
      first.observedAt,
    );
  });

  it("reconstructs earlier states and applies inclusive source update windows", async () => {
    const { connector } = create();
    const cutoff = "2026-01-01T10:00:00Z";
    const expected = generateMockSource(config, cutoff).orders;
    const page = value(await connector.listOrders({ until: cutoff, limit: 200 }, options()));
    expect(page.items.map((item) => item.externalOrderId).sort()).toEqual(
      expected.map((item) => item.externalOrderId).sort(),
    );
    expect(
      page.items.every((item) => Date.parse(item.source.updatedAt!) <= Date.parse(cutoff)),
    ).toBe(true);
    const launch = config.historyStart;
    expect(
      value(await connector.listProducts({ until: now, since: launch, limit: 200 }, options()))
        .items,
    ).toHaveLength(10);
    expect(
      value(
        await connector.listProducts(
          { until: now, since: "2026-01-01T00:00:01+08:00", limit: 200 },
          options(),
        ),
      ).items,
    ).toHaveLength(0);
  });

  it("returns absent store and empty pages before opening", async () => {
    const { connector } = create(config, "2025-12-30T00:00:00Z");
    expect(await connector.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(value(await connector.listOrders(query, options())).items).toHaveLength(0);
    expect(value(await connector.listProducts(query, options())).sourceWatermark).toBeNull();
  });

  it("rejects altered windows, method reuse, cursor forgery and other connector instances", async () => {
    const { connector } = create();
    const first = value(await connector.listProducts(query, options()));
    const cursor = first.nextCursor!;
    for (const change of [
      { limit: 4 },
      { until: "2026-01-14T15:00:00Z" },
      { since: config.historyStart },
    ]) {
      expect(
        await connector.listProducts({ ...query, cursor, ...change }, options()),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    expect(await connector.listOrders({ ...query, cursor }, options())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(
      await connector.listProducts({ ...query, cursor: `${cursor}edited` }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await create().connector.listProducts({ ...query, cursor }, options())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("accepts equivalent timestamp spellings and sorted SKU selections", async () => {
    const { connector } = create();
    const first = value(await connector.listProducts(query, options()));
    expect(
      value(
        await connector.listProducts(
          { ...query, until: "2026-01-15T00:00:00+08:00", cursor: first.nextCursor! },
          options(),
        ),
      ).items,
    ).toHaveLength(3);
    const inventory = generateMockSource(config, now).inventory;
    const selected = [inventory[0]!.externalSkuId, inventory[1]!.externalSkuId];
    const page = value(
      await connector.getInventory({ ...query, limit: 1, externalSkuIds: selected }, options()),
    );
    expect(
      value(
        await connector.getInventory(
          { ...query, limit: 1, externalSkuIds: [...selected].reverse(), cursor: page.nextCursor! },
          options(),
        ),
      ).items,
    ).toHaveLength(1);
    expect(
      value(await connector.getInventory({ ...query, externalSkuIds: ["mock-b:sku:0"] }, options()))
        .items,
    ).toHaveLength(0);
  });

  it("reads refunds and day-bounded marketing from observed facts", async () => {
    const { connector } = create({ ...config, refundBps: 5000 });
    expect(
      value(await connector.listRefunds({ ...query, limit: 200 }, options())).items.length,
    ).toBeGreaterThan(0);
    const since = "2026-01-02T00:00:00+08:00";
    const page = value(
      await connector.getMarketingMetrics(
        { until: "2026-01-04T00:00:00+08:00", since, limit: 200 },
        options(),
      ),
    );
    expect(page.items.map((item) => item.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(
      await connector.getMarketingMetrics(
        { ...query, since: "2026-01-02T01:00:00+08:00" },
        options(),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it.each([{ limit: 0 }, { limit: 201 }, { until: "bad" }, { storeId: "foreign" }])(
    "rejects invalid list query %j",
    async (change) => {
      expect(
        await create().connector.listProducts({ ...query, ...change }, options()),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    },
  );

  it("fails expired/evicted cursors and disposed instances safely", async () => {
    vi.useFakeTimers();
    const { connector, clock } = create(config, "2026-01-02T16:00:00Z");
    const first = value(await connector.listProducts(query, options()));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(
      await connector.listProducts({ ...query, cursor: first.nextCursor! }, options()),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const page = value(await connector.listOrders(query, options()));
    for (let i = 0; i < 2; i += 1) {
      clock.advance(86_400_000);
      await connector.listOrders(query, options());
    }
    expect(
      await connector.listOrders({ ...query, cursor: page.nextCursor! }, options()),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    connector.dispose();
    expect(await connector.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "AUTH_EXPIRED" },
    });
  });

  it("rechecks access on every call including continuations", async () => {
    let allowed = true;
    const connector = new MockCommerceConnector(
      config,
      new SimulationClock(now),
      async () => allowed,
    );
    const first = value(await connector.listProducts(query, options()));
    allowed = false;
    expect(
      await connector.listProducts({ ...query, cursor: first.nextCursor! }, options()),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(await connector.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("rejects write and verify methods without changing any state", async () => {
    const { connector } = create();
    const before = value(
      await connector.getProduct({ externalProductId: "mock-a:product:0" }, options()),
    );
    const sku = before.skus[0]!;
    const base = { executionId: "exec-a", idempotencyKey: "key-a" };
    const price = {
      ...base,
      externalSkuId: sku.externalSkuId,
      expectedVersion: "v1",
      oldPriceMinor: sku.salePriceMinor,
      newPriceMinor: 100,
      currency: "CNY" as const,
    };
    const inventory = {
      ...base,
      externalSkuId: sku.externalSkuId,
      externalLocationId: "warehouse",
      expectedVersion: "v1",
      oldAvailable: 10,
      targetAvailable: 20,
    };
    const listing = {
      title: "测试",
      description: "测试说明",
      category: "3C",
      brand: null,
      skus: [
        { sellerSkuCode: "sku-a", attributes: [], salePriceMinor: 100, currency: "CNY" as const },
      ],
    };
    const receipts = [
      await connector.updatePrice(price, options()),
      await connector.updateInventory(inventory, options()),
      await connector.createProduct({ ...base, listing }, options()),
      await connector.updateProduct(
        { ...base, listing, externalProductId: before.externalProductId, expectedVersion: "v1" },
        options(),
      ),
    ];
    for (const receipt of receipts) {
      expect(WriteReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(receipt).toMatchObject({
        executionId: "exec-a",
        outcome: "REJECTED",
        failureCode: "UNSUPPORTED",
      });
    }
    expect(
      await connector.verifyAction(
        {
          executionId: "exec-a",
          expected: {
            kind: "PRICE",
            externalSkuId: sku.externalSkuId,
            priceMinor: 100,
            currency: "CNY",
          },
        },
        options(),
      ),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    expect(
      value(await connector.getProduct({ externalProductId: before.externalProductId }, options())),
    ).toEqual(before);
  });

  it("preserves write correlation while rejecting malformed or cancelled requests", async () => {
    const { connector } = create();
    expect(await connector.updatePrice({ executionId: "exec-a" }, options())).toMatchObject({
      executionId: "exec-a",
      outcome: "REJECTED",
      failureCode: "INVALID_INPUT",
    });
    await expect(connector.updatePrice({}, options())).rejects.toThrow("INVALID_INPUT");
    const controller = new AbortController();
    controller.abort();
    expect(
      await connector.updatePrice(
        { executionId: "exec-a" },
        { ...options(), signal: controller.signal },
      ),
    ).toMatchObject({ outcome: "REJECTED", failureCode: "ABORTED" });
    expect(
      await connector.updatePrice(
        { executionId: "exec-a" },
        { ...options(), deadlineAt: new Date(Date.now() - 1).toISOString() },
      ),
    ).toMatchObject({ outcome: "REJECTED", failureCode: "TIMEOUT" });
  });
});
