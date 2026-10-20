import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MetricSnapshotV1, TenantContext } from "@shopmate/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { configureApp } from "../app.config.js";
import { DemoAuthModule } from "../auth/demo-auth.module.js";
import { DEMO_AUTH_CONFIG } from "../auth/demo-auth.config.js";
import { signDemoSession } from "../auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../auth/session/demo-session-cookie.js";
import { TenantScopeService } from "../tenant/tenant-scope.service.js";
import { TENANT_MEMBERSHIP_REPOSITORY } from "../tenant/tenant-membership.repository.js";
import { MetricsController } from "./metrics.controller.js";
import {
  METRIC_HISTORY_READ_PORT,
  METRIC_READ_PORT,
  METRIC_STORE_FACTORY,
  METRIC_CURSOR_SECRET,
  METRIC_STORE_OWNERSHIP_RESOLVER,
  MetricsQueryService,
  PersistedMetricReadAdapter,
} from "./metrics-query.service.js";

const key = randomBytes(48).toString("hex");
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const window = {
  periodStart: "2026-10-01T00:00:00Z",
  periodEnd: "2026-10-02T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const filters = {
  metricKey: "GMV",
  definitionVersion: "v1",
  ...window,
  visibleAt: "2026-10-03T00:00:00Z",
};
const path = "/api/v1/stores/store-a/metrics";
const snapshot: MetricSnapshotV1 = {
  schemaVersion: 1,
  binding,
  ...window,
  definitionVersion: "v1",
  inputRevision: "revision-1",
  visibleAt: filters.visibleAt,
  computedAt: filters.visibleAt,
  sourceWatermark: window.periodEnd,
  subject: { kind: "STORE" },
  metric: { kind: "GMV", unit: "minorCNY", value: 0 },
  status: "VERIFIED",
  sampleSize: 0,
  coverageBasisPoints: 10000,
  evidenceIds: ["observed-empty-window"],
  issues: [],
};
const stored = {
  id: "00000000-0000-4000-8000-000000000001",
  inputHash: `sha256:${"a".repeat(64)}`,
  snapshot,
};
const member = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "VIEWER",
};
const membership = vi.fn();
const ownership = vi.fn();
const read = vi.fn();
const history = vi.fn();
const storeFactory = vi.fn();
const cursorSecret = randomBytes(32);
function cookie(userId = "user-a") {
  const context = { userId, merchantId: "merchant-a", permissions: [] };
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(context, key, 3600).token}`;
}
function success<T>(value: T) {
  return { ok: true as const, value };
}
async function createApp() {
  const module = await Test.createTestingModule({
    imports: [DemoAuthModule],
    controllers: [MetricsController],
    providers: [
      MetricsQueryService,
      TenantScopeService,
      PersistedMetricReadAdapter,
      { provide: TENANT_MEMBERSHIP_REPOSITORY, useValue: { resolve: membership } },
      { provide: METRIC_STORE_OWNERSHIP_RESOLVER, useValue: { resolve: ownership } },
      { provide: METRIC_STORE_FACTORY, useValue: storeFactory },
      { provide: METRIC_CURSOR_SECRET, useValue: cursorSecret },
      { provide: METRIC_READ_PORT, useExisting: PersistedMetricReadAdapter },
      { provide: METRIC_HISTORY_READ_PORT, useExisting: PersistedMetricReadAdapter },
    ],
  })
    .overrideProvider(DEMO_AUTH_CONFIG)
    .useValue({ sessionSecret: key })
    .compile();
  const app = module.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
let app: INestApplication;
beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  membership.mockImplementation(async (user: string, merchant: string, workspace?: string) =>
    user === member.userId &&
    merchant === member.merchantId &&
    (!workspace || workspace === member.workspaceId)
      ? member
      : null,
  );
  ownership.mockImplementation(async (actor: TenantContext, storeId: string) =>
    actor.workspaceId === binding.workspaceId && storeId === binding.storeId ? binding : null,
  );
  read.mockResolvedValue(success([snapshot]));
  history.mockResolvedValue(success({ items: [stored], nextCursor: null }));
  storeFactory.mockReturnValue({ read, history });
});
it.each(["", "/history"])("requires a signed cookie for %s", async (suffix) => {
  await request(app.getHttpServer())
    .get(path + suffix)
    .query(filters)
    .expect(401);
  expect(membership).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it("returns observed VERIFIED zero and forwards only server-owned scope", async () => {
  const response = await request(app.getHttpServer())
    .get(path)
    .query(filters)
    .set("Cookie", cookie())
    .expect(200);
  expect(response.body).toEqual({ status: "AVAILABLE", snapshots: [snapshot] });
  expect(membership).toHaveBeenCalledWith("user-a", "merchant-a", undefined);
  expect(read).toHaveBeenCalledWith({
    binding,
    window,
    kinds: ["GMV"],
    subject: { kind: "STORE" },
    definitionVersion: "v1",
    inputRevision: null,
    visibleAt: filters.visibleAt,
  });
});
it("keeps absence distinct from a measured zero", async () => {
  read.mockResolvedValue(success([]));
  const response = await request(app.getHttpServer())
    .get(path)
    .query(filters)
    .set("Cookie", cookie())
    .expect(200);
  expect(response.body).toEqual({ status: "UNAVAILABLE", snapshots: [], reason: "NO_SNAPSHOT" });
});
it.each(["organizationId", "workspaceId", "connectionId", "role", "unknown"])(
  "rejects untrusted query field %s before lookup",
  async (field) => {
    await request(app.getHttpServer())
      .get(path)
      .query({ ...filters, [field]: "foreign" })
      .set("Cookie", cookie())
      .expect(400);
    expect(membership).not.toHaveBeenCalled();
  },
);
it.each([
  { periodEnd: window.periodStart },
  { metricKey: "unknown" },
  { limit: "0" },
  { cursor: "invalid" },
  { visibleAt: "yesterday" },
  { definitionVersion: "" },
])("rejects invalid filters %j", async (patch) => {
  await request(app.getHttpServer())
    .get(path)
    .query({ ...filters, ...patch })
    .set("Cookie", cookie())
    .expect(400);
});
it.each(["", "bad id", "workspace-a,workspace-a"])("rejects header %s", async (value) => {
  await request(app.getHttpServer())
    .get(path)
    .query(filters)
    .set("X-Workspace-Id", value)
    .set("Cookie", cookie())
    .expect(400);
  expect(membership).not.toHaveBeenCalled();
});
it("accepts matching header/path selection and rejects mismatch", async () => {
  const scoped = "/api/v1/workspaces/workspace-a/stores/store-a/metrics";
  await request(app.getHttpServer())
    .get(scoped)
    .query(filters)
    .set("X-Workspace-Id", "workspace-a")
    .set("Cookie", cookie())
    .expect(200);
  await request(app.getHttpServer())
    .get(scoped)
    .query(filters)
    .set("X-Workspace-Id", "workspace-b")
    .set("Cookie", cookie())
    .expect(400);
});
it("rejects repeated query values and GET bodies", async () => {
  await request(app.getHttpServer())
    .get(path + "?metricKey=GMV&metricKey=GMV")
    .query({ ...filters, metricKey: undefined })
    .set("Cookie", cookie())
    .expect(400);
  await request(app.getHttpServer())
    .get(path)
    .query(filters)
    .send({ role: "OWNER" })
    .set("Cookie", cookie())
    .expect(400);
});
it("refreshes current membership for each request", async () => {
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(200);
  membership.mockResolvedValue(null);
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(404);
  expect(read).toHaveBeenCalledTimes(1);
});
it.each(["store-b", "invalid%20store"])("hides/rejects store %s", async (store) => {
  await request(app.getHttpServer())
    .get(`/api/v1/stores/${store}/metrics`)
    .query(filters)
    .set("Cookie", cookie())
    .expect(store === "store-b" ? 404 : 400);
  expect(read).not.toHaveBeenCalled();
});
it("hides foreign bindings returned by the ownership resolver", async () => {
  ownership.mockResolvedValue({ ...binding, organizationId: "foreign" });
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(404);
  expect(read).not.toHaveBeenCalled();
});
it("rejects no read permission in the persisted adapter", async () => {
  const adapter = app.get(PersistedMetricReadAdapter);
  const actor: TenantContext = { ...member, role: "VIEWER", permissions: [] };
  const result = await adapter.read({
    actor,
    query: {
      binding,
      window,
      kinds: ["GMV"],
      subject: { kind: "STORE" },
      definitionVersion: "v1",
      inputRevision: null,
      visibleAt: filters.visibleAt,
    },
  });
  expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN", evidenceIds: [] } });
  expect(storeFactory).not.toHaveBeenCalled();
});
it.each(["membership", "ownership", "read"])("masks %s failures", async (stage) => {
  ({ membership, ownership, read })[stage as "membership" | "ownership" | "read"].mockRejectedValue(
    new Error("private database password"),
  );
  const response = await request(app.getHttpServer())
    .get(path)
    .query(filters)
    .set("Cookie", cookie())
    .expect(503);
  expect(JSON.stringify(response.body)).not.toContain("private");
});
it.each([
  { ...snapshot, binding: { ...binding, connectionId: "foreign" } },
  { ...snapshot, definitionVersion: "v2" },
  { ...snapshot, visibleAt: "2026-10-04T00:00:00Z" },
  { invalid: true },
])("masks invalid persisted result %j", async (value) => {
  read.mockResolvedValue(success([value]));
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(503);
});
it("rejects a repository that mutates its query before returning a mismatched row", async () => {
  read.mockImplementation(async (query: { definitionVersion: string }) => {
    query.definitionVersion = "v2";
    return success([{ ...snapshot, definitionVersion: "v2" }]);
  });
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(503);
  const result = await app.get(PersistedMetricReadAdapter).read({
    actor: {
      ...member,
      role: "VIEWER",
      permissions: ["tenant:read", "products:read", "orders:read", "inventory:read"],
    },
    query: {
      binding,
      window,
      kinds: ["GMV"],
      subject: { kind: "STORE" },
      definitionVersion: "v1",
      inputRevision: null,
      visibleAt: filters.visibleAt,
    },
  });
  expect(result).toEqual({ ok: false, error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] } });
});
it("returns stored history metadata and binds pagination to every filter", async () => {
  const cursor = await firstCursor();
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, limit: "1", cursor })
    .set("Cookie", cookie())
    .expect(200);
  expect(history).toHaveBeenLastCalledWith({
    query: expect.objectContaining({ binding }),
    limit: 1,
    cursor: "actual-p15-keyset",
  });
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, definitionVersion: "v2", cursor })
    .set("Cookie", cookie())
    .expect(400);
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, limit: "21", cursor })
    .set("Cookie", cookie())
    .expect(400);
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, cursor: cursor + "a" })
    .set("Cookie", cookie())
    .expect(400);
});

async function firstCursor(): Promise<string> {
  history.mockResolvedValueOnce(success({ items: [stored], nextCursor: "actual-p15-keyset" }));
  const response = await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, limit: "1" })
    .set("Cookie", cookie())
    .expect(200);
  expect(response.body.items).toEqual([stored]);
  return response.body.nextCursor as string;
}

it("returns HTTP 403 before ownership lookup when current read permission is absent", async () => {
  vi.spyOn(app.get(TenantScopeService), "resolve").mockResolvedValueOnce({
    ...member,
    role: "VIEWER",
    permissions: [],
  });
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(403);
  expect(ownership).not.toHaveBeenCalled();
});

it("rejects repeated raw workspace headers", async () => {
  await request(app.getHttpServer())
    .get(path)
    .query(filters)
    .set({ "X-Workspace-Id": ["workspace-a", "workspace-a"] })
    .set("Cookie", cookie())
    .expect(400);
  expect(membership).not.toHaveBeenCalled();
});

it.each(["FORBIDDEN", "NOT_FOUND", "INVALID_INPUT", "SOURCE_UNAVAILABLE"] as const)(
  "maps typed repository error %s without evidence leaks",
  async (code) => {
    read.mockResolvedValue({ ok: false, error: { code, evidenceIds: ["private-evidence"] } });
    const status = { FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400, SOURCE_UNAVAILABLE: 503 }[
      code
    ];
    const response = await request(app.getHttpServer())
      .get(path)
      .query(filters)
      .set("Cookie", cookie())
      .expect(status);
    expect(JSON.stringify(response.body)).not.toContain("private");
  },
);

it.each([
  { metricKey: "PAID_REVENUE" },
  { inputRevision: "revision-1" },
  { periodStart: "2026-09-30T00:00:00Z" },
  { periodEnd: "2026-10-02T01:00:00Z" },
  { visibleAt: "2026-10-04T00:00:00Z" },
  { subjectKind: "SKU", externalSkuId: "sku-a" },
])("rejects history cursor replay with changed filter %j before repository", async (patch) => {
  const cursor = await firstCursor();
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, limit: "1", ...patch, cursor })
    .set("Cookie", cookie())
    .expect(400);
  expect(history).toHaveBeenCalledTimes(1);
});

it("binds history cursors to the authenticated user and the full connection binding", async () => {
  const cursor = await firstCursor();
  membership.mockResolvedValue({ ...member, userId: "user-b" });
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, limit: "1", cursor })
    .set("Cookie", cookie("user-b"))
    .expect(400);
  membership.mockResolvedValue(member);
  ownership.mockResolvedValue({ ...binding, connectionId: "connection-b" });
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, limit: "1", cursor })
    .set("Cookie", cookie())
    .expect(400);
  expect(history).toHaveBeenCalledTimes(1);
});

it.each([
  { items: [stored], nextCursor: 123 },
  { items: [{ ...stored, inputHash: "invalid" }], nextCursor: null },
  { items: [stored, stored], nextCursor: null },
  {
    items: [{ ...stored, snapshot: { ...snapshot, binding: { ...binding, storeId: "foreign" } } }],
    nextCursor: null,
  },
])("masks malformed or foreign history output %j", async (page) => {
  history.mockResolvedValue(success(page));
  await request(app.getHttpServer())
    .get(path + "/history")
    .query(filters)
    .set("Cookie", cookie())
    .expect(503);
});

it("preserves explicit empty history without manufacturing zero", async () => {
  history.mockResolvedValue(success({ items: [], nextCursor: null }));
  const response = await request(app.getHttpServer())
    .get(path + "/history")
    .query(filters)
    .set("Cookie", cookie())
    .expect(200);
  expect(response.body).toEqual({
    status: "UNAVAILABLE",
    items: [],
    nextCursor: null,
    reason: "NO_SNAPSHOT",
  });
});

it("requires a stable server-owned cursor secret", () => {
  expect(() => new PersistedMetricReadAdapter(storeFactory, Buffer.alloc(0))).toThrow(
    "Invalid metric cursor secret",
  );
});

it.each(["tenant:read", "inventory:read"] as const)(
  "requires current %s alongside orders read",
  async (missing) => {
    const permissions = (
      ["tenant:read", "products:read", "orders:read", "inventory:read"] as const
    ).filter((permission) => permission !== missing);
    const actor: TenantContext = { ...member, role: "VIEWER", permissions };
    vi.spyOn(app.get(TenantScopeService), "resolve").mockResolvedValueOnce(actor);
    await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(403);
    const result = await app.get(PersistedMetricReadAdapter).read({
      actor,
      query: {
        binding,
        window,
        kinds: ["GMV"],
        subject: { kind: "STORE" },
        definitionVersion: "v1",
        inputRevision: null,
        visibleAt: filters.visibleAt,
      },
    });
    expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN", evidenceIds: [] } });
    expect(storeFactory).not.toHaveBeenCalled();
  },
);

it("uses the same injected secret across adapter instances and preserves repository receivers", async () => {
  const cursor = await firstCursor();
  const repository = {
    result: success({ items: [stored], nextCursor: null }),
    read,
    async history() {
      return this.result;
    },
  };
  const adapter = new PersistedMetricReadAdapter(() => repository, cursorSecret);
  const query = {
    binding,
    window,
    kinds: ["GMV"] as const,
    subject: { kind: "STORE" } as const,
    definitionVersion: "v1",
    inputRevision: null,
    visibleAt: filters.visibleAt,
  };
  const actor: TenantContext = {
    ...member,
    role: "VIEWER",
    permissions: ["tenant:read", "products:read", "orders:read", "inventory:read"],
  };
  const result = await adapter.history({ actor, query, limit: 1, cursor });
  expect(result).toEqual(repository.result);
  const other = new PersistedMetricReadAdapter(() => repository, randomBytes(32));
  expect(await other.history({ actor, query, limit: 1, cursor })).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it.each(["0", "101", "01", "1.5", "-1", "1e2"])(
  "rejects history limit %s before lookup",
  async (limit) => {
    await request(app.getHttpServer())
      .get(path + "/history")
      .query({ ...filters, limit })
      .set("Cookie", cookie())
      .expect(400);
    expect(membership).not.toHaveBeenCalled();
  },
);

it("rejects malformed history cursors before repository reads", async () => {
  await request(app.getHttpServer())
    .get(path + "/history")
    .query({ ...filters, cursor: "invalid" })
    .set("Cookie", cookie())
    .expect(400);
  expect(history).not.toHaveBeenCalled();
});

it("masks history failures and malformed ownership results", async () => {
  history.mockRejectedValue(new Error("private database credentials"));
  const response = await request(app.getHttpServer())
    .get(path + "/history")
    .query(filters)
    .set("Cookie", cookie())
    .expect(503);
  expect(JSON.stringify(response.body)).not.toContain("private");
  ownership.mockResolvedValue({ ...binding, connectionId: null });
  await request(app.getHttpServer()).get(path).query(filters).set("Cookie", cookie()).expect(503);
  expect(read).not.toHaveBeenCalled();
});

it("accepts supported subject and immutable revision filters without inventing repository filters", async () => {
  const subject = { kind: "SKU", externalSkuId: "sku-a" } as const;
  read.mockResolvedValue(success([{ ...snapshot, subject }]));
  await request(app.getHttpServer())
    .get(path)
    .query({ ...filters, subjectKind: "SKU", externalSkuId: "sku-a", inputRevision: "revision-1" })
    .set("Cookie", cookie())
    .expect(200);
  expect(read).toHaveBeenLastCalledWith(
    expect.objectContaining({ subject, inputRevision: "revision-1" }),
  );
});
