import { createHash } from "node:crypto";
import type { MetricKind, QualityPolicy } from "@shopmate/contracts";

export const METRIC_RUNTIME_DEFINITION_VERSION = "metrics-g4-v1";
export const METRIC_RUNTIME_ROUTES = Object.freeze({
  GMV: "payments",
  PAID_REVENUE: "payments",
  PAID_ORDERS: "payments",
  PAID_UNITS: "payments",
  AOV: "payments",
  REFUND_SETTLED_AMOUNT: "refunds",
  NET_REVENUE_SETTLEMENT: "refunds",
  REFUNDED_COHORT_ORDERS: "refunds",
  REFUND_COHORT_ORDER_RATE: "refunds",
  REFUND_COHORT_AMOUNT_RATE: "refunds",
  NET_MERCHANDISE_REVENUE: "costs",
  COGS: "costs",
  GROSS_PROFIT: "costs",
  CONTRIBUTION: "contribution",
  ESTIMATED_NET_PROFIT: "contribution",
  PROFIT_DELTA: "baseline",
  INVENTORY_AVAILABLE: "inventory",
  INVENTORY_HOURS_REMAINING: "inventory",
  LEAD_TIME_HOURS: "inventory",
  CONVERSION_RATE: "funnel",
  CART_RATE: "funnel",
  CHECKOUT_RATE: "funnel",
  ROAS: "funnel",
} as const satisfies Readonly<Record<MetricKind, string>>);
export function freezeRuntime<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freezeRuntime);
    Object.freeze(value);
  }
  return value;
}
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
export const METRIC_RUNTIME_QUALITY_POLICY: QualityPolicy = freezeRuntime({
  version: "metrics-g4-quality-v1",
  precedence,
  rules: (Object.keys(METRIC_RUNTIME_ROUTES) as MetricKind[]).map((kind) => ({
    kind,
    requiredFields: ["leaf"],
    minimumSampleSize: 0,
    maximumAgeHours: 24,
    minimumCoverageBasisPoints: 0,
    allowVerifiedEmptyWindow: true,
  })),
});
export const METRIC_RUNTIME_INVENTORY_POLICY: QualityPolicy = freezeRuntime({
  version: "metrics-g4-inventory-v1",
  precedence,
  rules: [
    { kind: "INVENTORY_AVAILABLE" as const, requiredFields: ["available"] },
    {
      kind: "INVENTORY_HOURS_REMAINING" as const,
      requiredFields: ["available", "soldUnits", "salesWindowHours", "quarantine", "asOf"],
    },
    { kind: "LEAD_TIME_HOURS" as const, requiredFields: ["leadTimeHours"] },
  ].map((rule) => ({
    ...rule,
    minimumSampleSize: 1,
    maximumAgeHours: 24,
    minimumCoverageBasisPoints: 10000,
    allowVerifiedEmptyWindow: false,
  })),
});
/** Persist this exact manifest alongside an explicitly provisioned definition; no request registration. */
export const METRIC_RUNTIME_DEFINITION_MANIFEST = freezeRuntime({
  version: METRIC_RUNTIME_DEFINITION_VERSION,
  routes: METRIC_RUNTIME_ROUTES,
  rounding: "HALF_AWAY_FROM_ZERO",
  returnPolicy: "accepted-resellable-frozen-v1",
  paymentCohort: "INPUT_WINDOW",
  maturityHours: 24,
  qualityPolicy: METRIC_RUNTIME_QUALITY_POLICY,
  inventoryPolicy: METRIC_RUNTIME_INVENTORY_POLICY,
  subjects: {
    financial: ["STORE"],
    inventory: ["SKU"],
    funnel: ["STORE"],
    roas: ["STORE", "CAMPAIGN"],
  },
  baseline: "UNAVAILABLE_UNTIL_ALIGNED_BASELINE_FACTS_EXIST",
  buyerShipping: "PAID_COHORT_SHIPPING_LESS_EXPLICIT_REFUND_ALLOCATIONS",
  skuSales: "EXACT_VISIBLE_PAID_COHORT_LINE_QUANTITIES",
  inventoryLocation: "EXACTLY_ONE_MATCHING_LOCATION",
  qualityObservation: "OLDEST_MATCHING_KIND_SUBJECT_PROOF",
});
export const METRIC_RUNTIME_DEFINITION_HASH = `sha256:${createHash("sha256")
  .update(JSON.stringify(METRIC_RUNTIME_DEFINITION_MANIFEST))
  .digest("hex")}`;
