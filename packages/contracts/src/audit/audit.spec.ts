import { expect, it } from "vitest";
import {
  AuditAppendInputSchema,
  AuditEntrySchema,
  AuditEventTypeSchema,
  AuditQueryAccessManifestSchema,
  AuditQueryPageSchema,
  AuditQuerySchema,
  AuditTraceViewSchema,
  AuditResourceSchema,
  AnonymousAuthSecurityEventSchema,
  TenantAuditEventSchema,
} from "./audit.schema.js";
import {
  EventStateTransitionSchema,
  EventStateSchema,
  EventTransitionReasonSchema,
} from "../events/event.schema.js";

const at = "2026-10-22T08:00:00Z";
const scope = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
};

const actor = {
  actorId: "user-a",
  actorKind: "USER",
  identitySource: "SERVER",
};

const links = {
  requestId: "request-a",
  occurrenceId: "occurrence-a",
  runId: null,
  evidenceId: null,
  actionId: null,
  revisionId: null,
  approvalId: null,
  executionId: null,
};

function eventMetadata(eventType: string) {
  if (eventType === "EVENT_STATE_CHANGE") return lifecycleMetadata();
  if (eventType === "ROLE_CHANGE") {
    return { previousRole: "VIEWER", nextRole: "OPERATOR" };
  }
  if (eventType === "AGENT_RUN") return { runStatus: "COMPLETED" };
  if (eventType === "BRIEF" || eventType.startsWith("NOTIFICATION_")) {
    return { channel: "IN_APP", deliveryStatus: "DELIVERED" };
  }
  if (
    ["PROPOSAL", "APPROVAL", "REJECTION", "EXECUTION", "VERIFICATION", "COMPENSATION"].includes(
      eventType,
    )
  ) {
    return {
      actionKind: "PRICE",
      oldPriceMinor: 1000,
      newPriceMinor: 1100,
      reasonCode: "COMPLETED",
    };
  }
  return { reasonCode: "COMPLETED" };
}

function tenant(eventType = "EXECUTION") {
  return {
    scopeKind: "TENANT",
    scope,
    actor,
    resource:
      eventType === "EVENT_STATE_CHANGE"
        ? { type: "EVENT", id: "event/alpha.1" }
        : { type: "SKU", id: "sku-a" },
    result: "SUCCESS",
    occurredAt: at,
    sourceOccurredAt: eventType === "EVENT_STATE_CHANGE" ? null : "2026-10-21T08:00:00Z",
    links,
    event: { eventType, redactedMetadata: eventMetadata(eventType) },
  };
}

function anonymous() {
  return {
    scopeKind: "ANONYMOUS_AUTH_SECURITY",
    scope: null,
    actor: null,
    requestId: "request-a",
    occurredAt: at,
    result: "REJECTED",
    reason: "UNKNOWN_IDENTITY",
    redactedMetadata: {
      attemptClass: "LOGIN",
      rateLimited: false,
    },
  };
}

function persisted() {
  return {
    ...tenant(),
    auditId: "audit-a",
    sequence: 1,
    hashVersion: 1,
    prevHash: null,
    entryHash: "a".repeat(64),
  };
}

function query() {
  return {
    scope,
    from: "2026-10-01T00:00:00Z",
    until: at,
    limit: 50,
    cursor: null,
    eventTypes: ["EXECUTION"],
    actorId: null,
  };
}

it.each(AuditEventTypeSchema.options)("supports tenant event family %s", (eventType) => {
  expect(TenantAuditEventSchema.safeParse(tenant(eventType)).success).toBe(true);
});

it("requires a complete tenant scope and server-sourced actor", () => {
  const base = tenant();

  for (const changes of [
    { scope: null },
    { scope: { organizationId: "org-a" } },
    { scope: { ...scope, storeId: null } },
    { actor: null },
    { actor: { actorId: "user-a", actorKind: "USER" } },
  ]) {
    expect(TenantAuditEventSchema.safeParse({ ...base, ...changes }).success).toBe(false);
  }
});

it("rejects unknown event families and arbitrary metadata", () => {
  const base = tenant();

  expect(
    TenantAuditEventSchema.safeParse({
      ...base,
      event: { eventType: "UNKNOWN_EVENT", redactedMetadata: {} },
    }).success,
  ).toBe(false);

  for (const field of [
    "email",
    "phone",
    "name",
    "prompt",
    "rawPrompt",
    "accessToken",
    "privateKey",
    "nestedSecret",
  ]) {
    expect(
      TenantAuditEventSchema.safeParse({
        ...base,
        event: {
          ...base.event,
          redactedMetadata: {
            ...base.event.redactedMetadata,
            [field]: { nested: "private-value" },
          },
        },
      }).success,
    ).toBe(false);
  }
});

it("keeps source time separate from server occurrence time", () => {
  expect(TenantAuditEventSchema.safeParse(tenant()).success).toBe(true);
  const { occurredAt: unused, ...withoutOccurredAt } = tenant();
  expect(unused).toBe(at);
  expect(TenantAuditEventSchema.safeParse(withoutOccurredAt).success).toBe(false);
  expect(
    AnonymousAuthSecurityEventSchema.safeParse({
      ...anonymous(),
      sourceOccurredAt: at,
    }).success,
  ).toBe(false);
});

it("isolates unknown login identities from tenant audit events", () => {
  expect(AnonymousAuthSecurityEventSchema.safeParse(anonymous()).success).toBe(true);
  expect(AuditAppendInputSchema.safeParse(anonymous()).success).toBe(true);

  for (const changes of [
    { scope },
    { actor },
    { organizationId: "invented-org" },
    { runId: "run-a" },
    { reason: "raw invalid password" },
    { redactedMetadata: { ...anonymous().redactedMetadata, ip: "private" } },
  ]) {
    expect(
      AnonymousAuthSecurityEventSchema.safeParse({
        ...anonymous(),
        ...changes,
      }).success,
    ).toBe(false);
  }
});

it("requires audited tenant links and bounded safe price values", () => {
  const base = tenant();

  expect(
    TenantAuditEventSchema.safeParse({
      ...base,
      links: { ...links, approvalId: "approval-a", executionId: "execution-a" },
    }).success,
  ).toBe(true);

  expect(
    TenantAuditEventSchema.safeParse({
      ...base,
      links: { requestId: "request-a" },
    }).success,
  ).toBe(false);

  expect(
    TenantAuditEventSchema.safeParse({
      ...base,
      event: {
        ...base.event,
        redactedMetadata: { ...base.event.redactedMetadata, oldPriceMinor: -1 },
      },
    }).success,
  ).toBe(false);
});

it("validates append-only entry shapes without claiming signature proof", () => {
  const entry = persisted();

  expect(AuditEntrySchema.safeParse(entry).success).toBe(true);
  expect(
    AuditEntrySchema.safeParse({
      ...anonymous(),
      auditId: "security-a",
    }).success,
  ).toBe(true);

  expect(
    AuditEntrySchema.safeParse({
      ...entry,
      entryHash: "not-a-hash",
    }).success,
  ).toBe(false);

  expect(
    AuditEntrySchema.safeParse({
      ...anonymous(),
      auditId: "security-a",
      sequence: 1,
      entryHash: "a".repeat(64),
    }).success,
  ).toBe(false);
});

it("enforces query date range, limits and safe cursors", () => {
  expect(AuditQuerySchema.safeParse(query()).success).toBe(true);

  for (const changes of [
    { limit: 0 },
    { limit: 101 },
    { from: "2026-09-01T00:00:00Z" },
    { from: "2026-10-23T00:00:00Z" },
    { cursor: "offset 100; DROP TABLE audit" },
    { scope: { organizationId: "org-a" } },
    { eventTypes: ["EXECUTION", "EXECUTION"] },
    { eventTypes: ["UNRECOGNIZED"] },
    { email: "private@example.org" },
  ]) {
    expect(AuditQuerySchema.safeParse({ ...query(), ...changes }).success).toBe(false);
  }
});

it("requires a scoped query authorization manifest", () => {
  const manifest = {
    principalId: "user-a",
    scope,
    policyVersion: "policy-v1",
    decision: "ALLOW",
    permittedEventTypes: ["EXECUTION"],
    evaluatedAt: at,
  };

  expect(AuditQueryAccessManifestSchema.safeParse(manifest).success).toBe(true);
  expect(
    AuditQueryAccessManifestSchema.safeParse({
      ...manifest,
      scope: null,
    }).success,
  ).toBe(false);
  expect(
    AuditQueryAccessManifestSchema.safeParse({
      ...manifest,
      rawToken: "private",
    }).success,
  ).toBe(false);
});

it("does not call a partial filtered chain a hash mismatch", () => {
  const base = {
    scope,
    items: [persisted()],
    nextCursor: "YWJj",
    chainVisibility: "PARTIAL",
    integrity: "PENDING",
    mismatchEvidenceId: null,
  };

  expect(AuditQueryPageSchema.safeParse(base).success).toBe(true);
  expect(
    AuditQueryPageSchema.safeParse({
      ...base,
      integrity: "MISMATCH",
    }).success,
  ).toBe(false);
  expect(
    AuditQueryPageSchema.safeParse({
      ...base,
      integrity: "MISMATCH",
      mismatchEvidenceId: "independent-evidence-a",
    }).success,
  ).toBe(true);
});

it("validates trace visibility independently from integrity", () => {
  const trace = {
    traceId: "trace-a",
    scope,
    entries: [persisted()],
    chainVisibility: "PARTIAL",
    integrity: "UNSUPPORTED",
    mismatchEvidenceId: null,
  };

  expect(AuditTraceViewSchema.safeParse(trace).success).toBe(true);
  expect(
    AuditTraceViewSchema.safeParse({
      ...trace,
      integrity: "MISMATCH",
    }).success,
  ).toBe(false);
});

const lifecycleBinding = { ...scope, connectionId: "connection-a", externalStoreId: "external-a" };
function lifecycleMetadata() {
  return {
    fromState: "OPEN",
    toState: "ACKNOWLEDGED",
    reason: "ACKNOWLEDGED_BY_OPERATOR",
    expectedRevision: 1,
    revision: 2,
    evidenceReference: {
      schemaVersion: 1,
      id: "evidence/alpha.1",
      version: "version/1",
      hash: "hash/1",
      binding: lifecycleBinding,
      eventType: "SYNC_FAILURE",
      entity: { kind: "CONNECTION", connectionId: "connection-a" },
      definitionVersion: "definition/1",
      baselineVersion: null,
    },
  };
}
function lifecycle(changes: Record<string, unknown> = {}) {
  return { ...tenant("EVENT_STATE_CHANGE"), ...changes };
}
function acceptsLifecycle(value: unknown): boolean[] {
  const persistedValue = Object.assign({}, value, {
    auditId: "audit-a",
    sequence: 1,
    hashVersion: 1,
    prevHash: null,
    entryHash: "a".repeat(64),
  });
  return [
    AuditAppendInputSchema.safeParse(value).success,
    AuditEntrySchema.safeParse(persistedValue).success,
  ];
}
it("round trips lifecycle external identifiers without widening legacy resources", () => {
  expect(acceptsLifecycle(lifecycle())).toEqual([true, true]);
  const parsed = AuditAppendInputSchema.parse(lifecycle());
  expect(parsed).toEqual(lifecycle());
  expect(AuditResourceSchema.shape.id.safeParse("event/alpha.1").success).toBe(false);
  expect(AuditResourceSchema.safeParse({ type: "EVENT", id: "event-a" }).success).toBe(false);
});
it("rejects lifecycle envelope mismatches through append and persisted entry", () => {
  for (const changes of [
    { result: "FAILED" },
    { actor: { ...actor, actorKind: "SYSTEM" } },
    { sourceOccurredAt: at },
    { resource: null },
    { resource: { type: "SKU", id: "sku-a" } },
    { links: { ...links, evidenceId: "evidence-a" } },
    { scope: { ...scope, storeId: "other" } },
    { occurredAt: "2026-02-30T08:00:00Z" },
    { extra: true },
  ])
    expect(acceptsLifecycle(lifecycle(changes))).toEqual([false, false]);
  expect(acceptsLifecycle({ ...tenant(), resource: { type: "EVENT", id: "event-a" } })).toEqual([
    false,
    false,
  ]);
});
it("rejects unsafe lifecycle revisions and metadata extensions", () => {
  for (const changes of [
    { expectedRevision: 0 },
    { revision: 3 },
    { expectedRevision: Number.MAX_SAFE_INTEGER, revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 1.5 },
    { arbitrary: "secret" },
    { evidenceReference: { ...lifecycleMetadata().evidenceReference, extra: true } },
  ]) {
    const event = {
      eventType: "EVENT_STATE_CHANGE",
      redactedMetadata: { ...lifecycleMetadata(), ...changes },
    };
    expect(acceptsLifecycle(lifecycle({ event }))).toEqual([false, false]);
  }
});
it.each([" event-a", "event-a ", "event\u0000a", "a".repeat(257)])(
  "rejects unsafe EVENT identifier %j",
  (id) => {
    expect(acceptsLifecycle(lifecycle({ resource: { type: "EVENT", id } }))).toEqual([
      false,
      false,
    ]);
  },
);
it("matches every event transition and reason combination", () => {
  const tenantActor = {
    userId: "user-a",
    merchantId: "merchant-a",
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    role: "OPERATOR",
    permissions: [],
  };
  for (const fromState of EventStateSchema.options)
    for (const toState of EventStateSchema.options) {
      for (const reason of EventTransitionReasonSchema.options) {
        const transition = {
          actor: tenantActor,
          binding: lifecycleBinding,
          eventId: "event/alpha.1",
          expectedRevision: 1,
          fromState,
          toState,
          reason,
          changedAt: at,
        };
        const event = {
          eventType: "EVENT_STATE_CHANGE",
          redactedMetadata: { ...lifecycleMetadata(), fromState, toState, reason },
        };
        const expected = EventStateTransitionSchema.safeParse(transition).success;
        expect(acceptsLifecycle(lifecycle({ event }))).toEqual([expected, expected]);
      }
    }
});
it("accepts every audit family together in query and access manifest", () => {
  expect(
    AuditQuerySchema.safeParse({
      ...query(),
      eventTypes: [...new Set([...AuditEventTypeSchema.options, "EVENT_STATE_CHANGE"])],
    }).success,
  ).toBe(true);
  expect(
    AuditQueryAccessManifestSchema.safeParse({
      principalId: "user-a",
      scope,
      policyVersion: "v1",
      decision: "ALLOW",
      permittedEventTypes: [...new Set([...AuditEventTypeSchema.options, "EVENT_STATE_CHANGE"])],
      evaluatedAt: at,
    }).success,
  ).toBe(true);
});
