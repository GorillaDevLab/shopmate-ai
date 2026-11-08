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
  f.query.mockImplementation(async (sql) => {
    const rows = sql.includes("notification_scope_access")
      ? [{ allowed: true, currentUser: actor.userId }]
      : sql.includes("FROM public.events") && event
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
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("FROM public.decision_runs")) return { rows: [run], rowCount: 1 };
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
const rowId = "57a1befc-02cb-4acc-8a1a-6975b2016242";
const insertNames = [
  "intentId",
  ...Object.keys(binding),
  "recipientUserId",
  "eventId",
  "eventState",
  "eventRevision",
  "channel",
  "decisionRunId",
  "route",
  "eventType",
  "severity",
  "createdAt",
  "notBefore",
  "evidenceId",
  "evidenceVersion",
  "evidenceHash",
  "entityKind",
  "entityId",
  "definitionVersion",
  "baselineVersion",
  "connectionGeneration",
  "nextAttemptAt",
];
function immutableRow(): Row {
  const intent = requestFixture().intent;
  return {
    intentId: intent.id,
    ...binding,
    recipientUserId: intent.recipient.userId,
    eventId: intent.eventId,
    eventState: intent.eventState,
    eventRevision: "1",
    channel: intent.channel,
    decisionRunId: intent.decisionRunId,
    route: intent.route,
    eventType: intent.summary.eventType,
    severity: intent.summary.severity,
    evidenceId: reference.id,
    evidenceVersion: reference.version,
    evidenceHash: reference.hash,
    entityKind: "CONNECTION",
    entityId: binding.connectionId,
    definitionVersion: reference.definitionVersion,
    baselineVersion: null,
    connectionGeneration: 0,
  };
}
function pendingRow(parameters?: unknown[]): Row {
  const row = parameters
    ? Object.fromEntries(insertNames.map((key, index) => [key, parameters[index]]))
    : immutableRow();
  return {
    ...row,
    rowId,
    status: "PENDING",
    attempt: "0",
    leaseToken: null,
    createdAtMs: String(Date.parse(instant)),
    notBeforeMs: String(Date.parse(instant)),
    nextAttemptAtMs: String(Date.parse(instant)),
    leaseUntilMs: null,
    deliveredAtMs: null,
    inboxOutboxId: null,
    inboxReadAtMs: null,
  };
}
function storageFixture(existing: Row | null = pendingRow()) {
  const f = winnerFixture();
  const previous = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("FROM public.notification_outbox"))
      return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
    if (sql.includes("INSERT INTO public.notification_outbox"))
      return { rows: [pendingRow(parameters)], rowCount: 1 };
    return previous(sql, parameters);
  });
  return f;
}
it("reuses the first natural intent after a committed winner's lease expires", async () => {
  const row = { ...pendingRow(), intentId: "original/intent", severity: "MEDIUM" };
  const f = storageFixture(row);
  const result = await f.repository.enqueue(f.transaction, f.request, clock);
  expect(result).toMatchObject({
    ok: true,
    value: {
      outcome: "DEDUPLICATED",
      receipt: {
        status: "PENDING",
        intent: { id: "original/intent", summary: { severity: "MEDIUM" } },
      },
    },
  });
  expect(f.query).toHaveBeenCalledTimes(4);
  expect(f.query.mock.calls[3]![0]).toContain("LEFT JOIN public.recipient_inbox");
});
it.each([null, true, "", "01", "9007199254740992", "1.5", -1])(
  "rejects corrupt attempt %s",
  async (attempt) => {
    const f = storageFixture({ ...pendingRow(), attempt });
    await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
      name: "NotificationEnqueueError",
    });
  },
);
it("binds only permitted pending columns and uses the private UUID default", async () => {
  const f = storageFixture(null);
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
  });
  const call = f.query.mock.calls.find(([sql]) =>
    sql.includes("INSERT INTO public.notification_outbox"),
  );
  expect(call?.[0].split("VALUES")[0]).not.toContain('"rowId"');
  expect(call?.[0]).toContain(
    "ON CONFLICT ON CONSTRAINT notification_outbox_natural_key DO NOTHING",
  );
  expect(call?.[1]).toEqual([
    f.request.intent.id,
    ...Object.values(binding),
    "recipient-a",
    "event/a .1",
    "OPEN",
    1,
    "IN_APP",
    "run/a .1",
    "DAILY_BRIEF",
    "SYNC_FAILURE",
    "LOW",
    instant,
    instant,
    reference.id,
    "v1",
    "hash-a",
    "CONNECTION",
    binding.connectionId,
    "metrics-v1",
    null,
    0,
    instant,
  ]);
});
function auditRow(parameters: unknown[]): Row {
  const names = [
    "auditId",
    "organizationId",
    "workspaceId",
    "storeId",
    "actorId",
    "actorKind",
    "requestId",
    "occurrenceId",
    "sequence",
    "prevHash",
    "entryHash",
    "hashVersion",
    "redactionVersion",
    "payload",
  ];
  const row = Object.fromEntries(names.map((key, index) => [key, parameters[index]]));
  return { ...row, sequence: String(row.sequence), payload: JSON.parse(String(row.payload)) };
}
function auditFixture() {
  const f = storageFixture(null);
  const previous = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("audit_chain_head"))
      return { rows: [{ sequence: "0", entryHash: null }], rowCount: 1 };
    if (sql.includes("FROM public.audit_logs")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.audit_logs"))
      return { rows: [auditRow(parameters!)], rowCount: 1 };
    return previous(sql, parameters);
  });
  return f;
}
it("appends one real audit on the owner client before returning a new intent", async () => {
  const f = auditFixture();
  const result = await f.repository.enqueue(f.transaction, f.request, clock);
  expect(result).toMatchObject({
    ok: true,
    value: { outcome: "ENQUEUED", receipt: { status: "PENDING", intent: f.request.intent } },
  });
  const inserts = f.query.mock.calls.filter(([sql]) =>
    sql.includes("INSERT INTO public.audit_logs"),
  );
  expect(inserts).toHaveLength(1);
  expect(JSON.parse(String(inserts[0]![1]![13]))).toEqual({
    scopeKind: "TENANT",
    scope: f.transaction.scope,
    actor: f.transaction.actor,
    resource: { type: "NOTIFICATION", id: rowId },
    result: "SUCCESS",
    occurredAt: instant,
    sourceOccurredAt: null,
    links: {
      requestId: "audit-request-a",
      occurrenceId: rowId,
      runId: null,
      evidenceId: null,
      actionId: null,
      revisionId: null,
      approvalId: null,
      executionId: null,
    },
    event: {
      eventType: "NOTIFICATION_INTENT",
      redactedMetadata: { channel: "IN_APP", deliveryStatus: "PENDING" },
    },
  });
});
it("rejects an audit failure after insertion so the owner rolls back its complete unit", async () => {
  const f = auditFixture();
  const previous = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("audit_chain_head")) throw new Error("private connection detail");
    return previous(sql, parameters);
  });
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
    code: "UNAVAILABLE",
    message: "Notification enqueue failed",
  });
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.notification_outbox")),
  ).toBe(true);
});
function deliveredRow(readAt: string | null = null): Row {
  const row = {
    ...pendingRow(),
    status: "DELIVERED",
    attempt: "1",
    nextAttemptAtMs: null,
    deliveredAtMs: String(Date.parse(instant)),
  };
  const inbox = Object.fromEntries(
    Object.entries(row)
      .filter(
        ([key]) =>
          (insertNames.includes(key) && !["connectionGeneration", "nextAttemptAt"].includes(key)) ||
          ["createdAtMs", "notBeforeMs", "deliveredAtMs"].includes(key),
      )
      .map(([key, value]) => [`inbox${key[0]!.toUpperCase()}${key.slice(1)}`, value]),
  );
  return { ...row, ...inbox, inboxOutboxId: rowId, inboxReadAtMs: readAt };
}
it.each(["PENDING", "LEASED", "FAILED", "UNKNOWN"] as const)(
  "replays a valid %s receipt",
  async (status) => {
    const row = {
      ...pendingRow(),
      status,
      attempt: status === "PENDING" ? "0" : "1",
      nextAttemptAtMs: status === "PENDING" ? String(Date.parse(instant)) : null,
      leaseToken: status === "LEASED" ? "lease-token" : null,
      leaseUntilMs: status === "LEASED" ? String(Date.parse(later)) : null,
    };
    const f = storageFixture(row);
    expect(await f.repository.enqueue(f.transaction, f.request, clock)).toMatchObject({
      ok: true,
      value: { receipt: { status, readState: status === "UNKNOWN" ? "UNKNOWN" : "UNREAD" } },
    });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("audit_"))).toBe(false);
  },
);
it.each([null, String(Date.parse(later))])(
  "reads delivery and confirmed read from one snapshot (%s)",
  async (readAt) => {
    const f = storageFixture(deliveredRow(readAt));
    expect(await f.repository.enqueue(f.transaction, f.request, clock)).toMatchObject({
      ok: true,
      value: {
        receipt: {
          status: "DELIVERED",
          readAt: readAt === null ? null : later,
          readState: readAt === null ? "UNREAD" : "READ",
        },
      },
    });
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("recipient_inbox"))).toHaveLength(1);
  },
);
it.each([
  { inboxOutboxId: null },
  { inboxIntentId: "other" },
  { inboxSeverity: "CRITICAL" },
  { inboxDeliveredAtMs: String(Date.parse(later)) },
  { inboxReadAtMs: String(Date.parse(instant) - 1) },
])("rejects a contradictory inbox projection %j", async (change) => {
  const f = storageFixture({ ...deliveredRow(), ...change });
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
  });
});
it("rejects a missing snapshot marker instead of treating it as an absent inbox", async () => {
  const f = storageFixture({ ...pendingRow(), inboxOutboxId: undefined });
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
  });
});
it("does not recover inside a transaction aborted by an intent-key conflict", async () => {
  const f = auditFixture();
  const previous = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("INSERT INTO public.notification_outbox"))
      throw { code: "23505", detail: "private foreign identity" };
    return previous(sql, parameters);
  });
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
    code: "CONFLICT",
  });
  expect(f.query).toHaveBeenCalledTimes(5);
});
it("rejects a different inserted payload before appending audit", async () => {
  const f = auditFixture();
  const previous = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("INSERT INTO public.notification_outbox"))
      return { rows: [{ ...pendingRow(parameters), severity: "CRITICAL" }], rowCount: 1 };
    return previous(sql, parameters);
  });
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
  });
  expect(f.query.mock.calls.some(([sql]) => sql.includes("audit_"))).toBe(false);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("deduplicates overlapping same-client inserts with one first-insert audit", async () => {
  const f = auditFixture();
  const previous = f.query.getMockImplementation()!;
  const gate = deferred();
  let reads = 0;
  let stored: Row | undefined;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("FROM public.notification_outbox")) {
      if (++reads <= 2) {
        if (reads === 2) gate.resolve();
        await gate.promise;
        return { rows: [], rowCount: 0 };
      }
      return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO public.notification_outbox")) {
      if (stored) return { rows: [], rowCount: 0 };
      stored = pendingRow(parameters);
      return { rows: [stored], rowCount: 1 };
    }
    return previous(sql, parameters);
  });
  const other = new NotificationEnqueueRepository({ decisionKey: () => "decision-v1" });
  const results = await Promise.all([
    f.repository.enqueue(f.transaction, f.request, clock),
    other.enqueue(f.transaction, f.request, clock),
  ]);
  expect(results.map((result) => result.ok && result.value.outcome).sort()).toEqual([
    "DEDUPLICATED",
    "ENQUEUED",
  ]);
  expect(
    f.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO public.audit_logs")),
  ).toHaveLength(1);
  expect(stored?.intentId).toBe(f.request.intent.id);
});
it("allows an independent client to finish while another client's audit waits", async () => {
  const f = auditFixture();
  const independent = auditFixture();
  const previous = f.query.getMockImplementation()!;
  const reached = deferred();
  const release = deferred();
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("audit_chain_head")) {
      reached.resolve();
      await release.promise;
    }
    return previous(sql, parameters);
  });
  const pending = f.repository.enqueue(f.transaction, f.request, clock);
  await reached.promise;
  try {
    expect(
      await independent.repository.enqueue(independent.transaction, independent.request, clock),
    ).toMatchObject({ ok: true });
  } finally {
    release.resolve();
  }
  expect(await pending).toMatchObject({ ok: true });
});
it("stops audit queries when control expires during the audit head await", async () => {
  const f = auditFixture();
  const previous = f.query.getMockImplementation()!;
  let now = instant;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("audit_chain_head")) now = later;
    return previous(sql, parameters);
  });
  await expect(
    f.repository.enqueue(f.transaction, f.request, { ...clock, now: () => now }),
  ).rejects.toMatchObject({ name: "NotificationEnqueueError" });
  expect(f.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.audit_logs"))).toBe(
    false,
  );
});
it("rechecks owner lifetime after the audit insert await", async () => {
  const f = auditFixture();
  const previous = f.query.getMockImplementation()!;
  let active = true;
  f.query.mockImplementation(async (sql, parameters) => {
    const result = await previous(sql, parameters);
    if (sql.includes("INSERT INTO public.audit_logs")) active = false;
    return result;
  });
  await expect(
    f.repository.enqueue({ ...f.transaction, isActive: () => active }, f.request, clock),
  ).rejects.toMatchObject({ name: "NotificationEnqueueError" });
});
it("accepts PostgreSQL's canonical UUID column with uppercase logical correlation metadata", async () => {
  const f = storageFixture();
  const correlationId = f.request.decision.context.correlationId.toUpperCase();
  const request = NotificationEnqueueRequestSchema.parse({
    ...f.request,
    decision: {
      ...f.request.decision,
      context: { ...f.request.decision.context, correlationId },
      run: {
        ...f.request.decision.run,
        result: { ...f.request.decision.run.result, correlationId },
      },
    },
  });
  const previous = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes("FROM public.decision_runs"))
      return {
        rows: [{ ...physicalRun(request), correlationId: correlationId.toLowerCase() }],
        rowCount: 1,
      };
    return previous(sql, parameters);
  });
  expect(await f.repository.enqueue(f.transaction, request, clock)).toMatchObject({ ok: true });
});
it("rejects a lone-surrogate persisted lease token", async () => {
  const f = storageFixture({
    ...pendingRow(),
    status: "LEASED",
    attempt: "1",
    nextAttemptAtMs: null,
    leaseToken: "lease\ud800",
    leaseUntilMs: String(Date.parse(later)),
  });
  await expect(f.repository.enqueue(f.transaction, f.request, clock)).rejects.toMatchObject({
    name: "NotificationEnqueueError",
  });
});
