import { expect, it, vi } from "vitest";
import type { AuditTransactionClient } from "../audit/audit-append.repository.js";
import {
  createEventFingerprint,
  createNotificationIntentKey,
  NotificationEnqueueRequestSchema,
  type NotificationEnqueueRequest,
  type SecurityClock,
} from "@shopmate/contracts";
import {
  NotificationEnqueueRepository,
  type BoundNotificationTransaction,
} from "./notification-enqueue.repository.js";

const instant = "2026-11-03T00:00:00.000Z";
const later = "2026-11-03T00:01:00.000Z";
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external/a .1",
};
const period = {
  periodStart: "2026-11-02T23:00:00.000Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
};
const entity = { kind: "CONNECTION", connectionId: binding.connectionId } as const;
const reference = {
  schemaVersion: 1,
  id: "evidence/a .1",
  version: "v1",
  hash: "hash-a",
  binding,
  eventType: "SYNC_FAILURE",
  entity,
  definitionVersion: "metrics-v1",
  baselineVersion: null,
} as const;
const labels = {
  severity: "LOW",
  notificationRoute: "DAILY_BRIEF",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "NORMAL_PRIORITY",
  reasonCodes: ["NO_MATERIAL_CHANGE"],
};
const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "VIEWER",
  permissions: ["tenant:read"],
};
const clock: SecurityClock = { timeDomain: "SECURITY_UTC", now: () => instant };
function evidenceFixture() {
  const source = {
    kind: "NORMALIZED_AGGREGATE",
    id: "source-a",
    version: "v1",
    hash: "source-hash",
    binding,
    definitionVersion: "metrics-v1",
    period,
    observedAt: instant,
    measure: null,
  };
  return {
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: instant,
    sourceWatermark: instant,
    dataStatus: "VERIFIED",
    sampleSize: 1,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    eventType: "SYNC_FAILURE",
    entity,
    sourceReferences: [source],
    facts: {
      lastSuccessAt: instant,
      lagSeconds: 0,
      typedErrorCode: "TEMPORARY",
      affectedResourceKind: "INVENTORY",
    },
  };
}
function eventFixture() {
  return {
    schemaVersion: 1,
    id: "event/a .1",
    binding,
    eventType: "SYNC_FAILURE",
    entity,
    fingerprint: createEventFingerprint(reference),
    severityFloor: "LOW",
    rulePolicyVersion: "policy-v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentEvidence: reference,
  };
}
function runFixture() {
  return {
    schemaVersion: 1,
    id: "run/a .1",
    eventId: "event/a .1",
    decisionKey: "decision-v1",
    requestId: "logical/request .1",
    evidence: reference,
    provider: { key: "rules", version: "v1", supportedInputVersions: [1] },
    rulesetVersion: "rules-v1",
    mode: "PRIMARY",
    fallbackOf: null,
    effective: labels,
    overrideReason: null,
    latencyMs: 1,
    createdAt: instant,
    result: {
      schemaVersion: 1,
      status: "EVALUATED",
      correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
      rulesetVersion: "rules-v1",
      labels,
      confidenceMetadata: null,
    },
  };
}
function requestFixture(): NotificationEnqueueRequest {
  const identity = {
    recipient: { binding, userId: "recipient-a" },
    eventId: "event/a .1",
    eventState: "OPEN",
    eventRevision: 1,
    channel: "IN_APP",
  } as const;
  return NotificationEnqueueRequestSchema.parse({
    intent: {
      schemaVersion: 1,
      id: "intent/a .1",
      ...identity,
      evidence: reference,
      decisionRunId: "run/a .1",
      route: "DAILY_BRIEF",
      createdAt: instant,
      notBefore: instant,
      dedupKey: createNotificationIntentKey(identity),
      summary: { eventType: "SYNC_FAILURE", severity: "LOW" },
    },
    decision: {
      context: {
        schemaVersion: 1,
        requestId: "logical/request .1",
        correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
        actor,
        event: eventFixture(),
        evidence: { reference, evidence: evidenceFixture() },
      },
      run: runFixture(),
      control: {
        timeDomain: "SECURITY_UTC",
        deadlineAt: later,
        signal: new AbortController().signal,
      },
    },
  });
}
function fixture() {
  const query = vi.fn<AuditTransactionClient["query"]>(async () => ({
    rows: [{ allowed: false, currentUser: actor.userId }],
    rowCount: 1,
  }));
  const transaction: BoundNotificationTransaction = {
    kind: "TENANT",
    client: { query },
    binding,
    connectionGeneration: 0,
    auditRequestId: "audit-request-a",
    scope: {
      organizationId: binding.organizationId,
      workspaceId: binding.workspaceId,
      storeId: binding.storeId,
    },
    actor: { actorId: actor.userId, actorKind: "USER", identitySource: "SERVER" },
    isActive: () => true,
  };
  return {
    query,
    transaction,
    request: requestFixture(),
    repository: new NotificationEnqueueRepository({ decisionKey: () => "decision-v1" }),
  };
}

it("rejects malformed input before SQL", async () => {
  const f = fixture();
  const request = { ...f.request, unexpected: true };
  expect(await f.repository.enqueue(f.transaction, request, clock)).toEqual({
    ok: false,
    code: "INVALID_INPUT",
  });
  expect(f.query).not.toHaveBeenCalled();
});
it("rechecks actual notification scope without setting body-derived GUCs", async () => {
  const f = fixture();
  expect(await f.repository.enqueue(f.transaction, f.request, clock)).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
  expect(f.query).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("notification_scope_access"),
    [...Object.values(binding), "recipient-a", 0],
  );
});
it.each(["SERVICE", "SYSTEM"] as const)("fails closed for unmapped %s principals", async (kind) => {
  const f = fixture();
  const transaction = { ...f.transaction, actor: { ...f.transaction.actor, actorKind: kind } };
  expect(await f.repository.enqueue(transaction, f.request, clock)).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
  expect(f.query).not.toHaveBeenCalled();
});
it("honors the original abort signal before SQL", async () => {
  const f = fixture();
  const controller = new AbortController();
  const request = {
    ...f.request,
    decision: {
      ...f.request.decision,
      control: { ...f.request.decision.control, signal: controller.signal },
    },
  };
  controller.abort();
  expect(await f.repository.enqueue(f.transaction, request, clock)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(f.query).not.toHaveBeenCalled();
});

it.each([-1, 1.5, 2147483648, Number.NaN])(
  "rejects invalid generation %s before SQL",
  async (generation) => {
    const f = fixture();
    expect(
      await f.repository.enqueue(
        { ...f.transaction, connectionGeneration: generation },
        f.request,
        clock,
      ),
    ).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(f.query).not.toHaveBeenCalled();
  },
);
it("requires the trusted key policy before SQL", async () => {
  const f = fixture();
  const repository = new NotificationEnqueueRepository({ decisionKey: () => "other-policy" });
  expect(await repository.enqueue(f.transaction, f.request, clock)).toEqual({
    ok: false,
    code: "FORBIDDEN",
  });
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects an elapsed deadline and inactive owner before SQL", async () => {
  const f = fixture();
  expect(
    await f.repository.enqueue(f.transaction, f.request, { ...clock, now: () => later }),
  ).toEqual({ ok: false, code: "CONFLICT" });
  expect(
    await f.repository.enqueue({ ...f.transaction, isActive: () => false }, f.request, clock),
  ).toEqual({ ok: false, code: "CONFLICT" });
  expect(f.query).not.toHaveBeenCalled();
});
it("propagates post-query lifetime loss as a bounded rejection", async () => {
  const f = fixture();
  let active = true;
  f.query.mockImplementationOnce(async () => {
    active = false;
    return { rows: [{ allowed: true, currentUser: actor.userId }], rowCount: 1 };
  });
  await expect(
    f.repository.enqueue({ ...f.transaction, isActive: () => active }, f.request, clock),
  ).rejects.toMatchObject({ name: "NotificationEnqueueError", code: "CONFLICT" });
});
type Row = Record<string, unknown>;
function physicalEvent(request = requestFixture()): Row {
  const event = request.decision.context.event;
  const ref = request.decision.context.evidence.reference;
  return {
    ...binding,
    id: event.id,
    schemaVersion: 1,
    eventType: event.eventType,
    entityKind: entity.kind,
    entityId: entity.connectionId,
    baselineVersion: null,
    fingerprint: event.fingerprint,
    severityFloor: event.severityFloor,
    rulePolicyVersion: event.rulePolicyVersion,
    state: event.state,
    revision: "1",
    firstSeenAtMs: String(Date.parse(instant)),
    lastSeenAtMs: String(Date.parse(instant)),
    currentEvidenceId: ref.id,
    currentEvidenceVersion: ref.version,
    currentEvidenceHash: ref.hash,
    vId: ref.id,
    vEventId: event.id,
    vSchemaVersion: 1,
    vEvidenceRevision: "1",
    vFingerprint: event.fingerprint,
    vVersion: ref.version,
    vHash: ref.hash,
    vDefinitionVersion: ref.definitionVersion,
    ...Object.fromEntries(
      Object.entries(binding).map(([key, value]) => [
        `v${key[0]!.toUpperCase()}${key.slice(1)}`,
        value,
      ]),
    ),
    evidencePayload: JSON.parse(JSON.stringify(request.decision.context.evidence.evidence)),
  };
}
function authorityFixture(event: Row | undefined = physicalEvent()) {
  const f = fixture();
  let count = 0;
  f.query.mockImplementation(async () => {
    count++;
    const rows =
      count === 1
        ? [{ allowed: true, currentUser: actor.userId }]
        : count === 2 && event
          ? [event]
          : [];
    return { rows, rowCount: rows.length };
  });
  return f;
}
it("locks and validates current event before looking for a committed winner", async () => {
  const f = authorityFixture();
  expect(await f.repository.enqueue(f.transaction, f.request, clock)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(f.query).toHaveBeenNthCalledWith(2, expect.stringContaining("FOR UPDATE OF e"), [
    ...Object.values(binding),
    "event/a .1",
  ]);
  expect(f.query).toHaveBeenNthCalledWith(3, expect.stringContaining("decision_claims"), [
    ...Object.values(binding),
    "event/a .1",
    "run/a .1",
    1,
    f.request.decision.context.event.fingerprint,
    reference.id,
    reference.version,
    reference.hash,
    "decision-v1",
  ]);
});
it.each(["revision", "state", "currentEvidenceHash", "vConnectionId", "vEventId", "entityId"])(
  "rejects a changed current event field %s before winner lookup",
  async (key) => {
    const f = authorityFixture({ ...physicalEvent(), [key]: "changed" });
    expect(await f.repository.enqueue(f.transaction, f.request, clock)).toEqual({
      ok: false,
      code: "CONFLICT",
    });
    expect(f.query).toHaveBeenCalledTimes(2);
  },
);
function physicalClaim(request: NotificationEnqueueRequest) {
  const run = request.decision.run;
  const common = {
    ...binding,
    eventId: run.eventId,
    fingerprint: request.decision.context.event.fingerprint,
    evidenceId: reference.id,
    evidenceVersion: reference.version,
    evidenceHash: reference.hash,
    decisionKey: run.decisionKey,
    claimToken: "claim-token-a",
  };
  return {
    ...common,
    eventRevision: "1",
    winnerRunId: run.id,
    winnerMode: "PRIMARY",
    winnerStatus: "EVALUATED",
  };
}
function physicalRun(request = requestFixture()): Row {
  const run = request.decision.run;
  const claim = physicalClaim(request);
  return {
    ...claim,
    id: run.id,
    claimId: "57a1befc-02cb-4acc-8a1a-6975b2016241",
    claimRowId: "57a1befc-02cb-4acc-8a1a-6975b2016241",
    schemaVersion: 1,
    requestId: run.requestId,
    correlationId: request.decision.context.correlationId,
    providerKey: run.provider.key,
    providerVersion: run.provider.version,
    supportedInputVersions: [1],
    rulesetVersion: run.rulesetVersion,
    mode: run.mode,
    fallbackOf: null,
    fallbackMode: null,
    fallbackStatus: null,
    resultStatus: "EVALUATED",
    result: JSON.parse(JSON.stringify(run.result)),
    effective: JSON.parse(JSON.stringify(run.effective)),
    overrideReason: null,
    latencyMs: "1",
    createdAtMs: String(Date.parse(instant)),
    claimCreatedAtMs: String(Date.parse(instant) - 120000),
    claimExpiresAtMs: String(Date.parse(instant) - 60000),
    ...Object.fromEntries(
      Object.entries(claim).map(([key, value]) => [
        `claim${key[0]!.toUpperCase()}${key.slice(1)}`,
        value,
      ]),
    ),
  };
}
function winnerFixture(run: Row = physicalRun()) {
  const f = authorityFixture();
  const previous = f.query.getMockImplementation()!;
  let count = 0;
  f.query.mockImplementation(async (sql, parameters) => {
    count++;
    if (count === 3) return { rows: [run], rowCount: 1 };
    return previous(sql, parameters);
  });
  return f;
}
it.each([
  "claimWinnerRunId",
  "claimClaimToken",
  "claimEventRevision",
  "claimConnectionId",
  "fingerprint",
  "correlationId",
  "mode",
  "resultStatus",
])("denies an inconsistent winning run field %s", async (key) => {
  const f = winnerFixture({ ...physicalRun(), [key]: "other" });
  expect(await f.repository.enqueue(f.transaction, f.request, clock)).toEqual({
    ok: false,
    code: "CONFLICT",
  });
  expect(f.query).toHaveBeenCalledTimes(3);
});
