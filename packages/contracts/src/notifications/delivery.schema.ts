import { z } from "zod";
import {
  ConnectorBindingSchema,
  CursorSchema,
  ExternalIdSchema,
  QuantitySchema,
} from "../commerce/connector-common.schema.js";
import {
  EventPeriodSchema,
  EventQualitySchema,
  EventTimestampSchema,
  EventTypeSchema,
  sameEventBinding,
} from "../events/event-evidence.schema.js";
import {
  EventEvidenceReferenceSchema,
  EventSeveritySchema,
  EventStateSchema,
} from "../events/event.schema.js";
import { SignedMinorSchema } from "../metrics/metric.schema.js";
import {
  EvaluationContextSchema,
  RoutedPrimaryDecisionRunSchema,
  sameDecisionEvidence,
} from "../decisions/decision.schema.js";
import { DecisionControlSchema } from "../decisions/decision-provider.js";
import type { DecisionOutboxRequest, SecurityClock } from "../decisions/decision-ports.js";
import { TenantContextSchema, TenantIdSchema } from "../tenant/tenant.schema.js";

const version = QuantitySchema.min(1);
export const NotificationRecipientSchema = z
  .strictObject({ binding: ConnectorBindingSchema, userId: TenantIdSchema })
  .readonly();
const identityFields = {
  recipient: NotificationRecipientSchema,
  eventId: ExternalIdSchema,
  eventState: EventStateSchema,
  eventRevision: version,
  channel: z.literal("IN_APP"),
};
export const NotificationIntentIdentitySchema = z.strictObject(identityFields).readonly();
export type NotificationIntentIdentity = z.infer<typeof NotificationIntentIdentitySchema>;
function serializeIntentKey(value: NotificationIntentIdentity): string {
  const { binding, userId } = value.recipient;
  return JSON.stringify([
    "notification-intent-v1",
    binding.organizationId,
    binding.workspaceId,
    binding.storeId,
    binding.connectionId,
    binding.externalStoreId,
    value.eventId,
    value.eventState,
    value.eventRevision,
    userId,
    value.channel,
  ]);
}
/** Stable idempotency identity only; never an authorization token or a title fingerprint. */
export function createNotificationIntentKey(value: NotificationIntentIdentity): string {
  return serializeIntentKey(NotificationIntentIdentitySchema.parse(value));
}
export const NotificationDeliveryRouteSchema = z.enum(["DAILY_BRIEF", "NOTIFY_NOW", "ESCALATE"]);
const summarySchema = z
  .strictObject({ eventType: EventTypeSchema, severity: EventSeveritySchema })
  .readonly();
export const NotificationIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: ExternalIdSchema,
    ...identityFields,
    evidence: EventEvidenceReferenceSchema,
    decisionRunId: ExternalIdSchema,
    route: NotificationDeliveryRouteSchema,
    createdAt: EventTimestampSchema,
    notBefore: EventTimestampSchema,
    dedupKey: z.string().min(1).max(4096),
    summary: summarySchema,
  })
  .refine(
    (value) =>
      sameEventBinding(value.recipient.binding, value.evidence.binding) &&
      value.summary.eventType === value.evidence.eventType &&
      value.dedupKey === serializeIntentKey(value) &&
      Date.parse(value.createdAt) <= Date.parse(value.notBefore),
    "Notification identity, evidence or schedule mismatch",
  )
  .readonly();
export type NotificationIntent = z.infer<typeof NotificationIntentSchema>;
export type NotificationRecipient = z.infer<typeof NotificationRecipientSchema>;
export type NotificationDeliveryRoute = z.infer<typeof NotificationDeliveryRouteSchema>;

function validTimezone(value: string): boolean {
  // Fixed offsets are not IANA zones and cannot express daylight-saving transitions.
  if (!/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
export const NotificationTimezoneSchema = z.string().min(1).max(128).refine(validTimezone);
export const NotificationQuietHoursSchema = z
  .strictObject({
    timezone: NotificationTimezoneSchema,
    startMinute: QuantitySchema.max(1439),
    endMinute: QuantitySchema.max(1439),
  })
  .refine((value) => value.startMinute !== value.endMinute, "Ambiguous quiet-hour window")
  .readonly();
export const NotificationPreferencesSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    recipient: NotificationRecipientSchema,
    version,
    notifications: z.enum(["ALL", "DAILY_ONLY", "NONE"]),
    quietHours: NotificationQuietHoursSchema.nullable(),
    cooldownSeconds: QuantitySchema.max(604800),
  })
  .readonly();
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type NotificationQuietHours = z.infer<typeof NotificationQuietHoursSchema>;

const briefEventSchema = z
  .strictObject({
    eventId: ExternalIdSchema,
    state: EventStateSchema,
    revision: version,
    evidence: EventEvidenceReferenceSchema,
    severity: EventSeveritySchema,
  })
  .readonly();
const briefObject = z.strictObject({
  schemaVersion: z.literal(1),
  id: ExternalIdSchema,
  binding: ConnectorBindingSchema,
  businessDate: z.iso.date(),
  timezone: NotificationTimezoneSchema,
  version,
  evidenceHash: ExternalIdSchema,
  observedAt: EventTimestampSchema,
  sourceWatermark: EventTimestampSchema.nullable(),
  period: EventPeriodSchema,
  quality: EventQualitySchema,
  profitMinor: SignedMinorSchema.nullable(),
  evidence: z.array(EventEvidenceReferenceSchema).min(1).max(100).readonly(),
  events: z.array(briefEventSchema).max(100).readonly(),
});
type BriefObject = z.infer<typeof briefObject>;
function localDateTime(value: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
function validBriefWindow(value: BriefObject): boolean {
  if (value.timezone !== value.period.timezone) return false;
  const start = Date.parse(value.period.periodStart);
  const end = Date.parse(value.period.periodEnd);
  return (
    start % 1000 === 0 &&
    end % 1000 === 0 &&
    localDateTime(start, value.timezone) === `${value.businessDate}T00:00:00` &&
    localDateTime(end, value.timezone).endsWith("T00:00:00") &&
    localDateTime(end - 1, value.timezone).startsWith(`${value.businessDate}T`) &&
    end <= Date.parse(value.observedAt) &&
    (value.sourceWatermark === null ||
      Date.parse(value.sourceWatermark) <= Date.parse(value.observedAt))
  );
}
function validBriefQuality(value: BriefObject): boolean {
  // Missing cost inputs keep profit unknown regardless of aggregate status or field alias.
  if (
    value.profitMinor !== null &&
    value.quality.issues.some((issue) => issue.code === "COST_MISSING")
  )
    return false;
  const status = value.quality.dataStatus;
  if (status === "UNAVAILABLE" || status === "INSUFFICIENT") return value.profitMinor === null;
  if (status !== "VERIFIED") return true;
  return (
    value.profitMinor !== null &&
    value.sourceWatermark !== null &&
    Date.parse(value.sourceWatermark) >= Date.parse(value.period.periodEnd)
  );
}
function validBriefReferences(value: BriefObject): boolean {
  const unique = new Set(value.evidence.map((ref) => JSON.stringify([ref.id, ref.version])));
  return (
    unique.size === value.evidence.length &&
    new Set(value.events.map((event) => event.eventId)).size === value.events.length &&
    value.evidence.every((ref) => sameEventBinding(value.binding, ref.binding)) &&
    value.events.every((event) =>
      value.evidence.some((ref) => sameDecisionEvidence(event.evidence, ref)),
    ) &&
    value.quality.issues.every((issue) =>
      issue.evidenceIds.every((id) => value.evidence.some((ref) => ref.id === id)),
    )
  );
}
export const DailyBriefSchema = briefObject
  .refine(validBriefWindow, "Brief business day or source window mismatch")
  .refine(validBriefQuality, "Brief profit must retain measured quality and unknown values")
  .refine(validBriefReferences, "Brief evidence scope or immutable reference mismatch")
  .readonly();
export type DailyBrief = z.infer<typeof DailyBriefSchema>;

const receiptFields = {
  schemaVersion: z.literal(1),
  intent: NotificationIntentSchema,
  attempt: QuantitySchema,
  nextAttemptAt: EventTimestampSchema.nullable(),
  leaseToken: ExternalIdSchema.nullable(),
  leaseUntil: EventTimestampSchema.nullable(),
  deliveredAt: EventTimestampSchema.nullable(),
  readAt: EventTimestampSchema.nullable(),
  readState: z.enum(["UNREAD", "READ", "UNKNOWN"]),
};
const receiptObject = z.discriminatedUnion("status", [
  z.strictObject({ ...receiptFields, status: z.literal("PENDING") }),
  z.strictObject({ ...receiptFields, status: z.literal("LEASED") }),
  z.strictObject({ ...receiptFields, status: z.literal("DELIVERED") }),
  z.strictObject({ ...receiptFields, status: z.literal("FAILED") }),
  z.strictObject({ ...receiptFields, status: z.literal("UNKNOWN") }),
]);
type ReceiptObject = z.infer<typeof receiptObject>;
function validReceiptState(value: ReceiptObject): boolean {
  if (value.status !== "PENDING" && value.attempt === 0) return false;
  if (value.status === "LEASED") {
    if (value.leaseToken === null || value.leaseUntil === null || value.nextAttemptAt !== null)
      return false;
  } else if (value.leaseToken !== null || value.leaseUntil !== null) return false;
  if (value.status === "PENDING" && value.nextAttemptAt === null) return false;
  if (value.status === "DELIVERED")
    return (
      value.deliveredAt !== null &&
      value.nextAttemptAt === null &&
      (value.readState === "READ"
        ? value.readAt !== null
        : value.readState === "UNREAD" && value.readAt === null)
    );
  return (
    value.deliveredAt === null &&
    value.readAt === null &&
    value.readState === (value.status === "UNKNOWN" ? "UNKNOWN" : "UNREAD")
  );
}
function validReceiptTimes(value: ReceiptObject): boolean {
  const floor = Date.parse(value.intent.notBefore);
  return (
    (value.nextAttemptAt === null || Date.parse(value.nextAttemptAt) >= floor) &&
    (value.leaseUntil === null || Date.parse(value.leaseUntil) > floor) &&
    (value.deliveredAt === null || Date.parse(value.deliveredAt) >= floor) &&
    (value.readAt === null ||
      (value.deliveredAt !== null && Date.parse(value.readAt) >= Date.parse(value.deliveredAt)))
  );
}
/** UNKNOWN records uncertain delivery; only a confirmed DELIVERED receipt can be read. */
export const DeliveryReceiptSchema = receiptObject
  .refine(validReceiptState, "Delivery state, lease, attempt or read state mismatch")
  .refine(validReceiptTimes, "Delivery timestamps precede their scheduling boundary")
  .readonly();
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

const inboxItemObject = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("DELIVERED"),
  intent: NotificationIntentSchema,
  deliveredAt: EventTimestampSchema,
  readAt: EventTimestampSchema.nullable(),
  readState: z.enum(["UNREAD", "READ"]),
});
function validInboxItem(value: z.infer<typeof inboxItemObject>): boolean {
  return (
    Date.parse(value.deliveredAt) >= Date.parse(value.intent.notBefore) &&
    (value.readState === "UNREAD"
      ? value.readAt === null
      : value.readAt !== null && Date.parse(value.readAt) >= Date.parse(value.deliveredAt))
  );
}
const deliveredInboxItem = inboxItemObject.refine(
  validInboxItem,
  "Inbox delivery or confirmed read timestamp mismatch",
);
/** Recipient projection intentionally excludes all internal worker scheduling and lease fields. */
export const NotificationInboxItemSchema = deliveredInboxItem.readonly();
export type NotificationInboxItem = z.infer<typeof NotificationInboxItemSchema>;
export const NotificationReadConfirmationSchema = deliveredInboxItem
  .safeExtend({ readState: z.literal("READ"), readAt: EventTimestampSchema })
  .readonly();
export type NotificationReadConfirmation = z.infer<typeof NotificationReadConfirmationSchema>;

const decisionOutboxRequestSchema = z
  .strictObject({
    context: EvaluationContextSchema,
    run: RoutedPrimaryDecisionRunSchema,
    control: DecisionControlSchema,
  })
  .readonly();
const enqueueObject = z.strictObject({
  intent: NotificationIntentSchema,
  decision: decisionOutboxRequestSchema,
});
function consistentEnqueue(value: z.infer<typeof enqueueObject>): boolean {
  const {
    intent,
    decision: { context, run },
  } = value;
  // Zod parent refinements may still run after a child refinement rejected its authority.
  if (run.mode !== "PRIMARY" || run.result.status !== "EVALUATED" || run.effective === null)
    return false;
  return (
    sameEventBinding(intent.recipient.binding, context.event.binding) &&
    intent.eventId === context.event.id &&
    intent.eventState === context.event.state &&
    intent.eventRevision === context.event.revision &&
    intent.decisionRunId === run.id &&
    run.eventId === context.event.id &&
    run.requestId === context.requestId &&
    run.result.correlationId === context.correlationId &&
    sameDecisionEvidence(intent.evidence, context.evidence.reference) &&
    sameDecisionEvidence(run.evidence, intent.evidence) &&
    intent.route === run.effective.notificationRoute &&
    intent.summary.severity === run.effective.severity
  );
}
/** Structural agreement only. Repository must recheck current membership and effective winning run. */
export const NotificationEnqueueRequestSchema = enqueueObject
  .refine(consistentEnqueue, "Notification does not match the current routed PRIMARY input")
  .readonly();
export type NotificationEnqueueRequest = Readonly<{
  intent: NotificationIntent;
  decision: DecisionOutboxRequest;
}>;
export type NotificationPortError = "INVALID_INPUT" | "FORBIDDEN" | "CONFLICT" | "UNAVAILABLE";
export type NotificationPortResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; code: NotificationPortError }
>;
export type NotificationEnqueueOutcome = Readonly<{
  outcome: "ENQUEUED" | "DEDUPLICATED";
  receipt: DeliveryReceipt;
}>;
/** Caller owns transaction lifetime and rollback; errors abort its complete business unit. */
export interface TransactionalEnqueuePort<TTransaction> {
  readonly enqueue: (
    transaction: TTransaction,
    request: NotificationEnqueueRequest,
    clock: SecurityClock,
  ) => Promise<NotificationPortResult<NotificationEnqueueOutcome>>;
}

const actorSchema = TenantContextSchema.extend({
  permissions: TenantContextSchema.shape.permissions.readonly(),
}).readonly();
const authorizedFields = { actor: actorSchema, recipient: NotificationRecipientSchema };
type Selection =
  z.infer<typeof actorSchema> extends infer A
    ? Readonly<{ actor: A; recipient: NotificationRecipient }>
    : never;
function authorizedSelection(value: Selection): boolean {
  return (
    value.actor.userId === value.recipient.userId &&
    value.actor.organizationId === value.recipient.binding.organizationId &&
    value.actor.workspaceId === value.recipient.binding.workspaceId &&
    value.actor.permissions.includes("tenant:read")
  );
}
export const NotificationPreferencesQuerySchema = z
  .strictObject(authorizedFields)
  .refine(authorizedSelection, "Authenticated recipient scope mismatch")
  .readonly();
export const NotificationInboxQuerySchema = z
  .strictObject({
    ...authorizedFields,
    limit: QuantitySchema.min(1).max(100),
    cursor: CursorSchema.nullable(),
  })
  .refine(authorizedSelection, "Authenticated recipient scope mismatch")
  .readonly();
export const NotificationMarkReadRequestSchema = z
  .strictObject({
    ...authorizedFields,
    intentId: ExternalIdSchema,
  })
  .refine(authorizedSelection, "Authenticated recipient scope mismatch")
  .readonly();
export const NotificationBriefQuerySchema = z
  .strictObject({
    ...authorizedFields,
    businessDate: z.iso.date(),
    timezone: NotificationTimezoneSchema,
  })
  .refine(authorizedSelection, "Authenticated recipient scope mismatch")
  .readonly();
function sameRecipient(left: NotificationRecipient, right: NotificationRecipient): boolean {
  return left.userId === right.userId && sameEventBinding(left.binding, right.binding);
}
export const NotificationInboxPageSchema = z
  .strictObject({
    recipient: NotificationRecipientSchema,
    items: z.array(NotificationInboxItemSchema).max(100).readonly(),
    nextCursor: CursorSchema.nullable(),
  })
  .refine(
    (value) => value.items.every((item) => sameRecipient(value.recipient, item.intent.recipient)),
    "Inbox contains another recipient",
  )
  .readonly();
export const NotificationPreferencesUpdateSchema = z
  .strictObject({
    ...authorizedFields,
    expectedVersion: version.nullable(),
    preferences: NotificationPreferencesSchema,
  })
  .refine(authorizedSelection, "Authenticated recipient scope mismatch")
  .refine(
    (value) =>
      sameRecipient(value.recipient, value.preferences.recipient) &&
      value.preferences.version ===
        (value.expectedVersion === null ? 1 : value.expectedVersion + 1),
    "Preference recipient or revision mismatch",
  )
  .readonly();

export type NotificationPreferencesQuery = z.infer<typeof NotificationPreferencesQuerySchema>;
export type NotificationInboxQuery = z.infer<typeof NotificationInboxQuerySchema>;
export type NotificationMarkReadRequest = z.infer<typeof NotificationMarkReadRequestSchema>;
export type NotificationBriefQuery = z.infer<typeof NotificationBriefQuerySchema>;
export type NotificationInboxPage = z.infer<typeof NotificationInboxPageSchema>;
export type NotificationPreferencesUpdate = z.infer<typeof NotificationPreferencesUpdateSchema>;
/** Implementations recheck current recipient membership; failures never become an empty inbox. */
export interface NotificationReadPort {
  readonly list: (
    query: NotificationInboxQuery,
  ) => Promise<NotificationPortResult<NotificationInboxPage>>;
  readonly readBrief: (
    query: NotificationBriefQuery,
  ) => Promise<NotificationPortResult<DailyBrief | null>>;
  readonly markRead: (
    request: NotificationMarkReadRequest,
    clock: SecurityClock,
  ) => Promise<NotificationPortResult<NotificationReadConfirmation>>;
}
export interface NotificationPreferencesPort {
  readonly read: (
    query: NotificationPreferencesQuery,
  ) => Promise<NotificationPortResult<NotificationPreferences | null>>;
  readonly update: (
    request: NotificationPreferencesUpdate,
    clock: SecurityClock,
  ) => Promise<NotificationPortResult<NotificationPreferences>>;
}
