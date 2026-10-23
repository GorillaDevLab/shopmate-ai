import { expect, expectTypeOf, it } from "vitest";
import {
  EventEvidenceV1Schema,
  EventRateSchema,
  EventRoasSchema,
} from "./event-evidence.schema.js";
import type { EventEvidenceV1 } from "./event-evidence.schema.js";

const start = "2026-10-01T16:00:00Z";
const end = "2026-10-02T06:00:00Z";
const future = "2026-10-03T06:00:00Z";
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const period = {
  periodStart: start,
  periodEnd: end,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const baselinePeriod = {
  ...period,
  periodStart: "2026-09-24T16:00:00Z",
  periodEnd: "2026-09-25T06:00:00Z",
};
const store = { kind: "STORE" } as const;
const sku = { kind: "SKU", externalSkuId: "sku-a" } as const;
const campaign = { kind: "CAMPAIGN", externalCampaignId: "campaign-a" } as const;
const connection = { kind: "CONNECTION", connectionId: binding.connectionId } as const;
const sourceRef = {
  kind: "METRIC_SNAPSHOT",
  measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
  id: "metric-a",
  version: "revision-a",
  hash: "hash-a",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: end,
};
const quality = { dataStatus: "VERIFIED", sampleSize: 100, coverageBasisPoints: 10000, issues: [] };
const common = {
  schemaVersion: 1,
  binding,
  ...period,
  observedAt: end,
  sourceWatermark: end,
  ...quality,
  definitionVersion: "metrics-v1",
  baselineVersion: "baseline-v1",
  baselineAlignment: "ALIGNED",
  baseline: {
    status: "AVAILABLE",
    alignment: "ALIGNED",
    measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
    aggregation: "EXACT_MEDIAN",
    version: "baseline-v1",
    period: baselinePeriod,
    median: 100,
    mad: 5,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [{ ...sourceRef, period: baselinePeriod }],
  },
  sourceReferences: [sourceRef],
};
function rate(
  numerator: number | null,
  denominator: number | null,
  valueBasisPoints: number | null,
) {
  return { numerator, denominator, valueBasisPoints, period };
}
const refundFacts = {
  paymentCohort: period,
  observedThrough: end,
  maturityHours: 0,
  paidCohortOrders: 100,
  refundedOrders: 20,
  currentRate: rate(20, 100, 2000),
  baselineRate: { ...rate(10, 100, 1000), period: baselinePeriod },
  affectedSkuShare: rate(10, 20, 5000),
  reasonCounts: [{ reason: "QUALITY", count: 20 }],
  skuConcentration: [{ externalSkuId: "sku-a", refundedOrders: 10 }],
};
const financialFacts = {
  paidRevenueMinor: 10000,
  netRevenueMinor: 9000,
  grossMerchandiseMinor: 11000,
  grossProfitMinor: -100,
  contributionMinor: -200,
  discountMinor: 1000,
  spendMinor: 500,
  costCoverageBasisPoints: 10000,
  feeCoverageBasisPoints: 10000,
  profitDeltaMinor: -1000,
  attributionVersion: "delta-v1",
  contributions: [{ kind: "SKU_MIX", amountMinor: -1000 }],
  skuContributions: [{ externalSkuId: "sku-a", revenueMinor: 9000, profitDeltaMinor: -1000 }],
  discountRate: rate(1000, 11000, 909),
  promotionPeriod: null,
};
const marketingFacts = {
  spendMinor: 10000,
  attributedRevenueMinor: 30000,
  impressions: 1000,
  clicks: 100,
  attributedOrders: 10,
  attributionCoverageBasisPoints: 10000,
  roas: rate(30000, 10000, 30000),
};
const funnelFacts = {
  visitors: 100,
  cart: 40,
  checkout: 30,
  paidOrders: 20,
  conversion: rate(20, 100, 2000),
  baselineConversion: { ...rate(30, 100, 3000), period: baselinePeriod },
  priceChangeBasisPoints: 1000,
  priceEffectiveAt: start,
  variantAvailabilityBasisPoints: 10000,
  relationship: "CORRELATION_ONLY",
};
const stockFacts = {
  availableUnits: 0,
  salesUnits: 10,
  salesWindow: period,
  salesWindowHours: 14,
  estimatedHoursRemaining: 0,
  supplierLeadTimeHours: null,
  safetyBufferHours: null,
  inboundETA: null,
  inventoryObservedAt: end,
  inventoryAgeSeconds: 0,
  inventoryStatus: "VERIFIED",
};
const fixtures = [
  { eventType: "STOCKOUT_RISK", entity: sku, facts: stockFacts },
  {
    eventType: "INVENTORY_STAGNATION",
    entity: sku,
    facts: {
      availableUnits: 200,
      salesUnits: 2,
      salesWindow: period,
      salesWindowHours: 14,
      holdingDays: 100,
      demandCoverageDays: 120,
      listedAt: start,
      inventoryCostMinor: 20000,
      costCoverageBasisPoints: 10000,
    },
  },
  { eventType: "REFUND_SPIKE", entity: store, facts: refundFacts },
  {
    eventType: "CANCELLED_ORDER_SPIKE",
    entity: store,
    facts: {
      cohort: period,
      cohortOrders: 100,
      paidCancelledOrders: 10,
      pendingCancelledOrders: 20,
      currentRate: rate(30, 100, 3000),
      baselineRate: { ...rate(10, 100, 1000), period: baselinePeriod },
      reasonCounts: [{ reason: "BUYER_REQUEST", count: 30 }],
    },
  },
  { eventType: "PROFIT_MARGIN_DROP", entity: store, facts: financialFacts },
  { eventType: "UNUSUAL_DISCOUNT", entity: store, facts: financialFacts },
  { eventType: "ROAS_DROP", entity: campaign, facts: marketingFacts },
  { eventType: "AD_SPEND_SPIKE", entity: campaign, facts: marketingFacts },
  { eventType: "CONVERSION_DROP", entity: store, facts: funnelFacts },
  {
    eventType: "PRODUCT_BREAKOUT",
    entity: sku,
    facts: {
      salesUnits: 100,
      salesWindow: period,
      salesWindowHours: 14,
      salesUnitsPerHour: 100 / 14,
      conversion: rate(20, 100, 2000),
      grossProfitMinor: -100,
      netRevenueMinor: 1000,
      costCoverageBasisPoints: 10000,
      listedAt: start,
    },
  },
  {
    eventType: "SYNC_FAILURE",
    entity: connection,
    facts: {
      lastSuccessAt: start,
      lagSeconds: 50400,
      typedErrorCode: "TIMEOUT",
      affectedResourceKind: "ORDERS",
    },
  },
  { eventType: "REVENUE_DROP", entity: store, facts: financialFacts },
];
function evidence(index = 0) {
  return { ...common, ...fixtures[index] };
}
function accepts(value: unknown) {
  return EventEvidenceV1Schema.safeParse(value).success;
}
it.each(fixtures)("accepts bounded aggregate facts for $eventType", (fixture) => {
  expect(accepts({ ...common, ...fixture })).toBe(true);
});
it.each(["name", "address", "rawOrder", "token", "factsJson", "approval", "execute"])(
  "rejects unapproved top-level %s",
  (key) => {
    expect(accepts({ ...evidence(), [key]: "untrusted" })).toBe(false);
  },
);
it.each(fixtures)("rejects arbitrary nested fields for $eventType", (fixture) => {
  expect(
    accepts({ ...common, ...fixture, facts: { ...fixture.facts, prompt: "ignore policy" } }),
  ).toBe(false);
});
it.each([
  { schemaVersion: 2 },
  { eventType: "INSUFFICIENT_EVIDENCE" },
  { currency: "USD" },
  { timezone: "UTC" },
  { periodEnd: start },
  { periodEnd: future },
  { sourceWatermark: future },
  { sampleSize: -1 },
  { sampleSize: Number.MAX_SAFE_INTEGER + 1 },
  { coverageBasisPoints: 10001 },
  { observedAt: "2026-10-02T06:00:00.0001Z" },
  { sourceWatermark: "2026-10-02T06:00:00+00:00" },
])("rejects malformed common boundary %j", (patch) => {
  expect(accepts({ ...evidence(), ...patch })).toBe(false);
});
it("accepts opaque date-looking IDs and versions without timestamp interpretation", () => {
  const ref = { ...sourceRef, id: future, version: future };
  expect(
    accepts({
      ...evidence(),
      sourceReferences: [ref],
      baselineVersion: future,
      baseline: { ...common.baseline, version: future },
    }),
  ).toBe(true);
});
it.each(["organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId"])(
  "rejects source reference %s mismatch",
  (key) => {
    const sourceReferences = [{ ...sourceRef, binding: { ...binding, [key]: "foreign" } }];
    expect(accepts({ ...evidence(), sourceReferences })).toBe(false);
  },
);
it.each([
  { definitionVersion: "foreign" },
  { period: baselinePeriod },
  { observedAt: future },
  { hash: "" },
])("rejects immutable reference mismatch %j", (patch) => {
  expect(accepts({ ...evidence(), sourceReferences: [{ ...sourceRef, ...patch }] })).toBe(false);
});
it.each([
  { baselineVersion: null },
  { baselineAlignment: "MISSING" },
  { baseline: null },
  { baseline: { ...common.baseline, version: "foreign" } },
  { baseline: { ...common.baseline, period } },
])("rejects falsely aligned baseline %j", (patch) => {
  expect(accepts({ ...evidence(), ...patch })).toBe(false);
});
it("preserves independently verified stockout with absent baseline and diagnostics", () => {
  const value = {
    ...evidence(),
    baseline: null,
    baselineVersion: null,
    baselineAlignment: "MISSING",
    facts: { ...stockFacts, estimatedHoursRemaining: null, inventoryAgeSeconds: null },
  };
  expect(accepts(value)).toBe(true);
});
it.each([
  rate(1, 0, 0),
  rate(1, null, 0),
  rate(null, 1, 0),
  rate(1, 3, 3334),
  rate(2, 1, 20000),
  rate(Number.MAX_SAFE_INTEGER + 1, 1, 1),
])("rejects invalid ratio %j", (value) => {
  expect(EventRateSchema.safeParse(value).success).toBe(false);
});
it.each([
  rate(1, 0, null),
  rate(null, 1, null),
  rate(1, null, null),
  rate(1, 3, 3333),
  rate(1, 32, 313),
  rate(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 10000),
])("accepts exact nullable ratio %j", (value) => {
  expect(EventRateSchema.safeParse(value).success).toBe(true);
});
it("distinguishes ROAS multiplier from probability rates", () => {
  expect(EventRoasSchema.safeParse(rate(30000, 10000, 30000)).success).toBe(true);
  expect(EventRateSchema.safeParse(rate(30000, 10000, 30000)).success).toBe(false);
});
it.each([
  { currentRate: rate(10, 100, 1000) },
  { currentRate: { ...rate(20, 100, 2000), period: baselinePeriod } },
  { refundedOrders: 101 },
  { reasonCounts: [{ reason: "raw customer text", count: 20 }] },
  { affectedSkuShare: rate(21, 20, 10500) },
])("rejects inconsistent refund evidence %j", (facts) => {
  expect(accepts({ ...evidence(2), facts: { ...refundFacts, ...facts } })).toBe(false);
});
it.each([
  { roas: rate(20000, 10000, 20000) },
  { attributedRevenueMinor: null },
  { spendMinor: -1 },
])("rejects marketing amount/ratio mismatch %j", (facts) => {
  expect(accepts({ ...evidence(6), facts: { ...marketingFacts, ...facts } })).toBe(false);
});
it("preserves missing attributed revenue without inventing zero ROAS", () => {
  expect(
    accepts({
      ...evidence(7),
      facts: { ...marketingFacts, attributedRevenueMinor: null, roas: rate(null, 10000, null) },
    }),
  ).toBe(true);
});
it.each([
  { salesWindowHours: 24 },
  { inventoryObservedAt: future },
  { inventoryAgeSeconds: 1 },
  { availableUnits: -1 },
])("rejects stock fact inconsistency %j", (facts) => {
  expect(accepts({ ...evidence(), facts: { ...stockFacts, ...facts } })).toBe(false);
});
it.each([0, 1, 6, 7, 9, 10])("rejects wrong entity for scoped family %j", (index) => {
  expect(accepts({ ...evidence(index), entity: store })).toBe(false);
});
it("freezes all nested evidence and exposes readonly types", () => {
  const parsed = EventEvidenceV1Schema.parse(evidence());
  expect(Object.isFrozen(parsed.facts)).toBe(true);
  expect(Object.isFrozen(parsed.sourceReferences)).toBe(true);
  expectTypeOf<EventEvidenceV1["sourceReferences"]>().toMatchTypeOf<readonly unknown[]>();
});
it("accepts observed same-weekday baseline references from multiple historical weeks", () => {
  const older = {
    ...baselinePeriod,
    periodStart: "2026-09-17T16:00:00Z",
    periodEnd: "2026-09-18T06:00:00Z",
  };
  const baseline = {
    ...common.baseline,
    sourceReferences: [
      { ...sourceRef, period: baselinePeriod },
      { ...sourceRef, id: "metric-b", period: older },
    ],
  };
  expect(accepts({ ...evidence(), baseline })).toBe(true);
});
it.each([
  { periodStart: "2026-09-24T17:00:00Z", periodEnd: baselinePeriod.periodEnd },
  { periodStart: "2026-09-23T16:00:00Z", periodEnd: "2026-09-24T06:00:00Z" },
])("rejects mismatched historical baseline sample %j", (patch) => {
  const baseline = {
    ...common.baseline,
    sourceReferences: [{ ...sourceRef, period: { ...baselinePeriod, ...patch } }],
  };
  expect(accepts({ ...evidence(), baseline })).toBe(false);
});
it.each(["inventoryObservedAt", "inboundETA"])(
  "rejects submillisecond stock timestamp %s",
  (key) => {
    expect(
      accepts({ ...evidence(), facts: { ...stockFacts, [key]: "2026-10-02T06:00:00.0001Z" } }),
    ).toBe(false);
  },
);
it.each([
  { conversion: rate(10, 100, 1000) },
  { priceEffectiveAt: future },
  { relationship: "CAUSATION" },
])("rejects unsupported conversion assertion %j", (facts) => {
  expect(accepts({ ...evidence(8), facts: { ...funnelFacts, ...facts } })).toBe(false);
});
it.each([
  { pendingCancelledOrders: 100 },
  { currentRate: rate(20, 100, 2000) },
  { reasonCounts: [{ reason: "BUYER_REQUEST", count: 31 }] },
])("rejects cancellation count inconsistency %j", (facts) => {
  expect(accepts({ ...evidence(3), facts: { ...fixtures[3]?.facts, ...facts } })).toBe(false);
});
it.each([
  { profitDeltaMinor: -1001 },
  { discountRate: rate(1000, 10000, 1000) },
  { attributionVersion: null },
  { contributions: [{ kind: "SKU_MIX", amountMinor: Number.MIN_SAFE_INTEGER - 1 }] },
])("rejects inconsistent financial aggregates %j", (facts) => {
  expect(accepts({ ...evidence(4), facts: { ...financialFacts, ...facts } })).toBe(false);
});
it.each([{ lastSuccessAt: future }, { lagSeconds: 1 }, { typedErrorCode: "raw exception" }])(
  "rejects unsafe sync diagnostics %j",
  (facts) => {
    expect(accepts({ ...evidence(10), facts: { ...fixtures[10]?.facts, ...facts } })).toBe(false);
  },
);
it("publishes candidate, policy and authenticated consumer contracts", async () => {
  const path = "./event.schema.js";
  const module = await import(path).catch((error: unknown) => ({ missingBoundary: error }));
  expect(module).toHaveProperty("EventCandidateSchema");
});
it("retains typed measures and fractional observed baseline medians", () => {
  const measure = { kind: "LEAD_TIME_HOURS", unit: "hours" };
  const baseline = {
    ...common.baseline,
    measure,
    aggregation: "EXACT_MEDIAN",
    median: 1.5,
    mad: 0.5,
    sourceReferences: [{ ...sourceRef, period: baselinePeriod, measure }],
  };
  expect(accepts({ ...evidence(), baseline })).toBe(true);
});

import {
  createEventFingerprint,
  EventCandidateSchema,
  EventEvidenceReferenceSchema,
  EventEvidenceRecordSchema,
  EventRecordSchema,
  EventStateTransitionSchema,
  EventListQuerySchema,
  EventDetailQuerySchema,
  EventEvidenceQuerySchema,
  EventHistoryQuerySchema,
  EventAppendEvidenceRequestSchema,
  EventCurrentQuerySchema,
  EventRulePolicyV1Schema,
  BaselineRequestSchema,
  EventDetectionRequestSchema,
  EventDetectionOutcomeSchema,
} from "./event.schema.js";
import type {
  BaselinePort,
  EventDetector,
  EventRepository,
  EventQueryPort,
} from "./event-ports.js";
import type {
  EventCandidate,
  EventDetectionRequest,
  EventStateTransition,
  BaselineRequest,
} from "./event.schema.js";
import type { TenantContext } from "../tenant/tenant.schema.js";
const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "OPERATOR",
  permissions: ["tenant:read"],
} as const;
const identity = {
  binding,
  eventType: "STOCKOUT_RISK",
  entity: sku,
  baselineVersion: "baseline-v1",
} as const;
function candidate(index = 0) {
  const value = EventEvidenceV1Schema.parse(evidence(index));
  return {
    schemaVersion: 1,
    fingerprint: createEventFingerprint(value),
    severityFloor: "LOW",
    rulePolicyVersion: "policy-v1",
    evidence: value,
  };
}
function evidenceReference(index = 0) {
  const value = evidence(index);
  return {
    schemaVersion: 1,
    id: "evidence-a",
    version: "evidence-v1",
    hash: "sha256-host-a",
    binding,
    eventType: value.eventType,
    entity: value.entity,
    definitionVersion: value.definitionVersion,
    baselineVersion: value.baselineVersion,
  };
}
function record() {
  return {
    schemaVersion: 1,
    id: "event-a",
    binding,
    eventType: identity.eventType,
    entity: sku,
    fingerprint: createEventFingerprint(identity),
    severityFloor: "LOW",
    rulePolicyVersion: "policy-v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: end,
    lastSeenAt: end,
    currentEvidence: evidenceReference(),
  };
}
const qualityRule = {
  minimumSampleSize: 20,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 100,
};
const thresholdFixtures = [
  { eventType: "STOCKOUT_RISK", thresholds: { criticalHoursRemaining: 6, leadTimeBufferHours: 4 } },
  {
    eventType: "INVENTORY_STAGNATION",
    thresholds: {
      minimumHoldingDays: 90,
      minimumDemandCoverageDays: 90,
      minimumListingAgeHours: 720,
    },
  },
  {
    eventType: "REFUND_SPIKE",
    thresholds: {
      relativeIncreaseBasisPoints: 20000,
      minimumRefundedOrders: 10,
      maturityHours: 48,
    },
  },
  {
    eventType: "CANCELLED_ORDER_SPIKE",
    thresholds: { relativeIncreaseBasisPoints: 20000, minimumCancelledOrders: 10 },
  },
  {
    eventType: "PROFIT_MARGIN_DROP",
    thresholds: { relativeDropBasisPoints: 1000, minimumDropMinor: 1000 },
  },
  {
    eventType: "UNUSUAL_DISCOUNT",
    thresholds: { discountBasisPoints: 3000, minimumDiscountMinor: 1000 },
  },
  {
    eventType: "ROAS_DROP",
    thresholds: {
      relativeDropBasisPoints: 3000,
      minimumSpendMinor: 1000,
      minimumAttributionCoverageBasisPoints: 9000,
    },
  },
  {
    eventType: "AD_SPEND_SPIKE",
    thresholds: { relativeIncreaseBasisPoints: 20000, minimumSpendMinor: 1000 },
  },
  {
    eventType: "CONVERSION_DROP",
    thresholds: { relativeDropBasisPoints: 3500, minimumVisitors: 100 },
  },
  {
    eventType: "PRODUCT_BREAKOUT",
    thresholds: {
      relativeGrowthBasisPoints: 20000,
      minimumSalesUnits: 20,
      minimumConversionBasisPoints: 1000,
    },
  },
  { eventType: "SYNC_FAILURE", thresholds: { maximumLagSeconds: 3600 } },
  {
    eventType: "REVENUE_DROP",
    thresholds: { relativeDropBasisPoints: 2000, minimumDropMinor: 1000 },
  },
];
const policy = {
  schemaVersion: 1,
  version: "policy-v1",
  baselineVersion: "baseline-v1",
  rules: thresholdFixtures.map((fixture) => ({ ...qualityRule, ...fixture })),
};
const snapshot = {
  schemaVersion: 1,
  definitionVersion: "metrics-v1",
  inputRevision: "revision-a",
  binding,
  ...period,
  visibleAt: end,
  sourceWatermark: end,
  computedAt: end,
  sampleSize: 100,
  coverageBasisPoints: 10000,
  status: "VERIFIED",
  issues: [],
  evidenceIds: ["metric-a"],
  subject: sku,
  metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 10000 },
};
const baselineRequest = {
  binding,
  eventType: "STOCKOUT_RISK",
  entity: sku,
  period,
  observedAt: end,
  definitionVersion: "metrics-v1",
  baselineVersion: "baseline-v1",
  measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
  sourceReferences: [{ ...sourceRef, period: baselinePeriod }],
  candidates: [
    {
      ...snapshot,
      ...baselinePeriod,
      visibleAt: baselinePeriod.periodEnd,
      sourceWatermark: baselinePeriod.periodEnd,
      computedAt: baselinePeriod.periodEnd,
    },
  ],
};
function detectionRequest() {
  return { evidence: evidence(), snapshots: [snapshot], baseline: common.baseline, policy };
}
it("uses an ordered canonical JSON tuple for opaque deduplication", () => {
  expect(createEventFingerprint(identity)).toBe(
    JSON.stringify([
      "event-fingerprint-v1",
      "org-a",
      "workspace-a",
      "store-a",
      "STOCKOUT_RISK",
      "SKU",
      "sku-a",
      "baseline-v1",
    ]),
  );
  expect(
    createEventFingerprint({
      ...identity,
      entity: { kind: "SKU", externalSkuId: "a|b" },
      baselineVersion: "c",
    }),
  ).not.toBe(
    createEventFingerprint({
      ...identity,
      entity: { kind: "SKU", externalSkuId: "a" },
      baselineVersion: "b|c",
    }),
  );
});
it.each(["organizationId", "workspaceId", "storeId"])("changes fingerprint with %s", (key) => {
  expect(
    createEventFingerprint({ ...identity, binding: { ...binding, [key]: "foreign" } }),
  ).not.toBe(createEventFingerprint(identity));
});
it("changes fingerprint with type, entity and baseline version", () => {
  const base = createEventFingerprint(identity);
  expect(createEventFingerprint({ ...identity, eventType: "INVENTORY_STAGNATION" })).not.toBe(base);
  expect(
    createEventFingerprint({ ...identity, entity: { ...sku, externalSkuId: "sku-b" } }),
  ).not.toBe(base);
  expect(createEventFingerprint({ ...identity, baselineVersion: "baseline-v2" })).not.toBe(base);
});
it.each(fixtures)("accepts strict candidate and immutable reference for $eventType", (fixture) => {
  const index = fixtures.indexOf(fixture);
  expect(EventCandidateSchema.safeParse(candidate(index)).success).toBe(true);
  expect(EventEvidenceReferenceSchema.safeParse(evidenceReference(index)).success).toBe(true);
  expect(
    EventEvidenceRecordSchema.safeParse({
      reference: evidenceReference(index),
      evidence: evidence(index),
    }).success,
  ).toBe(true);
});
it.each(["INFO", "LOW"])("allows %s opportunity severity", (severityFloor) => {
  expect(EventCandidateSchema.safeParse({ ...candidate(9), severityFloor }).success).toBe(true);
});
it.each(["MEDIUM", "HIGH", "CRITICAL"])("rejects %s opportunity severity", (severityFloor) => {
  expect(EventCandidateSchema.safeParse({ ...candidate(9), severityFloor }).success).toBe(false);
});
it.each([
  { fingerprint: "forged" },
  { severityFloor: "APPROVE" },
  { rulePolicyVersion: "" },
  { execute: true },
  { provider: "jev" },
])("rejects invalid candidate %j", (patch) => {
  expect(EventCandidateSchema.safeParse({ ...candidate(), ...patch }).success).toBe(false);
});
it.each([
  { binding: { ...binding, externalStoreId: "foreign" } },
  { definitionVersion: "foreign" },
  { baselineVersion: "foreign" },
  { eventType: "REFUND_SPIKE" },
  { entity: { ...sku, externalSkuId: "foreign" } },
  { version: "" },
])("rejects evidence reference mismatch %j", (patch) => {
  expect(
    EventEvidenceRecordSchema.safeParse({
      reference: { ...evidenceReference(), ...patch },
      evidence: evidence(),
    }).success,
  ).toBe(false);
});
it("requires immutable current evidence and monotone event times", () => {
  expect(EventRecordSchema.safeParse(record()).success).toBe(true);
  expect(EventRecordSchema.safeParse({ ...record(), revision: 0 }).success).toBe(false);
  expect(EventRecordSchema.safeParse({ ...record(), firstSeenAt: future }).success).toBe(false);
  expect(
    EventRecordSchema.safeParse({ ...record(), currentEvidence: evidenceReference(2) }).success,
  ).toBe(false);
});
const transition = {
  actor,
  binding,
  eventId: "event-a",
  expectedRevision: 1,
  fromState: "OPEN",
  toState: "ACKNOWLEDGED",
  reason: "ACKNOWLEDGED_BY_OPERATOR",
  changedAt: end,
};
it.each([
  { toState: "ACKNOWLEDGED", reason: "ACKNOWLEDGED_BY_OPERATOR" },
  { toState: "RESOLVED", reason: "CONDITION_CLEARED" },
  { toState: "SUPPRESSED", reason: "FALSE_POSITIVE" },
])("accepts scoped CAS transition %j", (patch) => {
  expect(EventStateTransitionSchema.safeParse({ ...transition, ...patch }).success).toBe(true);
});
it.each([
  { actor: undefined },
  { expectedRevision: 0 },
  { actor: { ...actor, workspaceId: "foreign" } },
  { toState: "RESOLVED", reason: "ACKNOWLEDGED_BY_OPERATOR" },
  { fromState: "RESOLVED", toState: "OPEN" },
  { reason: "free text" },
  { approval: true },
])("rejects invalid or unauthenticated state transition %j", (patch) => {
  expect(EventStateTransitionSchema.safeParse({ ...transition, ...patch }).success).toBe(false);
});
const detailQuery = { actor, binding, eventId: "event-a" };
const listQuery = {
  actor,
  binding,
  eventTypes: ["STOCKOUT_RISK"],
  states: ["OPEN"],
  entity: null,
  cursor: null,
  limit: 50,
};
it("accepts explicit scoped list/detail/evidence/history/current queries", () => {
  expect(EventListQuerySchema.safeParse(listQuery).success).toBe(true);
  expect(EventDetailQuerySchema.safeParse(detailQuery).success).toBe(true);
  expect(
    EventEvidenceQuerySchema.safeParse({ ...detailQuery, reference: evidenceReference() }).success,
  ).toBe(true);
  expect(
    EventHistoryQuerySchema.safeParse({ ...detailQuery, cursor: null, limit: 50 }).success,
  ).toBe(true);
  expect(EventCurrentQuerySchema.safeParse({ actor, binding, identity }).success).toBe(true);
});
it.each([
  { actor: undefined },
  { actor: { ...actor, organizationId: "foreign" } },
  { limit: 201 },
  { cursor: "x".repeat(1025) },
  { eventTypes: ["SQL"] },
  { states: ["OPEN", "OPEN"] },
  { entity: { kind: "STORE", name: "PII" } },
  { sql: "SELECT" },
])("rejects unbounded or unauthenticated list query %j", (patch) => {
  expect(EventListQuerySchema.safeParse({ ...listQuery, ...patch }).success).toBe(false);
});
it("requires full authenticated scope and expected revision for append", () => {
  const request = {
    actor,
    binding,
    candidate: candidate(),
    reference: evidenceReference(),
    expectedRevision: null,
  };
  expect(EventAppendEvidenceRequestSchema.safeParse(request).success).toBe(true);
  expect(
    EventAppendEvidenceRequestSchema.safeParse({ ...request, expectedRevision: undefined }).success,
  ).toBe(false);
  expect(
    EventAppendEvidenceRequestSchema.safeParse({
      ...request,
      binding: { ...binding, connectionId: "foreign" },
    }).success,
  ).toBe(false);
});
it("validates a versioned readonly policy across all 12 threshold families", () => {
  const parsed = EventRulePolicyV1Schema.parse(policy);
  expect(parsed.rules).toHaveLength(12);
  expect(Object.isFrozen(parsed.rules[0]?.thresholds)).toBe(true);
});
it.each([
  { schemaVersion: 2 },
  { version: "" },
  { rules: [policy.rules[0], policy.rules[0]] },
  { rules: [{ ...policy.rules[0], thresholds: { arbitrary: 10 } }] },
  { rules: [{ ...policy.rules[0], maximumAgeSeconds: -1 }] },
  { rules: [{ ...policy.rules[0], minimumCoverageBasisPoints: 10001 }] },
  { credentials: "x" },
])("rejects unsafe policy input %j", (patch) => {
  expect(EventRulePolicyV1Schema.safeParse({ ...policy, ...patch }).success).toBe(false);
});
it("validates baseline observation inputs without selecting candidates", () => {
  expect(BaselineRequestSchema.safeParse(baselineRequest).success).toBe(true);
  expect(
    BaselineRequestSchema.safeParse({
      ...baselineRequest,
      sourceReferences: [{ ...sourceRef, period: baselinePeriod }],
      candidates: [{ ...baselineRequest.candidates[0], computedAt: future }],
    }).success,
  ).toBe(false);
  expect(
    BaselineRequestSchema.safeParse({
      ...baselineRequest,
      sourceReferences: [{ ...sourceRef, period: baselinePeriod }],
      candidates: [
        { ...baselineRequest.candidates[0], binding: { ...binding, storeId: "foreign" } },
      ],
    }).success,
  ).toBe(false);
});
it.each([
  { policy: { ...policy, baselineVersion: "foreign" } },
  { snapshots: [{ ...snapshot, definitionVersion: "foreign" }] },
  { snapshots: [{ ...snapshot, binding: { ...binding, workspaceId: "foreign" } }] },
  { baseline: { ...common.baseline, version: "foreign" } },
])("rejects inconsistent detector context %j", (patch) => {
  expect(EventDetectionRequestSchema.safeParse({ ...detectionRequest(), ...patch }).success).toBe(
    false,
  );
});
it("accepts pure detection input and explicit no-candidate quality", () => {
  expect(EventDetectionRequestSchema.safeParse(detectionRequest()).success).toBe(true);
  expect(
    EventDetectionOutcomeSchema.safeParse({
      disposition: "NO_CANDIDATE",
      reason: "INSUFFICIENT_EVIDENCE",
      quality,
      blockedResources: ["ORDERS"],
    }).success,
  ).toBe(true);
  expect(
    EventDetectionOutcomeSchema.safeParse({
      disposition: "CANDIDATE",
      candidate: candidate(),
      quality,
      blockedResources: [],
    }).success,
  ).toBe(true);
});
it("exposes readonly authenticated ports with typed request/result contracts", () => {
  expectTypeOf<Parameters<EventDetector["detect"]>[0]>().toEqualTypeOf<EventDetectionRequest>();
  expectTypeOf<Parameters<BaselinePort["evaluate"]>[0]>().toEqualTypeOf<BaselineRequest>();
  expectTypeOf<
    Parameters<EventRepository["stateTransition"]>[0]
  >().toEqualTypeOf<EventStateTransition>();
  expectTypeOf<Parameters<EventQueryPort["list"]>[0]["actor"]>().toMatchTypeOf<TenantContext>();
  expectTypeOf<EventCandidate["evidence"]["sourceReferences"]>().toMatchTypeOf<
    readonly unknown[]
  >();
});
it("accepts sync diagnostics from immutable non-metric aggregate references", () => {
  const sourceReferences = [{ ...sourceRef, kind: "NORMALIZED_AGGREGATE", measure: null }];
  expect(accepts({ ...evidence(10), sourceReferences })).toBe(true);
});
it("rejects fabricated metric references without typed measure", () => {
  expect(accepts({ ...evidence(), sourceReferences: [{ ...sourceRef, measure: null }] })).toBe(
    false,
  );
});
it.each([
  { median: -1, measure: { kind: "LEAD_TIME_HOURS", unit: "hours" } },
  { median: 10001, measure: { kind: "CONVERSION_RATE", unit: "basisPoints" } },
  { median: 100, measure: { kind: "ROAS", unit: "minorCNY" } },
])("rejects baseline unit/domain mismatch %j", (patch) => {
  const baseline = {
    ...common.baseline,
    ...patch,
    sourceReferences: [{ ...sourceRef, period: baselinePeriod, measure: patch.measure }],
  };
  expect(accepts({ ...evidence(), baseline })).toBe(false);
});
it("rejects extra foreign immutable baseline references", () => {
  const foreign = {
    ...sourceRef,
    period: baselinePeriod,
    id: "foreign-ref",
    binding: { ...binding, organizationId: "foreign" },
  };
  expect(
    BaselineRequestSchema.safeParse({
      ...baselineRequest,
      sourceReferences: [...baselineRequest.sourceReferences, foreign],
    }).success,
  ).toBe(false);
});
it("distinguishes zero and missing baseline states without fabricated values", () => {
  expect(
    accepts({ ...evidence(), baseline: { ...common.baseline, status: "ZERO", median: 0 } }),
  ).toBe(true);
  expect(accepts({ ...evidence(), baseline: { ...common.baseline, median: 0 } })).toBe(false);
  const missing = {
    status: "MISSING",
    alignment: "MISSING",
    version: "baseline-v1",
    measure: common.baseline.measure,
    aggregation: "EXACT_MEDIAN",
    period: null,
    median: null,
    mad: null,
    sampleSize: 0,
    coverageBasisPoints: 0,
    sourceReferences: [],
  };
  expect(accepts({ ...evidence(), baseline: missing, baselineAlignment: "MISSING" })).toBe(true);
});
it("allows signed profit baselines and ROAS above 10000", () => {
  for (const measure of [
    { kind: "GROSS_PROFIT", unit: "minorCNY" },
    { kind: "ROAS", unit: "basisPoints" },
  ]) {
    const median = measure.kind === "GROSS_PROFIT" ? -100.5 : 30000;
    const baseline = {
      ...common.baseline,
      measure,
      median,
      sourceReferences: [{ ...sourceRef, period: baselinePeriod, measure }],
    };
    expect(accepts({ ...evidence(), baseline })).toBe(true);
  }
});
it("retains aligned low-sample baseline without fabricating its median", () => {
  const baseline = {
    ...common.baseline,
    status: "INSUFFICIENT",
    alignment: "ALIGNED",
    median: null,
    mad: null,
    sampleSize: 1,
    coverageBasisPoints: 9000,
  };
  expect(accepts({ ...evidence(), baseline })).toBe(true);
});
it("rejects inconsistent explicit baseline alignment", () => {
  expect(accepts({ ...evidence(), baseline: { ...common.baseline, alignment: "UNALIGNED" } })).toBe(
    false,
  );
});
