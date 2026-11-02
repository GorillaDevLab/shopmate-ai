import { expect, it } from "vitest";
import {
  createNotificationIntentKey,
  DailyBriefSchema,
  DeliveryReceiptSchema,
  NotificationIntentSchema,
  NotificationPreferencesSchema,
  NotificationRecipientSchema,
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

it("allows signed known profit when measured quality permits it", () => {
  const quality = { dataStatus: "VERIFIED", sampleSize: 1, coverageBasisPoints: 10000, issues: [] };
  expect(
    DailyBriefSchema.safeParse({
      ...briefFixture(),
      profitMinor: -150,
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
