import { z } from "zod";
import {
  ConnectorBindingSchema,
  CursorSchema,
  ExternalIdSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import { BasisPointsSchema, MetricSnapshotV1Schema } from "../metrics/metric.schema.js";
import { TenantContextSchema } from "../tenant/tenant.schema.js";
import {
  EventEntitySchema,
  EventCancellationObservationSchema,
  EventEvidenceV1Schema,
  EventMeasureSchema,
  EventPeriodSchema,
  EventQualitySchema,
  EventSourceReferenceSchema,
  EventTimestampSchema,
  EventTypeSchema,
  RobustBaselineV1Schema,
  sameEventBinding,
  sameEventPeriod,
} from "./event-evidence.schema.js";
import type { EventEntity, EventType } from "./event-evidence.schema.js";
import type { ConnectorBinding } from "../commerce/connector-common.schema.js";
import type { MetricSnapshotV1 } from "../metrics/metric.schema.js";

export const EventSeveritySchema = z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const EventStateSchema = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"]);
const revision = QuantitySchema.min(1);
function validEntity(value: {
  readonly eventType: EventType;
  readonly entity: EventEntity;
  readonly binding: ConnectorBinding;
}): boolean {
  switch (value.eventType) {
    case "STOCKOUT_RISK":
    case "INVENTORY_STAGNATION":
    case "PRODUCT_BREAKOUT":
      return value.entity.kind === "SKU";
    case "ROAS_DROP":
    case "AD_SPEND_SPIKE":
      return value.entity.kind === "CAMPAIGN";
    case "SYNC_FAILURE":
      return (
        value.entity.kind === "CONNECTION" &&
        value.entity.connectionId === value.binding.connectionId
      );
    default:
      return value.entity.kind === "STORE" || value.entity.kind === "SKU";
  }
}
export const EventIdentitySchema = z
  .strictObject({
    binding: ConnectorBindingSchema,
    eventType: EventTypeSchema,
    entity: EventEntitySchema,
    baselineVersion: SourceVersionSchema.nullable(),
  })
  .refine(validEntity, "Event entity does not match type/binding")
  .readonly();
export type EventIdentity = z.infer<typeof EventIdentitySchema>;
function entityIdentity(entity: EventEntity, binding: ConnectorBinding): string {
  switch (entity.kind) {
    case "STORE":
      return binding.storeId;
    case "SKU":
      return entity.externalSkuId;
    case "CAMPAIGN":
      return entity.externalCampaignId;
    case "CONNECTION":
      return entity.connectionId;
  }
}
// Parent refinements can run after child custom errors, so serialization must not re-parse.
function serializeEventFingerprint(identity: EventIdentity): string {
  return JSON.stringify([
    "event-fingerprint-v1",
    identity.binding.organizationId,
    identity.binding.workspaceId,
    identity.binding.storeId,
    identity.eventType,
    identity.entity.kind,
    entityIdentity(identity.entity, identity.binding),
    identity.baselineVersion,
  ]);
}
/** Canonical deduplication identity only; this is neither a signature nor an authorization token. */
export function createEventFingerprint(value: EventIdentity): string {
  const identity = EventIdentitySchema.parse({
    binding: value.binding,
    eventType: value.eventType,
    entity: value.entity,
    baselineVersion: value.baselineVersion,
  });
  return serializeEventFingerprint(identity);
}
function sameEntity(left: EventEntity, right: EventEntity, binding: ConnectorBinding): boolean {
  return (
    left.kind === right.kind && entityIdentity(left, binding) === entityIdentity(right, binding)
  );
}
function sameIdentity(left: EventIdentity, right: EventIdentity): boolean {
  return (
    sameEventBinding(left.binding, right.binding) &&
    left.eventType === right.eventType &&
    left.baselineVersion === right.baselineVersion &&
    sameEntity(left.entity, right.entity, left.binding)
  );
}
function allowedSeverity(value: {
  readonly eventType: EventType;
  readonly severityFloor: z.infer<typeof EventSeveritySchema>;
}): boolean {
  return (
    value.eventType !== "PRODUCT_BREAKOUT" ||
    value.severityFloor === "INFO" ||
    value.severityFloor === "LOW"
  );
}
export const EventCandidateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    fingerprint: z.string().min(1).max(4096),
    severityFloor: EventSeveritySchema,
    rulePolicyVersion: SourceVersionSchema,
    evidence: EventEvidenceV1Schema,
  })
  .refine(
    (value) =>
      value.fingerprint === serializeEventFingerprint(value.evidence) &&
      allowedSeverity({ eventType: value.evidence.eventType, severityFloor: value.severityFloor }),
    "Candidate fingerprint or deterministic severity floor disagrees with evidence",
  )
  .readonly();
export const EventEvidenceReferenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: ExternalIdSchema,
    version: SourceVersionSchema,
    hash: ExternalIdSchema,
    binding: ConnectorBindingSchema,
    eventType: EventTypeSchema,
    entity: EventEntitySchema,
    definitionVersion: SourceVersionSchema,
    baselineVersion: SourceVersionSchema.nullable(),
  })
  .refine(validEntity, "Invalid evidence entity")
  .readonly();
export const EventEvidenceRecordSchema = z
  .strictObject({ reference: EventEvidenceReferenceSchema, evidence: EventEvidenceV1Schema })
  .refine(
    ({ reference, evidence }) =>
      sameIdentity(reference, evidence) &&
      reference.definitionVersion === evidence.definitionVersion,
    "Immutable evidence reference does not match evidence scope/type/version",
  )
  .readonly();
const recordFields = {
  schemaVersion: z.literal(1),
  id: ExternalIdSchema,
  binding: ConnectorBindingSchema,
  eventType: EventTypeSchema,
  entity: EventEntitySchema,
  fingerprint: z.string().min(1).max(4096),
  severityFloor: EventSeveritySchema,
  rulePolicyVersion: SourceVersionSchema,
  state: EventStateSchema,
  revision,
  firstSeenAt: EventTimestampSchema,
  lastSeenAt: EventTimestampSchema,
  currentEvidence: EventEvidenceReferenceSchema,
};
export const EventRecordSchema = z
  .strictObject(recordFields)
  .refine(
    (value) =>
      sameEventBinding(value.binding, value.currentEvidence.binding) &&
      value.eventType === value.currentEvidence.eventType &&
      sameEntity(value.entity, value.currentEvidence.entity, value.binding) &&
      allowedSeverity(value) &&
      value.fingerprint === serializeEventFingerprint(value.currentEvidence) &&
      Date.parse(value.firstSeenAt) <= Date.parse(value.lastSeenAt),
    "Event record scope, identity, severity or timestamps disagree",
  )
  .readonly();
const actorSchema = TenantContextSchema.extend({
  permissions: TenantContextSchema.shape.permissions.readonly(),
}).readonly();
const authorizedFields = { actor: actorSchema, binding: ConnectorBindingSchema };
type Authorized =
  z.infer<typeof actorSchema> extends infer A
    ? { readonly actor: A; readonly binding: ConnectorBinding }
    : never;
function sameActorScope(value: Authorized): boolean {
  return (
    value.actor.organizationId === value.binding.organizationId &&
    value.actor.workspaceId === value.binding.workspaceId
  );
}
export const EventTransitionReasonSchema = z.enum([
  "ACKNOWLEDGED_BY_OPERATOR",
  "CONDITION_CLEARED",
  "MANUALLY_RESOLVED",
  "FALSE_POSITIVE",
  "DUPLICATE",
  "MAINTENANCE",
]);
const transitionObject = z.strictObject({
  ...authorizedFields,
  eventId: ExternalIdSchema,
  expectedRevision: revision,
  fromState: EventStateSchema,
  toState: EventStateSchema,
  reason: EventTransitionReasonSchema,
  changedAt: EventTimestampSchema,
});
function validTransition(value: z.infer<typeof transitionObject>): boolean {
  if (
    value.fromState === "RESOLVED" ||
    value.fromState === "SUPPRESSED" ||
    value.fromState === value.toState
  )
    return false;
  if (value.toState === "ACKNOWLEDGED")
    return value.fromState === "OPEN" && value.reason === "ACKNOWLEDGED_BY_OPERATOR";
  if (value.toState === "RESOLVED")
    return value.reason === "CONDITION_CLEARED" || value.reason === "MANUALLY_RESOLVED";
  return (
    value.toState === "SUPPRESSED" &&
    (value.reason === "FALSE_POSITIVE" ||
      value.reason === "DUPLICATE" ||
      value.reason === "MAINTENANCE")
  );
}
/** Host applies this CAS transition and its audit append in one atomic unit of work. */
export const EventStateTransitionSchema = transitionObject
  .refine(sameActorScope, "Authenticated scope mismatch")
  .refine(validTransition, "Invalid lifecycle transition/reason")
  .readonly();
export const EventAppendEvidenceRequestSchema = z
  .strictObject({
    ...authorizedFields,
    candidate: EventCandidateSchema,
    reference: EventEvidenceReferenceSchema,
    expectedRevision: revision.nullable(),
  })
  .refine(sameActorScope, "Authenticated scope mismatch")
  .refine(
    (value) =>
      sameEventBinding(value.binding, value.candidate.evidence.binding) &&
      EventEvidenceRecordSchema.safeParse({
        reference: value.reference,
        evidence: value.candidate.evidence,
      }).success,
    "Append scope or evidence identity mismatch",
  )
  .readonly();
export const EventCurrentQuerySchema = z
  .strictObject({ ...authorizedFields, identity: EventIdentitySchema })
  .refine(sameActorScope, "Authenticated scope mismatch")
  .refine(
    (value) => sameEventBinding(value.binding, value.identity.binding),
    "Current query scope mismatch",
  )
  .readonly();
function uniqueEnumList<T extends z.ZodType>(schema: T, max: number) {
  return z
    .array(schema)
    .max(max)
    .refine((values) => new Set(values).size === values.length, "Duplicate filter")
    .readonly();
}
const pagination = { cursor: CursorSchema.nullable(), limit: z.number().int().min(1).max(100) };
export const EventListQuerySchema = z
  .strictObject({
    ...authorizedFields,
    eventTypes: uniqueEnumList(EventTypeSchema, 12),
    states: uniqueEnumList(EventStateSchema, 4),
    entity: EventEntitySchema.nullable(),
    ...pagination,
  })
  .refine(sameActorScope, "Authenticated scope mismatch")
  .refine(
    (value) =>
      value.entity?.kind !== "CONNECTION" ||
      value.entity.connectionId === value.binding.connectionId,
    "Connection filter scope mismatch",
  )
  .readonly();
const detailFields = { ...authorizedFields, eventId: ExternalIdSchema };
export const EventDetailQuerySchema = z
  .strictObject(detailFields)
  .refine(sameActorScope, "Authenticated scope mismatch")
  .readonly();
export const EventEvidenceQuerySchema = z
  .strictObject({ ...detailFields, reference: EventEvidenceReferenceSchema })
  .refine(sameActorScope, "Authenticated scope mismatch")
  .refine(
    (value) => sameEventBinding(value.binding, value.reference.binding),
    "Evidence query scope mismatch",
  )
  .readonly();
export const EventHistoryQuerySchema = z
  .strictObject({ ...detailFields, ...pagination })
  .refine(sameActorScope, "Authenticated scope mismatch")
  .readonly();
const hours = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const ruleQuality = {
  minimumSampleSize: QuantitySchema,
  minimumCoverageBasisPoints: BasisPointsSchema,
  maximumAgeSeconds: QuantitySchema,
  minimumBaselineSamples: QuantitySchema,
  requireAlignedBaseline: z.boolean(),
  toleranceBasisPoints: BasisPointsSchema,
};
function rule<const K extends EventType, T extends z.ZodRawShape>(eventType: K, thresholds: T) {
  return z
    .strictObject({
      eventType: z.literal(eventType),
      ...ruleQuality,
      thresholds: z.strictObject(thresholds).readonly(),
    })
    .readonly();
}
export const EventRuleSchema = z.discriminatedUnion("eventType", [
  rule("STOCKOUT_RISK", { criticalHoursRemaining: hours, leadTimeBufferHours: hours }),
  rule("INVENTORY_STAGNATION", {
    minimumHoldingDays: hours,
    minimumDemandCoverageDays: hours,
    minimumListingAgeHours: hours,
  }),
  rule("REFUND_SPIKE", {
    relativeIncreaseBasisPoints: QuantitySchema,
    minimumRefundedOrders: QuantitySchema,
    maturityHours: hours,
  }),
  rule("CANCELLED_ORDER_SPIKE", {
    relativeIncreaseBasisPoints: QuantitySchema,
    minimumCancelledOrders: QuantitySchema,
  }),
  rule("PROFIT_MARGIN_DROP", {
    relativeDropBasisPoints: BasisPointsSchema,
    minimumDropMinor: QuantitySchema,
  }),
  rule("UNUSUAL_DISCOUNT", {
    discountBasisPoints: BasisPointsSchema,
    minimumDiscountMinor: QuantitySchema,
  }),
  rule("ROAS_DROP", {
    relativeDropBasisPoints: BasisPointsSchema,
    minimumSpendMinor: QuantitySchema,
    minimumAttributionCoverageBasisPoints: BasisPointsSchema,
  }),
  rule("AD_SPEND_SPIKE", {
    relativeIncreaseBasisPoints: QuantitySchema,
    minimumSpendMinor: QuantitySchema,
  }),
  rule("CONVERSION_DROP", {
    relativeDropBasisPoints: BasisPointsSchema,
    minimumVisitors: QuantitySchema,
  }),
  rule("PRODUCT_BREAKOUT", {
    relativeGrowthBasisPoints: QuantitySchema,
    minimumSalesUnits: QuantitySchema,
    minimumConversionBasisPoints: BasisPointsSchema,
  }),
  rule("SYNC_FAILURE", { maximumLagSeconds: QuantitySchema }),
  rule("REVENUE_DROP", {
    relativeDropBasisPoints: BasisPointsSchema,
    minimumDropMinor: QuantitySchema,
  }),
]);
/** Trusted, server-owned versioned input; registration and detector strategy live downstream. */
export const EventRulePolicyV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    version: SourceVersionSchema,
    baselineVersion: SourceVersionSchema,
    rules: z
      .array(EventRuleSchema)
      .min(1)
      .max(12)
      .refine(
        (values) => new Set(values.map((value) => value.eventType)).size === values.length,
        "Duplicate event policy",
      )
      .readonly(),
  })
  .readonly();
function snapshotSubjectMatches(snapshot: MetricSnapshotV1, entity: EventEntity): boolean {
  return entity.kind !== "CONNECTION" && sameEntity(snapshot.subject, entity, snapshot.binding);
}
function validSnapshotTime(snapshot: MetricSnapshotV1, observedAt: string): boolean {
  const times = [
    snapshot.periodStart,
    snapshot.periodEnd,
    snapshot.visibleAt,
    snapshot.computedAt,
    snapshot.sourceWatermark,
  ];
  return times.every(
    (time) =>
      time === null ||
      (EventTimestampSchema.safeParse(time).success && Date.parse(time) <= Date.parse(observedAt)),
  );
}
const baselineRequestObject = z.strictObject({
  binding: ConnectorBindingSchema,
  eventType: EventTypeSchema,
  entity: EventEntitySchema,
  period: EventPeriodSchema,
  observedAt: EventTimestampSchema,
  definitionVersion: SourceVersionSchema,
  baselineVersion: SourceVersionSchema,
  measure: EventMeasureSchema,
  candidates: z.array(MetricSnapshotV1Schema).max(1000).readonly(),
  sourceReferences: z.array(EventSourceReferenceSchema).max(1000).readonly(),
  normalizedObservations: z
    .array(EventCancellationObservationSchema)
    .max(1000)
    .readonly()
    .optional(),
});
type BaselineInput = z.infer<typeof baselineRequestObject>;
function exactObservationReference(
  left: z.infer<typeof EventSourceReferenceSchema>,
  right: z.infer<typeof EventSourceReferenceSchema>,
): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.version === right.version &&
    left.hash === right.hash &&
    sameEventBinding(left.binding, right.binding) &&
    left.definitionVersion === right.definitionVersion &&
    sameEventPeriod(left.period, right.period) &&
    Date.parse(left.observedAt) === Date.parse(right.observedAt) &&
    left.measure?.kind === right.measure?.kind &&
    left.measure?.unit === right.measure?.unit
  );
}
function validNormalizedObservations(value: BaselineInput): boolean {
  const observations = value.normalizedObservations ?? [];
  if (value.measure.kind === "CANCELLED_ORDER_RATE" && value.eventType !== "CANCELLED_ORDER_SPIKE")
    return false;
  if (value.normalizedObservations === undefined) return true;
  return (
    value.eventType === "CANCELLED_ORDER_SPIKE" &&
    value.measure.kind === "CANCELLED_ORDER_RATE" &&
    observations.every(
      (item) =>
        sameEventBinding(item.reference.binding, value.binding) &&
        item.reference.definitionVersion === value.definitionVersion &&
        sameEntity(item.entity, value.entity, value.binding) &&
        Date.parse(item.reference.observedAt) <= Date.parse(value.observedAt) &&
        value.sourceReferences.some((ref) => exactObservationReference(ref, item.reference)),
    )
  );
}
function validBaselineRequest(value: z.infer<typeof baselineRequestObject>): boolean {
  return (
    validEntity(value) &&
    validNormalizedObservations(value) &&
    Date.parse(value.period.periodEnd) <= Date.parse(value.observedAt) &&
    value.sourceReferences.every(
      (ref) =>
        sameEventBinding(ref.binding, value.binding) &&
        ref.definitionVersion === value.definitionVersion &&
        ref.measure?.kind === value.measure.kind &&
        ref.measure?.unit === value.measure.unit &&
        Date.parse(ref.observedAt) <= Date.parse(value.observedAt),
    ) &&
    value.candidates.every(
      (snapshot) =>
        sameEventBinding(snapshot.binding, value.binding) &&
        snapshot.definitionVersion === value.definitionVersion &&
        snapshotSubjectMatches(snapshot, value.entity) &&
        snapshot.metric.kind === value.measure.kind &&
        snapshot.metric.unit === value.measure.unit &&
        validSnapshotTime(snapshot, value.observedAt) &&
        value.sourceReferences.some(
          (ref) =>
            sameEventBinding(ref.binding, value.binding) &&
            ref.definitionVersion === value.definitionVersion &&
            ref.version === snapshot.inputRevision &&
            ref.measure?.kind === value.measure.kind &&
            ref.measure?.unit === value.measure.unit &&
            sameEventPeriod(ref.period, snapshot) &&
            Date.parse(ref.observedAt) <= Date.parse(value.observedAt),
        ),
    )
  );
}
export const BaselineRequestSchema = baselineRequestObject
  .refine(
    validBaselineRequest,
    "Baseline candidate scope, measure, definition or observation mismatch",
  )
  .readonly();
const detectionRequestObject = z.strictObject({
  evidence: EventEvidenceV1Schema,
  snapshots: z.array(MetricSnapshotV1Schema).max(200).readonly(),
  baseline: RobustBaselineV1Schema.nullable(),
  policy: EventRulePolicyV1Schema,
});
function validDetectionRequest(value: z.infer<typeof detectionRequestObject>): boolean {
  const evidence = value.evidence;
  const baseline = value.baseline;
  if (
    value.policy.baselineVersion !== evidence.baselineVersion &&
    evidence.baselineVersion !== null
  )
    return false;
  if (!value.policy.rules.some((entry) => entry.eventType === evidence.eventType)) return false;
  if (JSON.stringify(baseline) !== JSON.stringify(evidence.baseline)) return false;
  return value.snapshots.every(
    (snapshot) =>
      sameEventBinding(snapshot.binding, evidence.binding) &&
      snapshot.definitionVersion === evidence.definitionVersion &&
      sameEventPeriod(snapshot, evidence) &&
      snapshotSubjectMatches(snapshot, evidence.entity) &&
      validSnapshotTime(snapshot, evidence.observedAt) &&
      evidence.sourceReferences.some(
        (ref) =>
          ref.version === snapshot.inputRevision &&
          ref.measure?.kind === snapshot.metric.kind &&
          ref.measure?.unit === snapshot.metric.unit,
      ),
  );
}
export const EventDetectionRequestSchema = detectionRequestObject
  .refine(validDetectionRequest, "Detector scope, baseline, snapshot or policy mismatch")
  .readonly();
export const EventResourceKindSchema = z.enum([
  "PRODUCTS",
  "ORDERS",
  "REFUNDS",
  "INVENTORY",
  "MARKETING",
]);
const outcomeFields = {
  quality: EventQualitySchema,
  blockedResources: uniqueEnumList(EventResourceKindSchema, 5),
};
export const EventDetectionOutcomeSchema = z.discriminatedUnion("disposition", [
  z
    .strictObject({
      disposition: z.literal("CANDIDATE"),
      candidate: EventCandidateSchema,
      ...outcomeFields,
    })
    .readonly(),
  z
    .strictObject({
      disposition: z.literal("NO_CANDIDATE"),
      reason: z.enum([
        "BELOW_THRESHOLD",
        "INSUFFICIENT_EVIDENCE",
        "STALE_SOURCE",
        "BASELINE_UNAVAILABLE",
        "NORMAL_SEASONALITY",
        "SOURCE_CONFLICT",
      ]),
      ...outcomeFields,
    })
    .readonly(),
]);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;
export type EventState = z.infer<typeof EventStateSchema>;
export type EventCandidate = z.infer<typeof EventCandidateSchema>;
export type EventEvidenceReference = z.infer<typeof EventEvidenceReferenceSchema>;
export type EventEvidenceRecord = z.infer<typeof EventEvidenceRecordSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type EventStateTransition = z.infer<typeof EventStateTransitionSchema>;
export type EventAppendEvidenceRequest = z.infer<typeof EventAppendEvidenceRequestSchema>;
export type EventCurrentQuery = z.infer<typeof EventCurrentQuerySchema>;
export type EventListQuery = z.infer<typeof EventListQuerySchema>;
export type EventDetailQuery = z.infer<typeof EventDetailQuerySchema>;
export type EventEvidenceQuery = z.infer<typeof EventEvidenceQuerySchema>;
export type EventHistoryQuery = z.infer<typeof EventHistoryQuerySchema>;
export type EventRulePolicyV1 = z.infer<typeof EventRulePolicyV1Schema>;
export type BaselineRequest = z.infer<typeof BaselineRequestSchema>;
export type EventDetectionRequest = z.infer<typeof EventDetectionRequestSchema>;
export type EventDetectionOutcome = z.infer<typeof EventDetectionOutcomeSchema>;
