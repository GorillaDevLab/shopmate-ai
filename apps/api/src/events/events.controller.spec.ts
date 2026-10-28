import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  createEventFingerprint,
  EventRecordSchema,
  EventEvidenceRecordSchema,
  DecisionRunSchema,
  type DecisionRun,
  type DecisionPortResult,
  type EventQueryPort,
  type EventListQuery,
  type EventEvidenceQuery,
  type TenantContext,
} from "@shopmate/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { configureApp } from "../app.config.js";
import { DemoAuthModule } from "../auth/demo-auth.module.js";
import { DEMO_AUTH_CONFIG } from "../auth/demo-auth.config.js";
import { signDemoSession } from "../auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../auth/session/demo-session-cookie.js";
import { TenantScopeService } from "../tenant/tenant-scope.service.js";
import { TENANT_MEMBERSHIP_REPOSITORY } from "../tenant/tenant-membership.repository.js";
import { EventsController } from "./events.controller.js";
import {
  EVENT_QUERY_PORT,
  EVENT_DECISION_SUMMARY_READER,
  EVENT_STORE_OWNERSHIP_RESOLVER,
  EventQueryService,
  type EventDecisionSummaryReader,
  type EventDecisionSummaryQuery,
} from "./event-query.service.js";

const key = randomBytes(48).toString("hex");
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const instant = "2026-10-25T01:00:00Z";
const reference = {
  schemaVersion: 1,
  id: "evidence-a",
  version: "evidence-v2",
  hash: "hash-a-v2",
  binding,
  eventType: "SYNC_FAILURE",
  entity: { kind: "CONNECTION", connectionId: binding.connectionId },
  definitionVersion: "metrics-v1",
  baselineVersion: null,
} as const;
const event = EventRecordSchema.parse({
  schemaVersion: 1,
  id: "event-a",
  binding,
  eventType: "SYNC_FAILURE",
  entity: reference.entity,
  fingerprint: createEventFingerprint(reference),
  severityFloor: "HIGH",
  rulePolicyVersion: "policy-v1",
  state: "OPEN",
  revision: 2,
  firstSeenAt: instant,
  lastSeenAt: instant,
  currentEvidence: reference,
});
const oldReference = { ...reference, version: "evidence-v1", hash: "hash-a-v1" };
const period = {
  periodStart: "2026-10-25T00:00:00Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const sourceReference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "source-a",
  version: "source-v1",
  hash: "source-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: instant,
  measure: null,
};
const oldEvidence = EventEvidenceRecordSchema.parse({
  reference: oldReference,
  evidence: {
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: instant,
    sourceWatermark: null,
    dataStatus: "UNAVAILABLE",
    sampleSize: 0,
    coverageBasisPoints: 0,
    issues: [{ code: "NOT_SYNCHRONIZED", field: "inventory", evidenceIds: ["source-a"] }],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [sourceReference],
    eventType: "SYNC_FAILURE",
    entity: reference.entity,
    facts: {
      lastSuccessAt: null,
      lagSeconds: null,
      typedErrorCode: "TEMPORARY",
      affectedResourceKind: "INVENTORY",
    },
  },
});
const evidenceFilters = {
  version: oldReference.version,
  hash: oldReference.hash,
  definitionVersion: oldReference.definitionVersion,
};
const ignoredLabels = {
  severity: "LOW",
  notificationRoute: "IGNORE",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "INSUFFICIENT_DATA",
  attentionPriority: "LOW_PRIORITY",
  reasonCodes: ["SYNC_FAILURE"],
} as const;
const effectiveLabels = {
  ...ignoredLabels,
  severity: "HIGH",
  notificationRoute: "NOTIFY_NOW",
} as const;
const oldRun = DecisionRunSchema.parse({
  schemaVersion: 1,
  id: "decision-v1",
  eventId: event.id,
  decisionKey: "key-v1",
  requestId: "request-v1",
  evidence: oldReference,
  provider: { key: "rules", version: "v1", supportedInputVersions: [1] },
  rulesetVersion: "rules-v1",
  mode: "PRIMARY",
  fallbackOf: null,
  result: {
    schemaVersion: 1,
    status: "EVALUATED",
    correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
    rulesetVersion: "rules-v1",
    labels: ignoredLabels,
    confidenceMetadata: null,
  },
  latencyMs: 1,
  createdAt: instant,
  effective: effectiveLabels,
  overrideReason: "SEVERITY_FLOOR",
});
const newRun = DecisionRunSchema.parse({
  ...oldRun,
  id: "decision-v2",
  decisionKey: "key-v2",
  evidence: reference,
  rulesetVersion: "rules-v2",
  result: { ...oldRun.result, rulesetVersion: "rules-v2", labels: effectiveLabels },
  effective: effectiveLabels,
  overrideReason: null,
});
class VersionedDecisionFixture implements EventDecisionSummaryReader {
  runs: readonly DecisionRun[] = [];
  async read(
    query: EventDecisionSummaryQuery,
  ): Promise<DecisionPortResult<readonly DecisionRun[]>> {
    if (
      !isDeepStrictEqual(query.binding, binding) ||
      query.actor.organizationId !== binding.organizationId ||
      query.actor.workspaceId !== binding.workspaceId
    )
      return { ok: false as const, code: "SCOPE_MISMATCH" as const };
    return success(
      this.runs.filter(
        (run) =>
          run.eventId === query.eventId &&
          (query.decisionId === null || run.id === query.decisionId),
      ),
    );
  }
}
const decisions = new VersionedDecisionFixture();
const member = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "VIEWER",
};
const membership = vi.fn();
const ownership = vi.fn();
const list = vi.fn();
const detail = vi.fn();
const evidence = vi.fn();
const history = vi.fn();
const eventPort: EventQueryPort = { list, detail, evidence, history };
const path = "/api/v1/stores/store-a/events";
let app: INestApplication;

function cookie(userId = "user-a") {
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession({ userId, merchantId: "merchant-a", permissions: [] }, key, 3600).token}`;
}
function success<T>(value: T) {
  return { ok: true as const, value };
}
function get(suffix = "") {
  return request(app.getHttpServer())
    .get(path + suffix)
    .set("Cookie", cookie());
}
async function createApp() {
  const module = await Test.createTestingModule({
    imports: [DemoAuthModule],
    controllers: [EventsController],
    providers: [
      EventQueryService,
      TenantScopeService,
      { provide: TENANT_MEMBERSHIP_REPOSITORY, useValue: { resolve: membership } },
      { provide: EVENT_STORE_OWNERSHIP_RESOLVER, useValue: { resolve: ownership } },
      { provide: EVENT_QUERY_PORT, useValue: eventPort },
      { provide: EVENT_DECISION_SUMMARY_READER, useValue: decisions },
    ],
  })
    .overrideProvider(DEMO_AUTH_CONFIG)
    .useValue({ sessionSecret: key })
    .compile();
  const instance = module.createNestApplication();
  configureApp(instance);
  await instance.init();
  return instance;
}
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
  ownership.mockImplementation(async (_actor: TenantContext, storeId: string) =>
    storeId === binding.storeId ? binding : null,
  );
  list.mockResolvedValue(success({ items: [event], nextCursor: null }));
  detail.mockResolvedValue(success(event));
  evidence.mockImplementation(async (query: EventEvidenceQuery) =>
    success({ ...oldEvidence, reference: query.reference }),
  );
  history.mockResolvedValue(success({ items: [oldEvidence], nextCursor: null }));
  decisions.runs = [oldRun, newRun];
});

it("requires the existing signed session guard", async () => {
  await request(app.getHttpServer()).get(path).expect(401);
  expect(membership).not.toHaveBeenCalled();
});
it("returns an explicit empty page for a valid query", async () => {
  list.mockResolvedValue(success({ items: [], nextCursor: null }));
  const response = await get().expect(200);
  expect(response.body).toEqual({ status: "EMPTY", items: [], nextCursor: null });
});
it("uses fresh membership and current server-owned store binding", async () => {
  const response = await get().expect(200);
  expect(response.body.items).toEqual([event]);
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: expect.objectContaining({
        userId: member.userId,
        permissions: expect.arrayContaining(["tenant:read"]),
      }),
      binding,
      eventTypes: [],
      states: [],
      entity: null,
      cursor: null,
      limit: 20,
    }),
  );
  membership.mockResolvedValue(null);
  await get().expect(404);
  expect(list).toHaveBeenCalledTimes(1);
});
it("requires all existing business evidence read permissions before ownership", async () => {
  vi.spyOn(app.get(TenantScopeService), "resolve").mockResolvedValue({
    ...member,
    role: "VIEWER",
    permissions: ["tenant:read"],
  });
  await get().expect(403);
  expect(ownership).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
it("returns 404 for foreign stores even for critical severity", async () => {
  ownership.mockResolvedValue({ ...binding, storeId: "foreign-store" });
  await get().expect(404);
  expect(list).not.toHaveBeenCalled();
});
it.each([
  { type: "unknown" },
  { state: "IGNORE" },
  { limit: "101" },
  { limit: "01" },
  { limit: "1e2" },
  { cursor: "" },
  { severity: "CRITICAL" },
  { storeId: "foreign" },
  { type: ["SYNC_FAILURE", "ROAS_DROP"] },
  { state: ["OPEN", "OPEN"] },
])("rejects non-whitelisted or malformed filters %j before membership", async (query) => {
  await get().query(query).expect(400);
  expect(membership).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

it("passes stable opaque cursors and strict type/state filters without reordering", async () => {
  list.mockResolvedValueOnce(success({ items: [event], nextCursor: "stable-next" }));
  const first = await get().query({ type: "SYNC_FAILURE", state: "OPEN", limit: "1" }).expect(200);
  expect(first.body.nextCursor).toBe("stable-next");
  list.mockResolvedValueOnce(success({ items: [], nextCursor: null }));
  const second = await get()
    .query({ type: "SYNC_FAILURE", state: "OPEN", limit: "1", cursor: "stable-next" })
    .expect(200);
  expect(second.body.status).toBe("EMPTY");
  expect(list).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cursor: "stable-next",
      limit: 1,
      eventTypes: ["SYNC_FAILURE"],
      states: ["OPEN"],
    }),
  );
});
it.each([
  { items: [event, event], nextCursor: null },
  { items: [], nextCursor: "cursor" },
  { items: [{ ...event, revision: 0 }], nextCursor: null },
  { items: [event], nextCursor: 123 },
  { items: [{ ...event, binding: { ...binding, storeId: "foreign" } }], nextCursor: null },
  { items: [event], nextCursor: null, privateData: "secret" },
])("rejects malformed adapter pages without exposing private data %j", async (page) => {
  list.mockResolvedValue(success(page));
  const response = await get().expect(503);
  expect(response.body.status).toBe("UNAVAILABLE");
  expect(JSON.stringify(response.body)).not.toContain("secret");
});
it("rejects valid adapter records that disagree with filters or full connection binding", async () => {
  await get().query({ state: "RESOLVED" }).expect(503);
  await get().query({ type: "ROAS_DROP" }).expect(503);
  ownership.mockResolvedValue({ ...binding, externalStoreId: "changed-binding" });
  await get().expect(503);
});
it.each([
  "INVALID_INPUT",
  "FORBIDDEN",
  "NOT_FOUND",
  "SCOPE_MISMATCH",
  "SOURCE_UNAVAILABLE",
] as const)("maps typed adapter failure %s and removes evidence IDs", async (code) => {
  list.mockResolvedValue({ ok: false, error: { code, evidenceIds: ["private-evidence"] } });
  const status = {
    INVALID_INPUT: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    SCOPE_MISMATCH: 404,
    SOURCE_UNAVAILABLE: 503,
  }[code];
  const response = await get().expect(status);
  expect(JSON.stringify(response.body)).not.toContain("private-evidence");
});
it("masks thrown adapter and ownership errors", async () => {
  list.mockRejectedValue(new Error("private database credentials"));
  const response = await get().expect(503);
  expect(JSON.stringify(response.body)).not.toContain("private");
  ownership.mockRejectedValue(new Error("private connection"));
  await get().expect(503);
});
it("rejects repeated, malformed or conflicting workspace headers", async () => {
  await get()
    .set({ "X-Workspace-Id": ["workspace-a", "workspace-a"] })
    .expect(400);
  await get().set("X-Workspace-Id", "workspace-a,workspace-a").expect(400);
  await request(app.getHttpServer())
    .get("/api/v1/workspaces/workspace-a/stores/store-a/events")
    .set("Cookie", cookie())
    .set("X-Workspace-Id", "workspace-b")
    .expect(400);
  expect(membership).not.toHaveBeenCalled();
});
it("returns 404 for a valid foreign workspace and accepts matching path/header scope", async () => {
  await get().set("X-Workspace-Id", "workspace-b").expect(404);
  await request(app.getHttpServer())
    .get("/api/v1/workspaces/workspace-a/stores/store-a/events")
    .set("Cookie", cookie())
    .set("X-Workspace-Id", "workspace-a")
    .expect(200);
  expect(membership).toHaveBeenLastCalledWith("user-a", "merchant-a", "workspace-a");
});
it("rejects request bodies and missing direct-call authentication", async () => {
  await get().send({ state: "OPEN" }).expect(400);
  expect(membership).not.toHaveBeenCalled();
  await expect(
    app.get(EventQueryService).list({
      headers: {},
      rawHeaders: [],
      params: { storeId: "store-a" },
      query: {},
    }),
  ).rejects.toMatchObject({ status: 401 });
});

it("reads exact event identity and preserves immutable event facts", async () => {
  const response = await get("/event-a").expect(200);
  expect(response.body).toEqual({ status: "AVAILABLE", event });
  expect(detail).toHaveBeenCalledWith(expect.objectContaining({ binding, eventId: "event-a" }));
  detail.mockResolvedValue(success({ ...event, id: "unrelated" }));
  await get("/event-a").expect(503);
});
it("returns historical evidence with nullable quality and source versions unchanged", async () => {
  const response = await get("/event-a/history").query({ limit: "1" }).expect(200);
  expect(response.body).toEqual({ status: "AVAILABLE", items: [oldEvidence], nextCursor: null });
  const byId = await get("/event-a/evidence/evidence-a").query(evidenceFilters).expect(200);
  expect(byId.body).toEqual({ status: "AVAILABLE", ...oldEvidence });
  expect(evidence).toHaveBeenCalledWith(
    expect.objectContaining({ binding, eventId: "event-a", reference: oldReference }),
  );
  expect(event.currentEvidence.version).toBe("evidence-v2");
});
it("forwards history pagination and returns honest empty history", async () => {
  history.mockResolvedValueOnce(success({ items: [oldEvidence], nextCursor: "history-next" }));
  await get("/event-a/history").query({ limit: "1" }).expect(200);
  history.mockResolvedValueOnce(success({ items: [], nextCursor: null }));
  const response = await get("/event-a/history")
    .query({ cursor: "history-next", limit: "1" })
    .expect(200);
  expect(response.body.status).toBe("EMPTY");
  expect(history).toHaveBeenLastCalledWith(
    expect.objectContaining({ eventId: "event-a", cursor: "history-next", limit: 1 }),
  );
});
it.each([
  ["/event-a", { limit: "1" }],
  ["/event-a/history", { type: "SYNC_FAILURE" }],
  ["/event-a/history", { limit: "0" }],
  ["/event-a/evidence/evidence-a", {}],
  ["/event-a/evidence/evidence-a", { ...evidenceFilters, binding: "foreign" }],
  ["/event-a/evidence/evidence-a", { ...evidenceFilters, version: ["v1", "v2"] }],
  ["/event-a/evidence/%20hidden", evidenceFilters],
])("rejects invalid historical read %s %j before membership", async (suffix, filters) => {
  await get(suffix).query(filters).expect(400);
  expect(membership).not.toHaveBeenCalled();
});
it("rejects evidence responses with the wrong immutable reference", async () => {
  evidence.mockResolvedValue(success({ ...oldEvidence, reference }));
  await get("/event-a/evidence/evidence-a").query(evidenceFilters).expect(503);
});
it("rejects unrelated history evidence and duplicate immutable references", async () => {
  const unrelated = {
    ...oldEvidence,
    reference: { ...oldReference, baselineVersion: "different" },
    evidence: { ...oldEvidence.evidence, baselineVersion: "different" },
  };
  history.mockResolvedValueOnce(success({ items: [unrelated], nextCursor: null }));
  await get("/event-a/history").expect(503);
  history.mockResolvedValueOnce(success({ items: [oldEvidence, oldEvidence], nextCursor: null }));
  await get("/event-a/history").expect(503);
});
it("returns 404 for unknown event or immutable evidence references", async () => {
  detail.mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND", evidenceIds: [] } });
  await get("/missing/history").expect(404);
  expect(history).not.toHaveBeenCalled();
  evidence.mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND", evidenceIds: [] } });
  await get("/event-a/evidence/evidence-a").query(evidenceFilters).expect(404);
});

it("reads versioned decision summaries with original suggested/effective labels", async () => {
  const response = await get("/event-a/decisions").expect(200);
  expect(response.body).toEqual({ status: "AVAILABLE", items: [oldRun, newRun] });
  expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ reference: oldReference }));
  expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ reference }));
  const old = await get("/event-a/decisions/decision-v1").expect(200);
  expect(old.body).toEqual({ status: "AVAILABLE", decision: oldRun });
  expect(old.body.decision.result.labels.notificationRoute).toBe("IGNORE");
  expect(old.body.decision.effective.notificationRoute).toBe("NOTIFY_NOW");
  expect(old.body.decision.rulesetVersion).toBe("rules-v1");
});
it("keeps sync failure facts visible when a decision suggests IGNORE", async () => {
  decisions.runs = [oldRun];
  expect((await get().expect(200)).body.items).toEqual([event]);
  expect((await get("/event-a").expect(200)).body.event).toEqual(event);
  expect((await get("/event-a/decisions").expect(200)).body.items).toEqual([oldRun]);
  expect(event.severityFloor).toBe("HIGH");
});
it("distinguishes empty decision history, unknown decision ID, and unavailable reader", async () => {
  decisions.runs = [];
  expect((await get("/event-a/decisions").expect(200)).body).toEqual({
    status: "EMPTY",
    items: [],
  });
  await get("/event-a/decisions/unknown").expect(404);
  vi.spyOn(decisions, "read").mockRejectedValue(new Error("private provider failure"));
  const response = await get("/event-a/decisions").expect(503);
  expect(response.body.status).toBe("UNAVAILABLE");
  expect(JSON.stringify(response.body)).not.toContain("private");
  await get("/event-a").expect(200);
});
it.each([
  { ...oldRun, id: "" },
  { ...oldRun, eventId: "foreign-event" },
  { ...oldRun, evidence: { ...oldReference, hash: "forged-hash" } },
  { ...oldRun, evidence: { ...oldReference, definitionVersion: "forged-version" } },
  { ...oldRun, rulesetVersion: "wrong-version" },
  { ...oldRun, evidence: { ...oldReference, binding: { ...binding, storeId: "foreign-store" } } },
])("rejects malformed, foreign or uncorrelated decision output %j", async (run) => {
  vi.spyOn(decisions, "read").mockResolvedValue(success([run]));
  evidence.mockResolvedValue(success(oldEvidence));
  await get("/event-a/decisions").expect(503);
});
it("rejects mismatched decision IDs and duplicate histories", async () => {
  vi.spyOn(decisions, "read").mockResolvedValueOnce(success([newRun]));
  await get("/event-a/decisions/decision-v1").expect(503);
  decisions.runs = [oldRun, oldRun];
  await get("/event-a/decisions").expect(503);
});
it.each(["/event-a/decisions", "/event-a/decisions/decision-v1"])(
  "strictly rejects unsupported decision filters for %s",
  async (suffix) => {
    await get(suffix).query({ rulesetVersion: "latest" }).expect(400);
    expect(membership).not.toHaveBeenCalled();
  },
);

it.each([
  "",
  "/event-a",
  "/event-a/history",
  "/event-a/evidence/evidence-a",
  "/event-a/decisions",
  "/event-a/decisions/decision-v1",
])("enforces current authentication, evidence permissions and ownership on %s", async (suffix) => {
  const filters = suffix.includes("/evidence/") ? evidenceFilters : {};
  await request(app.getHttpServer())
    .get(path + suffix)
    .query(filters)
    .expect(401);
  const scope = vi.spyOn(app.get(TenantScopeService), "resolve");
  scope.mockResolvedValueOnce({ ...member, role: "VIEWER", permissions: [] });
  await get(suffix).query(filters).expect(403);
  expect(ownership).not.toHaveBeenCalled();
  ownership.mockResolvedValueOnce(null);
  await get(suffix).query(filters).expect(404);
  membership.mockResolvedValueOnce(null);
  await get(suffix).query(filters).expect(404);
  expect(list).not.toHaveBeenCalled();
  expect(detail).not.toHaveBeenCalled();
  expect(evidence).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});
it("keeps unavailable historical decisions explicit without fabricating labels", async () => {
  const unavailableRun = DecisionRunSchema.parse({
    ...oldRun,
    effective: null,
    overrideReason: null,
    result: {
      schemaVersion: 1,
      status: "UNAVAILABLE",
      correlationId: oldRun.result.correlationId,
      code: "PROVIDER_FAILURE",
    },
  });
  decisions.runs = [unavailableRun];
  const response = await get("/event-a/decisions/decision-v1").expect(200);
  expect(response.body.decision).toEqual(unavailableRun);
  expect(response.body.decision.result.labels).toBeUndefined();
  expect(response.body.decision.effective).toBeNull();
});
it.each(["INVALID_INPUT", "FORBIDDEN", "SCOPE_MISMATCH", "UNAVAILABLE", "HASH_MISMATCH"] as const)(
  "maps decision read-model failure %s without source details",
  async (code) => {
    vi.spyOn(decisions, "read").mockResolvedValue({ ok: false, code });
    const status = {
      INVALID_INPUT: 400,
      FORBIDDEN: 403,
      SCOPE_MISMATCH: 404,
      UNAVAILABLE: 503,
      HASH_MISMATCH: 503,
    }[code];
    await get("/event-a/decisions").expect(status);
    expect(evidence).not.toHaveBeenCalled();
  },
);
it("rejects malformed ownership and resolved identity mismatch", async () => {
  ownership.mockResolvedValueOnce({ ...binding, connectionId: null });
  await get().expect(503);
  vi.spyOn(app.get(TenantScopeService), "resolve").mockResolvedValueOnce({
    ...member,
    userId: "different-user",
    role: "VIEWER",
    permissions: [],
  });
  await get().expect(503);
  expect(list).not.toHaveBeenCalled();
});
it("preserves port receiver and prevents a mutated request from authorizing leaked data", async () => {
  list.mockImplementationOnce(async function (this: EventQueryPort, query: EventListQuery) {
    expect(this).toBe(eventPort);
    const changed = { ...query.binding, externalStoreId: "foreign-external" };
    Object.assign(query, { binding: changed });
    const forged = EventRecordSchema.parse({
      ...event,
      binding: changed,
      currentEvidence: { ...reference, binding: changed },
    });
    return success({ items: [forged], nextCursor: null });
  });
  await get().expect(503);
});
it("forwards opaque cursor replay scope for semantic port validation", async () => {
  list.mockImplementationOnce(async (query: EventListQuery) => {
    expect(query).toMatchObject({
      cursor: "opaque-port-cursor",
      eventTypes: ["ROAS_DROP"],
      binding,
    });
    return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
  });
  await get().query({ type: "ROAS_DROP", cursor: "opaque-port-cursor" }).expect(400);
});
