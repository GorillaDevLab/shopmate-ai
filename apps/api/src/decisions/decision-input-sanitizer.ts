import { createHash } from "node:crypto";
import {
  EventEvidenceV1Schema,
  EvaluationContextSchema,
  SanitizedDecisionInputSchema,
  type DecisionPortResult,
  type EvaluationContext,
  type EventType,
  type HostEvidenceHash,
  type DecisionInputSanitizer,
  type SanitizedDecisionInput,
} from "@shopmate/contracts";

const timestampKeys = new Set([
  "periodStart",
  "periodEnd",
  "observedAt",
  "sourceWatermark",
  "inboundETA",
  "inventoryObservedAt",
  "listedAt",
  "observedThrough",
  "priceEffectiveAt",
  "lastSuccessAt",
]);

/** Only validated evidence reaches this encoder; arrays retain their declared sequence. */
function canonical(value: unknown, key = ""): string {
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(timestampKeys.has(key) ? new Date(value).toISOString() : value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child, name)}`)
    .join(",")}}`;
}

/** Versioned domain separation keeps this digest distinct from source/metric hashes. */
export class CanonicalHostEvidenceHash implements HostEvidenceHash {
  hash(evidence: unknown): DecisionPortResult<string> {
    try {
      const parsed = EventEvidenceV1Schema.safeParse(evidence);
      if (!parsed.success) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
      const hash = createHash("sha256")
        .update("shopmate:decision-evidence:v1\0", "utf8")
        .update(canonical(parsed.data), "utf8")
        .digest("hex");
      return Object.freeze({ ok: true, value: `sha256:${hash}` });
    } catch {
      // Upstream exact-ratio refinements can throw on malformed numbers; fail closed.
      return Object.freeze({ ok: false, code: "INVALID_INPUT" });
    }
  }
}

const financialFields = [
  "paidRevenueMinor",
  "netRevenueMinor",
  "grossMerchandiseMinor",
  "grossProfitMinor",
  "contributionMinor",
  "discountMinor",
  "spendMinor",
  "costCoverageBasisPoints",
  "feeCoverageBasisPoints",
  "profitDeltaMinor",
  "contributions",
  "discountRate",
  "promotionPeriod",
];
const marketingFields = [
  "spendMinor",
  "attributedRevenueMinor",
  "impressions",
  "clicks",
  "attributedOrders",
  "attributionCoverageBasisPoints",
  "roas",
];
const factFields: Readonly<Record<EventType, readonly string[]>> = {
  STOCKOUT_RISK: [
    "availableUnits",
    "salesUnits",
    "salesWindow",
    "salesWindowHours",
    "estimatedHoursRemaining",
    "supplierLeadTimeHours",
    "safetyBufferHours",
    "inboundETA",
    "inventoryObservedAt",
    "inventoryAgeSeconds",
    "inventoryStatus",
  ],
  INVENTORY_STAGNATION: [
    "availableUnits",
    "salesUnits",
    "salesWindow",
    "salesWindowHours",
    "holdingDays",
    "demandCoverageDays",
    "listedAt",
    "inventoryCostMinor",
    "costCoverageBasisPoints",
  ],
  REFUND_SPIKE: [
    "paymentCohort",
    "observedThrough",
    "maturityHours",
    "paidCohortOrders",
    "refundedOrders",
    "currentRate",
    "baselineRate",
    "affectedSkuShare",
    "reasonCounts",
  ],
  CANCELLED_ORDER_SPIKE: [
    "cohort",
    "cohortOrders",
    "paidCancelledOrders",
    "pendingCancelledOrders",
    "currentRate",
    "baselineRate",
    "reasonCounts",
  ],
  PROFIT_MARGIN_DROP: financialFields,
  UNUSUAL_DISCOUNT: financialFields,
  REVENUE_DROP: financialFields,
  ROAS_DROP: marketingFields,
  AD_SPEND_SPIKE: marketingFields,
  CONVERSION_DROP: [
    "visitors",
    "cart",
    "checkout",
    "paidOrders",
    "conversion",
    "baselineConversion",
    "priceChangeBasisPoints",
    "priceEffectiveAt",
    "variantAvailabilityBasisPoints",
    "relationship",
  ],
  PRODUCT_BREAKOUT: [
    "salesUnits",
    "salesWindow",
    "salesWindowHours",
    "salesUnitsPerHour",
    "conversion",
    "grossProfitMinor",
    "netRevenueMinor",
    "costCoverageBasisPoints",
    "listedAt",
  ],
  SYNC_FAILURE: ["lastSuccessAt", "lagSeconds", "typedErrorCode", "affectedResourceKind"],
};
const baselineFields = [
  "status",
  "alignment",
  "measure",
  "aggregation",
  "period",
  "median",
  "mad",
  "sampleSize",
  "coverageBasisPoints",
];

function project(value: object, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key)));
}

function projectContext(context: EvaluationContext): unknown {
  const evidence = context.evidence.evidence;
  return {
    schemaVersion: 1,
    correlationId: context.correlationId,
    eventType: evidence.eventType,
    period: project(evidence, ["periodStart", "periodEnd", "timezone", "currency"]),
    observedAt: evidence.observedAt,
    sourceWatermark: evidence.sourceWatermark,
    dataStatus: evidence.dataStatus,
    sampleSize: evidence.sampleSize,
    coverageBasisPoints: evidence.coverageBasisPoints,
    qualityReasons: [...new Set(evidence.issues.map((issue) => issue.code))],
    baseline: evidence.baseline === null ? null : project(evidence.baseline, baselineFields),
    facts: project(evidence.facts, factFields[evidence.eventType]),
  };
}

/** Validate internal scope and immutable hash before emitting an explicit ID-free projection. */
export class DefaultDecisionInputSanitizer implements DecisionInputSanitizer {
  constructor(private readonly hasher: HostEvidenceHash = new CanonicalHostEvidenceHash()) {}

  sanitize(context: unknown): DecisionPortResult<SanitizedDecisionInput> {
    try {
      const parsed = EvaluationContextSchema.safeParse(context);
      if (!parsed.success) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
      const hash = this.hasher.hash(parsed.data.evidence.evidence);
      if (!hash.ok) return hash;
      if (hash.value !== parsed.data.evidence.reference.hash)
        return Object.freeze({ ok: false, code: "HASH_MISMATCH" });
      const output = SanitizedDecisionInputSchema.safeParse(projectContext(parsed.data));
      if (!output.success) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
      return Object.freeze({ ok: true, value: output.data });
    } catch {
      // Strict upstream validators may throw before producing issues for malformed arithmetic.
      return Object.freeze({ ok: false, code: "INVALID_INPUT" });
    }
  }
}
