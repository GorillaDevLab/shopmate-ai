import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import {
  TENANT_ROLE_PERMISSIONS,
  EventEvidenceV1Schema,
  EvaluationContextSchema,
  RoutedPrimaryDecisionRunSchema,
  TenantAuditEventSchema,
  type EvaluationContext,
  type PrimaryDecisionRun,
  type TenantContext,
  type DecisionControl,
} from "@shopmate/contracts";
import {
  disconnectPrismaClient,
  createEventDecisionPool,
  createDecisionRunRepository,
  type EventDecisionPool,
} from "@shopmate/database";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  EventDecisionsApiFixture,
  binding,
  observedAt,
  window,
} from "../../../packages/database/test/helpers/event-decisions-api-fixture.mjs";
import { MetricRuntimeService } from "../src/metrics/metric-runtime.service.js";
import {
  EventDecisionUnitOfWork,
  EVENT_SECURITY_CLOCK,
  runtimeControl,
} from "../src/events/event-decision-unit-of-work.js";
import type { EventRuntimeTransaction } from "../src/events/event-decision-transaction.js";
import { loadRuntimeHistory } from "../src/decisions/decision-runtime-history.js";
import { AuditAppendRepository } from "../src/audit/audit-append.repository.js";
import { EVENT_RUNTIME_POOL_FACTORY } from "../src/events/event-runtime-pool.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  EventDecisionRuntimeService,
  type EventRuntimeResult,
} from "../src/events/event-decision-runtime.service.js";
import { AuthPermission, createAuthContext } from "../src/auth/contracts/index.js";
import { signDemoSession } from "../src/auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../src/auth/session/demo-session-cookie.js";
import request from "supertest";

if (!process.env.TENANT_TEST_OPERATOR_URL || !process.env.EVENT_DECISION_DATABASE_URL)
  throw new Error("Event decision proof requires runner-owned isolated capability URLs");
const fixture = new EventDecisionsApiFixture(process.env.TENANT_TEST_OPERATOR_URL);
const signingKey = randomBytes(48).toString("hex");
const actor: TenantContext = {
  userId: "event-runtime-human",
  merchantId: "event-runtime-merchant",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "OWNER",
  permissions: TENANT_ROLE_PERMISSIONS.OWNER,
};
const identity = createAuthContext({ ...actor, permissions: Object.values(AuthPermission) });
const path = `/api/v1/stores/${binding.storeId}/events`;
const externalTransport = vi
  .spyOn(globalThis, "fetch")
  .mockRejectedValue(new Error("External transports are prohibited in offline proof"));
let loseNextCommit = false;
function observedPool(url: string): EventDecisionPool {
  const pool = createEventDecisionPool(url);
  return {
    end: () => pool.end(),
    connect: async () => {
      const raw = await pool.connect();
      return new Proxy(raw, {
        get(target, key) {
          if (key === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (sql === "COMMIT" && loseNextCommit) {
                loseNextCommit = false;
                throw new Error("Simulated lost COMMIT acknowledgement after real SQL commit");
              }
              return result;
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}
function cookie() {
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(identity, signingKey, 3600).token}`;
}
let app: INestApplication;
let runtime: EventDecisionRuntimeService;
let metrics: MetricRuntimeService;
let uow: EventDecisionUnitOfWork;
let first: EventRuntimeResult;
let second: EventRuntimeResult;
let clockObservation: EventRuntimeResult;
function evaluation(at = observedAt, control?: DecisionControl) {
  return runtime.evaluate({
    identity,
    workspaceId: actor.workspaceId,
    storeId: binding.storeId,
    externalSkuId: "one",
    window,
    observedAt: at,
    recipientId: "event-runtime-recipient",
    ...(control ? { control } : {}),
  });
}
function time(hours: number) {
  return new Date(Date.parse(observedAt) + hours * 3600000).toISOString();
}
beforeAll(async () => {
  await fixture.initialize();
  await fixture.seed();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEMO_AUTH_EMAIL", "events@example.test");
  vi.stubEnv("DEMO_AUTH_PASSWORD", randomBytes(24).toString("hex"));
  vi.stubEnv("DEMO_AUTH_USER_ID", actor.userId);
  vi.stubEnv("DEMO_AUTH_MERCHANT_ID", actor.merchantId);
  vi.stubEnv("DEMO_SESSION_SECRET", signingKey);
  const [{ AppModule }, { configureApp }] = await Promise.all([
    import("../src/app.module.js"),
    import("../src/app.config.js"),
  ]);
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EVENT_RUNTIME_POOL_FACTORY)
    .useValue(observedPool)
    .compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  runtime = module.get(EventDecisionRuntimeService);
  metrics = module.get(MetricRuntimeService);
  uow = module.get(EventDecisionUnitOfWork);
  expect(await metrics.provisionDefinitions({ actor, binding })).toEqual({ ok: true, value: true });
});
afterAll(async () => {
  if (app) await app.close();
  await disconnectPrismaClient();
  await fixture.close();
  vi.unstubAllEnvs();
  externalTransport.mockRestore();
});
async function verifyObservedSnapshots() {
  const calculated = await metrics.compute({
    actor,
    computedAt: observedAt,
    query: {
      binding,
      window,
      visibleAt: observedAt,
      definitionVersion: "metrics-g4-v1",
      inputRevision: null,
      coverageRequests: (["INVENTORY_AVAILABLE"] as const).map((kind) => ({
        kind,
        subject: { kind: "SKU" as const, externalSkuId: "one" },
      })),
    },
  });
  expect(calculated).toMatchObject({ ok: true });
  if (!calculated.ok) throw new Error("Expected real inventory snapshots");
  expect(calculated.value.find((row) => row.metric.kind === "INVENTORY_AVAILABLE")).toMatchObject({
    status: "VERIFIED",
    metric: { value: 0 },
  });
  for (const row of calculated.value)
    expect(
      [row.computedAt, row.visibleAt, row.sourceWatermark].map((at) =>
        at === null ? null : Date.parse(at),
      ),
    ).toEqual([Date.parse(observedAt), Date.parse(observedAt), Date.parse(observedAt)]);
}
async function verifyLinkedEvidence(result: EventRuntimeResult) {
  const savedEvidence = await fixture.query("SELECT payload FROM event_evidence WHERE id=$1", [
    result.events[0]!.currentEvidence.id,
  ]);
  expect(savedEvidence.rows[0]?.payload).toMatchObject({
    dataStatus: "INSUFFICIENT",
    facts: {
      availableUnits: 0,
      inventoryStatus: "VERIFIED",
      salesUnits: null,
      supplierLeadTimeHours: null,
      estimatedHoursRemaining: null,
    },
  });
  const saved = EventEvidenceV1Schema.parse(savedEvidence.rows[0]?.payload);
  expect(
    saved.issues.filter((item) => item.code === "INVENTORY_UNKNOWN").map((item) => item.field),
  ).toEqual(["facts.estimatedHoursRemaining"]);
  const metric = await fixture.query(
    `SELECT m.id::text,m."inputHash" FROM public.event_evidence_metrics e
    JOIN public.metric_snapshots m ON m.id=e."metricSnapshotId" WHERE e."evidenceId"=$1`,
    [result.events[0]!.currentEvidence.id],
  );
  expect(metric.rows).toHaveLength(1);
  expect(metric.rows[0]).toMatchObject({
    id: saved.sourceReferences[0]!.id,
    inputHash: saved.sourceReferences[0]!.hash,
  });
}
it("commits a real observed zero-stock metric through event, Rules winner, audit and intent", async () => {
  await verifyObservedSnapshots();
  const result = (first = await evaluation());
  expect(result.decisions).toHaveLength(1);
  await verifyLinkedEvidence(result);
  expect(result.decisions[0]?.result).toMatchObject({
    status: "EVALUATED",
    labels: { reasonCodes: ["MISSING_DATA"] },
  });
  expect(result.decisions[0]).toMatchObject({
    provider: { key: "rules" },
    mode: "PRIMARY",
    effective: {
      severity: "CRITICAL",
      notificationRoute: "DAILY_BRIEF",
      evidenceSufficiency: "INSUFFICIENT_DATA",
      llmEscalation: "NO_LLM_NEEDED",
    },
    overrideReason: "INSUFFICIENT_EVIDENCE",
  });
  expect(result.decisions[0]?.effective?.reasonCodes).toContain("CONFIRMED_STOCKOUT");
  expect(await fixture.counts()).toMatchObject({
    events: 1,
    event_evidence: 1,
    decision_claims: 1,
    decision_runs: 1,
    decision_records: 6,
    audit_logs: 2,
    notification_outbox: 1,
  });
  const list = await request(app.getHttpServer()).get(path).set("Cookie", cookie()).expect(200);
  expect(list.body.items).toHaveLength(1);
});
it("authenticates both aliases and preserves immutable linked evidence and decisions", async () => {
  const event = first.events[0]!;
  await request(app.getHttpServer()).get(path).expect(401);
  for (const base of [
    path,
    `/api/v1/workspaces/${binding.workspaceId}/stores/${binding.storeId}/events`,
  ]) {
    await request(app.getHttpServer())
      .get(`${base}/${event.id}`)
      .set("Cookie", cookie())
      .expect(200);
    const history = await request(app.getHttpServer())
      .get(`${base}/${event.id}/history`)
      .set("Cookie", cookie())
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    const decisions = await request(app.getHttpServer())
      .get(`${base}/${event.id}/decisions`)
      .set("Cookie", cookie())
      .expect(200);
    expect(decisions.body.items[0].id).toBe(first.decisions[0]!.id);
    await request(app.getHttpServer())
      .get(`${base}/${event.id}/decisions/${first.decisions[0]!.id}`)
      .set("Cookie", cookie())
      .expect(200);
    const ref = event.currentEvidence;
    await request(app.getHttpServer())
      .get(`${base}/${event.id}/evidence/${ref.id}`)
      .query({ version: ref.version, hash: ref.hash, definitionVersion: ref.definitionVersion })
      .set("Cookie", cookie())
      .expect(200);
  }
});
it("rejects malformed filters and cross-scope access without evaluating", async () => {
  const before = await fixture.counts();
  await request(app.getHttpServer())
    .get(path)
    .query({ limit: "0" })
    .set("Cookie", cookie())
    .expect(400);
  await request(app.getHttpServer())
    .get("/api/v1/stores/foreign-store/events")
    .set("Cookie", cookie())
    .expect(404);
  await request(app.getHttpServer())
    .get(`/api/v1/workspaces/foreign-workspace/stores/${binding.storeId}/events`)
    .set("Cookie", cookie())
    .expect(404);
  expect(await fixture.counts()).toEqual(before);
});
it("replays the original winner and effects without appending history or repairing", async () => {
  const before = await fixture.counts();
  const replay = await evaluation();
  expect(replay.decisions).toEqual(first.decisions);
  expect(replay.events[0]?.currentEvidence).toEqual(first.events[0]?.currentEvidence);
  expect(await fixture.counts()).toEqual(before);
});
it("reuses original evidence for equivalent exact UTC timestamp spellings", async () => {
  const before = await fixture.counts();
  const result = await runtime.evaluate({
    identity,
    workspaceId: actor.workspaceId,
    storeId: binding.storeId,
    externalSkuId: "one",
    window: {
      ...window,
      periodStart: window.periodStart.replace(".000Z", "Z"),
      periodEnd: window.periodEnd.replace(".000Z", "Z"),
    },
    observedAt: observedAt.replace(".000Z", "Z"),
    recipientId: "event-runtime-recipient",
  });
  expect(result.decisions).toEqual(first.decisions);
  expect(result.events[0]?.currentEvidence).toEqual(first.events[0]?.currentEvidence);
  expect(await fixture.counts()).toEqual(before);
});
it("observes independently committed healthy stock without manufacturing a candidate", async () => {
  const before = await fixture.counts();
  await fixture.seed(time(1), 50);
  expect(await evaluation(time(1))).toEqual({ events: [], decisions: [] });
  expect(await fixture.counts()).toEqual(before);
});
it("stores a second genuine observation and retains the earlier immutable version", async () => {
  await fixture.seed(time(2), 0);
  second = await evaluation(time(2));
  expect(second.events[0]?.id).toBe(first.events[0]?.id);
  expect(second.events[0]?.revision).toBe(2);
  expect(second.events[0]?.currentEvidence.version).not.toBe(
    first.events[0]?.currentEvidence.version,
  );
  const old = first.events[0]!.currentEvidence;
  await request(app.getHttpServer())
    .get(`${path}/${first.events[0]!.id}/evidence/${old.id}`)
    .query({
      version: old.version,
      hash: old.hash,
      definitionVersion: old.definitionVersion,
    })
    .set("Cookie", cookie())
    .expect(200);
  const decisions = await request(app.getHttpServer())
    .get(`${path}/${first.events[0]!.id}/decisions`)
    .set("Cookie", cookie())
    .expect(200);
  expect(decisions.body.items).toHaveLength(2);
});
it("performs lifecycle CAS and its one audit atomically", async () => {
  const event = second.events[0]!;
  const before = await fixture.counts();
  const changed = await request(app.getHttpServer())
    .post(`${path}/${event.id}/acknowledge`)
    .send({
      expectedRevision: event.revision,
      reason: "ACKNOWLEDGED_BY_OPERATOR",
    })
    .set("Cookie", cookie())
    .expect(201);
  expect(changed.body).toMatchObject({ state: "ACKNOWLEDGED", revision: event.revision + 1 });
  await request(app.getHttpServer())
    .post(`${path}/${event.id}/acknowledge`)
    .send({
      expectedRevision: event.revision,
      reason: "ACKNOWLEDGED_BY_OPERATOR",
    })
    .set("Cookie", cookie())
    .expect(409);
  expect((await fixture.counts()).audit_logs).toBe(before.audit_logs! + 1);
});
async function finalBarrier<T>(mutate: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  const original = uow.transaction.bind(uow);
  const hook: EventDecisionUnitOfWork["transaction"] = (input, operation) =>
    original(input, async (scope) => {
      const result = await operation(scope);
      if (input.writable && input.recipientId !== null) await mutate();
      return result;
    });
  const spy = vi.spyOn(uow, "transaction").mockImplementation(hook);
  try {
    return await work();
  } finally {
    spy.mockRestore();
  }
}
async function membership(role: string, active = true, recipient = false) {
  await fixture.query(
    'UPDATE "OrganizationMember" SET role=$1,status=$2 WHERE "organizationId"=$3 AND "userId"=$4',
    [
      role,
      active ? "ACTIVE" : "INACTIVE",
      binding.organizationId,
      recipient ? "event-runtime-recipient" : actor.userId,
    ],
  );
}
it.each(["revoked", "write-role-lost", "still-writable-demotion", "recipient-revoked"] as const)(
  "rolls back all prepared writes when %s commits before the final authorization statement",
  async (change) => {
    await fixture.seed(time(3), 0);
    if (change === "still-writable-demotion") await membership("ADMIN");
    const before = await fixture.counts();
    const mutate = async () => {
      if (change === "revoked") await membership("OWNER", false);
      if (change === "write-role-lost") await membership("VIEWER");
      if (change === "still-writable-demotion") await membership("OPERATOR");
      if (change === "recipient-revoked") await membership("VIEWER", false, true);
    };
    try {
      await expect(finalBarrier(mutate, () => evaluation(time(3)))).rejects.toMatchObject({
        status: 403,
      });
      expect(await fixture.counts()).toEqual(before);
    } finally {
      await membership("OWNER");
      await membership("VIEWER", true, true);
    }
  },
);
it("rejects a connection generation reset committed before its final authorization snapshot", async () => {
  const before = await fixture.counts();
  try {
    await expect(
      finalBarrier(
        () => fixture.connectionGeneration(1),
        () => evaluation(time(3)),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await fixture.counts()).toEqual(before);
  } finally {
    await fixture.connectionGeneration(0);
  }
});
it.each(["audit_logs", "notification_outbox"] as const)(
  "rolls back the whole unit after a real %s storage failure",
  async (table) => {
    await fixture.seed(time(4), 0);
    const before = await fixture.counts();
    const role =
      table === "audit_logs" ? "shopmate_audit_writer" : "shopmate_notification_enqueuer";
    await fixture.query(
      table === "audit_logs"
        ? `REVOKE INSERT ON public.${table} FROM ${role}`
        : 'REVOKE INSERT ("intentId","organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","eventId","eventState","eventRevision",channel,"decisionRunId",route,"eventType",severity,"createdAt","notBefore","evidenceId","evidenceVersion","evidenceHash","entityKind","entityId","definitionVersion","baselineVersion","connectionGeneration","nextAttemptAt") ON public.notification_outbox FROM shopmate_notification_enqueuer',
    );
    try {
      await expect(evaluation(time(4))).rejects.toMatchObject({ status: 503 });
      expect(await fixture.counts()).toEqual(before);
    } finally {
      await fixture.query(
        table === "audit_logs"
          ? "GRANT INSERT ON public.audit_logs TO shopmate_audit_writer"
          : 'GRANT INSERT ("intentId","organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","eventId","eventState","eventRevision",channel,"decisionRunId",route,"eventType",severity,"createdAt","notBefore","evidenceId","evidenceVersion","evidenceHash","entityKind","entityId","definitionVersion","baselineVersion","connectionGeneration","nextAttemptAt") ON public.notification_outbox TO shopmate_notification_enqueuer',
      );
    }
  },
);

async function rejectAtEnqueue<T>(work: () => Promise<T>): Promise<T> {
  const original = uow.transaction.bind(uow);
  let reached = false;
  const hook: EventDecisionUnitOfWork["transaction"] = (input, operation) =>
    original(input, async (scope) => {
      if (!input.writable) return operation(scope);
      const query = scope.client.query.bind(scope.client);
      const spy = vi.spyOn(scope.client, "query").mockImplementation(async (sql, values) => {
        if (
          sql.startsWith("SELECT public.notification_scope_access") &&
          sql.includes('AS "currentUser"')
        ) {
          reached = true;
          await membership("VIEWER", false, true);
        }
        return query(sql, values);
      });
      try {
        return await operation(scope);
      } finally {
        spy.mockRestore();
      }
    });
  const spy = vi.spyOn(uow, "transaction").mockImplementation(hook);
  try {
    return await work();
  } finally {
    spy.mockRestore();
    expect(reached).toBe(true);
  }
}
it("rolls back the event, winner, audit and outbox after a real typed enqueue denial", async () => {
  const before = await fixture.counts();
  try {
    await expect(rejectAtEnqueue(() => evaluation(time(4)))).rejects.toMatchObject({ status: 503 });
    expect(await fixture.counts()).toEqual(before);
  } finally {
    await membership("VIEWER", true, true);
  }
});
it("rejects a real SECURITY_UTC deadline elapsed after all writes but before the final statement", async () => {
  const before = await fixture.counts();
  const control: DecisionControl = {
    timeDomain: "SECURITY_UTC",
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 4000).toISOString(),
  };
  await expect(
    finalBarrier(
      async () => {
        await delay(Math.max(0, Date.parse(control.deadlineAt) - Date.now() + 5));
      },
      () => evaluation(time(4), control),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(await fixture.counts()).toEqual(before);
});
it("rejects a current operator workspace assignment removed before the final statement", async () => {
  const before = await fixture.counts();
  await membership("OPERATOR");
  try {
    await expect(
      finalBarrier(
        async () => {
          await fixture.query(
            'UPDATE "WorkspaceMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
            ["INACTIVE", binding.organizationId, actor.userId],
          );
        },
        () => evaluation(time(4)),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await fixture.counts()).toEqual(before);
  } finally {
    await fixture.query(
      'UPDATE "WorkspaceMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
      ["ACTIVE", binding.organizationId, actor.userId],
    );
    await membership("OWNER");
  }
});
it("durably retries once after faults and reuses that exact winner and original effects", async () => {
  const before = await fixture.counts();
  const result = await evaluation(time(4));
  const saved = await fixture.counts();
  expect(saved.decision_runs).toBe(before.decision_runs! + 1);
  expect(saved.decision_records).toBe(before.decision_records! + 6);
  expect(saved.audit_logs).toBe(before.audit_logs! + 2);
  expect(saved.notification_outbox).toBe(before.notification_outbox! + 1);
  expect((await evaluation(time(4))).decisions).toEqual(result.decisions);
  expect(await fixture.counts()).toEqual(saved);
});
it("keeps an unobserved SKU unavailable instead of converting missing inventory into zero", async () => {
  const before = await fixture.counts();
  expect(
    await runtime.evaluate({
      identity,
      workspaceId: actor.workspaceId,
      storeId: binding.storeId,
      externalSkuId: "unobserved-sku",
      window,
      observedAt: time(4),
      recipientId: "event-runtime-recipient",
    }),
  ).toEqual({ events: [], decisions: [] });
  expect(await fixture.counts()).toEqual(before);
});
it("rejects an already published later computation instead of backdating it into event evidence", async () => {
  await fixture.seed(time(5), 0);
  const late = new Date(Date.parse(time(5)) + 60000).toISOString();
  await fixture.advance(late);
  const result = await metrics.compute({
    actor,
    computedAt: late,
    query: {
      binding,
      window,
      visibleAt: time(5),
      definitionVersion: "metrics-g4-v1",
      inputRevision: null,
      coverageRequests: [
        { kind: "INVENTORY_AVAILABLE", subject: { kind: "SKU", externalSkuId: "one" } },
      ],
    },
  });
  expect(result).toMatchObject({ ok: true });
  const before = await fixture.counts();
  await expect(evaluation(time(5))).rejects.toMatchObject({ status: 503 });
  expect(await fixture.counts()).toEqual(before);
});
it("recovers an uncertain COMMIT acknowledgement through authorized durable winner lookup", async () => {
  await fixture.seed(time(6), 0);
  const before = await fixture.counts();
  await expect(
    finalBarrier(
      async () => {
        loseNextCommit = true;
      },
      () => evaluation(time(6)),
    ),
  ).rejects.toMatchObject({ status: 503, code: "COMMIT_INDETERMINATE" });
  const committed = await fixture.counts();
  expect(committed.decision_runs).toBe(before.decision_runs! + 1);
  expect(committed.notification_outbox).toBe(before.notification_outbox! + 1);
  const result = await evaluation(time(6));
  expect(result.decisions).toHaveLength(1);
  expect(await fixture.counts()).toEqual(committed);
});
it("serializes two fresh runtime calls into one durable winner and one set of effects", async () => {
  await fixture.seed(time(7), 0);
  const before = await fixture.counts();
  const [left, right] = await Promise.all([evaluation(time(7)), evaluation(time(7))]);
  expect(left.decisions).toEqual(right.decisions);
  expect(left.events[0]?.currentEvidence).toEqual(right.events[0]?.currentEvidence);
  const after = await fixture.counts();
  expect(after.event_evidence).toBe(before.event_evidence! + 1);
  expect(after.decision_runs).toBe(before.decision_runs! + 1);
  expect(after.decision_records).toBe(before.decision_records! + 6);
  expect(after.audit_logs).toBe(before.audit_logs! + 2);
  expect(after.notification_outbox).toBe(before.notification_outbox! + 1);
});
it("rejects an uncomputed old cutoff after only the authoritative clock advances", async () => {
  await fixture.seed(time(8), 0);
  const before = await fixture.counts();
  const snapshots = await publicationState();
  await fixture.advance(time(9));
  await expect(evaluation(time(8))).rejects.toMatchObject({ status: 503 });
  expect(await fixture.counts()).toEqual(before);
  expect(await publicationState()).toEqual(snapshots);
});
async function publicationState() {
  return (
    await fixture.query(`SELECT (SELECT count(*)::int FROM metric_snapshots) AS metrics,
      (SELECT count(*)::int FROM metric_source_bundles) AS bundles,
      (SELECT count(*)::int FROM sync_host."Job") AS jobs`)
  ).rows;
}
it("publishes from the actual current clock without requiring a new source job", async () => {
  clockObservation = await evaluation(time(9));
  expect(clockObservation.decisions).toHaveLength(1);
  const saved = await fixture.query("SELECT payload FROM event_evidence WHERE id=$1", [
    clockObservation.events[0]!.currentEvidence.id,
  ]);
  expect(EventEvidenceV1Schema.parse(saved.rows[0]?.payload).observedAt).toBe(time(9));
});
it("replays an authorized persisted old observation after the clock advances", async () => {
  await fixture.advance(time(10));
  await membership("OPERATOR");
  try {
    const before = await fixture.counts();
    const snapshots = await publicationState();
    const result = await evaluation(time(9));
    expect(result.decisions).toEqual(clockObservation.decisions);
    await expect(evaluation(time(10))).rejects.toMatchObject({ status: 503 });
    expect(await fixture.counts()).toEqual(before);
    expect(await publicationState()).toEqual(snapshots);
  } finally {
    await membership("OWNER");
  }
});
async function historyContext(scope: EventRuntimeTransaction): Promise<EvaluationContext> {
  const events = uow.events(scope);
  const event = await events.detail({ actor, binding, eventId: clockObservation.events[0]!.id });
  if (!event.ok) throw new BadRequestException("History fixture event unavailable");
  const evidence = await events.evidence({
    actor,
    binding,
    eventId: event.value.id,
    reference: event.value.currentEvidence,
  });
  if (!evidence.ok) throw new BadRequestException("History fixture evidence unavailable");
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    actor,
    event: event.value,
    evidence: evidence.value,
    requestId: randomUUID(),
    correlationId: randomUUID(),
  });
}
function epochRun(context: EvaluationContext, epoch: string) {
  const original = clockObservation.decisions[0]!;
  if (original.result.status !== "EVALUATED") throw new BadRequestException();
  return RoutedPrimaryDecisionRunSchema.parse({
    ...original,
    id: randomUUID(),
    decisionKey: `history:${epoch}`,
    requestId: context.requestId,
    rulesetVersion: epoch,
    createdAt: EVENT_SECURITY_CLOCK.now(),
    result: { ...original.result, correlationId: context.correlationId, rulesetVersion: epoch },
  });
}
async function appendEpochAudit(scope: EventRuntimeTransaction, run: PrimaryDecisionRun) {
  const audit = TenantAuditEventSchema.parse({
    scopeKind: "TENANT",
    scope: scope.handle.scope,
    actor: scope.handle.actor,
    resource: { type: "RUN", id: run.id },
    result: "SUCCESS",
    occurredAt: EVENT_SECURITY_CLOCK.now(),
    sourceOccurredAt: null,
    links: {
      requestId: scope.handle.auditRequestId,
      occurrenceId: `run:${run.id}`,
      runId: run.id,
      evidenceId: run.evidence.id,
      actionId: null,
      revisionId: null,
      approvalId: null,
      executionId: null,
    },
    event: { eventType: "AGENT_RUN", redactedMetadata: { runStatus: "COMPLETED" } },
  });
  await new AuditAppendRepository().appendTenant(scope.handle, audit);
}
async function appendEpochWinner(scope: EventRuntimeTransaction, epoch: string) {
  const context = await historyContext(scope);
  const run = epochRun(context, epoch);
  const repository = createDecisionRunRepository({
    actor,
    client: scope.client,
    clock: EVENT_SECURITY_CLOCK,
    decisionKey: () => run.decisionKey,
  });
  const request = { context, decisionKey: run.decisionKey, control: scope.authority.control };
  const claim = await repository.claim(request);
  if (!claim.ok || claim.value.status !== "CLAIMED") throw new BadRequestException();
  const committed = await repository.commit(
    { ...request, commitToken: claim.value.commitToken, runs: [run] },
    async (value) => ({ ok: true, value }),
  );
  if (!committed.ok) throw new BadRequestException();
  await appendEpochAudit(scope, committed.value);
  return repository;
}
it("attributes supported persisted winners to their original immutable routing epoch", async () => {
  const history = await uow.read(actor, binding, (scope) =>
    loadRuntimeHistory(scope, uow.decisions(scope)),
  );
  expect(history.length).toBeGreaterThan(1);
  expect(history.every((entry) => entry.run.rulesetVersion === "decision-rules-v1")).toBe(true);
  expect(history.every((entry) => entry.policyVersion === "event-routing-v1")).toBe(true);
  expect(history.some((entry) => entry.eventState === "ACKNOWLEDGED")).toBe(true);
});
it.each(["decision-rules-v0", "decision-rules-unknown"])(
  "rejects otherwise complete persisted history from unsupported epoch %s",
  async (epoch) => {
    const before = await fixture.counts();
    let seeded = false;
    await expect(
      uow.transaction(
        {
          actor,
          binding,
          generation: null,
          revisions: [],
          recipientId: null,
          writable: true,
          control: runtimeControl(),
        },
        async (scope) => {
          const repository = await appendEpochWinner(scope, epoch);
          seeded = true;
          await loadRuntimeHistory(scope, repository);
          // Roll back even if the loader incorrectly accepts the unsupported winner.
          throw new BadRequestException("Unsupported history accepted");
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(seeded).toBe(true);
    expect(await fixture.counts()).toEqual(before);
  },
);
it("keeps startup and health available when the dedicated capability is absent", async () => {
  const configured = process.env.EVENT_DECISION_DATABASE_URL;
  if (!configured) throw new Error("Expected runner-provisioned capability");
  vi.stubEnv("EVENT_DECISION_DATABASE_URL", "");
  let unavailable: INestApplication | undefined;
  try {
    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/app.config.js"),
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    unavailable = module.createNestApplication();
    configureApp(unavailable);
    await unavailable.listen(0, "127.0.0.1");
    await request(unavailable.getHttpServer()).get("/api/v1/health").expect(200);
    await request(unavailable.getHttpServer()).get(path).set("Cookie", cookie()).expect(503);
    const before = await fixture.counts();
    await expect(
      module.get(EventDecisionRuntimeService).evaluate({
        identity,
        workspaceId: actor.workspaceId,
        storeId: binding.storeId,
        externalSkuId: "one",
        window,
        observedAt: time(6),
        recipientId: "event-runtime-recipient",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await fixture.counts()).toEqual(before);
  } finally {
    if (unavailable) await unavailable.close();
    vi.stubEnv("EVENT_DECISION_DATABASE_URL", configured);
  }
});
it("registers no public evaluation entry point and performs no vendor, Jev or LLM transport", async () => {
  await request(app.getHttpServer())
    .post(`${path}/evaluate`)
    .send({})
    .set("Cookie", cookie())
    .expect(404);
  expect(externalTransport).not.toHaveBeenCalled();
});
it("drains real pending SQL, closes its handle and reuses a read-only client safely", async () => {
  let completed = false;
  const stale = await uow.read(actor, binding, async (scope) => {
    void scope.client.query("SELECT pg_sleep($1)", [0.02]).then(() => {
      completed = true;
    });
    return scope;
  });
  expect(completed).toBe(true);
  await expect(stale.client.query("SELECT 1")).rejects.toMatchObject({ status: 503 });
  const before = await fixture.counts();
  await expect(
    uow.read(actor, binding, (scope) =>
      scope.client.query("UPDATE public.events SET revision=revision WHERE id=$1", [
        first.events[0]!.id,
      ]),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(await fixture.counts()).toEqual(before);
  const reused = await uow.read(actor, binding, (scope) =>
    scope.client.query("SELECT current_setting('app.user_id') AS actor"),
  );
  expect(reused.rows).toEqual([{ actor: actor.userId }]);
});
