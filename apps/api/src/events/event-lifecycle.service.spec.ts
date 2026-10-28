import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ForbiddenException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import http from "supertest";
import {
  EventRecordSchema,
  EventStateTransitionSchema,
  TenantAuditEntrySchema,
  createEventFingerprint,
  type ConnectorBinding,
  type EventRecord,
  type EventDetailQuery,
  type EventErrorCode,
  type EventStateTransition,
  type TenantAuditEntry,
  type TenantAuditEvent,
  type TenantContext,
  type TenantRole,
} from "@shopmate/contracts";
import { TenantScopeService } from "../tenant/tenant-scope.service.js";
import type { AuthContext } from "../auth/contracts/index.js";
import {
  EventLifecycleService,
  type EventLifecycleUnitOfWork,
  type LifecycleSelection,
  type LifecycleScope,
  type LifecycleHttpRequest,
  EVENT_LIFECYCLE_SERVICE,
} from "./event-lifecycle.service.js";
import { EventLifecycleController } from "./event-lifecycle.controller.js";
import { configureApp } from "../app.config.js";
import { DemoAuthModule } from "../auth/demo-auth.module.js";
import { DEMO_AUTH_CONFIG } from "../auth/demo-auth.config.js";
import { signDemoSession } from "../auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../auth/session/demo-session-cookie.js";

const at = "2026-10-29T00:00:00.000Z";
const binding: ConnectorBinding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const identity: AuthContext = { userId: "user-a", merchantId: "merchant-a", permissions: [] };
function actor(role: TenantRole = "OPERATOR"): TenantContext {
  return {
    ...identity,
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    role,
    permissions: [],
  };
}
function initialRecord(): EventRecord {
  const evidence = {
    schemaVersion: 1,
    id: "evidence/alpha.1",
    version: "version/1",
    hash: "hash/1",
    binding,
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    definitionVersion: "definition/1",
    baselineVersion: null,
  } as const;
  return EventRecordSchema.parse({
    schemaVersion: 1,
    id: "event/alpha.1",
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    fingerprint: createEventFingerprint(evidence),
    severityFloor: "HIGH",
    rulePolicyVersion: "policy/1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: at,
    lastSeenAt: at,
    currentEvidence: evidence,
  });
}
interface FixtureTx {
  record: EventRecord;
  audits: TenantAuditEntry[];
  readonly actor: TenantContext;
  readonly binding: ConnectorBinding;
}
class Fixture implements EventLifecycleUnitOfWork<FixtureTx> {
  committed = initialRecord();
  audits: TenantAuditEntry[] = [];
  readonly history = [this.committed.currentEvidence];
  membership: TenantContext | null = actor();
  ownedBinding = binding;
  active: FixtureTx | null = null;
  mutationTx: FixtureTx | null = null;
  queryRequest: EventDetailQuery | null = null;
  queryError: EventErrorCode | null = null;
  auditTx: FixtureTx | null = null;
  stagedBeforeFailure = false;
  auditFails = false;
  boundaryHook = () => {};
  queryRecord = (value: EventRecord) => value;
  mutationRecord = (value: EventRecord) => value;
  auditEntry = (value: TenantAuditEntry) => value;
  scopeActor = (value: TenantContext) => value;
  scopeBinding = (value: ConnectorBinding) => value;
  mutationError = false;
  private tail = Promise.resolve();
  readonly tenants = new TenantScopeService({
    resolve: async () => {
      const current = this.membership;
      this.boundaryHook();
      return current;
    },
  });
  readonly service = new EventLifecycleService(
    this.tenants,
    this,
    this,
    () => at,
    () => ({ requestId: "server-request", occurrenceId: "server-occurrence" }),
  );
  async run<T>(
    id: AuthContext,
    selection: LifecycleSelection,
    work: (scope: LifecycleScope<FixtureTx>) => Promise<T>,
  ): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await this.transact(id, selection, work);
    } finally {
      release();
    }
  }
  private async transact<T>(
    id: AuthContext,
    selection: LifecycleSelection,
    work: (scope: LifecycleScope<FixtureTx>) => Promise<T>,
  ): Promise<T> {
    const current = this.membership;
    if (!current || current.userId !== id.userId || current.merchantId !== id.merchantId)
      throw new NotFoundException();
    if (!["OWNER", "ADMIN", "OPERATOR"].includes(current.role)) throw new ForbiddenException();
    if (
      selection.organizationId !== this.ownedBinding.organizationId ||
      selection.workspaceId !== this.ownedBinding.workspaceId ||
      selection.storeId !== this.ownedBinding.storeId
    )
      throw new NotFoundException();
    const tx: FixtureTx = {
      record: this.committed,
      audits: [...this.audits],
      actor: current,
      binding: this.ownedBinding,
    };
    this.active = tx;
    try {
      const result = await work({
        transaction: tx,
        actor: this.scopeActor(tx.actor),
        binding: this.scopeBinding(tx.binding),
        query: { detail: async (read) => this.detail(tx, read) },
        events: { stateTransition: async (change) => this.transition(tx, change) },
      });
      this.committed = tx.record;
      this.audits = tx.audits;
      return result;
    } finally {
      this.active = null;
    }
  }
  private detail(tx: FixtureTx, read: EventDetailQuery) {
    expect(tx).toBe(this.active);
    this.queryRequest = read;
    if (this.queryError)
      return { ok: false, error: { code: this.queryError, evidenceIds: [] } } as const;
    return { ok: true, value: this.queryRecord(tx.record) } as const;
  }
  private transition(tx: FixtureTx, change: EventStateTransition) {
    expect(tx).toBe(this.active);
    this.mutationTx = tx;
    EventStateTransitionSchema.parse(change);
    if (this.mutationError || change.expectedRevision !== tx.record.revision)
      return { ok: false, error: { code: "CONFLICT", evidenceIds: [] } } as const;
    tx.record = EventRecordSchema.parse({
      ...tx.record,
      state: change.toState,
      revision: tx.record.revision + 1,
    });
    return { ok: true, value: this.mutationRecord(tx.record) } as const;
  }
  async appendTenant(tx: FixtureTx, event: TenantAuditEvent): Promise<TenantAuditEntry> {
    expect(tx).toBe(this.active);
    this.auditTx = tx;
    this.stagedBeforeFailure = tx.record.revision === this.committed.revision + 1;
    if (this.auditFails) throw new Error("fixture audit failure");
    const entry = TenantAuditEntrySchema.parse({
      ...event,
      auditId: "audit-a",
      sequence: tx.audits.length + 1,
      hashVersion: 1,
      prevHash: null,
      entryHash: "a".repeat(64),
    });
    tx.audits.push(entry);
    return this.auditEntry(entry);
  }
}
const acknowledgeBody = { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR" };
function request(body: unknown = acknowledgeBody): LifecycleHttpRequest {
  return {
    auth: identity,
    headers: {},
    rawHeaders: [],
    params: { storeId: binding.storeId, eventId: "event/alpha.1" },
    body,
  };
}
it("commits one revision and correlated audit using the active transaction", async () => {
  const f = new Fixture();
  const result = await f.service.execute("acknowledge", request());
  expect(result).toEqual({ ...initialRecord(), state: "ACKNOWLEDGED", revision: 2 });
  expect(f.auditTx).toBe(f.mutationTx);
  expect(f.audits).toHaveLength(1);
  expect(f.queryRequest).toMatchObject({
    actor: { userId: identity.userId },
    binding,
    eventId: "event/alpha.1",
  });
  expect(f.audits[0]).toMatchObject({
    actor: { actorId: identity.userId, actorKind: "USER" },
    resource: { type: "EVENT", id: "event/alpha.1" },
    occurredAt: at,
    links: { requestId: "server-request", occurrenceId: "server-occurrence", evidenceId: null },
    event: {
      eventType: "EVENT_STATE_CHANGE",
      redactedMetadata: {
        fromState: "OPEN",
        toState: "ACKNOWLEDGED",
        expectedRevision: 1,
        revision: 2,
        reason: "ACKNOWLEDGED_BY_OPERATOR",
        evidenceReference: initialRecord().currentEvidence,
      },
    },
  });
});
it("rolls back a mutation already staged before audit failure", async () => {
  const f = new Fixture();
  f.auditFails = true;
  await expect(f.service.execute("acknowledge", request())).rejects.toThrow(
    "fixture audit failure",
  );
  expect(f.stagedBeforeFailure).toBe(true);
  expect(f.committed).toEqual(initialRecord());
  expect(f.history).toEqual([initialRecord().currentEvidence]);
  expect(f.audits).toEqual([]);
});
it.each(["OWNER", "ADMIN", "OPERATOR"] as const)("allows current %s membership", async (role) => {
  const f = new Fixture();
  f.membership = actor(role);
  await f.service.execute("acknowledge", request());
  expect(f.committed.revision).toBe(2);
});
it.each(["VIEWER", "ANALYST"] as const)("rejects current read-only %s", async (role) => {
  const f = new Fixture();
  f.membership = actor(role);
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 403 });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it.each([null, actor("VIEWER"), actor("ANALYST")])(
  "rechecks changed access after boundary resolution %j",
  async (changed) => {
    const f = new Fixture();
    f.boundaryHook = () => {
      f.membership = changed;
    };
    await expect(f.service.execute("acknowledge", request())).rejects.toBeDefined();
    expect(f.mutationTx).toBeNull();
    expect(f.audits).toEqual([]);
  },
);
it.each([
  ["resolve", "MANUALLY_RESOLVED", "RESOLVED"],
  ["resolve", "CONDITION_CLEARED", "RESOLVED"],
  ["suppress", "FALSE_POSITIVE", "SUPPRESSED"],
  ["suppress", "DUPLICATE", "SUPPRESSED"],
  ["suppress", "MAINTENANCE", "SUPPRESSED"],
] as const)(
  "supports %s with %s preserving SYNC_FAILURE and evidence",
  async (operation, reason, state) => {
    const f = new Fixture();
    await f.service.execute(operation, request({ expectedRevision: 1, reason }));
    expect(f.committed.state).toBe(state);
    expect(f.committed.eventType).toBe("SYNC_FAILURE");
    expect(f.committed.currentEvidence).toEqual(initialRecord().currentEvidence);
    expect(f.history).toHaveLength(1);
  },
);
it("serializes competing expected revisions and commits exactly one", async () => {
  const f = new Fixture();
  const results = await Promise.allSettled([
    f.service.execute("acknowledge", request()),
    f.service.execute("acknowledge", request()),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.committed.revision).toBe(2);
  expect(f.audits).toHaveLength(1);
});
it("rejects missing authentication before resolving tenant access", async () => {
  const f = new Fixture();
  const { auth: unused, ...unauthenticated } = request();
  expect(unused).toEqual(identity);
  await expect(f.service.execute("acknowledge", unauthenticated)).rejects.toMatchObject({
    status: 401,
  });
  expect(f.mutationTx).toBeNull();
});
it.each([
  {},
  { expectedRevision: 0, reason: "ACKNOWLEDGED_BY_OPERATOR" },
  { expectedRevision: Number.MAX_SAFE_INTEGER + 1, reason: "ACKNOWLEDGED_BY_OPERATOR" },
  { expectedRevision: 1, reason: "FALSE_POSITIVE" },
  { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR", actor: actor("OWNER") },
  { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR", role: "OWNER" },
  { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR", binding },
  { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR", changedAt: at },
  { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR", toState: "RESOLVED" },
  { expectedRevision: 1, reason: "ACKNOWLEDGED_BY_OPERATOR", requestId: "forged" },
])("rejects strict operation body %j", async (body) => {
  const f = new Fixture();
  await expect(f.service.execute("acknowledge", request(body))).rejects.toMatchObject({
    status: 400,
  });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it.each([
  { headers: { "x-workspace-id": ["workspace-a"] } },
  { rawHeaders: ["X-Workspace-Id", "workspace-a", "x-workspace-id", "workspace-a"] },
  {
    headers: { "x-workspace-id": "workspace-a" },
    params: { ...request().params, workspaceId: "other" },
  },
  { params: { ...request().params, eventId: " event" } },
  { params: { ...request().params, storeId: "store/bad" } },
  { params: { ...request().params, role: "OWNER" } },
  { query: { state: "OPEN" } },
])("rejects forged or ambiguous scope %j", async (changes) => {
  const f = new Fixture();
  await expect(
    f.service.execute("acknowledge", { ...request(), ...changes }),
  ).rejects.toMatchObject({ status: 400 });
  expect(f.mutationTx).toBeNull();
});
it.each([
  { params: { ...request().params, storeId: "store-other" } },
  { auth: { ...identity, userId: "other" } },
  { auth: { ...identity, merchantId: "other" } },
])("rejects foreign identity/store %j", async (changes) => {
  const f = new Fixture();
  await expect(
    f.service.execute("acknowledge", { ...request(), ...changes }),
  ).rejects.toBeDefined();
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it.each(["ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"] as const)(
  "conflicts on illegal acknowledge from %s",
  async (state) => {
    const f = new Fixture();
    f.committed = EventRecordSchema.parse({ ...f.committed, state });
    await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({
      status: 409,
    });
    expect(f.mutationTx).toBeNull();
    expect(f.audits).toEqual([]);
  },
);
it("conflicts on old revision without appending audit", async () => {
  const f = new Fixture();
  f.committed = EventRecordSchema.parse({ ...f.committed, revision: 2 });
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 409 });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it("aborts on a repository CAS conflict", async () => {
  const f = new Fixture();
  f.mutationError = true;
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 409 });
  expect(f.committed).toEqual(initialRecord());
  expect(f.audits).toEqual([]);
});
it.each([
  (r: EventRecord): EventRecord => ({ ...r, id: "foreign" }),
  (r: EventRecord): EventRecord => ({ ...r, revision: 0 }),
  (r: EventRecord): EventRecord => ({ ...r, revision: 3 }),
  (r: EventRecord): EventRecord => ({ ...r, state: "RESOLVED" }),
  (r: EventRecord): EventRecord => ({
    ...r,
    currentEvidence: { ...r.currentEvidence, hash: "changed" },
  }),
])("rolls back malformed or mismatched adapter success %j", async (transform) => {
  const f = new Fixture();
  f.mutationRecord = transform;
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 503 });
  expect(f.committed).toEqual(initialRecord());
  expect(f.audits).toEqual([]);
});
it.each([
  (e: TenantAuditEntry): TenantAuditEntry => ({ ...e, sequence: 0 }),
  (e: TenantAuditEntry): TenantAuditEntry => ({ ...e, links: { ...e.links, requestId: "other" } }),
])("rolls back invalid or uncorrelated returned audit %j", async (transform) => {
  const f = new Fixture();
  f.auditEntry = transform;
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 503 });
  expect(f.stagedBeforeFailure).toBe(true);
  expect(f.committed).toEqual(initialRecord());
  expect(f.audits).toEqual([]);
});
it.each([
  (a: TenantContext): TenantContext => ({ ...a, userId: "other" }),
  (a: TenantContext): TenantContext => ({ ...a, merchantId: "other" }),
  (a: TenantContext): TenantContext => ({ ...a, workspaceId: "other" }),
  (a: TenantContext): TenantContext => ({ ...a, organizationId: "other" }),
  (a: TenantContext): TenantContext => ({ ...a, role: "VIEWER" }),
])("rejects a UoW actor that disagrees with trusted selection %j", async (transform) => {
  const f = new Fixture();
  f.scopeActor = transform;
  await expect(f.service.execute("acknowledge", request())).rejects.toBeDefined();
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it.each(["storeId", "workspaceId", "organizationId", "connectionId"] as const)(
  "rejects %s scope mismatch",
  async (key) => {
    const f = new Fixture();
    f.scopeBinding = (b) => ({ ...b, [key]: "other" });
    await expect(f.service.execute("acknowledge", request())).rejects.toBeDefined();
    expect(f.mutationTx).toBeNull();
    expect(f.audits).toEqual([]);
  },
);
it("rejects a foreign event from transaction-bound detail", async () => {
  const f = new Fixture();
  f.queryRecord = (r) => ({ ...r, id: "other" });
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 404 });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});

const httpKey = randomBytes(48).toString("hex");
const httpPath = "/api/v1/stores/store-a/events/event%2Falpha.1";
let app: INestApplication;
let httpFixture = new Fixture();
function cookie() {
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(identity, httpKey, 3600).token}`;
}
async function createHttpApp() {
  const module = await Test.createTestingModule({
    imports: [DemoAuthModule],
    controllers: [EventLifecycleController],
    providers: [
      {
        provide: EVENT_LIFECYCLE_SERVICE,
        useValue: {
          execute: (
            operation: Parameters<Fixture["service"]["execute"]>[0],
            incoming: LifecycleHttpRequest,
          ) => httpFixture.service.execute(operation, incoming),
        },
      },
    ],
  })
    .overrideProvider(DEMO_AUTH_CONFIG)
    .useValue({ sessionSecret: httpKey })
    .compile();
  const instance = module.createNestApplication();
  configureApp(instance);
  await instance.init();
  return instance;
}
beforeAll(async () => {
  app = await createHttpApp();
});
afterAll(async () => {
  await app.close();
});
it.each(["acknowledge", "resolve", "suppress"])(
  "HTTP %s requires the existing signed-session guard",
  async (operation) => {
    httpFixture = new Fixture();
    await http(app.getHttpServer())
      .post(`${httpPath}/${operation}`)
      .send(acknowledgeBody)
      .expect(401);
    expect(httpFixture.mutationTx).toBeNull();
  },
);
it.each([
  ["acknowledge", "ACKNOWLEDGED_BY_OPERATOR", "ACKNOWLEDGED"],
  ["resolve", "MANUALLY_RESOLVED", "RESOLVED"],
  ["suppress", "MAINTENANCE", "SUPPRESSED"],
])("HTTP %s commits only its route-selected target", async (operation, reason, state) => {
  httpFixture = new Fixture();
  const response = await http(app.getHttpServer())
    .post(`${httpPath}/${operation}`)
    .set("Cookie", cookie())
    .send({ expectedRevision: 1, reason })
    .expect(201);
  expect(response.body).toMatchObject({ id: "event/alpha.1", state, revision: 2 });
  expect(httpFixture.audits).toHaveLength(1);
});
it("HTTP independently validates a strict mutation body", async () => {
  httpFixture = new Fixture();
  await http(app.getHttpServer())
    .post(`${httpPath}/acknowledge`)
    .set("Cookie", cookie())
    .send({ ...acknowledgeBody, actor: actor("OWNER") })
    .expect(400);
  expect(httpFixture.mutationTx).toBeNull();
});
it("HTTP accepts matching workspace header/path and rejects disagreement", async () => {
  httpFixture = new Fixture();
  const scoped = "/api/v1/workspaces/workspace-a/stores/store-a/events/event%2Falpha.1/acknowledge";
  await http(app.getHttpServer())
    .post(scoped)
    .set("Cookie", cookie())
    .set("X-Workspace-Id", "foreign")
    .send(acknowledgeBody)
    .expect(400);
  expect(httpFixture.mutationTx).toBeNull();
  await http(app.getHttpServer())
    .post(scoped)
    .set("Cookie", cookie())
    .set("X-Workspace-Id", "workspace-a")
    .send(acknowledgeBody)
    .expect(201);
  expect(httpFixture.audits).toHaveLength(1);
});
it("HTTP rejects revoked membership between boundary and write unit", async () => {
  httpFixture = new Fixture();
  httpFixture.boundaryHook = () => {
    httpFixture.membership = null;
  };
  await http(app.getHttpServer())
    .post(`${httpPath}/acknowledge`)
    .set("Cookie", cookie())
    .send(acknowledgeBody)
    .expect(404);
  expect(httpFixture.mutationTx).toBeNull();
  expect(httpFixture.audits).toEqual([]);
});
it("conflicts before mutation when the next revision would overflow", async () => {
  const f = new Fixture();
  f.committed = EventRecordSchema.parse({ ...f.committed, revision: Number.MAX_SAFE_INTEGER });
  await expect(
    f.service.execute(
      "acknowledge",
      request({ expectedRevision: Number.MAX_SAFE_INTEGER, reason: "ACKNOWLEDGED_BY_OPERATOR" }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it.each([
  ["FORBIDDEN", 403],
  ["NOT_FOUND", 404],
  ["SCOPE_MISMATCH", 404],
  ["CONFLICT", 409],
  ["VERSION_MISMATCH", 409],
  ["SOURCE_UNAVAILABLE", 503],
] as const)("maps detail %s to %s without mutation or audit", async (code, status) => {
  const f = new Fixture();
  f.queryError = code;
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it("fails closed on malformed detail adapter output", async () => {
  const f = new Fixture();
  f.queryRecord = (r) => ({ ...r, revision: 0 });
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 503 });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it.each(["resolve", "suppress"] as const)(
  "allows %s after acknowledgement at its current revision",
  async (operation) => {
    const f = new Fixture();
    await f.service.execute("acknowledge", request());
    const reason = operation === "resolve" ? "CONDITION_CLEARED" : "DUPLICATE";
    await f.service.execute(operation, request({ expectedRevision: 2, reason }));
    expect(f.committed.revision).toBe(3);
    expect(f.audits).toHaveLength(2);
    expect(f.audits[1]?.event).toMatchObject({
      redactedMetadata: { fromState: "ACKNOWLEDGED", expectedRevision: 2, revision: 3 },
    });
  },
);
it("does not allow broad permissions to elevate a read-only current role", async () => {
  const f = new Fixture();
  f.membership = { ...actor("VIEWER"), permissions: ["products:write", "actions:approve"] };
  await expect(f.service.execute("acknowledge", request())).rejects.toMatchObject({ status: 403 });
  expect(f.mutationTx).toBeNull();
  expect(f.audits).toEqual([]);
});
it("generates audit request and occurrence identifiers server-side by default", async () => {
  const f = new Fixture();
  const service = new EventLifecycleService(f.tenants, f, f, () => at);
  await service.execute("acknowledge", { ...request(), headers: { "x-request-id": "untrusted" } });
  const links = f.audits[0]?.links;
  expect(links?.requestId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(links?.occurrenceId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(links?.requestId).not.toBe("untrusted");
  expect(links?.requestId).not.toBe(links?.occurrenceId);
});
