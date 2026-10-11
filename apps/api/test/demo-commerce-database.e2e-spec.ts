import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DemoSessionViewSchema, type CommerceConnector } from "@shopmate/contracts";
import { disconnectPrismaClient, getPrismaClient } from "@shopmate/database";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoPersistentApiFixture } from "../../../packages/database/test/helpers/demo-persistent-api-fixture.mjs";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";
import { DemoCommerceConnectorHost } from "../src/demo-commerce/demo-commerce-connector.host.js";
import { DEMO_COMMERCE_ENV } from "../src/demo-commerce/demo-commerce.environment.js";
import { DatabasePersistentReadPorts } from "../src/demo-commerce/database-persistent-read-ports.js";
import {
  DEMO_COMMERCE_REPOSITORY,
  type DemoCommerceRepository,
} from "../src/demo-commerce/demo-commerce.repository.js";

import {
  DEMO_FAILURE_RULE_REPOSITORY,
  type DemoFailureRuleRepository,
} from "../src/demo-commerce/demo-failure-rules.repository.js";

const operatorUrl = process.env.TENANT_TEST_OPERATOR_URL;
if (!operatorUrl || !process.env.DATABASE_URL)
  throw new Error("Run pnpm test:tenant with isolated PostgreSQL; this suite cannot be skipped");
const fixture = new DemoPersistentApiFixture(operatorUrl);
const signingKey = randomBytes(48).toString("hex");
const origin = "https://demo.example.test";
const command = {
  settings: {
    profile: "mature",
    seed: 42,
    historyStart: "2026-01-01T00:00:00+08:00",
    days: 14,
    productCount: 5,
    variantsPerProduct: 1,
    dailyOrders: 6,
  },
  observedAt: "2026-01-14T00:00:00Z",
};
const identity = (key = "a") =>
  createAuthContext({
    userId: `demo-api-user-${key}`,
    merchantId: `demo-api-merchant-${key}`,
    permissions: Object.values(AuthPermission),
  });
const cookie = (key = "a") =>
  `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(identity(key), signingKey, 3600).token}`;
const path = (store = "demo-api-store-a") => `/api/v1/demo-commerce/stores/${store}/session`;
const options = () => ({
  requestId: "demo-api-read",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});

describe("persisted demo controls with actual authenticated AppModule and restricted PostgreSQL", () => {
  let app: INestApplication;
  let disabled: INestApplication;
  let host: DemoCommerceConnectorHost;
  beforeAll(async () => {
    await fixture.initialize();
    for (const [key, value] of Object.entries(fixture.readEnvironment)) vi.stubEnv(key, value);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "demo");
    vi.stubEnv("ENABLE_DEMO_MODE", "true");
    vi.stubEnv("APP_ORIGIN", origin);
    vi.stubEnv("DEMO_AUTH_EMAIL", "demo-fixture@example.test");
    vi.stubEnv("DEMO_AUTH_PASSWORD", randomBytes(24).toString("hex"));
    vi.stubEnv("DEMO_AUTH_USER_ID", "demo-api-user-a");
    vi.stubEnv("DEMO_AUTH_MERCHANT_ID", "demo-api-merchant-a");
    vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    host = app.get(DemoCommerceConnectorHost);
    const off = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DEMO_COMMERCE_ENV)
      .useValue({ enabled: false, origin: null })
      .compile();
    disabled = off.createNestApplication();
    configureApp(disabled);
    await disabled.listen(0, "127.0.0.1");
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (disabled) await disabled.close();
    await disconnectPrismaClient();
    await fixture.close();
    vi.unstubAllEnvs();
  });
  function get(store = "demo-api-store-a", key = "a") {
    return request(app.getHttpServer()).get(path(store)).set("Cookie", cookie(key));
  }
  function post(suffix = "", body: object = command, store = "demo-api-store-a", key = "a") {
    return request(app.getHttpServer())
      .post(path(store) + suffix)
      .set("Cookie", cookie(key))
      .set("Origin", origin)
      .send(body);
  }
  async function create(store = "demo-api-store-a", body = command, publish = true) {
    const response = await post("", body, store).expect(201);
    if (publish) await fixture.publish(store);
    return DemoSessionViewSchema.parse(response.body);
  }
  async function connector(store = "demo-api-store-a"): Promise<CommerceConnector> {
    const opened = await host.open(identity(), store, options());
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.code);
    return opened.data;
  }
  async function reopenedConnector() {
    const provider = new DatabasePersistentReadPorts();
    const selected = new DemoCommerceConnectorHost(
      app.get<DemoCommerceRepository>(DEMO_COMMERCE_REPOSITORY),
      { enabled: true, origin },
      provider,
      app.get<DemoFailureRuleRepository>(DEMO_FAILURE_RULE_REPOSITORY),
    );
    const opened = await selected.open(identity(), "demo-api-store-a", options());
    if (!opened.ok) {
      await provider.onModuleDestroy();
      throw new Error(opened.error.code);
    }
    return { connector: opened.data, close: () => provider.onModuleDestroy() };
  }
  it("persists authenticated failure controls and forwards actual source after confirmed removal", async () => {
    const session = await create();
    const rulesPath = path() + "/failure-rules";
    const rule = {
      id: "api-failure",
      priority: 10,
      startsAt: command.observedAt,
      endsAt: "2026-01-15T00:00:00.000Z",
      methods: ["getProduct"],
      effect: { kind: "FAIL", code: "RATE_LIMIT", retryAfterMs: 500 },
    };
    await request(app.getHttpServer()).get(rulesPath).expect(401);
    await request(disabled.getHttpServer()).get(rulesPath).set("Cookie", cookie()).expect(404);
    await post("/failure-rules", { expectedRevision: 0, rule }).expect(201);
    await request(app.getHttpServer()).get(rulesPath).set("Cookie", cookie("b")).expect(404);
    await request(app.getHttpServer())
      .get(rulesPath + "?namespace=foreign")
      .set("Cookie", cookie())
      .expect(400);
    await post("/failure-rules", { expectedRevision: 0, rule: { ...rule, id: "stale" } }).expect(
      409,
    );
    const selected = await connector();
    const ref = { externalProductId: 'quoted/"中文' };
    expect(await selected.getProduct(ref, options())).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMIT", retryAfterMs: 500 },
    });
    const reopened = await reopenedConnector();
    try {
      expect(await reopened.connector.getProduct(ref, options())).toMatchObject({
        error: { code: "RATE_LIMIT" },
      });
    } finally {
      await reopened.close();
    }
    await post("/failure-rules/remove", { expectedRevision: 1, ruleId: rule.id }).expect(400);
    await post("/failure-rules/remove", {
      expectedRevision: 1,
      ruleId: rule.id,
      confirmSessionId: "wrong",
    }).expect(409);
    await post("/failure-rules/remove", {
      expectedRevision: 1,
      ruleId: rule.id,
      confirmSessionId: session.id,
    }).expect(200);
    expect(await selected.getProduct(ref, options())).toMatchObject({
      ok: true,
      data: { title: "Persisted fixture product" },
    });
    await fixture.setRole("VIEWER");
    await post("/failure-rules", { expectedRevision: 2, rule }).expect(403);
    await fixture.disableMembership();
    expect(await selected.getProduct(ref, options())).toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
  });
  it("uses unknown publication, certified absence and exact persisted DTOs without replay", async () => {
    await create("demo-api-store-a", command, false);
    const opened = await connector();
    const ref = { externalProductId: "absent" };
    expect(await opened.getProduct(ref, options())).toMatchObject({
      ok: false,
      error: { code: "TEMPORARY" },
    });
    await fixture.publish("demo-api-store-a", true);
    for (const id of ["absent", "x".repeat(256), "界".repeat(256), "\ud800"])
      expect(await opened.getProduct({ ...ref, externalProductId: id }, options())).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    await post("/advance", { expectedRevision: 0, durationMs: 1 }).expect(200);
    await fixture.publish("demo-api-store-a");
    expect(
      await opened.getProduct({ ...ref, externalProductId: 'quoted/"中文' }, options()),
    ).toMatchObject({ ok: true, data: { title: "Persisted fixture product", status: "DELETED" } });
  });
  it("keeps runtime writes unsupported with the execution identity", async () => {
    await create();
    const opened = await connector();
    expect(
      await opened.updatePrice(
        {
          executionId: "execution",
          idempotencyKey: "key",
          externalSkuId: "sku",
          expectedVersion: "v1",
          oldPriceMinor: 100,
          newPriceMinor: 200,
          currency: "CNY",
        },
        options(),
      ),
    ).toMatchObject({ executionId: "execution", outcome: "REJECTED", failureCode: "UNSUPPORTED" });
  });
  it("rejects source cursor scope and filter tampering", async () => {
    await create();
    await create("demo-api-store-a2");
    const selected = await connector(),
      other = await connector("demo-api-store-a2");
    const query = { until: command.observedAt, limit: 1 };
    const first = await selected.listProducts(query, options());
    if (!first.ok || !first.data.nextCursor) throw new Error("Persisted cursor required");
    const resumed = { ...query, cursor: first.data.nextCursor };
    expect(await other.listProducts(resumed, options())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(
      await selected.listProducts({ ...resumed, since: "2026-01-01T00:00:00.000Z" }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
  it("invalidates the original connector when an identical session is replaced", async () => {
    const original = await create();
    const opened = await connector();
    await fixture.reset();
    const replacement = await create();
    expect(replacement.id).not.toBe(original.id);
    expect(await opened.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "AUTH_EXPIRED" },
    });
  });
  it("denies facts when membership is independently revoked while source SQL is waiting", async () => {
    await create();
    const opened = await connector();
    const release = await fixture.holdEntityTable();
    try {
      const pending = opened.listProducts({ until: command.observedAt, limit: 1 }, options());
      await fixture.waitSourceQuery();
      await fixture.disableMembership();
      await release();
      expect(await pending).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally {
      await release();
    }
  });
  it("actively cancels actual source SQL through the runtime provider and reuses its pool", async () => {
    await create();
    const opened = await connector();
    const release = await fixture.holdEntityTable();
    const controller = new AbortController();
    try {
      const pending = opened.listProducts(
        { until: command.observedAt, limit: 1 },
        { ...options(), signal: controller.signal },
      );
      const pid = await fixture.waitSourceQuery();
      controller.abort("private caller reason");
      expect(await pending).toEqual({ ok: false, error: { code: "ABORTED", retryAfterMs: null } });
      await fixture.waitBackendGone(pid);
    } finally {
      await release();
    }
    expect(
      await opened.listProducts({ until: command.observedAt, limit: 1 }, options()),
    ).toMatchObject({ ok: true });
  });

  it("uses nonowner NOBYPASSRLS with no rows outside identity transactions", async () => {
    expect(
      await getPrismaClient()
        .$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect(await getPrismaClient().demoCommerceSession.count()).toBe(0);
  });
  it("requires a valid signed cookie", async () => {
    await request(app.getHttpServer()).get(path()).expect(401);
    await request(app.getHttpServer())
      .get(path())
      .set("Cookie", "shopmate_demo_session=invalid")
      .expect(401);
  });
  it("uniformly hides disabled controls", async () => {
    for (const suffix of ["", "/advance", "/reset", "/disconnect"])
      await request(disabled.getHttpServer())
        .post(path() + suffix)
        .set("Cookie", cookie())
        .send({ attacker: true })
        .expect(404);
    await request(disabled.getHttpServer()).get(path()).set("Cookie", cookie()).expect(404);
  });
  it.each([undefined, "https://foreign.example.test"])(
    "denies mutation Origin %s",
    async (value) => {
      const req = request(app.getHttpServer()).post(path()).set("Cookie", cookie());
      if (value) req.set("Origin", value);
      await req.send(command).expect(403);
      expect((await fixture.snapshot("demo-api-store-a")).session).toEqual([]);
    },
  );
  it.each(["organizationId", "workspaceId", "connectionId"])(
    "rejects spoofed query/body %s",
    async (field) => {
      await get()
        .query({ [field]: "other" })
        .expect(400);
      await post("", { ...command, [field]: "other" }).expect(400);
    },
  );
  it("keeps global merchant override 404", async () => {
    await get().query({ merchantId: "other" }).expect(404);
    await post("", { ...command, merchantId: "other" }).expect(404);
  });
  it.each(["OWNER", "ADMIN"] as const)(
    "allows current %s lifecycle with safe strict views",
    async (role) => {
      await fixture.setRole(role);
      const first = await create();
      expect(first.status).toBe("ACTIVE");
      expect(first.generation).toBe(0);
      const view = await get().expect(200);
      expect(DemoSessionViewSchema.safeParse(view.body).success).toBe(true);
      expect(view.body).not.toHaveProperty("config");
      await post("", command).expect(409);
      const advanced = await post("/advance", {
        expectedRevision: 0,
        durationMs: 86_400_000,
      }).expect(200);
      expect(advanced.body.clockNow).toBe("2026-01-15T00:00:00.000Z");
      const reset = await post("/reset", {
        ...command,
        expectedRevision: 1,
        confirmSessionId: first.id,
      }).expect(200);
      expect(reset.body).toMatchObject({
        id: first.id,
        connectionId: first.connectionId,
        generation: 1,
        revision: 2,
        clockRevision: 2,
      });
      await post("/disconnect", { expectedRevision: 2, confirmSessionId: first.id }).expect(200);
      expect((await get().expect(200)).body).toMatchObject({
        status: "DISCONNECTED",
        generation: 2,
        revision: 3,
      });
      expect((await fixture.snapshot("demo-api-store-a")).audit).toHaveLength(4);
    },
  );
  it("has exactly one concurrent CAS winner and rejects stale controls", async () => {
    await create();
    const results = await Promise.all([
      post("/advance", { expectedRevision: 0, durationMs: 1 }),
      post("/advance", { expectedRevision: 0, durationMs: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await post("/advance", { expectedRevision: 0, durationMs: 1 }).expect(409);
    expect((await fixture.snapshot("demo-api-store-a")).audit).toHaveLength(2);
  });
  it("denies foreign and missing stores", async () => {
    await get("demo-api-store-b").expect(404);
    await post("", command, "demo-api-store-b").expect(404);
    await get("missing-store").expect(404);
  });
  it("uses fresh viewer read permission while cookie management hints remain unchanged", async () => {
    await create();
    const opened = await connector();
    await fixture.setRole("VIEWER");
    await get().expect(200);
    await post("/advance", { expectedRevision: 0, durationMs: 1 }).expect(403);
    expect(await opened.getStore(options())).toMatchObject({ ok: true });
    await get("demo-api-store-unassigned").expect(404);
    await post("", command, "demo-api-store-unassigned").expect(404);
    await fixture.revokeWorkspace();
    await get().expect(404);
    expect(await opened.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
  it.each(["disableMembership", "suspendOrganization", "suspendWorkspace"] as const)(
    "revokes same cookie and connector after %s",
    async (operation) => {
      await create();
      const opened = await connector();
      await fixture[operation]();
      await get().expect(404);
      await post("/advance", { expectedRevision: 0, durationMs: 1 }).expect(404);
      expect(await opened.getStore(options())).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      });
    },
  );
  it("denies a nonDEMO database marker", async () => {
    await create();
    const opened = await connector();
    await fixture.setMarker("PRODUCTION");
    await get().expect(404);
    await post("/advance", { expectedRevision: 0, durationMs: 1 }).expect(404);
    expect(await opened.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
  it("requires an operator provisioned DemoTenant marker", async () => {
    await create();
    await fixture.removeDemoTenant();
    await get().expect(404);
    await post("/advance", { expectedRevision: 0, durationMs: 1 }).expect(404);
  });
  it("confirmation mismatch leaves session and audit unchanged", async () => {
    await create();
    const before = await fixture.snapshot("demo-api-store-a");
    await post("/disconnect", { expectedRevision: 0, confirmSessionId: "wrong" }).expect(400);
    await post("/reset", { ...command, expectedRevision: 0, confirmSessionId: "wrong" }).expect(
      400,
    );
    expect(await fixture.snapshot("demo-api-store-a")).toEqual(before);
  });
  it("disconnect preserves selected data and reset reactivates only selected store", async () => {
    const first = await create();
    await create("demo-api-store-a2");
    const other = await fixture.snapshot("demo-api-store-a2");
    const selected = await fixture.snapshot("demo-api-store-a");
    await post("/disconnect", { expectedRevision: 0, confirmSessionId: first.id }).expect(200);
    expect((await fixture.snapshot("demo-api-store-a")).session).toHaveLength(1);
    await post("/reset", { ...command, expectedRevision: 1, confirmSessionId: first.id }).expect(
      200,
    );
    expect((await get().expect(200)).body).toMatchObject({
      status: "ACTIVE",
      id: first.id,
      connectionId: first.connectionId,
      generation: 2,
    });
    expect(await fixture.snapshot("demo-api-store-a2")).toEqual(other);
    expect(selected.session).toHaveLength(1);
  });
  it("reopens from a new client with deterministic JSONB config and persisted source", async () => {
    await create();
    const first = await connector();
    const query = { until: command.observedAt, limit: 200 };
    const before = await first.listProducts(query, options());
    expect(before.ok).toBe(true);
    await disconnectPrismaClient();
    const restarted = await reopenedConnector();
    try {
      expect(await restarted.connector.listProducts(query, options())).toEqual(before);
    } finally {
      await restarted.close();
    }
    expect((await get().expect(200)).body.configHash).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("freshens time and facts but retains the existing paging frame", async () => {
    await create();
    const opened = await connector();
    const query = { until: command.observedAt, limit: 1 };
    const page = await opened.listProducts(query, options());
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error.code);
    expect(page.data.nextCursor).not.toBeNull();
    const initial = await opened.listOrders(
      { until: "2026-01-15T00:00:00Z", limit: 200 },
      options(),
    );
    await post("/advance", { expectedRevision: 0, durationMs: 86_400_000 }).expect(200);
    await fixture.publish("demo-api-store-a");
    const restarted = await reopenedConnector();
    try {
      const next = await restarted.connector.listProducts(
        { ...query, cursor: page.data.nextCursor! },
        options(),
      );
      expect(next).toMatchObject({
        ok: true,
        data: {
          observedAt: "2026-01-15T00:00:00.000Z",
          sourceWatermark: page.data.sourceWatermark,
        },
      });
    } finally {
      await restarted.close();
    }
    const fresh = await opened.listOrders({ until: "2026-01-15T00:00:00Z", limit: 200 }, options());
    expect(fresh).toMatchObject({ ok: true, data: { observedAt: "2026-01-15T00:00:00.000Z" } });
    expect(fresh).not.toEqual(initial);
  });
  it("invalidates reset connector/cursor and disconnect blocks all source reads", async () => {
    const view = await create();
    const old = await connector();
    const query = { until: command.observedAt, limit: 1 };
    const page = await old.listProducts(query, options());
    if (!page.ok) throw new Error(page.error.code);
    await post("/reset", {
      ...command,
      observedAt: "2026-01-02T00:00:00Z",
      expectedRevision: 0,
      confirmSessionId: view.id,
    }).expect(200);
    expect(await old.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "AUTH_EXPIRED" },
    });
    const fresh = await connector();
    expect(
      await fresh.listProducts({ ...query, cursor: page.data.nextCursor! }, options()),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    await post("/disconnect", { expectedRevision: 1, confirmSessionId: view.id }).expect(200);
    expect(await fresh.getStore(options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(await host.open(identity(), "demo-api-store-a", options())).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
  it("isolates clocks for interleaved sessions with distinct persisted times", async () => {
    await create();
    await create("demo-api-store-a2", { ...command, observedAt: "2026-01-03T00:00:00Z" });
    const a = await connector();
    const b = await connector("demo-api-store-a2");
    const query = { until: command.observedAt, limit: 1 };
    expect(await a.listProducts(query, options())).toMatchObject({
      ok: true,
      data: { observedAt: "2026-01-14T00:00:00.000Z" },
    });
    expect(await b.listProducts(query, options())).toMatchObject({
      ok: true,
      data: { observedAt: "2026-01-03T00:00:00.000Z" },
    });
    expect(await a.listProducts(query, options())).toMatchObject({
      ok: true,
      data: { observedAt: "2026-01-14T00:00:00.000Z" },
    });
  });
});
