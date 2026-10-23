import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import {
  TENANT_ROLE_PERMISSIONS,
  type MetricKind,
  type MetricResult,
  type MetricSnapshotV1,
  type MetricSourceQuery,
  type TenantContext,
} from "@shopmate/contracts";
import { disconnectPrismaClient } from "@shopmate/database";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  MetricsApiFixture,
  binding,
  cutoff,
  scope,
  window,
} from "../../../packages/database/test/helpers/metrics-api-fixture.mjs";
import { MetricRuntimeService } from "../src/metrics/metric-runtime.service.js";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";

if (
  !process.env.TENANT_TEST_OPERATOR_URL ||
  !process.env.DATABASE_URL ||
  !process.env.METRIC_DATABASE_URL ||
  !process.env.METRIC_DEFINITION_DATABASE_URL
)
  throw new Error("Metrics proof requires runner-owned operator, membership and metric URLs");
const fixture = new MetricsApiFixture(process.env.TENANT_TEST_OPERATOR_URL);
const signingKey = randomBytes(48).toString("hex");
const actor: TenantContext = {
  userId: "metric-api-human",
  merchantId: "metric-api-merchant",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "OWNER",
  permissions: TENANT_ROLE_PERMISSIONS.OWNER,
};
const path = `/api/v1/stores/${scope.storeId}/metrics`;
function cookie() {
  const identity = createAuthContext({
    userId: actor.userId,
    merchantId: actor.merchantId,
    permissions: Object.values(AuthPermission),
  });
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(identity, signingKey, 3600).token}`;
}
function query(
  kinds: readonly MetricKind[] = ["PAID_REVENUE"],
  patch: Partial<MetricSourceQuery> = {},
): MetricSourceQuery {
  return {
    binding,
    window,
    visibleAt: cutoff,
    definitionVersion: "metrics-g4-v1",
    inputRevision: null,
    coverageRequests: kinds.map((kind) => ({ kind, subject: { kind: "STORE" } })),
    ...patch,
  };
}
function values(result: MetricResult<readonly MetricSnapshotV1[]>) {
  if (!result.ok) throw new Error(`Metric proof failed: ${result.error.code}`);
  expect(result.ok).toBe(true);
  return result.value;
}
function filters(kind: MetricKind = "PAID_REVENUE") {
  return { ...window, visibleAt: cutoff, metricKey: kind, definitionVersion: "metrics-g4-v1" };
}
async function reversedReplay(
  runtime: MetricRuntimeService,
  initial: readonly MetricSnapshotV1[],
  revision: string,
) {
  const reverse = [...initial].reverse();
  const replay = values(
    await runtime.compute({
      actor,
      query: query(
        reverse.map((row) => row.metric.kind),
        { inputRevision: revision },
      ),
      computedAt: cutoff,
    }),
  );
  expect(replay).toEqual(reverse);
}
async function application() {
  const [{ AppModule }, { configureApp }] = await Promise.all([
    import("../src/app.module.js"),
    import("../src/app.config.js"),
  ]);
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication();
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return { app, runtime: module.get(MetricRuntimeService) };
}

let app: INestApplication;
let runtime: MetricRuntimeService;
let initial: readonly MetricSnapshotV1[];
let revision: string;
let inputHash: string;
let resetCursor: string;
const resetFilters = { ...filters(), visibleAt: "2026-01-03T00:00:00.000Z" };
async function noGenerationZeroSnapshots(inputRevision?: string) {
  const selected = { ...resetFilters, ...(inputRevision ? { inputRevision } : {}) };
  const read = await request(app.getHttpServer())
    .get(path)
    .query(selected)
    .set("Cookie", cookie())
    .expect(200);
  expect(read.body).toMatchObject({ status: "UNAVAILABLE", snapshots: [], reason: "NO_SNAPSHOT" });
  const history = await request(app.getHttpServer())
    .get(`${path}/history`)
    .query(selected)
    .set("Cookie", cookie())
    .expect(200);
  expect(history.body).toMatchObject({ items: [], nextCursor: null, reason: "NO_SNAPSHOT" });
}
beforeAll(async () => {
  await fixture.initialize();
  await fixture.seed();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEMO_AUTH_EMAIL", "metric@example.test");
  vi.stubEnv("DEMO_AUTH_PASSWORD", randomBytes(24).toString("hex"));
  vi.stubEnv("DEMO_AUTH_USER_ID", actor.userId);
  vi.stubEnv("DEMO_AUTH_MERCHANT_ID", actor.merchantId);
  vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
  ({ app, runtime } = await application());
});
afterAll(async () => {
  if (app) await app.close();
  await disconnectPrismaClient();
  await fixture.close();
  vi.unstubAllEnvs();
});
it("does not provision definitions or compute through GET/history", async () => {
  const before = await fixture.counts();
  expect(before).toEqual({ archives: 0, snapshots: 0, definitions: 0 });
  await request(app.getHttpServer()).get(path).query(filters()).set("Cookie", cookie()).expect(200);
  await request(app.getHttpServer())
    .get(`${path}/history`)
    .query(filters())
    .set("Cookie", cookie())
    .expect(200);
  expect(await fixture.counts()).toEqual(before);
  expect(await runtime.compute({ actor, query: query(), computedAt: cutoff })).toMatchObject({
    ok: false,
    error: { code: "VERSION_MISMATCH" },
  });
});
it("provisions fixed immutable definitions explicitly using the separate writer", async () => {
  expect(await runtime.provisionDefinitions({ actor, binding })).toEqual({ ok: true, value: true });
  expect(await runtime.provisionDefinitions({ actor, binding })).toEqual({ ok: true, value: true });
  expect((await fixture.counts()).definitions).toBe(23);
});
it("computes real G4 paid10500, refund2000 and settlement8500 with unknown profit/traffic", async () => {
  const single = values(await runtime.compute({ actor, query: query(), computedAt: cutoff }));
  const kinds = [
    "GMV",
    "PAID_REVENUE",
    "REFUND_SETTLED_AMOUNT",
    "NET_REVENUE_SETTLEMENT",
    "GROSS_PROFIT",
    "CONTRIBUTION",
    "ESTIMATED_NET_PROFIT",
    "CONVERSION_RATE",
    "ROAS",
  ] as const;
  initial = values(await runtime.compute({ actor, query: query(kinds), computedAt: cutoff }));
  expect(initial.map((row) => row.metric.value)).toEqual([
    12000,
    10500,
    2000,
    8500,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(initial[1]).toEqual(single[0]);
  revision = initial[0]!.inputRevision;
  expect(initial.slice(4).every((row) => row.status === "UNAVAILABLE")).toBe(true);
});
it("returns stored snapshots and scoped signed history without source activity", async () => {
  const before = await fixture.counts();
  const response = await request(app.getHttpServer())
    .get(path)
    .query(filters())
    .set("Cookie", cookie())
    .expect(200);
  expect(response.body.snapshots[0].metric.value).toBe(10500);
  const history = await request(app.getHttpServer())
    .get(`${path}/history`)
    .query({ ...filters(), limit: "1" })
    .set("Cookie", cookie())
    .expect(200);
  expect(history.body.items[0].snapshot.inputRevision).toBe(revision);
  inputHash = history.body.items[0].inputHash;
  expect(await fixture.counts()).toEqual(before);
});
it("rejects anonymous, foreign binding, unknown revisions and false archive contexts", async () => {
  await request(app.getHttpServer()).get(path).query(filters()).expect(401);
  await request(app.getHttpServer())
    .get(path.replace(scope.storeId, "foreign-store"))
    .query(filters())
    .set("Cookie", cookie())
    .expect(404);
  const before = await fixture.counts();
  for (const patch of [
    { binding: { ...binding, externalStoreId: "foreign" } },
    { inputRevision: `p2-normalized-v1:${"a".repeat(64)}` },
    { inputRevision: revision, visibleAt: "2026-01-02T01:00:00.000Z" },
  ])
    expect(
      (
        await runtime.compute({
          actor,
          query: query(["PAID_REVENUE"], patch),
          computedAt: "2026-01-02T01:00:00.000Z",
        })
      ).ok,
    ).toBe(false);
  expect(await fixture.counts()).toEqual(before);
});
it("rejects future visibility until persisted business clock advances", async () => {
  const future = "2026-01-03T00:00:00.000Z";
  const before = await fixture.counts();
  expect(
    (
      await runtime.compute({
        actor,
        query: query(["PAID_REVENUE"], { visibleAt: future }),
        computedAt: future,
      })
    ).ok,
  ).toBe(false);
  expect(await fixture.counts()).toEqual(before);
  await fixture.advance(future);
  await fixture.seed(future, true);
  const corrected = values(
    await runtime.compute({
      actor,
      query: query(["PAID_REVENUE"], { visibleAt: future }),
      computedAt: future,
    }),
  );
  expect(corrected[0]!.metric.value).toBe(11500);
  expect(corrected[0]!.inputRevision).not.toBe(revision);
  expect(corrected[0]!.evidenceIds).not.toEqual(initial[0]!.evidenceIds);
});
it("replays exact old v1 revision after mutable current state changes", async () => {
  const replay = values(
    await runtime.compute({
      actor,
      query: query(
        initial.map((row) => row.metric.kind),
        { inputRevision: revision },
      ),
      computedAt: "2026-01-03T00:00:00.000Z",
    }),
  );
  expect(replay).toEqual(initial);
  await reversedReplay(runtime, initial, revision);
  const history = await request(app.getHttpServer())
    .get(`${path}/history`)
    .query({ ...filters(), inputRevision: revision })
    .set("Cookie", cookie())
    .expect(200);
  expect(history.body.items).toHaveLength(1);
  expect(history.body.items[0].inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(history.body.items[0].inputHash).toBe(inputHash);
  expect(
    await runtime.compute({
      actor,
      query: query(["PAID_REVENUE"], { definitionVersion: "unknown-current-default" }),
      computedAt: cutoff,
    }),
  ).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
});
it("retains prior-day payment linkage for next-day refund settlement", async () => {
  const next = "2026-01-03T00:00:00.000Z";
  const result = values(
    await runtime.compute({
      actor,
      query: query(["PAID_REVENUE", "REFUND_SETTLED_AMOUNT", "NET_REVENUE_SETTLEMENT"], {
        window: { ...window, periodStart: cutoff, periodEnd: next },
        visibleAt: next,
      }),
      computedAt: next,
    }),
  );
  expect(result.map((row) => row.metric.value)).toEqual([0, 2000, -2000]);
});
it("fails source RPC without appending a clean zero", async () => {
  const before = await fixture.counts();
  const result = await fixture.sourceFailure(() =>
    runtime.compute({ actor, query: query(), computedAt: cutoff }),
  );
  expect(result).toMatchObject({ ok: false, error: { code: "SOURCE_UNAVAILABLE" } });
  expect(await fixture.counts()).toEqual(before);
});
it("rechecks current membership for the same signed cookie on GET and history", async () => {
  const signed = cookie();
  await fixture.membership(false);
  try {
    await request(app.getHttpServer()).get(path).query(filters()).set("Cookie", signed).expect(404);
    await request(app.getHttpServer())
      .get(`${path}/history`)
      .query(filters())
      .set("Cookie", signed)
      .expect(404);
  } finally {
    await fixture.membership(true);
  }
});
it("rejects conflicting immutable definition hashes without overwriting", async () => {
  const conflict = await fixture.conflictDefinition();
  expect(await runtime.provisionDefinitions({ actor, binding: conflict })).toMatchObject({
    ok: false,
    error: { code: "VERSION_MISMATCH" },
  });
});
it("boots health without metric configuration and returns metric503 only after auth", async () => {
  const url = process.env.METRIC_DATABASE_URL!;
  vi.stubEnv("METRIC_DATABASE_URL", "");
  const missing = await application();
  try {
    await request(missing.app.getHttpServer()).get("/api/v1/health").expect(200);
    await request(missing.app.getHttpServer()).get(path).query(filters()).expect(401);
    await request(missing.app.getHttpServer())
      .get(path)
      .query(filters())
      .set("Cookie", cookie())
      .expect(503);
    await request(missing.app.getHttpServer())
      .get(`${path}/history`)
      .query(filters())
      .set("Cookie", cookie())
      .expect(503);
  } finally {
    await missing.app.close();
    vi.stubEnv("METRIC_DATABASE_URL", url);
  }
});
it("computes preprovisioned definitions without writer credentials", async () => {
  vi.stubEnv("METRIC_DEFINITION_DATABASE_URL", "");
  const reader = new MetricRuntimeService();
  try {
    const replay = values(
      await reader.compute({
        actor,
        query: query(["PAID_REVENUE"], { inputRevision: revision }),
        computedAt: cutoff,
      }),
    );
    expect(replay[0]!.metric.value).toBe(10500);
    const history = await request(app.getHttpServer())
      .get(`${path}/history`)
      .query({ ...filters(), inputRevision: revision })
      .set("Cookie", cookie())
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].inputHash).toBe(inputHash);
    expect(await reader.provisionDefinitions({ actor, binding })).toMatchObject({
      ok: false,
      error: { code: "SOURCE_UNAVAILABLE" },
    });
  } finally {
    await reader.onModuleDestroy();
  }
});
it("fences implicit and explicit persisted reads after reset with the same binding", async () => {
  const history = await request(app.getHttpServer())
    .get(`${path}/history`)
    .query({ ...resetFilters, limit: "1" })
    .set("Cookie", cookie())
    .expect(200);
  expect(history.body.items).toHaveLength(1);
  expect(typeof history.body.nextCursor).toBe("string");
  resetCursor = history.body.nextCursor;
  await fixture.reset();
  expect(await runtime.resolve(actor, scope.storeId)).toEqual(binding);
  const before = await fixture.counts();
  await noGenerationZeroSnapshots();
  await noGenerationZeroSnapshots(revision);
  expect(await fixture.counts()).toEqual(before);
});
it("installs a restrictive source fence with a private owner RPC and no raw archive grant", async () => {
  expect(await fixture.sourceFenceSecurity()).toEqual({
    restrictive: true,
    narrow_owner: true,
    private: true,
    source_only: true,
    archive_hidden: true,
  });
});
it("rejects a signed old-generation history cursor and exact old archive replay", async () => {
  await request(app.getHttpServer())
    .get(`${path}/history`)
    .query({ ...resetFilters, limit: "1", cursor: resetCursor })
    .set("Cookie", cookie())
    .expect(404);
  expect(
    await runtime.compute({
      actor,
      query: query(["PAID_REVENUE"], { inputRevision: revision }),
      computedAt: cutoff,
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});
it("keeps current-generation paid10500 visible while excluding old revisions", async () => {
  const current = values(await runtime.compute({ actor, query: query(), computedAt: cutoff }));
  expect(current[0]!.metric.value).toBe(10500);
  expect(current[0]!.inputRevision).not.toBe(revision);
  const read = await request(app.getHttpServer())
    .get(path)
    .query(resetFilters)
    .set("Cookie", cookie())
    .expect(200);
  expect(read.body.snapshots).toHaveLength(1);
  expect(read.body.snapshots[0].inputRevision).toBe(current[0]!.inputRevision);
  const history = await request(app.getHttpServer())
    .get(`${path}/history`)
    .query(resetFilters)
    .set("Cookie", cookie())
    .expect(200);
  expect(history.body.items).toHaveLength(1);
  expect(history.body.items[0].snapshot.inputRevision).toBe(current[0]!.inputRevision);
  expect(history.body.nextCursor).toBeNull();
  await noGenerationZeroSnapshots(revision);
});
it("fails closed for owner runtime credentials", async () => {
  vi.stubEnv("METRIC_DATABASE_URL", process.env.TENANT_TEST_OPERATOR_URL!);
  vi.stubEnv("METRIC_DEFINITION_DATABASE_URL", "");
  const unsafe = new MetricRuntimeService();
  try {
    expect(await unsafe.compute({ actor, query: query(), computedAt: cutoff })).toMatchObject({
      ok: false,
      error: { code: "SOURCE_UNAVAILABLE" },
    });
    expect(await unsafe.provisionDefinitions({ actor, binding })).toMatchObject({
      ok: false,
      error: { code: "SOURCE_UNAVAILABLE" },
    });
  } finally {
    await unsafe.onModuleDestroy();
  }
});
