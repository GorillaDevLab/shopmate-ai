import {
  TENANT_ROLE_PERMISSIONS,
  type ReadOptions,
  type ConnectorResult,
  type CommerceConnector,
} from "@shopmate/contracts";
import { describe, expect, it, vi, afterEach } from "vitest";
import { SimulationClock } from "./business-clock.js";
import {
  MockConnectorFactory,
  type MockConnectorAccessResolver,
} from "./mock-connector-factory.js";

const identity = {
  userId: "user-a",
  merchantId: "merchant-a",
  permissions: ["products:read"] as const,
};
const config = {
  binding: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "mock-a",
  },
  seed: 42,
  profile: "mature",
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 14,
  productCount: 5,
  variantsPerProduct: 1,
  dailyOrders: 6,
};
const record = () => ({
  sessionId: "session-a",
  context: {
    ...identity,
    organizationId: "org-a",
    workspaceId: "ws-a",
    role: "VIEWER",
    permissions: [...TENANT_ROLE_PERMISSIONS.VIEWER],
  },
  config,
  generation: 1,
  environmentMarker: "demo",
  demoTenant: true,
});
const options = () => ({
  requestId: "req-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
const environment = { appEnv: "demo", enableDemoMode: true };
function port(result: ConnectorResult<CommerceConnector>): CommerceConnector {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}
afterEach(() => vi.useRealTimers());

describe("fresh tenant connector selection", () => {
  it("resolves store config internally and returns a common port", async () => {
    const resolver: MockConnectorAccessResolver = { resolve: vi.fn(async () => record()) };
    const factory = new MockConnectorFactory(
      environment,
      resolver,
      new SimulationClock("2026-01-14T00:00:00Z"),
    );
    const connector = port(await factory.open(identity, "store-a", options()));
    expect(connector.binding).toEqual(config.binding);
    expect(await connector.getStore(options())).toMatchObject({ ok: true });
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenCalledWith(
      identity,
      "store-a",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { appEnv: "production", enableDemoMode: true },
    { appEnv: "staging", enableDemoMode: true },
    { appEnv: "demo", enableDemoMode: false },
    { enableDemoMode: true },
  ])("fails closed for environment %j", async (env) => {
    const resolver: MockConnectorAccessResolver = { resolve: vi.fn(async () => record()) };
    const result = await new MockConnectorFactory(
      env,
      resolver,
      new SimulationClock(config.historyStart),
    ).open(identity, "store-a", options());
    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: undefined },
    { sessionId: "invalid session" },
    { environmentMarker: "production" },
    { demoTenant: false },
    { generation: -1 },
    { context: { ...record().context, userId: "user-b" } },
    { context: { ...record().context, merchantId: "merchant-b" } },
    { context: { ...record().context, organizationId: "org-b" } },
    { context: { ...record().context, workspaceId: "ws-b" } },
    { config: { ...config, binding: { ...config.binding, storeId: "store-b" } } },
    { context: { ...record().context, permissions: [] } },
  ])("rejects uncorrelated/unapproved resolver records %j", async (change) => {
    const factory = new MockConnectorFactory(
      environment,
      { resolve: async () => ({ ...record(), ...change }) },
      new SimulationClock(config.historyStart),
    );
    expect(await factory.open(identity, "store-a", options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("rejects request-side binding/context injection before lookup", async () => {
    const resolver: MockConnectorAccessResolver = { resolve: vi.fn(async () => record()) };
    const factory = new MockConnectorFactory(
      environment,
      resolver,
      new SimulationClock(config.historyStart),
    );
    expect(
      await factory.open({ ...identity, organizationId: "org-b" }, "store-a", options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await factory.open(identity, { storeId: "store-a", binding: config.binding }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("revokes reads and page continuations when current membership disappears", async () => {
    let current: unknown = record();
    const factory = new MockConnectorFactory(
      environment,
      { resolve: async () => current },
      new SimulationClock("2026-01-14T00:00:00Z"),
    );
    const connector = port(await factory.open(identity, "store-a", options()));
    const page = await connector.listProducts(
      { until: "2026-01-14T00:00:00Z", limit: 1 },
      options(),
    );
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error.code);
    current = null;
    expect(
      await connector.listProducts(
        { until: "2026-01-14T00:00:00Z", limit: 1, cursor: page.data.nextCursor! },
        options(),
      ),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it.each(["generation", "connection", "source-config"])(
    "invalidates old instances on %s change",
    async (change) => {
      let current = record();
      const factory = new MockConnectorFactory(
        environment,
        { resolve: async () => current },
        new SimulationClock(config.historyStart),
      );
      const connector = port(await factory.open(identity, "store-a", options()));
      current =
        change === "generation"
          ? { ...current, generation: 2 }
          : change === "connection"
            ? {
                ...current,
                config: { ...config, binding: { ...config.binding, connectionId: "conn-b" } },
              }
            : { ...current, config: { ...config, seed: 43 } };
      expect(await connector.getStore(options())).toMatchObject({
        ok: false,
        error: { code: "AUTH_EXPIRED" },
      });
    },
  );

  it("checks current per-method permissions instead of identity-supplied permission hints", async () => {
    let current = record();
    const factory = new MockConnectorFactory(
      environment,
      { resolve: async () => current },
      new SimulationClock("2026-01-14T00:00:00Z"),
    );
    const connector = port(await factory.open(identity, "store-a", options()));
    current = { ...current, context: { ...current.context, permissions: ["tenant:read"] } };
    expect(await connector.getStore(options())).toMatchObject({ ok: true });
    expect(
      await connector.listOrders({ until: "2026-01-14T00:00:00Z", limit: 10 }, options()),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("uses call cancellation/deadlines for access lookup and sanitizes failure", async () => {
    const broken = new MockConnectorFactory(
      environment,
      {
        resolve: async () => {
          throw new Error("private database detail");
        },
      },
      new SimulationClock(config.historyStart),
    );
    expect(await broken.open(identity, "store-a", options())).toEqual({
      ok: false,
      error: { code: "TEMPORARY", retryAfterMs: null },
    });
    vi.useFakeTimers();
    let received: ReadOptions | undefined;
    const hanging = new MockConnectorFactory(
      environment,
      {
        resolve: async (_identity, _store, call) => {
          received = call;
          return new Promise(() => undefined);
        },
      },
      new SimulationClock(config.historyStart),
    );
    const pending = hanging.open(identity, "store-a", options());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(received!.signal!.aborted).toBe(true);
  });
});
