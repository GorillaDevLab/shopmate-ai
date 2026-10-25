import { expect, expectTypeOf, it } from "vitest";
import { EventEvidenceV1Schema, EventRateSchema, EventRoasSchema } from "../index.js";
import type { EventEvidenceV1 } from "../index.js";

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
it.each([0, 10])("preserves verified inventory %i with absent diagnostics", (availableUnits) => {
  const value = {
    ...evidence(),
    baseline: null,
    baselineVersion: null,
    baselineAlignment: "MISSING",
    facts: {
      ...stockFacts,
      availableUnits,
      salesUnits: null,
      estimatedHoursRemaining: null,
      inventoryObservedAt: null,
      inventoryAgeSeconds: null,
    },
  };
  expect(accepts(value)).toBe(true);
});
it.each([
  { availableUnits: null },
  {
    availableUnits: null,
    salesUnits: null,
    estimatedHoursRemaining: null,
    inventoryObservedAt: null,
    inventoryAgeSeconds: null,
  },
])("rejects verified stockout inventory without a known availability %j", (facts) => {
  expect(accepts({ ...evidence(), facts: { ...stockFacts, ...facts } })).toBe(false);
});
it("retains unavailable inventory with an explicit quality limitation", () => {
  const value = {
    ...evidence(),
    dataStatus: "UNAVAILABLE",
    coverageBasisPoints: 0,
    issues: [{ code: "INVENTORY_UNKNOWN", field: "availableUnits", evidenceIds: ["metric-a"] }],
    facts: { ...stockFacts, availableUnits: null, inventoryStatus: "UNAVAILABLE" },
  };
  expect(accepts(value)).toBe(true);
});
it.each([
  rate(1, 0, 0),
  rate(1, null, 0),
  rate(null, 1, 0),
  rate(1, 3, 3334),
  rate(2, 1, 20000),
  rate(100001, 100000, 10000),
  rate(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 10000),
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
  rate(99999, 100000, 10000),
  rate(100000, 100000, 10000),
  rate(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 10000),
])("accepts exact nullable ratio %j", (value) => {
  expect(EventRateSchema.safeParse(value).success).toBe(true);
});
it("distinguishes ROAS multiplier from probability rates", () => {
  expect(EventRoasSchema.safeParse(rate(30000, 10000, 30000)).success).toBe(true);
  expect(EventRateSchema.safeParse(rate(30000, 10000, 30000)).success).toBe(false);
});
it("rejects refunded orders above the cohort even when the rate rounds to 10000", () => {
  const facts = {
    ...refundFacts,
    paidCohortOrders: 100000,
    refundedOrders: 100001,
    currentRate: rate(100001, 100000, 10000),
    affectedSkuShare: rate(10, 100001, 1),
  };
  expect(accepts({ ...evidence(2), facts })).toBe(false);
});
it("rejects paid orders above visitors even when conversion rounds to 10000", () => {
  const facts = {
    ...funnelFacts,
    visitors: 100000,
    paidOrders: 100001,
    conversion: rate(100001, 100000, 10000),
  };
  expect(accepts({ ...evidence(8), facts })).toBe(false);
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
  const path = "../index.js";
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
} from "../index.js";
import type { BaselinePort, EventDetector, EventRepository, EventQueryPort } from "../index.js";
import type {
  EventCandidate,
  EventDetectionRequest,
  EventStateTransition,
  BaselineRequest,
  EventIdentity,
} from "../index.js";
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
const invalidIdentityCases = [
  {
    label: "cross-connection sync identity",
    index: 10,
    patch: { entity: { ...connection, connectionId: "foreign" } },
  },
  {
    label: "hidden character in SKU identity",
    index: 0,
    patch: { entity: { ...sku, externalSkuId: "sku-\u200ba" } },
  },
  {
    label: "untrimmed external store binding",
    index: 0,
    patch: { binding: { ...binding, externalStoreId: " external-a" } },
  },
] as const;
function invalidIdentityCandidate(index: number, patch: Partial<EventIdentity>) {
  const value = candidate(index);
  return { ...value, evidence: { ...value.evidence, ...patch } };
}
function eventRecord(index: number, patch: Partial<EventIdentity> = {}) {
  const reference = { ...evidenceReference(index), ...patch };
  return {
    ...record(),
    binding: reference.binding,
    eventType: reference.eventType,
    entity: reference.entity,
    fingerprint: candidate(index).fingerprint,
    currentEvidence: reference,
  };
}
it.each(invalidIdentityCases)("returns candidate failure for $label", ({ index, patch }) => {
  expect(EventCandidateSchema.safeParse(invalidIdentityCandidate(index, patch)).success).toBe(
    false,
  );
});
it.each(invalidIdentityCases)("returns record failure for $label", ({ index, patch }) => {
  expect(EventRecordSchema.safeParse(eventRecord(index, patch)).success).toBe(false);
});
it.each(invalidIdentityCases)("returns append request failure for $label", ({ index, patch }) => {
  expect(
    EventAppendEvidenceRequestSchema.safeParse({
      actor,
      binding,
      candidate: invalidIdentityCandidate(index, patch),
      reference: { ...evidenceReference(index), ...patch },
      expectedRevision: null,
    }).success,
  ).toBe(false);
});
it.each(invalidIdentityCases)(
  "returns detection outcome failure for $label",
  ({ index, patch }) => {
    expect(
      EventDetectionOutcomeSchema.safeParse({
        disposition: "CANDIDATE",
        candidate: invalidIdentityCandidate(index, patch),
        quality,
        blockedResources: [],
      }).success,
    ).toBe(false);
  },
);
it.each(invalidIdentityCases)(
  "keeps public fingerprint rejection for $label",
  ({ index, patch }) => {
    expect(() => createEventFingerprint({ ...candidate(index).evidence, ...patch })).toThrow();
  },
);
it.each(fixtures)("preserves record and reference fingerprint for $eventType", (fixture) => {
  const index = fixtures.indexOf(fixture);
  const value = eventRecord(index);
  expect(EventRecordSchema.safeParse(value).success).toBe(true);
  const reference = EventEvidenceReferenceSchema.parse(value.currentEvidence);
  expect(createEventFingerprint(reference)).toBe(candidate(index).fingerprint);
});
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

import { EventMeasureSchema, MetricValueSchema, MetricSnapshotV1Schema } from "../index.js";
const cancellationMeasure = { kind: "CANCELLED_ORDER_RATE", unit: "basisPoints" } as const;
function cancellationObservation() {
  const reference = {
    ...sourceRef,
    kind: "NORMALIZED_AGGREGATE",
    measure: cancellationMeasure,
    period: baselinePeriod,
    observedAt: baselinePeriod.periodEnd,
  };
  return {
    reference,
    entity: store,
    rate: { numerator: 1, denominator: 100, valueBasisPoints: 100, period: baselinePeriod },
    visibleAt: baselinePeriod.periodEnd,
    computedAt: baselinePeriod.periodEnd,
    sourceWatermark: baselinePeriod.periodEnd,
    evidenceIds: ["cohort-a"],
    quality,
  };
}
function cancellationRequest() {
  const observation = cancellationObservation();
  return {
    ...baselineRequest,
    eventType: "CANCELLED_ORDER_SPIKE",
    entity: store,
    measure: cancellationMeasure,
    candidates: [],
    normalizedObservations: [observation],
    sourceReferences: [observation.reference],
  };
}
it("accepts event-only cancellation histories without changing P3 metrics", () => {
  expect(EventMeasureSchema.safeParse(cancellationMeasure).success).toBe(true);
  const parsed = BaselineRequestSchema.parse(cancellationRequest());
  expect(Object.isFrozen(parsed)).toBe(true);
  const observation = parsed.normalizedObservations?.[0];
  expect(observation && "rate" in observation && Object.isFrozen(observation.rate)).toBe(true);
  expect(MetricValueSchema.safeParse({ ...cancellationMeasure, value: 100 }).success).toBe(false);
  expect(
    MetricSnapshotV1Schema.safeParse({
      ...snapshot,
      metric: { ...cancellationMeasure, value: 100 },
    }).success,
  ).toBe(false);
});
it("accepts cancellation AVAILABLE/ZERO evidence and direct empty-snapshot detection", () => {
  for (const median of [100.5, 0]) {
    const baseline = {
      ...common.baseline,
      measure: cancellationMeasure,
      median,
      status: median === 0 ? "ZERO" : "AVAILABLE",
      sourceReferences: [cancellationObservation().reference],
    };
    const currentRef = { ...cancellationObservation().reference, period, observedAt: end };
    const value = { ...evidence(3), baseline, sourceReferences: [currentRef] };
    expect(
      EventDetectionRequestSchema.safeParse({ evidence: value, baseline, snapshots: [], policy })
        .success,
    ).toBe(true);
  }
});
it.each([
  { entity: sku },
  { binding: { ...binding, storeId: "foreign" } },
  { definitionVersion: "foreign" },
  { eventType: "REFUND_SPIKE" },
  { measure: { kind: "REFUND_ORDER_RATE", unit: "basisPoints" } },
  { sourceReferences: [] },
  { candidates: [snapshot] },
  { normalizedObservations: Array.from({ length: 1001 }, cancellationObservation) },
])("rejects cancellation request scope/provenance mismatch %j", (patch) => {
  expect(BaselineRequestSchema.safeParse({ ...cancellationRequest(), ...patch }).success).toBe(
    false,
  );
});
const invalidObservationPatches = [
  { extra: true },
  { entity: campaign },
  { visibleAt: start },
  { computedAt: future },
  { visibleAt: "2026-09-25T06:00:00.0001Z" },
  { sourceWatermark: null },
  { sourceWatermark: baselinePeriod.periodStart },
  { rate: { numerator: 1, denominator: 100, valueBasisPoints: 101, period: baselinePeriod } },
  { rate: { numerator: 1, denominator: 100, valueBasisPoints: 100, period } },
  { quality: { ...quality, sampleSize: 99 } },
  { quality: { ...quality, coverageBasisPoints: 9999 } },
  {
    quality: {
      ...quality,
      issues: [{ code: "LOW_SAMPLE", field: "cohort", evidenceIds: ["cohort-a"] }],
    },
  },
  {
    quality: {
      ...quality,
      dataStatus: "INSUFFICIENT",
      issues: [{ code: "LOW_SAMPLE", field: "cohort", evidenceIds: ["foreign"] }],
    },
  },
];
it.each(invalidObservationPatches)(
  "rejects invalid normalized cancellation observation %j",
  (patch) => {
    const value = cancellationRequest();
    expect(
      BaselineRequestSchema.safeParse({
        ...value,
        normalizedObservations: [{ ...value.normalizedObservations[0], ...patch }],
      }).success,
    ).toBe(false);
  },
);
it.each([
  { kind: "METRIC_SNAPSHOT" },
  { hash: "different" },
  { id: "different" },
  { version: "different" },
  { observedAt: end },
  { measure: { kind: "CANCELLED_ORDER_RATE", unit: "minorCNY" } },
])("requires the exact aggregate reference %j", (patch) => {
  const value = cancellationRequest();
  expect(
    BaselineRequestSchema.safeParse({
      ...value,
      sourceReferences: [{ ...value.sourceReferences[0], ...patch }],
    }).success,
  ).toBe(false);
});
it("represents zero-denominator and missing-time aggregates with explicit limitations", () => {
  for (const [denominator, code] of [
    [0, "ZERO_DENOMINATOR"],
    [null, "SOURCE_TIME_MISSING"],
  ] as const) {
    const value = cancellationRequest();
    const observation = {
      ...cancellationObservation(),
      sourceWatermark: null,
      rate: { numerator: null, denominator, valueBasisPoints: null, period: baselinePeriod },
      quality: {
        dataStatus: "UNAVAILABLE",
        sampleSize: 0,
        coverageBasisPoints: 0,
        issues: [{ code, field: "cohort", evidenceIds: ["cohort-a"] }],
      },
    };
    expect(
      BaselineRequestSchema.safeParse({ ...value, normalizedObservations: [observation] }).success,
    ).toBe(true);
  }
});
it("leaves normalized histories optional for existing typed callers", () => {
  const oldShape: Omit<BaselineRequest, "normalizedObservations"> =
    BaselineRequestSchema.parse(baselineRequest);
  const legacy: BaselineRequest = oldShape;
  expect(BaselineRequestSchema.parse(legacy)).not.toHaveProperty("normalizedObservations");
});
it("does not allow cancellation measures on another event's evidence", () => {
  expect(
    accepts({
      ...evidence(),
      sourceReferences: [
        { ...sourceRef, kind: "NORMALIZED_AGGREGATE", measure: cancellationMeasure },
      ],
    }),
  ).toBe(false);
});

it("rejects a verified cancellation observation with unknown rate or a zero cohort", () => {
  for (const denominator of [null, 0]) {
    const value = cancellationRequest();
    const item = cancellationObservation();
    const observation = {
      ...item,
      rate: { ...item.rate, numerator: null, denominator, valueBasisPoints: null },
      quality: { ...quality, sampleSize: 0 },
    };
    expect(
      BaselineRequestSchema.safeParse({ ...value, normalizedObservations: [observation] }).success,
    ).toBe(false);
  }
});
it("matches exact external SKU identity on normalized observations", () => {
  const value = cancellationRequest();
  const item = { ...cancellationObservation(), entity: { kind: "SKU", externalSkuId: "sku-a" } };
  expect(
    BaselineRequestSchema.safeParse({ ...value, entity: sku, normalizedObservations: [item] })
      .success,
  ).toBe(true);
  expect(
    BaselineRequestSchema.safeParse({
      ...value,
      entity: sku,
      normalizedObservations: [{ ...item, entity: { ...item.entity, externalSkuId: "sku-b" } }],
    }).success,
  ).toBe(false);
});

it("limits even an explicitly empty normalized observation channel to cancellation requests", () => {
  expect(
    BaselineRequestSchema.safeParse({ ...baselineRequest, normalizedObservations: [] }).success,
  ).toBe(false);
});

const spendMeasure = { kind: "AD_SPEND", unit: "minorCNY" } as const;
function spendObservation() {
  const reference = {
    ...sourceRef,
    kind: "NORMALIZED_AGGREGATE",
    measure: spendMeasure,
    period: baselinePeriod,
    observedAt: baselinePeriod.periodEnd,
  };
  return {
    reference,
    entity: campaign,
    spendMinor: 20000,
    measuredCoverage: {
      binding,
      ...baselinePeriod,
      observedAt: baselinePeriod.periodEnd,
      sourceVersion: "measurement-source-v1",
      evidenceIds: ["campaign-record"],
      coverageBasisPoints: 10000,
    },
    visibleAt: baselinePeriod.periodEnd,
    computedAt: baselinePeriod.periodEnd,
    sourceWatermark: baselinePeriod.periodEnd,
    evidenceIds: ["campaign-record"],
    quality: { ...quality, sampleSize: 1 },
  };
}
function spendRequest() {
  const observation = spendObservation();
  return {
    ...baselineRequest,
    eventType: "AD_SPEND_SPIKE",
    entity: campaign,
    measure: spendMeasure,
    candidates: [],
    normalizedObservations: [observation],
    sourceReferences: [observation.reference],
  };
}
function spendRequestWithObservation(patch: object) {
  const value = spendRequest();
  return { ...value, normalizedObservations: [{ ...spendObservation(), ...patch }] };
}
it("accepts a strict measured ad-spend observation without attribution dependency", () => {
  expect(EventMeasureSchema.safeParse(spendMeasure).success).toBe(true);
  const parsed = BaselineRequestSchema.parse(spendRequest());
  expect(Object.isFrozen(parsed.normalizedObservations)).toBe(true);
  expect(Object.isFrozen(parsed.normalizedObservations?.[0])).toBe(true);
  expect(MetricValueSchema.safeParse({ ...spendMeasure, value: 20000 }).success).toBe(false);
  expect(
    MetricSnapshotV1Schema.safeParse({ ...snapshot, metric: { ...spendMeasure, value: 20000 } })
      .success,
  ).toBe(false);
});
it("accepts AVAILABLE/ZERO ad-spend baseline and direct aggregate detection", () => {
  for (const median of [20000.5, 0]) {
    const baseline = {
      ...common.baseline,
      measure: spendMeasure,
      median,
      mad: 15000.5,
      status: median === 0 ? "ZERO" : "AVAILABLE",
      sourceReferences: [spendObservation().reference],
    };
    const current = { ...spendObservation().reference, period, observedAt: end };
    expect(
      EventDetectionRequestSchema.safeParse({
        evidence: { ...evidence(7), baseline, sourceReferences: [current] },
        baseline,
        snapshots: [],
        policy,
      }).success,
    ).toBe(true);
  }
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null])(
  "rejects invalid verified spend amount %s",
  (spendMinor) => {
    expect(
      BaselineRequestSchema.safeParse(spendRequestWithObservation({ spendMinor })).success,
    ).toBe(false);
  },
);
it("accepts explicitly measured zero spend with positive source sample size", () => {
  expect(
    BaselineRequestSchema.safeParse(spendRequestWithObservation({ spendMinor: 0 })).success,
  ).toBe(true);
});
it.each([
  { extra: true },
  { entity: store },
  { entity: sku },
  { entity: { ...campaign, externalCampaignId: "other" } },
  { visibleAt: baselinePeriod.periodStart },
  { computedAt: future },
  { visibleAt: "2026-09-25T06:00:00.0001Z" },
  { sourceWatermark: null },
  { sourceWatermark: baselinePeriod.periodStart },
  { measuredCoverage: null },
  { quality: { ...quality, sampleSize: 0 } },
  { quality: { ...quality, sampleSize: 1, coverageBasisPoints: 9999 } },
  {
    quality: {
      ...quality,
      sampleSize: 1,
      issues: [{ code: "SOURCE_INCONSISTENT", field: "spend", evidenceIds: ["campaign-record"] }],
    },
  },
])("rejects invalid spend observation %j", (patch) => {
  expect(BaselineRequestSchema.safeParse(spendRequestWithObservation(patch)).success).toBe(false);
});
it.each([
  { binding: { ...binding, connectionId: "foreign" } },
  { periodStart: start },
  { currency: "USD" },
  { evidenceIds: ["foreign"] },
  { observedAt: end },
  { observedAt: "2026-09-25T06:00:00.0001Z" },
  { periodStart: "2026-09-24T16:00:00.0001Z" },
  { periodEnd: "2026-09-25T06:00:00.0001Z" },
  { coverageBasisPoints: 9999 },
])("rejects inconsistent measured spend coverage %j", (patch) => {
  const measuredCoverage = { ...spendObservation().measuredCoverage, ...patch };
  expect(
    BaselineRequestSchema.safeParse(spendRequestWithObservation({ measuredCoverage })).success,
  ).toBe(false);
});
it.each([
  { kind: "METRIC_SNAPSHOT" },
  { hash: "foreign" },
  { id: "foreign" },
  { version: "foreign" },
  { definitionVersion: "foreign" },
  { binding: { ...binding, storeId: "foreign" } },
  { measure: { kind: "AD_SPEND", unit: "basisPoints" } },
])("requires exact normalized spend reference %j", (patch) => {
  const value = spendRequest();
  expect(
    BaselineRequestSchema.safeParse({
      ...value,
      sourceReferences: [{ ...value.sourceReferences[0], ...patch }],
    }).success,
  ).toBe(false);
});
it.each([
  { eventType: "ROAS_DROP" },
  { eventType: "CANCELLED_ORDER_SPIKE" },
  { entity: store },
  { measure: { kind: "ROAS", unit: "basisPoints" } },
  { definitionVersion: "foreign" },
  { binding: { ...binding, workspaceId: "foreign" } },
  { sourceReferences: [] },
  { normalizedObservations: [spendObservation(), cancellationObservation()] },
  { normalizedObservations: Array.from({ length: 1001 }, spendObservation) },
])("rejects wrong spend request domain or scope %j", (patch) => {
  expect(BaselineRequestSchema.safeParse({ ...spendRequest(), ...patch }).success).toBe(false);
});
it("keeps explicit unavailable and unmeasured diagnostic spend with limitations", () => {
  for (const dataStatus of ["UNAVAILABLE", "INSUFFICIENT"] as const) {
    const patch = {
      spendMinor: dataStatus === "UNAVAILABLE" ? null : 20000,
      measuredCoverage: null,
      sourceWatermark: dataStatus === "UNAVAILABLE" ? null : baselinePeriod.periodEnd,
      quality: {
        dataStatus,
        sampleSize: 0,
        coverageBasisPoints: 0,
        issues: [{ code: "WINDOW_MISMATCH", field: "spend", evidenceIds: ["campaign-record"] }],
      },
    };
    const parsed = BaselineRequestSchema.parse(spendRequestWithObservation(patch));
    expect(parsed.normalizedObservations?.[0]?.quality.issues[0]?.code).toBe("WINDOW_MISMATCH");
  }
});
it.each([
  {
    quality: {
      dataStatus: "INSUFFICIENT",
      sampleSize: 1,
      coverageBasisPoints: 1,
      issues: [{ code: "PARTIAL_COVERAGE", field: "spend", evidenceIds: ["campaign-record"] }],
    },
  },
  {
    quality: {
      dataStatus: "INSUFFICIENT",
      sampleSize: 1,
      coverageBasisPoints: 0,
      issues: [{ code: "LOW_SAMPLE", field: "spend", evidenceIds: ["campaign-record"] }],
    },
  },
])("requires zero coverage and a relevant issue when measured provenance is absent %j", (patch) => {
  expect(
    BaselineRequestSchema.safeParse(
      spendRequestWithObservation({ measuredCoverage: null, ...patch }),
    ).success,
  ).toBe(false);
});
it("limits partial coverage claims and checks every spend issue evidence ID", () => {
  const item = spendObservation();
  const quality = {
    ...item.quality,
    dataStatus: "INSUFFICIENT",
    coverageBasisPoints: 5000,
    issues: [{ code: "PARTIAL_COVERAGE", field: "spend", evidenceIds: ["campaign-record"] }],
  };
  const partial = {
    ...item,
    quality,
    measuredCoverage: { ...item.measuredCoverage, coverageBasisPoints: 5000 },
  };
  expect(BaselineRequestSchema.safeParse(spendRequestWithObservation(partial)).success).toBe(true);
  expect(
    BaselineRequestSchema.safeParse(
      spendRequestWithObservation({
        ...partial,
        quality: { ...quality, coverageBasisPoints: 5001 },
      }),
    ).success,
  ).toBe(false);
  expect(
    BaselineRequestSchema.safeParse(
      spendRequestWithObservation({
        ...partial,
        quality: {
          ...quality,
          issues: [{ code: "PARTIAL_COVERAGE", field: "spend", evidenceIds: ["foreign"] }],
        },
      }),
    ).success,
  ).toBe(false);
});
it("allows current spend references on both marketing events, with spend baseline only on spend spike", () => {
  const current = { ...spendObservation().reference, period, observedAt: end };
  expect(accepts({ ...evidence(6), sourceReferences: [current] })).toBe(true);
  expect(accepts({ ...evidence(7), sourceReferences: [current] })).toBe(true);
  expect(accepts({ ...evidence(), sourceReferences: [current] })).toBe(false);
  const baseline = {
    ...common.baseline,
    measure: spendMeasure,
    sourceReferences: [spendObservation().reference],
  };
  expect(accepts({ ...evidence(6), baseline, sourceReferences: [current] })).toBe(false);
});
it("scopes event-only measures even without observations, and permits empty spend history", () => {
  const { normalizedObservations: omitted, ...value } = spendRequest();
  expect(omitted).toHaveLength(1);
  expect(BaselineRequestSchema.safeParse(value).success).toBe(true);
  expect(BaselineRequestSchema.safeParse({ ...value, normalizedObservations: [] }).success).toBe(
    true,
  );
  expect(BaselineRequestSchema.safeParse({ ...value, eventType: "ROAS_DROP" }).success).toBe(false);
});

import {
  EventCancellationObservationSchema,
  EventAdSpendObservationSchema,
  EventNormalizedObservationSchema,
  type EventCancellationObservation,
} from "../index.js";
it("preserves typed cancellation arrays and frozen measured spend provenance in the two-variant union", () => {
  const cancellations: readonly EventCancellationObservation[] = [
    EventCancellationObservationSchema.parse(cancellationObservation()),
  ];
  const legacy: BaselineRequest = {
    ...BaselineRequestSchema.parse(cancellationRequest()),
    normalizedObservations: cancellations,
  };
  expect(BaselineRequestSchema.parse(legacy).normalizedObservations).toEqual(cancellations);
  const spend = EventAdSpendObservationSchema.parse(spendObservation());
  expect(Object.isFrozen(spend.measuredCoverage)).toBe(true);
  expect(Object.isFrozen(spend.measuredCoverage?.evidenceIds)).toBe(true);
  expect(EventNormalizedObservationSchema.safeParse(cancellations[0]).success).toBe(true);
  expect(EventNormalizedObservationSchema.safeParse(spend).success).toBe(true);
  expect(
    EventNormalizedObservationSchema.safeParse({ ...spend, rate: cancellationObservation().rate })
      .success,
  ).toBe(false);
});
