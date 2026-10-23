import { z } from "zod";
import {
  ConnectorBindingSchema,
  ExternalIdSchema,
  MinorAmountSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import type { ConnectorBinding } from "../commerce/connector-common.schema.js";
import {
  BasisPointsSchema,
  DataQualityIssueV1Schema,
  MetricStatusSchema,
  MetricValueSchema,
  SignedMinorSchema,
} from "../metrics/metric.schema.js";

/** UTC instants must be exactly representable in milliseconds; opaque IDs never use this schema. */
export const EventTimestampSchema = z.iso.datetime().refine((value) => {
  const fraction = /\.(\d+)Z$/u.exec(value)?.[1];
  return fraction === undefined || !/[1-9]/u.test(fraction.slice(3));
}, "Timestamp exceeds millisecond precision");
export const EventTypeSchema = z.enum([
  "STOCKOUT_RISK",
  "INVENTORY_STAGNATION",
  "REFUND_SPIKE",
  "CANCELLED_ORDER_SPIKE",
  "PROFIT_MARGIN_DROP",
  "UNUSUAL_DISCOUNT",
  "ROAS_DROP",
  "AD_SPEND_SPIKE",
  "CONVERSION_DROP",
  "PRODUCT_BREAKOUT",
  "SYNC_FAILURE",
  "REVENUE_DROP",
]);
const storeEntity = z.strictObject({ kind: z.literal("STORE") }).readonly();
const skuEntity = z
  .strictObject({ kind: z.literal("SKU"), externalSkuId: ExternalIdSchema })
  .readonly();
const campaignEntity = z
  .strictObject({ kind: z.literal("CAMPAIGN"), externalCampaignId: ExternalIdSchema })
  .readonly();
const connectionEntity = z
  .strictObject({ kind: z.literal("CONNECTION"), connectionId: ExternalIdSchema })
  .readonly();
export const EventEntitySchema = z.discriminatedUnion("kind", [
  storeEntity,
  skuEntity,
  campaignEntity,
  connectionEntity,
]);
const businessEntity = z.union([storeEntity, skuEntity]);
export const EventPeriodSchema = z
  .strictObject({
    periodStart: EventTimestampSchema,
    periodEnd: EventTimestampSchema,
    timezone: z.literal("Asia/Shanghai"),
    currency: z.literal("CNY"),
  })
  .refine(
    (value) => Date.parse(value.periodStart) < Date.parse(value.periodEnd),
    "Invalid half-open period",
  )
  .readonly();
export type EventPeriod = z.infer<typeof EventPeriodSchema>;
export function sameEventBinding(left: ConnectorBinding, right: ConnectorBinding): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.workspaceId === right.workspaceId &&
    left.storeId === right.storeId &&
    left.connectionId === right.connectionId &&
    left.externalStoreId === right.externalStoreId
  );
}
export function sameEventPeriod(left: EventPeriod, right: EventPeriod): boolean {
  return (
    Date.parse(left.periodStart) === Date.parse(right.periodStart) &&
    Date.parse(left.periodEnd) === Date.parse(right.periodEnd) &&
    left.timezone === right.timezone &&
    left.currency === right.currency
  );
}
export const EventMeasureSchema = z.union(
  MetricValueSchema.options.map((option) => option.unwrap().omit({ value: true }).readonly()),
);
export const EventSourceReferenceSchema = z
  .strictObject({
    kind: z.enum(["METRIC_SNAPSHOT", "NORMALIZED_AGGREGATE"]),
    id: ExternalIdSchema,
    version: SourceVersionSchema,
    hash: ExternalIdSchema,
    binding: ConnectorBindingSchema,
    definitionVersion: SourceVersionSchema,
    period: EventPeriodSchema,
    observedAt: EventTimestampSchema,
    measure: EventMeasureSchema.nullable(),
  })
  .refine(
    (value) => Date.parse(value.period.periodEnd) <= Date.parse(value.observedAt),
    "Reference is not observed",
  )
  .refine(
    (value) => value.kind !== "METRIC_SNAPSHOT" || value.measure !== null,
    "Metric reference requires typed measure",
  )
  .readonly();
export const EventSourceReferencesSchema = z
  .array(EventSourceReferenceSchema)
  .min(1)
  .max(200)
  .refine(
    (refs) =>
      new Set(refs.map((ref) => JSON.stringify([ref.kind, ref.id, ref.version]))).size ===
      refs.length,
    "Duplicate immutable reference",
  )
  .readonly();
const ratioFields = {
  numerator: QuantitySchema.nullable(),
  denominator: QuantitySchema.nullable(),
  valueBasisPoints: QuantitySchema.nullable(),
  period: EventPeriodSchema,
};
type RatioFields = {
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly valueBasisPoints: number | null;
};
function exactRatio(value: RatioFields): boolean {
  if (value.numerator === null || value.denominator === null || value.denominator === 0)
    return value.valueBasisPoints === null;
  if (value.valueBasisPoints === null) return false;
  const scaled = BigInt(value.numerator) * 10000n;
  const base = BigInt(value.denominator);
  const expected = scaled / base + ((scaled % base) * 2n >= base ? 1n : 0n);
  return expected === BigInt(value.valueBasisPoints);
}
export const EventRateSchema = z
  .strictObject({ ...ratioFields, valueBasisPoints: BasisPointsSchema.nullable() })
  .refine(
    (value) =>
      value.numerator === null ||
      value.denominator === null ||
      value.denominator === 0 ||
      value.numerator <= value.denominator,
    "Probability numerator cannot exceed a positive denominator",
  )
  .refine(
    exactRatio,
    "Rate must equal the exact rounded ratio, or null for missing/zero denominator",
  )
  .readonly();
/** ROAS is a scaled multiplier, not a probability: 3x is 30000. */
export const EventRoasSchema = z
  .strictObject(ratioFields)
  .refine(exactRatio, "Invalid exact ROAS ratio")
  .readonly();
export const EventQualitySchema = z
  .strictObject({
    dataStatus: MetricStatusSchema,
    sampleSize: QuantitySchema,
    coverageBasisPoints: BasisPointsSchema,
    issues: z.array(DataQualityIssueV1Schema).max(100).readonly(),
  })
  .refine(
    (value) =>
      value.dataStatus === "VERIFIED"
        ? value.coverageBasisPoints === 10000 && value.issues.length === 0
        : value.issues.length > 0,
    "Quality must retain status and limitations",
  )
  .readonly();
const finiteHours = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const baselineFields = {
  alignment: z.literal("ALIGNED"),
  measure: EventMeasureSchema,
  aggregation: z.literal("EXACT_MEDIAN"),
  version: SourceVersionSchema,
  period: EventPeriodSchema,
  median: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  mad: finiteHours,
  sampleSize: QuantitySchema.min(1),
  coverageBasisPoints: BasisPointsSchema,
  sourceReferences: EventSourceReferencesSchema,
};
const baselineUnion = z.discriminatedUnion("status", [
  z
    .strictObject({ ...baselineFields, status: z.literal("AVAILABLE") })
    .refine((value) => value.median !== 0, "Zero baseline has an explicit state")
    .readonly(),
  z.strictObject({ ...baselineFields, status: z.literal("ZERO"), median: z.literal(0) }).readonly(),
  z
    .strictObject({
      status: z.enum(["MISSING", "UNALIGNED", "INSUFFICIENT", "STALE"]),
      alignment: z.enum(["ALIGNED", "MISSING", "UNALIGNED"]),
      measure: EventMeasureSchema,
      aggregation: z.literal("EXACT_MEDIAN"),
      version: SourceVersionSchema,
      period: EventPeriodSchema.nullable(),
      median: z.null(),
      mad: z.null(),
      sampleSize: QuantitySchema,
      coverageBasisPoints: BasisPointsSchema,
      sourceReferences: z.array(EventSourceReferenceSchema).max(200).readonly(),
    })
    .readonly(),
]);
const signedBaselineKinds = new Set([
  "NET_REVENUE_SETTLEMENT",
  "NET_MERCHANDISE_REVENUE",
  "GROSS_PROFIT",
  "CONTRIBUTION",
  "ESTIMATED_NET_PROFIT",
  "PROFIT_DELTA",
]);
function validBaselineDomain(value: z.infer<typeof baselineUnion>): boolean {
  if (value.alignment === "ALIGNED" && value.period === null) return false;
  if (value.status === "MISSING" && (value.alignment !== "MISSING" || value.period !== null))
    return false;
  if (value.status === "UNALIGNED" && value.alignment !== "UNALIGNED") return false;
  if (value.median === null) return true;
  if (!signedBaselineKinds.has(value.measure.kind) && value.median < 0) return false;
  return (
    value.measure.unit !== "basisPoints" ||
    value.measure.kind === "ROAS" ||
    (value.median <= 10000 && value.mad <= 10000)
  );
}
export const RobustBaselineV1Schema = baselineUnion.refine(
  validBaselineDomain,
  "Baseline measure domain mismatch",
);
const stockoutFacts = z
  .strictObject({
    availableUnits: QuantitySchema.nullable(),
    salesUnits: QuantitySchema.nullable(),
    salesWindow: EventPeriodSchema,
    salesWindowHours: finiteHours.positive(),
    estimatedHoursRemaining: finiteHours.nullable(),
    supplierLeadTimeHours: finiteHours.nullable(),
    safetyBufferHours: finiteHours.nullable(),
    inboundETA: EventTimestampSchema.nullable(),
    inventoryObservedAt: EventTimestampSchema.nullable(),
    inventoryAgeSeconds: QuantitySchema.nullable(),
    inventoryStatus: MetricStatusSchema,
  })
  .refine(
    (value) => value.inventoryStatus !== "VERIFIED" || value.availableUnits !== null,
    "Verified inventory requires known availability",
  )
  .readonly();
const stagnationFacts = z
  .strictObject({
    availableUnits: QuantitySchema.nullable(),
    salesUnits: QuantitySchema.nullable(),
    salesWindow: EventPeriodSchema,
    salesWindowHours: finiteHours.positive(),
    holdingDays: finiteHours.nullable(),
    demandCoverageDays: finiteHours.nullable(),
    listedAt: EventTimestampSchema.nullable(),
    inventoryCostMinor: MinorAmountSchema.nullable(),
    costCoverageBasisPoints: BasisPointsSchema,
  })
  .readonly();
export const EventRefundReasonSchema = z.enum([
  "QUALITY",
  "NOT_AS_DESCRIBED",
  "LOGISTICS",
  "BUYER_REMORSE",
  "OTHER",
  "UNKNOWN",
]);
export const EventCancellationReasonSchema = z.enum([
  "BUYER_REQUEST",
  "PAYMENT_TIMEOUT",
  "OUT_OF_STOCK",
  "MERCHANT_CANCELLED",
  "OTHER",
  "UNKNOWN",
]);
const refundFacts = z
  .strictObject({
    paymentCohort: EventPeriodSchema,
    observedThrough: EventTimestampSchema,
    maturityHours: finiteHours,
    paidCohortOrders: QuantitySchema.nullable(),
    refundedOrders: QuantitySchema.nullable(),
    currentRate: EventRateSchema,
    baselineRate: EventRateSchema.nullable(),
    affectedSkuShare: EventRateSchema,
    reasonCounts: z
      .array(z.strictObject({ reason: EventRefundReasonSchema, count: QuantitySchema }).readonly())
      .max(6)
      .refine(
        (items) => new Set(items.map((item) => item.reason)).size === items.length,
        "Duplicate refund reason",
      )
      .readonly(),
    skuConcentration: z
      .array(
        z
          .strictObject({ externalSkuId: ExternalIdSchema, refundedOrders: QuantitySchema })
          .readonly(),
      )
      .max(100)
      .readonly(),
  })
  .readonly();
const cancellationFacts = z
  .strictObject({
    cohort: EventPeriodSchema,
    cohortOrders: QuantitySchema.nullable(),
    paidCancelledOrders: QuantitySchema.nullable(),
    pendingCancelledOrders: QuantitySchema.nullable(),
    currentRate: EventRateSchema,
    baselineRate: EventRateSchema.nullable(),
    reasonCounts: z
      .array(
        z.strictObject({ reason: EventCancellationReasonSchema, count: QuantitySchema }).readonly(),
      )
      .max(6)
      .refine(
        (items) => new Set(items.map((item) => item.reason)).size === items.length,
        "Duplicate cancellation reason",
      )
      .readonly(),
  })
  .readonly();
export const EventProfitComponentSchema = z.enum([
  "VOLUME",
  "PRICE_DISCOUNT",
  "SKU_MIX",
  "COGS",
  "ADVERTISING",
  "RESIDUAL",
]);
const financialFacts = z
  .strictObject({
    paidRevenueMinor: MinorAmountSchema.nullable(),
    netRevenueMinor: SignedMinorSchema.nullable(),
    grossMerchandiseMinor: MinorAmountSchema.nullable(),
    grossProfitMinor: SignedMinorSchema.nullable(),
    contributionMinor: SignedMinorSchema.nullable(),
    discountMinor: MinorAmountSchema.nullable(),
    spendMinor: MinorAmountSchema.nullable(),
    costCoverageBasisPoints: BasisPointsSchema,
    feeCoverageBasisPoints: BasisPointsSchema,
    profitDeltaMinor: SignedMinorSchema.nullable(),
    attributionVersion: SourceVersionSchema.nullable(),
    contributions: z
      .array(
        z
          .strictObject({
            kind: EventProfitComponentSchema,
            amountMinor: SignedMinorSchema.nullable(),
          })
          .readonly(),
      )
      .max(6)
      .readonly(),
    skuContributions: z
      .array(
        z
          .strictObject({
            externalSkuId: ExternalIdSchema,
            revenueMinor: SignedMinorSchema.nullable(),
            profitDeltaMinor: SignedMinorSchema.nullable(),
          })
          .readonly(),
      )
      .max(100)
      .readonly(),
    discountRate: EventRateSchema,
    promotionPeriod: EventPeriodSchema.nullable(),
  })
  .readonly();
const marketingFacts = z
  .strictObject({
    spendMinor: MinorAmountSchema.nullable(),
    attributedRevenueMinor: MinorAmountSchema.nullable(),
    impressions: QuantitySchema.nullable(),
    clicks: QuantitySchema.nullable(),
    attributedOrders: QuantitySchema.nullable(),
    attributionCoverageBasisPoints: BasisPointsSchema,
    roas: EventRoasSchema,
  })
  .readonly();
const conversionFacts = z
  .strictObject({
    visitors: QuantitySchema.nullable(),
    cart: QuantitySchema.nullable(),
    checkout: QuantitySchema.nullable(),
    paidOrders: QuantitySchema.nullable(),
    conversion: EventRateSchema,
    baselineConversion: EventRateSchema.nullable(),
    priceChangeBasisPoints: SignedMinorSchema.nullable(),
    priceEffectiveAt: EventTimestampSchema.nullable(),
    variantAvailabilityBasisPoints: BasisPointsSchema.nullable(),
    relationship: z.literal("CORRELATION_ONLY"),
  })
  .readonly();
const breakoutFacts = z
  .strictObject({
    salesUnits: QuantitySchema.nullable(),
    salesWindow: EventPeriodSchema,
    salesWindowHours: finiteHours.positive(),
    salesUnitsPerHour: finiteHours.nullable(),
    conversion: EventRateSchema,
    grossProfitMinor: SignedMinorSchema.nullable(),
    netRevenueMinor: SignedMinorSchema.nullable(),
    costCoverageBasisPoints: BasisPointsSchema,
    listedAt: EventTimestampSchema.nullable(),
  })
  .readonly();
const syncFacts = z
  .strictObject({
    lastSuccessAt: EventTimestampSchema.nullable(),
    lagSeconds: QuantitySchema.nullable(),
    typedErrorCode: z.enum([
      "TIMEOUT",
      "RATE_LIMIT",
      "AUTH_EXPIRED",
      "PERMISSION_DENIED",
      "TEMPORARY",
      "INVALID_RESPONSE",
      "NOT_SYNCHRONIZED",
    ]),
    affectedResourceKind: z.enum(["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]),
  })
  .readonly();
const commonFields = {
  schemaVersion: z.literal(1),
  binding: ConnectorBindingSchema,
  periodStart: EventTimestampSchema,
  periodEnd: EventTimestampSchema,
  timezone: z.literal("Asia/Shanghai"),
  currency: z.literal("CNY"),
  observedAt: EventTimestampSchema,
  sourceWatermark: EventTimestampSchema.nullable(),
  ...EventQualitySchema.unwrap().shape,
  definitionVersion: SourceVersionSchema,
  baselineVersion: SourceVersionSchema.nullable(),
  baselineAlignment: z.enum(["ALIGNED", "MISSING", "UNALIGNED"]),
  baseline: RobustBaselineV1Schema.nullable(),
  sourceReferences: EventSourceReferencesSchema,
};
function evidenceVariant<const K extends string, E extends z.ZodType, F extends z.ZodType>(
  eventType: K,
  entity: E,
  facts: F,
) {
  return z
    .strictObject({ ...commonFields, eventType: z.literal(eventType), entity, facts })
    .readonly();
}
const evidenceUnion = z.discriminatedUnion("eventType", [
  evidenceVariant("STOCKOUT_RISK", skuEntity, stockoutFacts),
  evidenceVariant("INVENTORY_STAGNATION", skuEntity, stagnationFacts),
  evidenceVariant("REFUND_SPIKE", businessEntity, refundFacts),
  evidenceVariant("CANCELLED_ORDER_SPIKE", businessEntity, cancellationFacts),
  evidenceVariant("PROFIT_MARGIN_DROP", businessEntity, financialFacts),
  evidenceVariant("UNUSUAL_DISCOUNT", businessEntity, financialFacts),
  evidenceVariant("ROAS_DROP", campaignEntity, marketingFacts),
  evidenceVariant("AD_SPEND_SPIKE", campaignEntity, marketingFacts),
  evidenceVariant("CONVERSION_DROP", businessEntity, conversionFacts),
  evidenceVariant("PRODUCT_BREAKOUT", skuEntity, breakoutFacts),
  evidenceVariant("SYNC_FAILURE", connectionEntity, syncFacts),
  evidenceVariant("REVENUE_DROP", businessEntity, financialFacts),
]);
type Evidence = z.infer<typeof evidenceUnion>;
function referenceMatches(
  ref: z.infer<typeof EventSourceReferenceSchema>,
  value: Evidence,
  period: EventPeriod,
): boolean {
  return (
    sameEventBinding(ref.binding, value.binding) &&
    ref.definitionVersion === value.definitionVersion &&
    sameEventPeriod(ref.period, period) &&
    Date.parse(ref.observedAt) <= Date.parse(value.observedAt)
  );
}
function alignedPeriod(current: EventPeriod, baseline: EventPeriod): boolean {
  const startDelta = Date.parse(current.periodStart) - Date.parse(baseline.periodStart);
  const endDelta = Date.parse(current.periodEnd) - Date.parse(baseline.periodEnd);
  return startDelta > 0 && startDelta === endDelta && startDelta % (7 * 86400000) === 0;
}
function validBaseline(value: Evidence): boolean {
  const baseline = value.baseline;
  if (baseline === null)
    return value.baselineVersion === null && value.baselineAlignment === "MISSING";
  if (value.baselineVersion !== baseline.version || value.baselineAlignment !== baseline.alignment)
    return false;
  if (baseline.alignment === "ALIGNED")
    return (
      baseline.period !== null &&
      alignedPeriod(value, baseline.period) &&
      baseline.sourceReferences.every(
        (ref) =>
          referenceMatches(ref, value, ref.period) &&
          alignedPeriod(value, ref.period) &&
          ref.measure?.kind === baseline.measure.kind &&
          ref.measure?.unit === baseline.measure.unit,
      )
    );
  return baseline.sourceReferences.every(
    (ref) =>
      sameEventBinding(ref.binding, value.binding) &&
      ref.definitionVersion === value.definitionVersion &&
      Date.parse(ref.observedAt) <= Date.parse(value.observedAt),
  );
}
function validCommon(value: Evidence): boolean {
  const observed = Date.parse(value.observedAt);
  if (
    Date.parse(value.periodStart) >= Date.parse(value.periodEnd) ||
    Date.parse(value.periodEnd) > observed
  )
    return false;
  if (value.sourceWatermark !== null && Date.parse(value.sourceWatermark) > observed) return false;
  if (
    !EventQualitySchema.safeParse({
      dataStatus: value.dataStatus,
      sampleSize: value.sampleSize,
      coverageBasisPoints: value.coverageBasisPoints,
      issues: value.issues,
    }).success
  )
    return false;
  if (
    value.dataStatus === "VERIFIED" &&
    (value.sourceWatermark === null ||
      Date.parse(value.sourceWatermark) < Date.parse(value.periodEnd))
  )
    return false;
  return (
    value.sourceReferences.every((ref) => referenceMatches(ref, value, value)) &&
    validBaseline(value)
  );
}
function ratioMatches(
  ratio: z.infer<typeof EventRoasSchema>,
  numerator: number | null,
  denominator: number | null,
  period: EventPeriod,
): boolean {
  return (
    ratio.numerator === numerator &&
    ratio.denominator === denominator &&
    sameEventPeriod(ratio.period, period)
  );
}
function baselineRateMatches(
  ratio: z.infer<typeof EventRateSchema> | null,
  value: Evidence,
): boolean {
  if (ratio === null) return true;
  return (
    value.baseline !== null &&
    value.baseline.period !== null &&
    sameEventPeriod(ratio.period, value.baseline.period)
  );
}
function observedBefore(value: Evidence, times: readonly (string | null)[]): boolean {
  return times.every((time) => time === null || Date.parse(time) <= Date.parse(value.observedAt));
}
function validSalesWindow(
  facts:
    | z.infer<typeof stockoutFacts>
    | z.infer<typeof stagnationFacts>
    | z.infer<typeof breakoutFacts>,
  value: Evidence,
): boolean {
  return (
    sameEventPeriod(facts.salesWindow, value) &&
    facts.salesWindowHours ===
      (Date.parse(facts.salesWindow.periodEnd) - Date.parse(facts.salesWindow.periodStart)) /
        3600000
  );
}
function boundedCountSum(
  counts: readonly { readonly count: number }[],
  bound: number | null,
): boolean {
  return bound === null
    ? counts.length === 0
    : counts.reduce((total, item) => total + BigInt(item.count), 0n) <= BigInt(bound);
}
function validRefund(value: Extract<Evidence, { eventType: "REFUND_SPIKE" }>): boolean {
  const facts = value.facts;
  return (
    sameEventPeriod(facts.paymentCohort, value) &&
    ratioMatches(facts.currentRate, facts.refundedOrders, facts.paidCohortOrders, value) &&
    ratioMatches(
      facts.affectedSkuShare,
      facts.affectedSkuShare.numerator,
      facts.refundedOrders,
      value,
    ) &&
    baselineRateMatches(facts.baselineRate, value) &&
    observedBefore(value, [facts.observedThrough]) &&
    Date.parse(facts.observedThrough) >= Date.parse(facts.paymentCohort.periodEnd) &&
    boundedCountSum(facts.reasonCounts, facts.refundedOrders) &&
    boundedCountSum(
      facts.skuConcentration.map((item) => ({ count: item.refundedOrders })),
      facts.refundedOrders,
    ) &&
    new Set(facts.skuConcentration.map((item) => item.externalSkuId)).size ===
      facts.skuConcentration.length
  );
}
function validCancellation(
  value: Extract<Evidence, { eventType: "CANCELLED_ORDER_SPIKE" }>,
): boolean {
  const facts = value.facts;
  const total =
    facts.paidCancelledOrders === null || facts.pendingCancelledOrders === null
      ? null
      : BigInt(facts.paidCancelledOrders) + BigInt(facts.pendingCancelledOrders);
  return (
    sameEventPeriod(facts.cohort, value) &&
    (total === null || total <= BigInt(Number.MAX_SAFE_INTEGER)) &&
    ratioMatches(
      facts.currentRate,
      total === null ? null : Number(total),
      facts.cohortOrders,
      value,
    ) &&
    baselineRateMatches(facts.baselineRate, value) &&
    boundedCountSum(facts.reasonCounts, total === null ? null : Number(total))
  );
}
function validFinancial(
  value: Extract<
    Evidence,
    { eventType: "PROFIT_MARGIN_DROP" | "UNUSUAL_DISCOUNT" | "REVENUE_DROP" }
  >,
): boolean {
  const facts = value.facts;
  const kinds = facts.contributions.map((item) => item.kind);
  const contributions = facts.contributions;
  if (
    new Set(kinds).size !== kinds.length ||
    (contributions.length > 0 && facts.attributionVersion === null)
  )
    return false;
  if (
    contributions.length > 0 &&
    contributions.every((item) => item.amountMinor !== null) &&
    facts.profitDeltaMinor !== null &&
    contributions.reduce((sum, item) => sum + BigInt(item.amountMinor ?? 0), 0n) !==
      BigInt(facts.profitDeltaMinor)
  )
    return false;
  return (
    ratioMatches(facts.discountRate, facts.discountMinor, facts.grossMerchandiseMinor, value) &&
    (facts.promotionPeriod === null ||
      (Date.parse(facts.promotionPeriod.periodStart) < Date.parse(value.periodEnd) &&
        Date.parse(facts.promotionPeriod.periodEnd) > Date.parse(value.periodStart))) &&
    new Set(facts.skuContributions.map((item) => item.externalSkuId)).size ===
      facts.skuContributions.length
  );
}
function validStockout(value: Extract<Evidence, { eventType: "STOCKOUT_RISK" }>): boolean {
  const facts = value.facts;
  if (!validSalesWindow(facts, value) || !observedBefore(value, [facts.inventoryObservedAt]))
    return false;
  return (
    facts.inventoryAgeSeconds === null ||
    (facts.inventoryObservedAt !== null &&
      facts.inventoryAgeSeconds ===
        (Date.parse(value.observedAt) - Date.parse(facts.inventoryObservedAt)) / 1000)
  );
}
function validMarketing(
  value: Extract<Evidence, { eventType: "ROAS_DROP" | "AD_SPEND_SPIKE" }>,
): boolean {
  return ratioMatches(
    value.facts.roas,
    value.facts.attributedRevenueMinor,
    value.facts.spendMinor,
    value,
  );
}
function validConversion(value: Extract<Evidence, { eventType: "CONVERSION_DROP" }>): boolean {
  return (
    ratioMatches(value.facts.conversion, value.facts.paidOrders, value.facts.visitors, value) &&
    baselineRateMatches(value.facts.baselineConversion, value) &&
    observedBefore(value, [value.facts.priceEffectiveAt])
  );
}
function validBreakout(value: Extract<Evidence, { eventType: "PRODUCT_BREAKOUT" }>): boolean {
  return (
    validSalesWindow(value.facts, value) &&
    sameEventPeriod(value.facts.conversion.period, value) &&
    observedBefore(value, [value.facts.listedAt]) &&
    (value.facts.salesUnits === null
      ? value.facts.salesUnitsPerHour === null
      : value.facts.salesUnitsPerHour === value.facts.salesUnits / value.facts.salesWindowHours)
  );
}
function validSync(value: Extract<Evidence, { eventType: "SYNC_FAILURE" }>): boolean {
  return (
    value.entity.connectionId === value.binding.connectionId &&
    observedBefore(value, [value.facts.lastSuccessAt]) &&
    (value.facts.lagSeconds === null ||
      (value.facts.lastSuccessAt !== null &&
        value.facts.lagSeconds ===
          (Date.parse(value.observedAt) - Date.parse(value.facts.lastSuccessAt)) / 1000))
  );
}
function validFacts(value: Evidence): boolean {
  switch (value.eventType) {
    case "STOCKOUT_RISK":
      return validStockout(value);
    case "INVENTORY_STAGNATION":
      return validSalesWindow(value.facts, value) && observedBefore(value, [value.facts.listedAt]);
    case "REFUND_SPIKE":
      return validRefund(value);
    case "CANCELLED_ORDER_SPIKE":
      return validCancellation(value);
    case "PROFIT_MARGIN_DROP":
    case "UNUSUAL_DISCOUNT":
    case "REVENUE_DROP":
      return validFinancial(value);
    case "ROAS_DROP":
    case "AD_SPEND_SPIKE":
      return validMarketing(value);
    case "CONVERSION_DROP":
      return validConversion(value);
    case "PRODUCT_BREAKOUT":
      return validBreakout(value);
    case "SYNC_FAILURE":
      return validSync(value);
  }
}
export const EventEvidenceV1Schema = evidenceUnion
  .refine(validCommon, "Evidence scope, visibility, quality or baseline mismatch")
  .refine(validFacts, "Event facts disagree with their counts, rates, periods or observations")
  .readonly();
export type EventEvidenceV1 = z.infer<typeof EventEvidenceV1Schema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventEntity = z.infer<typeof EventEntitySchema>;
export type EventQuality = z.infer<typeof EventQualitySchema>;
export type RobustBaselineV1 = z.infer<typeof RobustBaselineV1Schema>;
export type EventSourceReference = z.infer<typeof EventSourceReferenceSchema>;
export type EventRate = z.infer<typeof EventRateSchema>;
