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
