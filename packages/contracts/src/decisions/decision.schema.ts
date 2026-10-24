import { z } from "zod";
import {
  ExternalIdSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import {
  BasisPointsSchema,
  MetricIssueCodeSchema,
  MetricStatusSchema,
} from "../metrics/metric.schema.js";
import {
  EventEvidenceV1Schema,
  EventPeriodSchema,
  EventTimestampSchema,
  RobustBaselineV1Schema,
  sameEventBinding,
} from "../events/event-evidence.schema.js";
import {
  EventEvidenceRecordSchema,
  EventEvidenceReferenceSchema,
  EventRecordSchema,
  EventSeveritySchema,
} from "../events/event.schema.js";
import type { EventEvidenceReference } from "../events/event.schema.js";
import { TenantContextSchema } from "../tenant/tenant.schema.js";

export const NotificationRouteSchema = z.enum(["IGNORE", "DAILY_BRIEF", "NOTIFY_NOW", "ESCALATE"]);
export const LLMEscalationSchema = z.enum([
  "NO_LLM_NEEDED",
  "SIMPLE_EXPLANATION",
  "DEEP_REASONING_REQUIRED",
]);
export const EvidenceSufficiencySchema = z.enum(["SUFFICIENT", "INSUFFICIENT_DATA", "AMBIGUOUS"]);
export const AttentionPrioritySchema = z.enum([
  "LOW_PRIORITY",
  "NORMAL_PRIORITY",
  "HIGH_PRIORITY",
  "URGENT",
]);
export const DecisionReasonCodeSchema = z.enum([
  "CONFIRMED_STOCKOUT",
  "INVENTORY_COVERAGE_LOW",
  "INVENTORY_STAGNATION",
  "REFUND_RATE_HIGH",
  "REFUND_CONCENTRATION",
  "CANCELLATION_RATE_HIGH",
  "PROFIT_MARGIN_DROP",
  "DISCOUNT_HIGH",
  "ROAS_LOW",
  "AD_SPEND_HIGH",
  "CONVERSION_DROP",
  "PRODUCT_BREAKOUT",
  "REVENUE_DROP",
  "SYNC_FAILURE",
  "INSUFFICIENT_SAMPLE",
  "MISSING_DATA",
  "PARTIAL_COVERAGE",
  "STALE_DATA",
  "CONFLICTING_DATA",
  "ZERO_BASELINE",
  "NORMAL_SEASONALITY",
  "NO_MATERIAL_CHANGE",
]);
function uniqueList<T extends z.ZodType>(schema: T, maximum: number) {
  return z
    .array(schema)
    .max(maximum)
    .refine((items) => new Set(items).size === items.length, "Duplicate code")
    .readonly();
}
export const DecisionLabelsSchema = z
  .strictObject({
    severity: EventSeveritySchema,
    notificationRoute: NotificationRouteSchema,
    llmEscalation: LLMEscalationSchema,
    evidenceSufficiency: EvidenceSufficiencySchema,
    attentionPriority: AttentionPrioritySchema,
    reasonCodes: uniqueList(
      DecisionReasonCodeSchema,
      DecisionReasonCodeSchema.options.length,
    ).refine((codes) => codes.length > 0),
  })
  .readonly();

/** Host classification of adapter acceptance, never vendor confidence or evidence sufficiency. */
export const DecisionConfidenceMetadataSchema = z
  .strictObject({
    kind: z.literal("HOST_ACCEPTANCE"),
    value: z.boolean(),
    semanticsVersion: z.literal("host-acceptance-v1"),
    calibrationVersion: z.null(),
  })
  .readonly()
  .nullable();
export const DecisionProviderDescriptorSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    version: SourceVersionSchema,
    supportedInputVersions: z.tuple([z.literal(1)]).readonly(),
  })
  .readonly();
export const DecisionCorrelationIdSchema = z.uuid();
const resultFields = { schemaVersion: z.literal(1), correlationId: DecisionCorrelationIdSchema };
export const DecisionUnavailableCodeSchema = z.enum([
  "TIMEOUT",
  "ABORTED",
  "PROVIDER_FAILURE",
  "INVALID_RESULT",
  "UNSUPPORTED_SCHEMA",
]);
export const DecisionResultSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      ...resultFields,
      status: z.literal("EVALUATED"),
      rulesetVersion: SourceVersionSchema,
      labels: DecisionLabelsSchema,
      confidenceMetadata: DecisionConfidenceMetadataSchema,
    })
    .readonly(),
  z
    .strictObject({
      ...resultFields,
      status: z.literal("UNAVAILABLE"),
      code: DecisionUnavailableCodeSchema,
    })
    .readonly(),
]);

const variants = EventEvidenceV1Schema.unwrap().options;
const baselineVariants = RobustBaselineV1Schema.options;
const baselineMask = {
  status: true,
  alignment: true,
  measure: true,
  aggregation: true,
  period: true,
  median: true,
  mad: true,
  sampleSize: true,
  coverageBasisPoints: true,
} as const;
/** Explicit projection of the frozen baseline contract; no reference IDs or merchant identifiers. */
export const SanitizedDecisionBaselineSchema = z
  .union([
    z
      .strictObject(baselineVariants[0].unwrap().shape)
      .pick(baselineMask)
      .refine((value) => value.median !== 0)
      .readonly(),
    baselineVariants[1].unwrap().pick(baselineMask).readonly(),
    baselineVariants[2].unwrap().pick(baselineMask).readonly(),
  ])
  .refine((value) => {
    if (value.alignment === "ALIGNED" && value.period === null) return false;
    if (value.status === "MISSING") return value.alignment === "MISSING" && value.period === null;
    return value.status !== "UNALIGNED" || value.alignment === "UNALIGNED";
  }, "Projected baseline status, alignment or period mismatch")
  .nullable();
const sanitizedFields = {
  ...resultFields,
  period: EventPeriodSchema,
  observedAt: EventTimestampSchema,
  sourceWatermark: EventTimestampSchema.nullable(),
  dataStatus: MetricStatusSchema,
  sampleSize: QuantitySchema,
  coverageBasisPoints: BasisPointsSchema,
  qualityReasons: uniqueList(MetricIssueCodeSchema, MetricIssueCodeSchema.options.length),
  baseline: SanitizedDecisionBaselineSchema,
};
function safeVariant<K extends z.ZodType, F extends z.ZodType>(eventType: K, facts: F) {
  return z.strictObject({ ...sanitizedFields, eventType, facts }).readonly();
}
// Explicit masks prevent a future internal evidence field from silently becoming provider-visible.
const stockoutFacts = z
  .strictObject(variants[0].unwrap().shape.facts.unwrap().shape)
  .pick({
    availableUnits: true,
    salesUnits: true,
    salesWindow: true,
    salesWindowHours: true,
    estimatedHoursRemaining: true,
    supplierLeadTimeHours: true,
    safetyBufferHours: true,
    inboundETA: true,
    inventoryObservedAt: true,
    inventoryAgeSeconds: true,
    inventoryStatus: true,
  })
  .refine((value) => value.inventoryStatus !== "VERIFIED" || value.availableUnits !== null)
  .readonly();
const stagnationFacts = variants[1]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    availableUnits: true,
    salesUnits: true,
    salesWindow: true,
    salesWindowHours: true,
    holdingDays: true,
    demandCoverageDays: true,
    listedAt: true,
    inventoryCostMinor: true,
    costCoverageBasisPoints: true,
  })
  .readonly();
const sanitizedRefundFacts = variants[2]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    paymentCohort: true,
    observedThrough: true,
    maturityHours: true,
    paidCohortOrders: true,
    refundedOrders: true,
    currentRate: true,
    baselineRate: true,
    affectedSkuShare: true,
    reasonCounts: true,
  })
  .readonly();
const cancellationFacts = variants[3]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    cohort: true,
    cohortOrders: true,
    paidCancelledOrders: true,
    pendingCancelledOrders: true,
    currentRate: true,
    baselineRate: true,
    reasonCounts: true,
  })
  .readonly();
const sanitizedFinancialFacts = variants[4]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    paidRevenueMinor: true,
    netRevenueMinor: true,
    grossMerchandiseMinor: true,
    grossProfitMinor: true,
    contributionMinor: true,
    discountMinor: true,
    spendMinor: true,
    costCoverageBasisPoints: true,
    feeCoverageBasisPoints: true,
    profitDeltaMinor: true,
    contributions: true,
    discountRate: true,
    promotionPeriod: true,
  })
  .readonly();
const marketingFacts = variants[6]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    spendMinor: true,
    attributedRevenueMinor: true,
    impressions: true,
    clicks: true,
    attributedOrders: true,
    attributionCoverageBasisPoints: true,
    roas: true,
  })
  .readonly();
const conversionFacts = variants[8]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    visitors: true,
    cart: true,
    checkout: true,
    paidOrders: true,
    conversion: true,
    baselineConversion: true,
    priceChangeBasisPoints: true,
    priceEffectiveAt: true,
    variantAvailabilityBasisPoints: true,
    relationship: true,
  })
  .readonly();
const breakoutFacts = variants[9]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    salesUnits: true,
    salesWindow: true,
    salesWindowHours: true,
    salesUnitsPerHour: true,
    conversion: true,
    grossProfitMinor: true,
    netRevenueMinor: true,
    costCoverageBasisPoints: true,
    listedAt: true,
  })
  .readonly();
const syncFacts = variants[10]
  .unwrap()
  .shape.facts.unwrap()
  .pick({
    lastSuccessAt: true,
    lagSeconds: true,
    typedErrorCode: true,
    affectedResourceKind: true,
  })
  .readonly();
const sanitizedInput = z.discriminatedUnion("eventType", [
  safeVariant(variants[0].unwrap().shape.eventType, stockoutFacts),
  safeVariant(variants[1].unwrap().shape.eventType, stagnationFacts),
  safeVariant(variants[2].unwrap().shape.eventType, sanitizedRefundFacts),
  safeVariant(variants[3].unwrap().shape.eventType, cancellationFacts),
  safeVariant(variants[4].unwrap().shape.eventType, sanitizedFinancialFacts),
  safeVariant(variants[5].unwrap().shape.eventType, sanitizedFinancialFacts),
  safeVariant(variants[6].unwrap().shape.eventType, marketingFacts),
  safeVariant(variants[7].unwrap().shape.eventType, marketingFacts),
  safeVariant(variants[8].unwrap().shape.eventType, conversionFacts),
  safeVariant(variants[9].unwrap().shape.eventType, breakoutFacts),
  safeVariant(variants[10].unwrap().shape.eventType, syncFacts),
  safeVariant(variants[11].unwrap().shape.eventType, sanitizedFinancialFacts),
]);
export const SanitizedDecisionInputSchema = sanitizedInput.refine(
  (value) =>
    Date.parse(value.period.periodEnd) <= Date.parse(value.observedAt) &&
    (value.sourceWatermark === null ||
      Date.parse(value.sourceWatermark) <= Date.parse(value.observedAt)) &&
    (value.dataStatus === "VERIFIED"
      ? value.coverageBasisPoints === 10000 &&
        value.qualityReasons.length === 0 &&
        value.sourceWatermark !== null &&
        Date.parse(value.sourceWatermark) >= Date.parse(value.period.periodEnd)
      : value.qualityReasons.length > 0),
  "Invalid observed input or missing quality limitations",
);

// Frozen upstream validators may reject arithmetic via a thrown error; untrusted boundaries must fail closed.
function nonthrowing<T extends z.ZodType>(schema: T) {
  return z.unknown().transform((value, context): z.output<T> => {
    try {
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      context.addIssue({ code: "custom", message: "Malformed nested contract" });
      return z.NEVER;
    }
    context.addIssue({ code: "custom", message: "Invalid nested contract" });
    return z.NEVER;
  });
}
/** All five binding fields and immutable identity/version/hash must agree. Not an authorization check. */
export function sameDecisionEvidence(
  left: EventEvidenceReference,
  right: EventEvidenceReference,
): boolean {
  return (
    sameEventBinding(left.binding, right.binding) &&
    left.id === right.id &&
    left.version === right.version &&
    left.hash === right.hash &&
    left.definitionVersion === right.definitionVersion &&
    left.baselineVersion === right.baselineVersion &&
    left.eventType === right.eventType &&
    JSON.stringify(left.entity) === JSON.stringify(right.entity)
  );
}
const actorSchema = TenantContextSchema.extend({
  permissions: TenantContextSchema.shape.permissions.readonly(),
}).readonly();
const contextObject = z.strictObject({
  schemaVersion: z.literal(1),
  actor: actorSchema,
  requestId: ExternalIdSchema,
  correlationId: DecisionCorrelationIdSchema,
  event: nonthrowing(EventRecordSchema),
  evidence: nonthrowing(EventEvidenceRecordSchema),
});
export const EvaluationContextSchema = contextObject
  .refine((value) => {
    const event = EventRecordSchema.safeParse(value.event);
    const evidence = EventEvidenceRecordSchema.safeParse(value.evidence);
    if (!event.success || !evidence.success) return false;
    return (
      value.actor.organizationId === event.data.binding.organizationId &&
      value.actor.workspaceId === event.data.binding.workspaceId &&
      sameDecisionEvidence(event.data.currentEvidence, evidence.data.reference)
    );
  }, "Authenticated event/evidence scope or identity mismatch")
  .readonly();

export const DecisionOverrideReasonSchema = z.enum([
  "SEVERITY_FLOOR",
  "INSUFFICIENT_EVIDENCE",
  "SECURITY_POLICY",
  "QUIET_HOURS",
  "COOLDOWN",
  "NOTIFICATION_PREFERENCE",
  "LLM_BUDGET",
  "PROVIDER_UNAVAILABLE",
]);
const runFields = {
  schemaVersion: z.literal(1),
  id: ExternalIdSchema,
  eventId: ExternalIdSchema,
  decisionKey: ExternalIdSchema,
  requestId: ExternalIdSchema,
  evidence: EventEvidenceReferenceSchema,
  provider: DecisionProviderDescriptorSchema,
  rulesetVersion: SourceVersionSchema,
  fallbackOf: ExternalIdSchema.nullable(),
  result: DecisionResultSchema,
  latencyMs: QuantitySchema,
  createdAt: EventTimestampSchema,
};
const primaryRun = z
  .strictObject({
    ...runFields,
    mode: z.literal("PRIMARY"),
    effective: DecisionLabelsSchema.nullable(),
    overrideReason: DecisionOverrideReasonSchema.nullable(),
  })
  .readonly();
const shadowRun = z
  .strictObject({
    ...runFields,
    mode: z.literal("SHADOW"),
    effective: z.null(),
    overrideReason: z.null(),
  })
  .readonly();
const runUnion = z.discriminatedUnion("mode", [primaryRun, shadowRun]);
function validRun(value: z.infer<typeof runUnion>): boolean {
  if (value.fallbackOf === value.id) return false;
  if (value.mode === "SHADOW" && value.fallbackOf !== null) return false;
  if (value.result.status === "EVALUATED" && value.result.rulesetVersion !== value.rulesetVersion)
    return false;
  if (value.mode === "SHADOW") return true;
  if (value.result.status === "UNAVAILABLE")
    return value.effective === null && value.overrideReason === null;
  if (value.effective === null) return false;
  return (
    JSON.stringify(value.effective) === JSON.stringify(value.result.labels) ||
    value.overrideReason !== null
  );
}
export const DecisionRunSchema = runUnion.refine(
  validRun,
  "Invalid run authority, result version or fallback link",
);
export const PrimaryDecisionRunSchema = DecisionRunSchema.refine(
  (value) => value.mode === "PRIMARY",
).transform((value) => (value.mode === "PRIMARY" ? value : z.NEVER));
export const ShadowDecisionRunSchema = DecisionRunSchema.refine(
  (value) => value.mode === "SHADOW",
).transform((value) => (value.mode === "SHADOW" ? value : z.NEVER));
export const RoutedPrimaryDecisionRunSchema = PrimaryDecisionRunSchema.refine(
  (value) => value.result.status === "EVALUATED" && value.effective !== null,
  "Only an evaluated PRIMARY can produce product side effects",
).transform((value) => {
  if (value.result.status !== "EVALUATED" || value.effective === null) return z.NEVER;
  return Object.freeze({ ...value, result: value.result, effective: value.effective });
});
export const DecisionDifferenceSchema = z.enum([
  "SEVERITY",
  "NOTIFICATION_ROUTE",
  "LLM_ESCALATION",
  "EVIDENCE_SUFFICIENCY",
  "ATTENTION_PRIORITY",
  "REASON_CODES",
]);
export const ShadowComparisonSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    primary: PrimaryDecisionRunSchema,
    shadow: ShadowDecisionRunSchema,
    evaluationVersion: SourceVersionSchema,
    differences: uniqueList(DecisionDifferenceSchema, 6),
  })
  .refine(
    (value) =>
      value.primary.id !== value.shadow.id &&
      value.primary.eventId === value.shadow.eventId &&
      value.primary.decisionKey === value.shadow.decisionKey &&
      sameDecisionEvidence(value.primary.evidence, value.shadow.evidence) &&
      value.primary.result.correlationId === value.shadow.result.correlationId &&
      value.primary.result.status === "EVALUATED" &&
      value.shadow.result.status === "EVALUATED",
    "Comparison requires evaluated same-scope/evidence PRIMARY and SHADOW runs",
  )
  .readonly();

const ruleFields = {
  minimumSampleSize: QuantitySchema,
  minimumCoverageBasisPoints: BasisPointsSchema,
  maximumAgeSeconds: QuantitySchema,
  minimumBaselineSamples: QuantitySchema,
};
export const DecisionRulesetV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    version: SourceVersionSchema,
    defaultLabels: DecisionLabelsSchema,
    inventory: z
      .strictObject({
        ...ruleFields,
        eventType: z.literal("STOCKOUT_RISK"),
        criticalHoursRemaining: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
        labels: DecisionLabelsSchema,
      })
      .readonly(),
    refund: z
      .strictObject({
        ...ruleFields,
        eventType: z.literal("REFUND_SPIKE"),
        relativeIncreaseBasisPoints: QuantitySchema,
        minimumRefundedOrders: QuantitySchema,
        labels: DecisionLabelsSchema,
      })
      .readonly(),
  })
  .readonly();

export type NotificationRoute = z.infer<typeof NotificationRouteSchema>;
export type LLMEscalation = z.infer<typeof LLMEscalationSchema>;
export type EvidenceSufficiency = z.infer<typeof EvidenceSufficiencySchema>;
export type AttentionPriority = z.infer<typeof AttentionPrioritySchema>;
export type DecisionReasonCode = z.infer<typeof DecisionReasonCodeSchema>;
export type DecisionLabels = z.infer<typeof DecisionLabelsSchema>;
export type DecisionConfidenceMetadata = z.infer<typeof DecisionConfidenceMetadataSchema>;
export type DecisionProviderDescriptor = z.infer<typeof DecisionProviderDescriptorSchema>;
export type DecisionResult = z.infer<typeof DecisionResultSchema>;
export type DecisionUnavailableCode = z.infer<typeof DecisionUnavailableCodeSchema>;
export type DecisionCorrelationId = z.infer<typeof DecisionCorrelationIdSchema>;
export type SanitizedDecisionBaseline = z.infer<typeof SanitizedDecisionBaselineSchema>;
export type SanitizedDecisionInput = z.infer<typeof SanitizedDecisionInputSchema>;
export type EvaluationContext = z.infer<typeof EvaluationContextSchema>;
export type DecisionOverrideReason = z.infer<typeof DecisionOverrideReasonSchema>;
export type DecisionRun = z.infer<typeof DecisionRunSchema>;
export type PrimaryDecisionRun = z.infer<typeof PrimaryDecisionRunSchema>;
export type ShadowDecisionRun = z.infer<typeof ShadowDecisionRunSchema>;
export type RoutedPrimaryDecisionRun = z.infer<typeof RoutedPrimaryDecisionRunSchema>;
export type ShadowComparison = z.infer<typeof ShadowComparisonSchema>;
export type DecisionDifference = z.infer<typeof DecisionDifferenceSchema>;
export type DecisionRulesetV1 = z.infer<typeof DecisionRulesetV1Schema>;
