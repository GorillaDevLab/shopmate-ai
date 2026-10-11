import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommerceConnector } from "@shopmate/contracts";
import type { SyncRuntimeBootstrap } from "@shopmate/database/sync-host";
import type { SourceReadPorts, BoundSourceReadPort } from "@shopmate/database/mock-platform-read";
import { SyncCommerce } from "./commerce.js";

const binding = {
  organizationId: "org-a",
  workspaceId: "ws-a",
  storeId: "store-a",
  connectionId: "conn-a",
  externalStoreId: "external-a",
};
const config = {
  binding,
  seed: 42,
  profile: "mature",
  historyStart: "2025-12-31T16:00:00.000Z",
  days: 14,
  productCount: 5,
  variantsPerProduct: 1,
  dailyOrders: 6,
  growthBps: 0,
  refundBps: 150,
  adSpendMinor: 10000,
};
function bootstrap(): SyncRuntimeBootstrap {
  return {
    grantId: "grant-a",
    principalUserId: "user-a",
    merchantId: "merchant-a",
    provider: "MOCK",
    scope: { ...binding, sessionId: "session-a", generation: 1 },
    initialSince: config.historyStart,
    businessNow: "2026-01-14T16:00:00.000Z",
    clockRevision: 1,
    sessionRevision: 1,
    config,
    configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    generatorVersion: "mock-source-v1",
    runtimeOpening: config.historyStart,
    state: "READY",
  };
}
const options = () => ({
  requestId: "commerce-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
function fixture() {
  let current: SyncRuntimeBootstrap | null = bootstrap();
  const host = { runtimeBootstrap: vi.fn(async () => current) };
  const read = vi.fn<BoundSourceReadPort["read"]>(async () => null);
  const sources: SourceReadPorts = {
    bind: vi.fn(() => ({
      read,
      refreshCheckpoint: async () => null,
      findPublication: async () => null,
    })),
    close: async () => undefined,
  };
  return {
    host,
    sources,
    read,
    commerce: new SyncCommerce(host, sources),
    set: (next: SyncRuntimeBootstrap | null) => {
      current = next;
    },
  };
}
async function connector(f: ReturnType<typeof fixture>): Promise<CommerceConnector> {
  const opened = await f.commerce.open(options());
  if (!opened.ok || opened.data === null) throw new Error("OPEN_FAILED");
  return opened.data.connector;
}
afterEach(() => vi.useRealTimers());
describe("server derived commerce", () => {
  it("waits for the actual runtime and never binds source reads while waiting", async () => {
    const f = fixture();
    f.set({ ...bootstrap(), state: "WAITING_RUNTIME", runtimeOpening: null });
    expect(await f.commerce.open(options())).toEqual({ ok: true, data: null });
    expect(f.sources.bind).not.toHaveBeenCalled();
  });
  it("derives the complete source authority and keeps missing publication unknown", async () => {
    const f = fixture();
    const c = await connector(f);
    expect(f.sources.bind).toHaveBeenCalledWith(
      { userId: "user-a", merchantId: "merchant-a" },
      bootstrap().scope,
    );
    expect(
      await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "TEMPORARY" } });
    expect(f.host.runtimeBootstrap.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("refreshes persisted business time before every data read", async () => {
    const f = fixture();
    const c = await connector(f);
    f.set({ ...bootstrap(), businessNow: "2026-01-15T16:00:00.000Z", clockRevision: 2 });
    await c.listProducts({ until: "2026-01-15T16:00:00.000Z", limit: 1 }, options());
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({ businessNow: "2026-01-15T16:00:00.000Z" }),
      expect.anything(),
    );
  });
  it.each(["principalUserId", "merchantId", "grantId"] as const)(
    "denies changed %s before source I/O",
    async (field) => {
      const f = fixture();
      const c = await connector(f);
      f.set({ ...bootstrap(), [field]: "other-a" });
      expect(
        await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
      ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it("expires a connector when frozen configuration changes", async () => {
    const f = fixture();
    const c = await connector(f);
    f.set({ ...bootstrap(), config: { ...config, seed: 43 } });
    expect(
      await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "AUTH_EXPIRED" } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("denies revoked membership before reads", async () => {
    const f = fixture();
    const c = await connector(f);
    f.set(null);
    expect(
      await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("checks cancellation again after bootstrap I/O", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.runtimeBootstrap.mockImplementation(async () => {
      controller.abort();
      return bootstrap();
    });
    expect(await f.commerce.open({ ...options(), signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: "ABORTED" },
    });
    expect(f.sources.bind).not.toHaveBeenCalled();
  });
  it("rejects malformed caller options before bootstrap", async () => {
    const f = fixture();
    expect(await f.commerce.open({ ...options(), storeId: "other-a" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
  });
  it("checks the absolute deadline after bootstrap I/O", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const call = options();
    f.host.runtimeBootstrap.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5001);
      return bootstrap();
    });
    expect(await f.commerce.open(call)).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(f.sources.bind).not.toHaveBeenCalled();
  });
});

describe("commerce authority boundaries", () => {
  it("retains cancellation when a bootstrap operation rejects after abort", async () => {
    const f = fixture(),
      controller = new AbortController();
    f.host.runtimeBootstrap.mockImplementation(async () => {
      controller.abort();
      throw new Error("HOST_FAILURE");
    });
    expect(await f.commerce.open({ ...options(), signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: "ABORTED" },
    });
  });
  it("returns the checked bootstrap used for connector binding", async () => {
    const f = fixture();
    const newer = { ...bootstrap(), businessNow: "2026-01-15T16:00:00.000Z", clockRevision: 2 };
    f.host.runtimeBootstrap.mockResolvedValueOnce(bootstrap()).mockResolvedValue(newer);
    const result = await f.commerce.open(options());
    expect(result).toMatchObject({ ok: true, data: { bootstrap: newer } });
  });
});

function emptyPage() {
  const record = bootstrap(),
    at = record.businessNow;
  return {
    publication: {
      scope: record.scope,
      revision: "1",
      targetClockRevision: record.clockRevision,
      targetTime: at,
      baseRevision: "0",
      baseHighEventSeq: "0",
      highEventSeq: "0",
      eventCount: "0",
      versionCount: "0",
      processedThrough: at,
      generatorVersion: "mock-source-v1",
      runtimeVersion: "mock-runtime-v2",
      codec: "source-snapshot-v1",
      publishedAt: at,
      certificateHash: "a".repeat(64),
    },
    items: [],
    nextCursor: null,
    effectiveUntil: at,
  } as const;
}
describe("read-only five-stream composition", () => {
  it("consumes all five streams through the authorized full source namespace", async () => {
    const f = fixture();
    f.read.mockResolvedValue(emptyPage());
    const c = await connector(f);
    const query = { until: bootstrap().businessNow, limit: 1 };
    const calls = [
      c.listProducts(query, options()),
      c.listOrders(query, options()),
      c.listRefunds(query, options()),
      c.getInventory(query, options()),
      c.getMarketingMetrics({ ...query, since: bootstrap().runtimeOpening! }, options()),
    ];
    for (const result of await Promise.all(calls))
      expect(result).toMatchObject({ ok: true, data: { items: [], nextCursor: null } });
    expect(f.read.mock.calls.map(([request]) => (request as { kind: string }).kind).sort()).toEqual(
      ["INVENTORY", "MARKETING", "ORDER", "PRODUCT", "REFUND"],
    );
    expect(c.capabilities).toMatchObject({
      writePrice: false,
      writeInventory: false,
      publishProduct: false,
    });
  });
  it("reauthorizes after successful source I/O before exposing a page", async () => {
    const f = fixture();
    const c = await connector(f);
    f.read.mockImplementation(async () => {
      f.set(null);
      return emptyPage();
    });
    expect(
      await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  });
  it("expires changed generation without source reads", async () => {
    const f = fixture();
    const c = await connector(f);
    f.set({ ...bootstrap(), scope: { ...bootstrap().scope, generation: 2 }, clockRevision: 2 });
    expect(
      await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "AUTH_EXPIRED" } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("enforces the monotonic persistent business clock", async () => {
    const f = fixture();
    const c = await connector(f);
    f.set({ ...bootstrap(), businessNow: config.historyStart, clockRevision: 2 });
    expect(
      await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(f.read).not.toHaveBeenCalled();
  });
});

it("cold-loads independently without application, Prisma, or generator imports", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const moduleUrl = new URL("index.ts", import.meta.url).href;
  const program = `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    import ts from 'typescript';
    registerHooks({ resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
        return next(specifier.slice(0, -3) + '.ts', context);
      }
    }, load(url, context, next) {
      if (/app\\.module|@prisma|prisma-client|mock-generator|mock-runtime\\.js|mock-dataset\\.js|database\\/dist\\/src\\/index\\.js/u.test(url)) throw new Error('FORBIDDEN_IMPORT');
      if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
      return next(url, context);
    }});
    const worker = await import(${JSON.stringify(moduleUrl)});
    if (typeof worker.SyncCommerce !== 'function' || typeof worker.planSyncWindows !== 'function') throw new Error('EXPORT_MISSING');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      DATABASE_URL: "invalid",
      APP_DATABASE_URL: "invalid",
      NODE_ENV: "production",
    },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it.each(["SOURCE_INTEGRITY", "SOURCE_CONFIGURATION"] as const)(
  "keeps bootstrap %s permanent",
  async (code) => {
    const { SourceStorageError } = await import("@shopmate/database/mock-platform-read");
    const f = fixture();
    f.host.runtimeBootstrap.mockRejectedValue(new SourceStorageError(code));
    expect(await f.commerce.open(options())).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  },
);

describe("hostile read controls", () => {
  it("rejects accessors without invoking them or contacting the host", async () => {
    const f = fixture(),
      getter = vi.fn(() => "commerce-a");
    const input = Object.defineProperty({ deadlineAt: options().deadlineAt }, "requestId", {
      get: getter,
      enumerable: true,
    });
    expect(await f.commerce.open(input)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(getter).not.toHaveBeenCalled();
    expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
  });
  it("rejects proxies without invoking traps or contacting the host", async () => {
    const f = fixture(),
      trap = vi.fn();
    const input = new Proxy(options(), {
      ownKeys(target) {
        trap();
        return Reflect.ownKeys(target);
      },
      get(target, key) {
        trap();
        return Reflect.get(target, key);
      },
      getPrototypeOf(target) {
        trap();
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(await f.commerce.open(input)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(trap).not.toHaveBeenCalled();
    expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
  });
  it.each(["symbol", "nonenumerable", "nonplain"] as const)(
    "rejects %s controls before host I/O",
    async (kind) => {
      const f = fixture();
      const input = options();
      if (kind === "symbol")
        Object.defineProperty(input, Symbol("extra"), { value: true, enumerable: true });
      if (kind === "nonenumerable") Object.defineProperty(input, "extra", { value: true });
      if (kind === "nonplain") Object.setPrototypeOf(input, { inherited: true });
      expect(await f.commerce.open(input)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
      expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
    },
  );
});

it("keeps an existing connector usable after clock and session revisions advance", async () => {
  const f = fixture();
  const c = await connector(f);
  const advanced = {
    ...bootstrap(),
    businessNow: "2026-01-15T16:00:00.000Z",
    clockRevision: 2,
    sessionRevision: 2,
  };
  f.set(advanced);
  f.read.mockResolvedValue(emptyPage());
  const until = bootstrap().businessNow;
  expect(await c.listProducts({ until, limit: 1 }, options())).toMatchObject({
    ok: true,
    data: { items: [], sourceWatermark: until },
  });
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({ requestedUntil: until, businessNow: advanced.businessNow }),
    expect.anything(),
  );
});
it("keeps an existing connector usable after mutable rule session revisions advance", async () => {
  const f = fixture();
  const c = await connector(f);
  f.set({ ...bootstrap(), sessionRevision: 2 });
  f.read.mockResolvedValue(emptyPage());
  expect(
    await c.listProducts({ until: bootstrap().businessNow, limit: 1 }, options()),
  ).toMatchObject({ ok: true, data: { items: [] } });
});

it.each(["proxied", "unbranded", "overridden"] as const)(
  "rejects %s signals before bootstrap I/O",
  async (kind) => {
    const f = fixture(),
      invoked = vi.fn();
    let signal: object = new AbortController().signal;
    if (kind === "proxied")
      signal = new Proxy(signal, {
        getPrototypeOf(target) {
          invoked();
          return Reflect.getPrototypeOf(target);
        },
      });
    if (kind === "unbranded") signal = Object.create(AbortSignal.prototype);
    if (kind === "overridden")
      Object.defineProperty(signal, "aborted", {
        get() {
          invoked();
          return false;
        },
      });
    expect(await f.commerce.open({ ...options(), signal })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(invoked).not.toHaveBeenCalled();
    expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
  },
);

it("rejects signal symbol accessors before bootstrap I/O", async () => {
  const f = fixture(),
    invoked = vi.fn(),
    signal = new AbortController().signal;
  const slot =
    Object.getOwnPropertySymbols(signal).find((key) => String(key) === "Symbol(kAborted)") ??
    Symbol("hostile");
  Object.defineProperty(signal, slot, {
    get() {
      invoked();
      return false;
    },
  });
  expect(await f.commerce.open({ ...options(), signal })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(invoked).not.toHaveBeenCalled();
  expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
});
