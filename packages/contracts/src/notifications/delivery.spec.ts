import { expect, expectTypeOf, it } from "vitest";
import {
  createNotificationIntentKey,
  DailyBriefSchema,
  DeliveryReceiptSchema,
  NotificationIntentSchema,
  NotificationIntentIdentitySchema,
  NotificationPreferencesSchema,
  NotificationRecipientSchema,
  NotificationEnqueueRequestSchema,
  NotificationInboxQuerySchema,
  NotificationInboxPageSchema,
  NotificationInboxItemSchema,
  NotificationReadConfirmationSchema,
  NotificationPreferencesQuerySchema,
  NotificationPreferencesUpdateSchema,
  NotificationMarkReadRequestSchema,
  NotificationBriefQuerySchema,
  createEventFingerprint,
} from "../index.js";
import type {
  DecisionOutboxRequest,
  SecurityClock,
  TransactionalEnqueuePort,
  NotificationReadPort,
  NotificationPreferencesPort,
  NotificationEnqueueRequest,
  NotificationInboxItem,
  NotificationReadConfirmation,
  NotificationEnqueueOutcome,
  DeliveryReceipt,
} from "../index.js";

const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const recipient = { binding, userId: "user-a" };
const instant = "2026-10-25T16:00:00Z";
const reference = {
  schemaVersion: 1,
  id: "evidence-a",
  version: "v1",
  hash: "hash-a",
  binding,
  eventType: "SYNC_FAILURE",
  entity: { kind: "CONNECTION", connectionId: "connection-a" },
  definitionVersion: "metrics-v1",
  baselineVersion: null,
} as const;
const identity = {
  recipient,
  eventId: "event-a",
  eventState: "OPEN",
  eventRevision: 1,
  channel: "IN_APP",
} as const;
function intentFixture() {
  return {
    schemaVersion: 1,
    id: "intent-a",
    ...identity,
    evidence: reference,
    decisionRunId: "run-a",
    route: "DAILY_BRIEF",
    createdAt: instant,
    notBefore: instant,
    dedupKey: createNotificationIntentKey(identity),
    summary: { eventType: "SYNC_FAILURE", severity: "LOW" },
  };
}
function preferencesFixture() {
  return {
    schemaVersion: 1,
    recipient,
    version: 1,
    notifications: "ALL",
    cooldownSeconds: 60,
    quietHours: { timezone: "Pacific/Auckland", startMinute: 1320, endMinute: 420 },
  };
}
function briefFixture() {
  return {
    schemaVersion: 1,
    id: "brief-a",
    binding,
    businessDate: "2026-10-25",
    timezone: "Asia/Shanghai",
    version: 1,
    evidenceHash: "brief-hash",
    observedAt: instant,
    sourceWatermark: null,
    period: {
      periodStart: "2026-10-24T16:00:00Z",
      periodEnd: instant,
      timezone: "Asia/Shanghai",
      currency: "CNY",
    },
    quality: {
      dataStatus: "UNAVAILABLE",
      sampleSize: 0,
      coverageBasisPoints: 0,
      issues: [{ code: "COST_MISSING", field: "profit", evidenceIds: ["evidence-a"] }],
    },
    profitMinor: null,
    evidence: [reference],
    events: [
      { eventId: "event-a", state: "OPEN", revision: 1, evidence: reference, severity: "LOW" },
    ],
  };
}
function receiptFixture() {
  return {
    schemaVersion: 1,
    intent: intentFixture(),
    status: "PENDING",
    attempt: 0,
    nextAttemptAt: instant,
    leaseToken: null,
    leaseUntil: null,
    deliveredAt: null,
    readAt: null,
    readState: "UNREAD",
  };
}
function inboxItemFixture() {
  return {
    schemaVersion: 1,
    status: "DELIVERED",
    intent: intentFixture(),
    deliveredAt: instant,
    readAt: null,
    readState: "UNREAD",
  };
}

it("accepts strict readonly in-app intent and preserves exact opaque identity", () => {
  const parsed = NotificationIntentSchema.parse(intentFixture());
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.recipient.binding)).toBe(true);
  expect(parsed.dedupKey).toBe(createNotificationIntentKey(identity));
});

it.each(["", "user a", "user\n", "a".repeat(129)])("rejects invalid recipient %s", (userId) => {
  expect(NotificationRecipientSchema.safeParse({ ...recipient, userId }).success).toBe(false);
});

it.each([
  { channel: "EMAIL" },
  { eventRevision: 1.5 },
  { eventRevision: 0 },
  { eventRevision: Number.MAX_SAFE_INTEGER + 1 },
  { decisionRunId: "" },
  { route: "IGNORE" },
  { rawPrompt: "secret" },
  { dedupKey: "title-fingerprint" },
  { notBefore: "2026-10-25T15:00:00Z" },
  { id: "x".repeat(257) },
  { summary: { eventType: "SYNC_FAILURE", severity: "CRITICAL", approve: true } },
  { summary: { eventType: "STOCKOUT_RISK", severity: "LOW" } },
])("rejects invalid notification intent %#", (mutation) => {
  expect(NotificationIntentSchema.safeParse({ ...intentFixture(), ...mutation }).success).toBe(
    false,
  );
});

it.each(["organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId"] as const)(
  "rejects evidence %s mismatch",
  (field) => {
    const evidence = { ...reference, binding: { ...binding, [field]: "different" } };
    expect(NotificationIntentSchema.safeParse({ ...intentFixture(), evidence }).success).toBe(
      false,
    );
  },
);

it.each([
  { eventState: "ACKNOWLEDGED" as const },
  { eventRevision: 2 },
  { eventId: "event-b" },
  { recipient: { ...recipient, userId: "user-b" } },
  ...Object.keys(binding).map((field) => ({
    recipient: { ...recipient, binding: { ...binding, [field]: "different" } },
  })),
])("changes dedup identity for each immutable dimension %#", (mutation) => {
  expect(createNotificationIntentKey({ ...identity, ...mutation })).not.toBe(
    createNotificationIntentKey(identity),
  );
});

it("avoids delimiter collisions and preserves opaque identifier bytes", () => {
  const left = { ...identity, eventId: 'a", "b', recipient };
  const right = { ...identity, eventId: "a", recipient: { ...recipient, userId: "b" } };
  expect(createNotificationIntentKey(left)).not.toBe(createNotificationIntentKey(right));
  expect(createNotificationIntentKey({ ...identity, eventId: "é" })).not.toBe(
    createNotificationIntentKey({ ...identity, eventId: "é" }),
  );
});

it("accepts quiet hours crossing midnight or disabled explicitly", () => {
  expect(NotificationPreferencesSchema.safeParse(preferencesFixture()).success).toBe(true);
  expect(
    NotificationPreferencesSchema.safeParse({ ...preferencesFixture(), quietHours: null }).success,
  ).toBe(true);
});

it.each([
  { timezone: "Mars/Olympus" },
  { timezone: "x".repeat(129) },
  { timezone: "+12:00" },
  { startMinute: -1 },
  { endMinute: 1440 },
  { startMinute: 1.5 },
  { endMinute: 1320 },
])("rejects invalid quiet hours %#", (mutation) => {
  const prefs = preferencesFixture();
  expect(
    NotificationPreferencesSchema.safeParse({
      ...prefs,
      quietHours: { ...prefs.quietHours, ...mutation },
    }).success,
  ).toBe(false);
});

it.each([
  { cooldownSeconds: -1 },
  { cooldownSeconds: 1.5 },
  { cooldownSeconds: 604801 },
  { version: 0 },
  { notifications: "EMAIL" },
  { timezone: "UTC" },
])("rejects invalid preferences %#", (mutation) => {
  expect(
    NotificationPreferencesSchema.safeParse({ ...preferencesFixture(), ...mutation }).success,
  ).toBe(false);
});

it("keeps unknown profit null with explicit quality and observed source time", () => {
  const parsed = DailyBriefSchema.parse(briefFixture());
  expect(parsed.profitMinor).toBeNull();
  expect(parsed.quality.dataStatus).toBe("UNAVAILABLE");
  expect(parsed.observedAt).toBe(instant);
  expect(Object.isFrozen(parsed.events)).toBe(true);
});

const missingCostQualities = ["ESTIMATED", "STALE"].flatMap((dataStatus) =>
  ["profit", "frozenCosts"].map((field) => ({
    ...briefFixture().quality,
    dataStatus,
    issues: [{ ...briefFixture().quality.issues[0], field }],
  })),
);

it.each(
  missingCostQualities.flatMap((quality) =>
    [0, 150, -150].map((profitMinor) => ({ quality, profitMinor })),
  ),
)("rejects numeric profit with explicit missing costs %#", (mutation) => {
  expect(DailyBriefSchema.safeParse({ ...briefFixture(), ...mutation }).success).toBe(false);
});

it.each(missingCostQualities)("retains null profit with explicit missing costs %#", (quality) => {
  const parsed = DailyBriefSchema.parse({ ...briefFixture(), quality });
  expect(parsed.profitMinor).toBeNull();
  expect(parsed.quality).toEqual(quality);
  expect(parsed.sourceWatermark).toBeNull();
});

it.each(missingCostQualities)("requires listed missing-cost evidence %#", (quality) => {
  const issues = [{ ...quality.issues[0], evidenceIds: ["unlisted-evidence"] }];
  expect(
    DailyBriefSchema.safeParse({ ...briefFixture(), quality: { ...quality, issues } }).success,
  ).toBe(false);
});

const knownProfitQualities = [
  { dataStatus: "ESTIMATED", code: "COST_ESTIMATED", field: "frozenCosts" },
  { dataStatus: "STALE", code: "STALE_SOURCE", field: "profit" },
  { dataStatus: "ESTIMATED", code: "INVENTORY_UNKNOWN", field: "inventory" },
  { dataStatus: "STALE", code: "INVENTORY_UNKNOWN", field: "inventory" },
].map(({ dataStatus, code, field }) => ({
  dataStatus,
  sampleSize: 1,
  coverageBasisPoints: 10000,
  issues: [{ code, field, evidenceIds: ["evidence-a"] }],
}));

it.each(
  knownProfitQualities.flatMap((quality) =>
    [0, 150, -150].map((profitMinor) => ({ quality, profitMinor })),
  ),
)("preserves known estimated, stale or unrelated-quality profit %#", (mutation) => {
  const parsed = DailyBriefSchema.parse({
    ...briefFixture(),
    ...mutation,
    sourceWatermark: instant,
  });
  expect(parsed.profitMinor).toBe(mutation.profitMinor);
  expect(parsed.quality).toEqual(mutation.quality);
});

it.each([
  { profitMinor: 0 },
  { profitMinor: 0.5 },
  { profitMinor: Number.MAX_SAFE_INTEGER + 1 },
  { businessDate: "2026-02-30" },
  { businessDate: "2026-10-24" },
  { timezone: "Pacific/Auckland" },
  { version: 0 },
  { evidenceHash: "" },
  { sourceWatermark: "2026-10-26T16:00:00Z" },
  { quality: { dataStatus: "VERIFIED", sampleSize: 1, coverageBasisPoints: 10000, issues: [] } },
  { evidence: Array.from({ length: 101 }, () => reference) },
  { events: Array.from({ length: 101 }, () => briefFixture().events[0]) },
])("rejects invalid brief %#", (mutation) => {
  expect(DailyBriefSchema.safeParse({ ...briefFixture(), ...mutation }).success).toBe(false);
});

it("requires exact business-day window, same-scope references and listed event evidence", () => {
  const brief = briefFixture();
  const other = { ...reference, id: "other-evidence" };
  expect(
    DailyBriefSchema.safeParse({ ...brief, events: [{ ...brief.events[0], evidence: other }] })
      .success,
  ).toBe(false);
  expect(
    DailyBriefSchema.safeParse({
      ...brief,
      evidence: [{ ...reference, binding: { ...binding, storeId: "store-b" } }],
    }).success,
  ).toBe(false);
  expect(
    DailyBriefSchema.safeParse({
      ...brief,
      period: { ...brief.period, periodStart: "2026-10-24T17:00:00Z" },
    }).success,
  ).toBe(false);
});

it.each([-150, 0, 150])("allows measured signed or zero profit %s", (profitMinor) => {
  const quality = { dataStatus: "VERIFIED", sampleSize: 1, coverageBasisPoints: 10000, issues: [] };
  expect(
    DailyBriefSchema.safeParse({
      ...briefFixture(),
      profitMinor,
      quality,
      sourceWatermark: instant,
    }).success,
  ).toBe(true);
});

it("accepts pending, leased, failed, unknown and delivered receipt states explicitly", () => {
  const receipt = receiptFixture();
  expect(DeliveryReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(
    DeliveryReceiptSchema.safeParse({
      ...receipt,
      status: "LEASED",
      attempt: 1,
      nextAttemptAt: null,
      leaseToken: "lease-a",
      leaseUntil: "2026-10-25T16:01:00Z",
    }).success,
  ).toBe(true);
  expect(
    DeliveryReceiptSchema.safeParse({ ...receipt, status: "FAILED", attempt: 1 }).success,
  ).toBe(true);
  expect(
    DeliveryReceiptSchema.safeParse({
      ...receipt,
      status: "UNKNOWN",
      attempt: 1,
      readState: "UNKNOWN",
      nextAttemptAt: null,
    }).success,
  ).toBe(true);
  expect(
    DeliveryReceiptSchema.safeParse({
      ...receipt,
      status: "DELIVERED",
      attempt: 1,
      nextAttemptAt: null,
      deliveredAt: instant,
    }).success,
  ).toBe(true);
});

it.each([
  { status: "UNKNOWN", attempt: 1, deliveredAt: instant, readState: "UNKNOWN" },
  { status: "UNKNOWN", attempt: 1 },
  { attempt: 0.5 },
  { attempt: Number.MAX_SAFE_INTEGER + 1 },
  { status: "DELIVERED", attempt: 1, nextAttemptAt: null },
  { status: "LEASED", attempt: 1, nextAttemptAt: null },
  { leaseToken: "lease-a", leaseUntil: instant },
  { readAt: instant },
  { nextAttemptAt: "2026-10-25T15:00:00Z" },
  { status: "ACTION_DISPATCH" },
])("rejects illegal delivery state %#", (mutation) => {
  expect(DeliveryReceiptSchema.safeParse({ ...receiptFixture(), ...mutation }).success).toBe(false);
});

it("binds read state to actual delivery time and rejects backdated reads", () => {
  const delivered = {
    ...receiptFixture(),
    status: "DELIVERED",
    attempt: 1,
    nextAttemptAt: null,
    deliveredAt: instant,
    readState: "READ",
    readAt: instant,
  };
  expect(DeliveryReceiptSchema.safeParse(delivered).success).toBe(true);
  expect(
    DeliveryReceiptSchema.safeParse({ ...delivered, readAt: "2026-10-25T15:59:00Z" }).success,
  ).toBe(false);
  expect(DeliveryReceiptSchema.safeParse({ ...delivered, readState: "UNREAD" }).success).toBe(
    false,
  );
});

const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "VIEWER",
  permissions: ["tenant:read"],
};
const labels = {
  severity: "LOW",
  notificationRoute: "DAILY_BRIEF",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "NORMAL_PRIORITY",
  reasonCodes: ["NO_MATERIAL_CHANGE"],
};
const result = {
  schemaVersion: 1,
  status: "EVALUATED",
  correlationId: "57a1befc-02cb-4acc-8a1a-6975b2016240",
  rulesetVersion: "rules-v1",
  labels,
  confidenceMetadata: null,
};
const run = {
  schemaVersion: 1,
  id: "run-a",
  eventId: "event-a",
  decisionKey: "decision-a",
  requestId: "request-a",
  evidence: reference,
  provider: { key: "rules", version: "v1", supportedInputVersions: [1] },
  rulesetVersion: "rules-v1",
  mode: "PRIMARY",
  fallbackOf: null,
  result,
  latencyMs: 1,
  createdAt: instant,
  effective: labels,
  overrideReason: null,
};
function eventFixture() {
  return {
    schemaVersion: 1,
    id: "event-a",
    binding,
    eventType: "SYNC_FAILURE",
    entity: reference.entity,
    fingerprint: createEventFingerprint(reference),
    severityFloor: "LOW",
    rulePolicyVersion: "v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentEvidence: reference,
  };
}
const facts = {
  lastSuccessAt: instant,
  lagSeconds: 0,
  typedErrorCode: "TEMPORARY",
  affectedResourceKind: "INVENTORY",
};
function evidenceFixture() {
  const period = briefFixture().period;
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
    entity: reference.entity,
    facts,
    sourceReferences: [
      {
        kind: "NORMALIZED_AGGREGATE",
        id: "source-a",
        version: "v1",
        hash: "source-hash",
        binding,
        definitionVersion: "metrics-v1",
        period,
        observedAt: instant,
        measure: null,
      },
    ],
  };
}
function enqueueFixture() {
  return {
    intent: intentFixture(),
    decision: {
      context: {
        schemaVersion: 1,
        actor,
        requestId: "request-a",
        correlationId: result.correlationId,
        event: eventFixture(),
        evidence: { reference, evidence: evidenceFixture() },
      },
      run,
      control: {
        timeDomain: "SECURITY_UTC",
        deadlineAt: "2026-10-25T16:01:00Z",
        signal: new AbortController().signal,
      },
    },
  };
}
const query = { actor, recipient, limit: 25, cursor: null };

it("validates existing PRIMARY decision request without granting current authority", () => {
  const parsed = NotificationEnqueueRequestSchema.parse(enqueueFixture());
  expect(parsed.decision.run.effective.notificationRoute).toBe("DAILY_BRIEF");
  expectTypeOf<NotificationEnqueueRequest["decision"]>().toEqualTypeOf<DecisionOutboxRequest>();
  expect(Object.isFrozen(parsed)).toBe(true);
});

it.each([
  { mode: "SHADOW", effective: null },
  { effective: { ...labels, notificationRoute: "IGNORE" }, overrideReason: "COOLDOWN" },
  {
    result: {
      schemaVersion: 1,
      status: "UNAVAILABLE",
      correlationId: result.correlationId,
      code: "TIMEOUT",
    },
    effective: null,
  },
  { eventId: "event-b" },
  { id: "run-b" },
  { requestId: "request-b" },
  { evidence: { ...reference, hash: "different" } },
  { effective: { ...labels, severity: "HIGH" }, overrideReason: "SEVERITY_FLOOR" },
])("rejects non-authoritative or mismatched routed run %#", (mutation) => {
  const request = enqueueFixture();
  expect(
    NotificationEnqueueRequestSchema.safeParse({
      ...request,
      decision: { ...request.decision, run: { ...run, ...mutation } },
    }).success,
  ).toBe(false);
});

it.each([
  { eventState: "ACKNOWLEDGED" },
  { eventRevision: 2 },
  { route: "NOTIFY_NOW" },
  { recipient: { ...recipient, binding: { ...binding, storeId: "store-b" } } },
])("rejects intent/current event disagreement %#", (mutation) => {
  const request = enqueueFixture();
  const candidate = { ...request.intent, ...mutation };
  const changedIdentity = NotificationIntentIdentitySchema.parse({
    recipient: candidate.recipient,
    eventId: candidate.eventId,
    eventState: candidate.eventState,
    eventRevision: candidate.eventRevision,
    channel: candidate.channel,
  });
  const intent = {
    ...candidate,
    dedupKey: createNotificationIntentKey(changedIdentity),
    evidence: { ...candidate.evidence, binding: candidate.recipient.binding },
  };
  expect(NotificationIntentSchema.safeParse(intent).success).toBe(true);
  expect(NotificationEnqueueRequestSchema.safeParse({ ...request, intent }).success).toBe(false);
});

it("retains source observation independently from true security scheduling", () => {
  const request = enqueueFixture();
  const createdAt = "2026-11-03T01:00:00Z";
  expect(
    NotificationEnqueueRequestSchema.safeParse({
      ...request,
      intent: { ...request.intent, createdAt, notBefore: createdAt },
    }).success,
  ).toBe(true);
  expect(
    NotificationEnqueueRequestSchema.safeParse({
      ...request,
      decision: {
        ...request.decision,
        control: { ...request.decision.control, timeDomain: "BUSINESS" },
      },
    }).success,
  ).toBe(false);
});

it("validates recipient self-read selection and bounded pagination", () => {
  expect(NotificationInboxQuerySchema.safeParse(query).success).toBe(true);
  expect(NotificationPreferencesQuerySchema.safeParse({ actor, recipient }).success).toBe(true);
  expect(
    NotificationMarkReadRequestSchema.safeParse({ actor, recipient, intentId: "intent-a" }).success,
  ).toBe(true);
  expect(
    NotificationBriefQuerySchema.safeParse({
      actor,
      recipient,
      businessDate: "2026-10-25",
      timezone: "Asia/Shanghai",
    }).success,
  ).toBe(true);
});

it.each([
  { limit: 101 },
  { limit: 0.5 },
  { cursor: "x".repeat(1025) },
  { actor: { ...actor, userId: "user-b" } },
  { actor: { ...actor, organizationId: "org-b" } },
  { actor: { ...actor, workspaceId: "workspace-b" } },
  { actor: { ...actor, permissions: [] } },
  { rawContact: "private" },
])("rejects unauthorized or invalid read query %#", (mutation) => {
  expect(NotificationInboxQuerySchema.safeParse({ ...query, ...mutation }).success).toBe(false);
});

it.each([
  {},
  {
    status: "LEASED",
    attempt: 1,
    nextAttemptAt: null,
    leaseToken: "worker-token",
    leaseUntil: "2026-10-25T16:01:00Z",
  },
  { status: "UNKNOWN", attempt: 1, nextAttemptAt: null, readState: "UNKNOWN" },
  { status: "DELIVERED", attempt: 1, nextAttemptAt: null, deliveredAt: instant },
])("rejects internal outbox receipts in public pages %#", (mutation) => {
  const item = { ...receiptFixture(), ...mutation };
  expect(DeliveryReceiptSchema.safeParse(item).success).toBe(true);
  expect(
    NotificationInboxPageSchema.safeParse({ recipient, items: [item], nextCursor: null }).success,
  ).toBe(false);
});

it.each([
  { readState: "UNREAD", readAt: null },
  { readState: "READ", readAt: "2026-10-25T16:01:00Z" },
])("accepts actual delivered recipient projections %#", (mutation) => {
  const item = { ...inboxItemFixture(), ...mutation };
  const parsed = NotificationInboxPageSchema.parse({ recipient, items: [item], nextCursor: null });
  expect(parsed.items[0]).toEqual(item);
  expect(Object.isFrozen(parsed.items[0])).toBe(true);
  expect(Object.isFrozen(parsed.items)).toBe(true);
});

it.each([
  { leaseToken: null },
  { leaseUntil: null },
  { attempt: 1 },
  { nextAttemptAt: null },
  { status: "PENDING" },
  { status: "LEASED" },
  { status: "UNKNOWN" },
  { deliveredAt: null },
  { deliveredAt: "2026-10-25T15:59:00Z" },
  { readState: "UNKNOWN" },
  { readAt: instant },
  { readState: "READ" },
  { readState: "READ", readAt: "2026-10-25T15:59:00Z" },
  { deliveredAt: "2026-10-25T16:01:00Z", readState: "READ", readAt: instant },
])("rejects private fields or invalid public delivery/read state %#", (mutation) => {
  const item = { ...inboxItemFixture(), ...mutation };
  expect(
    NotificationInboxPageSchema.safeParse({ recipient, items: [item], nextCursor: null }).success,
  ).toBe(false);
});

it("requires public inbox items to match the selected recipient", () => {
  const page = { recipient, items: [inboxItemFixture()], nextCursor: null };
  expect(NotificationInboxPageSchema.safeParse(page).success).toBe(true);
  expect(
    NotificationInboxPageSchema.safeParse({
      ...page,
      recipient: { ...recipient, userId: "user-b" },
    }).success,
  ).toBe(false);
});

it.each(["organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId"] as const)(
  "rejects public inbox items from another recipient %s",
  (field) => {
    const selected = { ...recipient, binding: { ...binding, [field]: "different" } };
    expect(
      NotificationInboxPageSchema.safeParse({
        recipient: selected,
        items: [inboxItemFixture()],
        nextCursor: null,
      }).success,
    ).toBe(false);
  },
);

it("returns a strict confirmed read projection from the public markRead port", () => {
  const item = { ...inboxItemFixture(), readState: "READ", readAt: instant };
  const parsed = NotificationReadConfirmationSchema.parse(item);
  expect(parsed).toEqual(item);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(NotificationInboxItemSchema.safeParse(parsed).success).toBe(true);
  type MarkedRead = Extract<Awaited<ReturnType<NotificationReadPort["markRead"]>>, { ok: true }>;
  expectTypeOf<MarkedRead["value"]>().toEqualTypeOf<NotificationReadConfirmation>();
  expectTypeOf<NotificationReadConfirmation["readState"]>().toEqualTypeOf<"READ">();
  expectTypeOf<NotificationReadConfirmation["readAt"]>().toEqualTypeOf<string>();
  expectTypeOf<NotificationInboxItem["status"]>().toEqualTypeOf<"DELIVERED">();
  type PrivateFields = "leaseToken" | "leaseUntil" | "attempt" | "nextAttemptAt";
  expectTypeOf<Extract<keyof NotificationInboxItem, PrivateFields>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof NotificationReadConfirmation, PrivateFields>>().toEqualTypeOf<never>();
  expectTypeOf<NotificationEnqueueOutcome["receipt"]>().toEqualTypeOf<DeliveryReceipt>();
});

it.each([
  {},
  { readState: "UNKNOWN" },
  { readState: "READ" },
  { readState: "READ", readAt: "2026-10-25T15:59:00Z" },
  { deliveredAt: "2026-10-25T16:01:00Z", readState: "READ", readAt: instant },
  { readState: "READ", readAt: instant, leaseToken: "worker-token" },
  { status: "UNKNOWN", readState: "READ", readAt: instant },
])("rejects unread, unconfirmed or private markRead results %#", (mutation) => {
  expect(
    NotificationReadConfirmationSchema.safeParse({ ...inboxItemFixture(), ...mutation }).success,
  ).toBe(false);
});

it("binds preference updates to authorized recipient and compare-and-swap version", () => {
  const update = { actor, recipient, expectedVersion: null, preferences: preferencesFixture() };
  expect(NotificationPreferencesUpdateSchema.safeParse(update).success).toBe(true);
  expect(
    NotificationPreferencesUpdateSchema.safeParse({ ...update, expectedVersion: 1 }).success,
  ).toBe(false);
  expect(
    NotificationPreferencesUpdateSchema.safeParse({
      ...update,
      expectedVersion: 1,
      preferences: { ...preferencesFixture(), version: 2 },
    }).success,
  ).toBe(true);
  expect(
    NotificationPreferencesUpdateSchema.safeParse({
      ...update,
      preferences: { ...preferencesFixture(), recipient: { ...recipient, userId: "user-b" } },
    }).success,
  ).toBe(false);
});

it("requires caller transaction and SecurityClock for enqueue and mutations", () => {
  type Tx = Readonly<{ id: string }>;
  expectTypeOf<Parameters<TransactionalEnqueuePort<Tx>["enqueue"]>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<
    Parameters<TransactionalEnqueuePort<Tx>["enqueue"]>[2]
  >().toEqualTypeOf<SecurityClock>();
  expectTypeOf<Parameters<NotificationReadPort["markRead"]>[1]>().toEqualTypeOf<SecurityClock>();
  expectTypeOf<
    Parameters<NotificationPreferencesPort["update"]>[1]
  >().toEqualTypeOf<SecurityClock>();
});
