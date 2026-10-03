import type { CommerceConnector, ConnectorResult, ReadOptions } from "@shopmate/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulationClock } from "./business-clock.js";
import { MockCommerceConnector, type MockReadAccess } from "./mock-commerce-connector.js";
import { type MockReadMethod } from "./failure-rules.js";
import { ReadFaultInjectingConnector } from "./read-fault-connector.js";

const now = "2026-01-03T16:00:00Z";
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
  days: 4,
  productCount: 3,
  variantsPerProduct: 1,
  dailyOrders: 2,
};
const options = (duration = 5000): ReadOptions => ({
  requestId: "request-a",
  deadlineAt: new Date(Date.now() + duration).toISOString(),
});
const query = { until: now, limit: 1 };
const reads = {
  getStore: (c: CommerceConnector, o: ReadOptions) => c.getStore(o),
  listProducts: (c: CommerceConnector, o: ReadOptions) => c.listProducts(query, o),
  getProduct: (c: CommerceConnector, o: ReadOptions) =>
    c.getProduct({ externalProductId: "mock-a:product:0" }, o),
  listOrders: (c: CommerceConnector, o: ReadOptions) => c.listOrders(query, o),
  getOrder: (c: CommerceConnector, o: ReadOptions) =>
    c.getOrder({ externalOrderId: "mock-a:order:0:0" }, o),
  listRefunds: (c: CommerceConnector, o: ReadOptions) => c.listRefunds(query, o),
  getInventory: (c: CommerceConnector, o: ReadOptions) => c.getInventory(query, o),
  getMarketingMetrics: (c: CommerceConnector, o: ReadOptions) =>
    c.getMarketingMetrics({ ...query, since: config.historyStart }, o),
};
const methods = Object.keys(reads) as MockReadMethod[];
const pageMethods = [
  "listProducts",
  "listOrders",
  "listRefunds",
  "getInventory",
  "getMarketingMetrics",
] as const;
const unsupportedUtcTimes = ["0000-01-01T00:00:00+14:00", "9999-12-31T23:59:59-14:00"];
const calendarCases = pageMethods.flatMap((method) => {
  const cases = unsupportedUtcTimes.map((until) => ({
    method,
    field: "until",
    input: {
      until,
      limit: 1,
      ...(method === "getMarketingMetrics"
        ? { since: until.startsWith("0000") ? "0000-01-01T00:00:00+08:00" : config.historyStart }
        : {}),
    },
  }));
  if (method === "getInventory") return cases;
  return cases.concat(
    unsupportedUtcTimes.map((since) => ({
      method,
      field: "since",
      input: {
        until: since.startsWith("9999") ? since : now,
        limit: 1,
        since:
          method === "getMarketingMetrics" && since.startsWith("0000")
            ? "0000-01-01T00:00:00+08:00"
            : since,
      },
    })),
  );
});
const listing = {
  title: "测试",
  description: "测试说明",
  category: "3C",
  brand: null,
  skus: [{ sellerSkuCode: "sku-a", attributes: [], salePriceMinor: 100, currency: "CNY" as const }],
};
const common = { executionId: "exec-a", idempotencyKey: "key-a", expectedVersion: "v1" };
const actions = [
  (c: CommerceConnector) =>
    c.updatePrice(
      { ...common, externalSkuId: "sku", oldPriceMinor: 10, newPriceMinor: 20, currency: "CNY" },
      options(),
    ),
  (c: CommerceConnector) =>
    c.updateInventory(
      {
        ...common,
        externalSkuId: "sku",
        externalLocationId: "loc",
        oldAvailable: 1,
        targetAvailable: 2,
      },
      options(),
    ),
  (c: CommerceConnector) =>
    c.createProduct({ executionId: "exec-a", idempotencyKey: "key-a", listing }, options()),
  (c: CommerceConnector) =>
    c.updateProduct({ ...common, externalProductId: "p", listing }, options()),
];
const fail = (code = "TEMPORARY", retryAfterMs: number | null = null) => ({
  kind: "FAIL",
  code,
  retryAfterMs,
});
const rule = (effect: unknown) => ({
  id: "private-rule",
  priority: 1,
  startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2026-01-10T00:00:00Z",
  methods,
  effect,
});
function create(
  rules: unknown = [],
  access: MockReadAccess = async () => true,
  loader: (o: ReadOptions) => Promise<unknown> = async () => rules,
) {
  const clock = new SimulationClock(now);
  const base = new MockCommerceConnector(config, clock, access);
  const wrapper = new ReadFaultInjectingConnector(base, clock, access, loader);
  return { base, clock, wrapper };
}
function value<T>(result: ConnectorResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("read-only fault injecting connector", () => {
  it.each(methods)(
    "delegates actual %s source reads exactly when no rule matches",
    async (method) => {
      const { base, wrapper } = create();
      const expected = await reads[method](base, options());
      const result = await reads[method](wrapper, options());
      if (
        expected.ok &&
        result.ok &&
        "nextCursor" in expected.data &&
        "nextCursor" in result.data
      ) {
        expect({ ...result.data, nextCursor: null }).toEqual({
          ...expected.data,
          nextCursor: null,
        });
      } else expect(result).toEqual(expected);
    },
  );

  it.each(methods)(
    "injects exact validated failures before actual %s source generation",
    async (method) => {
      const { base, wrapper } = create([rule(fail("RATE_LIMIT", 123))]);
      const source = vi.spyOn(base, method);
      expect(await reads[method](wrapper, options())).toEqual({
        ok: false,
        error: { code: "RATE_LIMIT", retryAfterMs: 123 },
      });
      expect(source).not.toHaveBeenCalled();
    },
  );

  it.each(["AUTH_EXPIRED", "TEMPORARY", "INVALID_RESPONSE"])(
    "reports explicit synthetic %s safely",
    async (code) => {
      expect(await create([rule(fail(code))]).wrapper.getStore(options())).toEqual({
        ok: false,
        error: { code, retryAfterMs: null },
      });
    },
  );

  it("validates and freezes binding/capabilities and rejects write-capable providers", () => {
    const { base, clock, wrapper } = create();
    expect(wrapper.binding).toEqual(base.binding);
    expect(wrapper.capabilities).toEqual(base.capabilities);
    expect(Object.isFrozen(wrapper.binding)).toBe(true);
    expect(Object.isFrozen(wrapper.capabilities)).toBe(true);
    for (const change of [
      { writePrice: true },
      { writeInventory: true },
      { publishProduct: true },
      { idempotencyMode: "NATIVE" },
      { preconditionMode: "READ_THEN_WRITE" },
    ]) {
      const altered = Object.assign(Object.create(base) as CommerceConnector, {
        capabilities: { ...base.capabilities, ...change },
      });
      expect(
        () =>
          new ReadFaultInjectingConnector(
            altered,
            clock,
            async () => true,
            async () => [],
          ),
      ).toThrow("UNSUPPORTED");
    }
    const malformed = Object.assign(Object.create(base) as CommerceConnector, {
      binding: { ...base.binding, token: "secret" },
    });
    expect(
      () =>
        new ReadFaultInjectingConnector(
          malformed,
          clock,
          async () => true,
          async () => [],
        ),
    ).toThrow("INVALID_RESPONSE");
  });

  it("rejects malformed read inputs before rule selection", async () => {
    const load = vi.fn(async () => [rule(fail())]);
    const { wrapper } = create([], async () => true, load);
    const invalid = { ...query, tenantId: "foreign" };
    const results = await Promise.all([
      wrapper.getStore({ ...options(), token: "secret" }),
      wrapper.listProducts(invalid, options()),
      wrapper.getProduct({ externalProductId: "" }, options()),
      wrapper.listOrders(invalid, options()),
      wrapper.getOrder({ externalOrderId: "", token: "secret" }, options()),
      wrapper.listRefunds(invalid, options()),
      wrapper.getInventory({ ...query, externalSkuIds: ["x", "x"] }, options()),
      wrapper.getMarketingMetrics({ ...query, since: "2026-01-01T01:00:00+08:00" }, options()),
    ]);
    for (const result of results)
      expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", retryAfterMs: null } });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(calendarCases)(
    "matches actual base calendar rejection for $method $field: $input",
    async ({ method, input }) => {
      const access = vi.fn(async () => true);
      const load = vi.fn(async () => [rule(fail())]);
      const { base, wrapper } = create([], access, load);
      const expected = await base[method](input, options());
      expect(expected).toEqual({
        ok: false,
        error: { code: "INVALID_INPUT", retryAfterMs: null },
      });
      access.mockClear();
      const source = vi.spyOn(base, method);
      expect(await wrapper[method](input, options())).toEqual(expected);
      expect(access).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
    },
  );

  it.each(pageMethods)("preserves actual %s valid UTC boundaries and offsets", async (method) => {
    const { base, wrapper } = create();
    const times = [
      "0000-01-02T00:00:00Z",
      "0000-01-02T08:00:00+08:00",
      "9999-12-31T23:59:59Z",
      "9999-12-31T09:59:59-14:00",
    ];
    if (method !== "getMarketingMetrics") times.push("0000-01-01T00:00:00Z");
    for (const until of times) {
      const input = {
        until,
        limit: 200,
        ...(method === "getMarketingMetrics" ? { since: "0000-01-02T00:00:00+08:00" } : {}),
      };
      const expected = await base[method](input, options());
      expect(expected.ok).toBe(true);
      expect(await wrapper[method](input, options())).toEqual(expected);
    }
  });

  it("preserves Shanghai midnight validation for equivalent since offsets", async () => {
    const { base, wrapper } = create();
    for (const since of [
      config.historyStart,
      "2025-12-31T16:00:00Z",
      "2025-12-31T11:00:00-05:00",
    ]) {
      const input = { ...query, since, limit: 200 };
      const expected = await base.getMarketingMetrics(input, options());
      expect(expected.ok).toBe(true);
      expect(await wrapper.getMarketingMetrics(input, options())).toEqual(expected);
    }
  });

  it("retains the real call gate before calendar validation", async () => {
    const { base, wrapper } = create([rule(fail())]);
    const source = vi.spyOn(base, "listProducts");
    const input = { ...query, until: unsupportedUtcTimes[1] };
    const expired = { ...options(), deadlineAt: new Date(Date.now() - 1).toISOString() };
    expect(await wrapper.listProducts(input, expired)).toMatchObject({
      error: { code: "TIMEOUT" },
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await wrapper.listProducts(input, { ...options(), signal: controller.signal }),
    ).toMatchObject({
      error: { code: "ABORTED" },
    });
    expect(source).not.toHaveBeenCalled();
  });

  it("uses fresh explicit permission checks before loading or selecting faults", async () => {
    let allowed = true;
    const permissions: string[] = [];
    const load = vi.fn(async () => [rule(fail())]);
    const access: MockReadAccess = async (permission) => {
      permissions.push(permission);
      return allowed;
    };
    const { wrapper } = create([], access, load);
    for (const method of methods) await reads[method](wrapper, options());
    expect(permissions).toEqual([
      "tenant:read",
      "products:read",
      "products:read",
      "orders:read",
      "orders:read",
      "orders:read",
      "inventory:read",
      "tenant:read",
    ]);
    allowed = false;
    expect(await wrapper.getStore(options())).toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
    expect(load).toHaveBeenCalledTimes(8);
  });

  it("sanitizes loader exceptions and invalid rules or clock", async () => {
    const loader = async () => {
      throw new Error("private token and policy");
    };
    expect(await create([], async () => true, loader).wrapper.getStore(options())).toEqual({
      ok: false,
      error: { code: "TEMPORARY", retryAfterMs: null },
    });
    expect(await create([{ private: "token" }]).wrapper.getStore(options())).toEqual({
      ok: false,
      error: { code: "INVALID_RESPONSE", retryAfterMs: null },
    });
    const { base } = create();
    const wrapper = new ReadFaultInjectingConnector(
      base,
      { snapshot: () => ({ now: "invalid", revision: 0 }) },
      async () => true,
      async () => [],
    );
    expect(await wrapper.getStore(options())).toMatchObject({
      error: { code: "INVALID_RESPONSE" },
    });
  });

  it.each(["access", "loader"] as const)(
    "prevents late %s returns after the real deadline from starting base work",
    async (boundary) => {
      vi.useFakeTimers();
      const pending = deferred<unknown>();
      let linked: ReadOptions | undefined;
      const access: MockReadAccess = async () =>
        boundary === "access" ? (await pending.promise) === true : true;
      const loader = async (call: ReadOptions) => {
        linked = call;
        return boundary === "loader" ? pending.promise : [];
      };
      const { base, wrapper } = create([], access, loader);
      const source = vi.spyOn(base, "getStore");
      const result = wrapper.getStore(options(20));
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toMatchObject({ error: { code: "TIMEOUT" } });
      if (boundary === "loader") expect(linked?.signal?.aborted).toBe(true);
      pending.resolve(boundary === "access" ? true : []);
      await vi.advanceTimersByTimeAsync(0);
      expect(source).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels rule loading and prevents its late return from delegating", async () => {
    const pending = deferred<unknown>();
    const controller = new AbortController();
    let linked: ReadOptions | undefined;
    const loader = async (call: ReadOptions) => {
      linked = call;
      return pending.promise;
    };
    const { base, wrapper } = create([], async () => true, loader);
    const source = vi.spyOn(base, "getStore");
    const result = wrapper.getStore({ ...options(), signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ error: { code: "ABORTED" } });
    expect(linked?.signal?.aborted).toBe(true);
    pending.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(source).not.toHaveBeenCalled();
  });

  it("delays real reads and retains current base authorization and timer cleanup", async () => {
    vi.useFakeTimers();
    const { base, wrapper } = create([rule({ kind: "DELAY", delayMs: 100 })]);
    const source = vi.spyOn(base, "getStore");
    const result = wrapper.getStore(options());
    await vi.advanceTimersByTimeAsync(99);
    expect(source).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(await base.getStore(options()));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("base authorization sees revocation during the injected delay", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const { wrapper } = create([rule({ kind: "DELAY", delayMs: 100 })], async () => allowed);
    const result = wrapper.getStore(options());
    await vi.advanceTimersByTimeAsync(1);
    allowed = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
  });

  it.each(["deadline", "abort"] as const)("cleans delay timers/listeners on %s", async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { base, wrapper } = create([rule({ kind: "DELAY", delayMs: 100 })]);
    const source = vi.spyOn(base, "getStore");
    const result = wrapper.getStore({ ...options(20), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    if (mode === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(19);
    expect(await result).toMatchObject({
      error: { code: mode === "abort" ? "ABORTED" : "TIMEOUT" },
    });
    expect(source).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("TIMEOUT waits for real time even when simulation time advances, capped at 30 seconds", async () => {
    vi.useFakeTimers();
    const { clock, wrapper } = create([rule(fail("TIMEOUT"))]);
    let settled = false;
    const result = wrapper.getStore(options(120000)).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    clock.advance(86400000);
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("TIMEOUT follows caller abort and removes its linked listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { wrapper } = create([rule(fail("TIMEOUT"))]);
    const result = wrapper.getStore({ ...options(), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ error: { code: "ABORTED" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps pinned continuation/retry and source facts unchanged through fault recovery", async () => {
    let rules: unknown = [];
    const { base, clock, wrapper } = create(
      [],
      async () => true,
      async () => rules,
    );
    const before = await base.getStore(options());
    const page = value(await wrapper.listProducts(query, options()));
    const continuation = { ...query, cursor: page.nextCursor! };
    const next = await wrapper.listProducts(continuation, options());
    rules = [rule(fail())];
    expect(await wrapper.listProducts(continuation, options())).toMatchObject({
      error: { code: "TEMPORARY" },
    });
    rules = [];
    clock.advance(86400000);
    expect(await wrapper.listProducts(continuation, options())).toEqual(next);
    expect(await base.getStore(options())).toEqual(before);
  });

  it("passes all writes/verification to the actual read-only adapter unchanged", async () => {
    vi.useFakeTimers();
    const { base, wrapper } = create([rule(fail())]);
    for (const action of actions) {
      expect(await action(wrapper)).toEqual(await action(base));
      expect(await action(wrapper)).toMatchObject({
        outcome: "REJECTED",
        failureCode: "UNSUPPORTED",
      });
    }
    const verification = {
      executionId: "exec-a",
      expected: {
        kind: "PRICE" as const,
        externalSkuId: "sku",
        priceMinor: 100,
        currency: "CNY" as const,
      },
    };
    expect(await wrapper.verifyAction(verification, options())).toEqual(
      await base.verifyAction(verification, options()),
    );
    expect(await wrapper.updatePrice({ executionId: "exec-a" }, options())).toEqual(
      await base.updatePrice({ executionId: "exec-a" }, options()),
    );
    await expect(wrapper.updatePrice({}, options())).rejects.toThrow("INVALID_INPUT");
    const controller = new AbortController();
    controller.abort();
    expect(
      await wrapper.updatePrice(
        { executionId: "exec-a" },
        { ...options(), signal: controller.signal },
      ),
    ).toMatchObject({ outcome: "REJECTED", failureCode: "ABORTED" });
  });

  it("retains base write authorization and real deadline rejections for every write", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const { base, wrapper } = create([rule(fail())], async () => allowed);
    const expired = { ...options(), deadlineAt: new Date(Date.now() - 1).toISOString() };
    for (const method of [
      "updatePrice",
      "updateInventory",
      "createProduct",
      "updateProduct",
    ] as const) {
      const malformed = { executionId: "exec-a" };
      expect(await wrapper[method](malformed, expired)).toEqual(
        await base[method](malformed, expired),
      );
      expect(await wrapper[method](malformed, expired)).toMatchObject({ failureCode: "TIMEOUT" });
    }
    allowed = false;
    for (const action of actions) {
      expect(await action(wrapper)).toEqual(await action(base));
      expect(await action(wrapper)).toMatchObject({
        outcome: "REJECTED",
        failureCode: "PERMISSION_DENIED",
      });
    }
    expect(await wrapper.verifyAction({}, options())).toEqual(
      await base.verifyAction({}, options()),
    );
  });
});
