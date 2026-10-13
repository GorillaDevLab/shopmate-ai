// These adapters are intentionally synthetic: they demonstrate injection, not runtime integration.

import type {
  MetricSourceReader,
  MetricCalculator,
  MetricSnapshotRepository,
  MetricReadPort,
  ExactMinorMath,
  MetricWindowResolver,
  PaymentMetricCalculator,
  RefundMetricCalculator,
  FrozenCostCalculator,
  ContributionCalculator,
  InventoryCoverageCalculator,
  FunnelMarketingCalculator,
  ProfitDeltaAttributionV1,
  MetricQualityReducer,
  QualityPolicy,
  MetricLeafPorts,
} from "./metric-ports.js";
import type { MetricInputV1, MetricComputationV1 } from "./metric.schema.js";

import { expect, expectTypeOf, it } from "vitest";
import {
  MetricInputV1Schema,
  MetricSnapshotV1Schema,
  MetricComputationV1Schema,
} from "./metric.schema.js";

const start = "2026-10-01T16:00:00Z";
const end = "2026-10-02T06:00:00Z";
const later = "2026-10-03T06:00:00Z";
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const source = {
  version: "source-v1",
  updatedAt: start,
  quality: { state: "COMPLETE", issues: [] },
};
const provenance = {
  binding,
  observedAt: end,
  sourceVersion: "source-v1",
  evidenceIds: ["fact-a"],
};
const order = {
  externalStoreId: "external-a",
  externalOrderId: "order-a",
  source,
  status: "PAID",
  orderedAt: start,
  paidAt: start,
  currency: "CNY",
  grossMinor: 12000,
  discountMinor: 2000,
  shippingMinor: 500,
  payableMinor: 10500,
  paidMinor: 10500,
  refundedMinor: 0,
  items: [
    {
      externalLineId: "line-a",
      externalProductId: "product-a",
      externalSkuId: "sku-a",
      quantity: 2,
      unitPriceMinor: 6000,
      grossMinor: 12000,
      discountMinor: 2000,
      netMinor: 10000,
    },
  ],
};
const window = { periodStart: start, periodEnd: end, timezone: "Asia/Shanghai", currency: "CNY" };
const collections = {
  paymentFacts: [],
  refundFacts: [],
  inventoryFacts: [],
  campaignFacts: [],
  frozenCosts: null,
  refundAllocations: null,
  returnReceipts: null,
  fees: null,
  traffic: null,
  inventoryExtensions: null,
};
const baseInput = {
  schemaVersion: 1,
  definitionVersion: "g4-v1",
  inputRevision: "revision-a",
  binding,
  ...window,
  visibleAt: end,
  sourceWatermark: end,
  status: "VERIFIED",
  evidenceIds: ["sync-a"],
  ...collections,
};
const revenueCoverage = {
  schemaVersion: 1,
  definitionVersion: "g4-v1",
  inputRevision: "revision-a",
  ...provenance,
  ...window,
  visibleAt: end,
  sourceWatermark: end,
  evidenceIds: ["sync-a"],
  kind: "PAID_REVENUE",
  subject: { kind: "STORE" },
  collections: ["paymentFacts"],
  coverageBasisPoints: 10000,
};
const input = { ...baseInput, metricCoverage: [revenueCoverage] };
const snapshot = {
  schemaVersion: 1,
  definitionVersion: "g4-v1",
  inputRevision: "revision-a",
  binding,
  ...window,
  visibleAt: end,
  sourceWatermark: end,
  computedAt: end,
  sampleSize: 0,
  coverageBasisPoints: 10000,
  status: "VERIFIED",
  evidenceIds: ["sync-a"],
  issues: [],
  subject: { kind: "STORE" },
  metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 0 },
};
function parsedInput(value: unknown): Record<string, unknown> {
  return MetricInputV1Schema.parse(value);
}
function parsedSnapshot(value: unknown): Record<string, unknown> {
  return MetricSnapshotV1Schema.parse(value);
}
it("accepts synchronized evidence-backed empty periods", () => {
  expect(parsedInput(input).sourceWatermark).toBe(end);
  expect(parsedSnapshot(snapshot).status).toBe("VERIFIED");
});
it("preserves unsynchronized null facts and unavailable snapshots", () => {
  const absent = Object.fromEntries(Object.keys(collections).map((key) => [key, null]));
  const unavailable = {
    ...input,
    ...absent,
    metricCoverage: [],
    sourceWatermark: null,
    status: "UNAVAILABLE",
  };
  expect(parsedInput(unavailable).paymentFacts).toBeNull();
  const result = {
    ...snapshot,
    sourceWatermark: null,
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
    issues: [{ code: "NOT_SYNCHRONIZED", field: "paymentFacts", evidenceIds: ["sync-a"] }],
    metric: { ...snapshot.metric, value: null },
  };
  expect(parsedSnapshot(result).sourceWatermark).toBeNull();
});
it("consumes the existing immutable order DTO with fact provenance", () => {
  const value = { ...input, paymentFacts: [{ ...provenance, data: order }] };
  const parsed = parsedInput(value);
  expect(parsed.paymentFacts).toEqual(value.paymentFacts);
  expect(Object.isFrozen(parsed.paymentFacts)).toBe(true);
});
it.each(["organizationId", "workspaceId", "storeId", "connectionId", "externalStoreId"])(
  "rejects %s leakage in nested source facts",
  (key) => {
    const fact = { ...provenance, binding: { ...binding, [key]: "foreign" }, data: order };
    expect(MetricInputV1Schema.safeParse({ ...input, paymentFacts: [fact] }).success).toBe(false);
  },
);
it.each([
  { unexpected: true },
  { currency: "USD" },
  { definitionVersion: "" },
  { inputRevision: "" },
  { evidenceIds: [] },
  { schemaVersion: 2 },
  { periodEnd: start },
  { periodStart: end },
  { periodEnd: later },
  { sourceWatermark: later },
  { visibleAt: start },
  { timezone: "UTC" },
  { periodStart: "2026-10-02T00:00:00+08:00" },
  { sourceWatermark: null },
  { status: "UNAVAILABLE" },
])("rejects invalid input boundary %j", (patch) => {
  expect(MetricInputV1Schema.safeParse({ ...input, ...patch }).success).toBe(false);
});
it.each([
  { observedAt: later },
  { sourceVersion: "" },
  { evidenceIds: [] },
  { unexpected: true },
  { data: { ...order, externalStoreId: "foreign" } },
  { data: { ...order, source: { ...source, updatedAt: later } } },
  { data: { ...order, paidAt: later } },
  { data: { ...order, currency: "USD" } },
  { data: { ...order, paidMinor: Number.MAX_SAFE_INTEGER + 1 } },
  { data: { ...order, items: [{ ...order.items[0], quantity: 0 }] } },
])("rejects invalid fact provenance or DTO %j", (patch) => {
  const paymentFacts = [{ ...provenance, data: order, ...patch }];
  expect(MetricInputV1Schema.safeParse({ ...input, paymentFacts }).success).toBe(false);
});
it.each([
  { unexpected: true },
  { currency: "USD" },
  { definitionVersion: "" },
  { inputRevision: "" },
  { evidenceIds: [] },
  { periodEnd: start },
  { sourceWatermark: later },
  { computedAt: start },
  { sourceWatermark: null },
  { sampleSize: -1 },
  { sampleSize: 0.5 },
  { sampleSize: Number.MAX_SAFE_INTEGER + 1 },
  { coverageBasisPoints: 10001 },
  { coverageBasisPoints: 9999 },
  { status: "SUCCESS" },
  { metric: { ...snapshot.metric, value: null } },
  { metric: { ...snapshot.metric, unit: "units" } },
  { metric: { ...snapshot.metric, value: -1 } },
  { metric: { ...snapshot.metric, value: 0.1 } },
  { metric: { ...snapshot.metric, value: Number.MAX_SAFE_INTEGER + 1 } },
])("rejects invalid snapshot boundary %j", (patch) => {
  expect(MetricSnapshotV1Schema.safeParse({ ...snapshot, ...patch }).success).toBe(false);
});
it.each([
  { kind: "GROSS_PROFIT", unit: "minorCNY", value: -200 },
  { kind: "NET_REVENUE_SETTLEMENT", unit: "minorCNY", value: -100 },
  { kind: "PAID_UNITS", unit: "units", value: 2 },
  { kind: "CONVERSION_RATE", unit: "basisPoints", value: 1000 },
  { kind: "ROAS", unit: "basisPoints", value: 30000 },
  { kind: "INVENTORY_HOURS_REMAINING", unit: "hours", value: 1.5 },
])("accepts explicit metric kind and unit %j", (metric) => {
  expect(parsedSnapshot({ ...snapshot, metric }).metric).toEqual(metric);
});
it.each([
  { kind: "CONVERSION_RATE", unit: "basisPoints", value: 10001 },
  { kind: "PAID_UNITS", unit: "units", value: 0.5 },
  { kind: "GROSS_PROFIT", unit: "minorCNY", value: -Number.MAX_SAFE_INTEGER - 1 },
  { kind: "INVENTORY_HOURS_REMAINING", unit: "hours", value: Infinity },
  { kind: "ROAS", unit: "basisPoints", value: -1 },
])("rejects invalid kind-specific numeric values %j", (metric) => {
  expect(MetricSnapshotV1Schema.safeParse({ ...snapshot, metric }).success).toBe(false);
});

const inventory = {
  externalStoreId: "external-a",
  externalSkuId: "sku-a",
  externalLocationId: "location-a",
  source,
  available: 12,
  reserved: 0,
  onHand: 12,
  safetyStock: null,
  leadTimeDays: null,
};
const refund = {
  externalStoreId: "external-a",
  externalRefundId: "refund-a",
  externalOrderId: "order-a",
  externalSkuId: "sku-a",
  status: "SUCCEEDED",
  requestedMinor: 2000,
  succeededMinor: 2000,
  requestedAt: start,
  succeededAt: start,
  currency: "CNY",
  source,
};
const campaign = {
  externalStoreId: "external-a",
  externalCampaignId: "campaign-a",
  date: "2026-10-02",
  source,
  currency: "CNY",
  impressions: 1000,
  clicks: 100,
  attributedOrders: 10,
  spendMinor: 10000,
  attributedRevenueMinor: 30000,
};
const extensionData = {
  frozenCosts: {
    externalOrderId: "order-a",
    externalLineId: "line-a",
    externalSkuId: "sku-a",
    quantity: 2,
    frozenAt: start,
    skuCostVersion: "cost-v1",
    unitCostMinor: 3000,
    basis: "CONFIRMED",
    currency: "CNY",
  },
  refundAllocations: {
    externalRefundId: "refund-a",
    externalOrderId: "order-a",
    externalLineId: "line-a",
    externalSkuId: "sku-a",
    merchandiseMinor: 2000,
    buyerShippingMinor: 0,
    currency: "CNY",
  },
  returnReceipts: {
    externalReceiptId: "receipt-a",
    externalRefundId: "refund-a",
    externalOrderId: "order-a",
    externalLineId: "line-a",
    externalSkuId: "sku-a",
    acceptedAt: start,
    resellableQuantity: 1,
  },
  fees: {
    ...window,
    kind: "FULFILLMENT",
    externalOrderId: null,
    amountMinor: 700,
    coverageBasisPoints: 10000,
    basis: "CONFIRMED",
  },
  traffic: {
    ...window,
    visitors: 1000,
    cart: 200,
    checkout: 150,
    paidOrders: 100,
    coverageBasisPoints: 10000,
  },
  inventoryExtensions: {
    externalSkuId: "sku-a",
    externalLocationId: "location-a",
    asOf: start,
    quarantine: null,
    inbound: null,
    leadTimeHours: null,
    safetyBufferHours: null,
    eta: later,
  },
};
it.each(Object.entries(extensionData))(
  "preserves scoped extension %s and explicit missing data",
  (key, data) => {
    const fact = { ...provenance, data };
    expect(parsedInput({ ...input, [key]: [fact] })[key]).toEqual([fact]);
    expect(parsedInput({ ...input, [key]: [{ ...provenance, data: null }] })[key]).toEqual([
      { ...provenance, data: null },
    ]);
  },
);
it.each(Object.entries(extensionData))("rejects scope leakage inside extension %s", (key, data) => {
  const fact = { ...provenance, binding: { ...binding, storeId: "foreign" }, data };
  expect(MetricInputV1Schema.safeParse({ ...input, [key]: [fact] }).success).toBe(false);
});
it.each(Object.entries(extensionData))(
  "rejects unknown fields inside extension %s",
  (key, data) => {
    const fact = { ...provenance, data: { ...data, unknownField: true } };
    expect(MetricInputV1Schema.safeParse({ ...input, [key]: [fact] }).success).toBe(false);
  },
);
it.each([
  ["refundFacts", refund],
  ["inventoryFacts", inventory],
  ["campaignFacts", campaign],
])("reuses normalized %s validation", (key, data) => {
  const fact = {
    ...provenance,
    data,
    ...(key === "campaignFacts" ? { measuredCoverage: null } : {}),
  };
  expect(parsedInput({ ...input, [String(key)]: [fact] })[String(key)]).toEqual([fact]);
});
it("preserves nullable normalized inventory and source metadata", () => {
  const data = {
    ...inventory,
    available: null,
    source: {
      version: null,
      updatedAt: null,
      quality: { state: "PARTIAL", issues: ["INVENTORY_UNKNOWN", "SOURCE_TIME_MISSING"] },
    },
  };
  const facts = [{ ...provenance, data }];
  expect(parsedInput({ ...input, inventoryFacts: facts }).inventoryFacts).toEqual(facts);
});
it.each([
  ["frozenCosts", { ...extensionData.frozenCosts, frozenAt: later }],
  ["frozenCosts", { ...extensionData.frozenCosts, skuCostVersion: null }],
  ["returnReceipts", { ...extensionData.returnReceipts, acceptedAt: later }],
  ["fees", { ...extensionData.fees, periodEnd: later }],
  ["fees", { ...extensionData.fees, amountMinor: null }],
  ["traffic", { ...extensionData.traffic, periodEnd: later }],
  ["inventoryExtensions", { ...extensionData.inventoryExtensions, asOf: later }],
  ["refundFacts", { ...refund, succeededAt: later }],
  ["campaignFacts", { ...campaign, date: "2026-10-04" }],
])("rejects future-visible or incomplete confirmed data %s", (key, data) => {
  expect(
    MetricInputV1Schema.safeParse({ ...input, [String(key)]: [{ ...provenance, data }] }).success,
  ).toBe(false);
});
it.each(["ESTIMATED", "INSUFFICIENT", "STALE", "UNAVAILABLE"])(
  "retains %s status and multiple quality reasons",
  (status) => {
    const issues = [
      { code: "COST_MISSING", field: "frozenCosts", evidenceIds: ["sync-a"] },
      { code: "STALE_SOURCE", field: "paymentFacts", evidenceIds: ["sync-a"] },
    ];
    expect(
      parsedSnapshot({ ...snapshot, status, issues, metric: { ...snapshot.metric, value: null } })
        .issues,
    ).toEqual(issues);
  },
);
it("rejects issue evidence outside the snapshot evidence set", () => {
  const issues = [{ code: "COST_MISSING", field: "frozenCosts", evidenceIds: ["foreign"] }];
  expect(
    MetricSnapshotV1Schema.safeParse({ ...snapshot, status: "ESTIMATED", issues }).success,
  ).toBe(false);
});
it("rejects VERIFIED zero when the source watermark does not cover the period", () => {
  expect(MetricSnapshotV1Schema.safeParse({ ...snapshot, sourceWatermark: start }).success).toBe(
    false,
  );
});
it("validates snapshots against their immutable source input", async () => {
  const schema = await import("./metric.schema.js");
  expect(schema).toHaveProperty("MetricComputationV1Schema");
});

it("accepts a snapshot paired with the exact input revision", () => {
  expect(MetricComputationV1Schema.safeParse({ input, snapshot }).success).toBe(true);
});
it.each([
  { definitionVersion: "g4-v2" },
  { inputRevision: "revision-b" },
  { binding: { ...binding, connectionId: "foreign" } },
  { periodStart: "2026-10-01T17:00:00Z" },
  { visibleAt: later, computedAt: later },
  { evidenceIds: ["foreign"] },
])("rejects a snapshot detached from its source %j", (patch) => {
  expect(
    MetricComputationV1Schema.safeParse({ input, snapshot: { ...snapshot, ...patch } }).success,
  ).toBe(false);
});
it("rejects promotion of unsynchronized input to VERIFIED zero", () => {
  const absent = Object.fromEntries(Object.keys(collections).map((key) => [key, null]));
  const unavailable = {
    ...input,
    ...absent,
    metricCoverage: [],
    sourceWatermark: null,
    status: "UNAVAILABLE",
  };
  expect(MetricComputationV1Schema.safeParse({ input: unavailable, snapshot }).success).toBe(false);
});
it("allows snapshot evidence retained from a normalized fact", () => {
  const withFact = { ...input, paymentFacts: [{ ...provenance, data: order }] };
  expect(
    MetricComputationV1Schema.safeParse({
      input: withFact,
      snapshot: { ...snapshot, evidenceIds: ["sync-a", "fact-a"] },
    }).success,
  ).toBe(true);
});

it("accepts readonly source, pure calculator, append-only repository and authorized read adapters", async () => {
  const parsed = MetricInputV1Schema.parse(input);
  const computed = MetricComputationV1Schema.parse({ input, snapshot });
  const sourceReader: MetricSourceReader = { read: async () => ({ ok: true, value: parsed }) };
  const calculator: MetricCalculator = { calculate: () => ({ ok: true, value: computed }) };
  const repository: MetricSnapshotRepository = {
    append: async () => ({ ok: true, value: computed.snapshot }),
    read: async () => ({ ok: true, value: [computed.snapshot] }),
  };
  const reader: MetricReadPort = { read: async () => ({ ok: true, value: [computed.snapshot] }) };
  expectTypeOf(sourceReader.read).returns.resolves.toMatchTypeOf<{ readonly ok: boolean }>();
  expectTypeOf<
    Parameters<MetricSnapshotRepository["append"]>[0]
  >().toEqualTypeOf<MetricComputationV1>();
  expectTypeOf<
    Parameters<MetricCalculator["calculate"]>[0]["input"]
  >().toEqualTypeOf<MetricInputV1>();
  expect(
    calculator.calculate({
      input: parsed,
      computedAt: end,
      kind: "PAID_REVENUE",
      subject: { kind: "STORE" },
    }).ok,
  ).toBe(true);
  expect((await repository.append(computed)).ok).toBe(true);
  expect(reader).toHaveProperty("read");
});
it("exposes independently injectable leaf calculations", () => {
  expectTypeOf<MetricLeafPorts["math"]>().toEqualTypeOf<ExactMinorMath>();
  expectTypeOf<MetricLeafPorts["windows"]>().toEqualTypeOf<MetricWindowResolver>();
  expectTypeOf<MetricLeafPorts["payments"]>().toEqualTypeOf<PaymentMetricCalculator>();
  expectTypeOf<MetricLeafPorts["refunds"]>().toEqualTypeOf<RefundMetricCalculator>();
  expectTypeOf<MetricLeafPorts["frozenCosts"]>().toEqualTypeOf<FrozenCostCalculator>();
  expectTypeOf<MetricLeafPorts["contribution"]>().toEqualTypeOf<ContributionCalculator>();
  expectTypeOf<MetricLeafPorts["inventory"]>().toEqualTypeOf<InventoryCoverageCalculator>();
  expectTypeOf<MetricLeafPorts["funnelMarketing"]>().toEqualTypeOf<FunnelMarketingCalculator>();
  expectTypeOf<MetricLeafPorts["profitDelta"]>().toEqualTypeOf<ProfitDeltaAttributionV1>();
  expectTypeOf<MetricLeafPorts["quality"]>().toEqualTypeOf<MetricQualityReducer>();
  expectTypeOf<QualityPolicy["version"]>().toEqualTypeOf<string>();
});

it("permits test-only leaf adapters without a provider, repository or oracle", () => {
  const unavailable = () =>
    ({ ok: false, error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["test-only"] } }) as const;
  const quality = {
    status: "UNAVAILABLE",
    sampleSize: 0,
    coverageBasisPoints: 0,
    evidenceIds: ["test-only"],
    issues: [],
  } as const;
  const leafPorts: MetricLeafPorts = {
    math: {
      add: unavailable,
      subtract: unavailable,
      multiply: unavailable,
      ratio: unavailable,
      allocate: unavailable,
    },
    clock: { snapshot: () => ({ now: end, revision: 1 }) },
    windows: { businessDay: unavailable, elapsed: unavailable, align: unavailable },
    payments: { calculate: unavailable },
    refunds: { calculate: unavailable },
    frozenCosts: { calculate: unavailable },
    contribution: { calculate: unavailable },
    inventory: { calculate: unavailable },
    funnelMarketing: { calculate: unavailable },
    profitDelta: { calculate: unavailable },
    quality: { reduce: () => quality },
  };
  expect(leafPorts.payments.calculate(MetricInputV1Schema.parse(input))).toEqual(unavailable());
  expect(leafPorts.math.ratio(0, 0, "HALF_AWAY_FROM_ZERO")).toEqual(unavailable());
  expect(leafPorts.clock.snapshot().now).toBe(end);
});

it("exports metric boundary schemas from the built public package", async () => {
  const publicContracts = await import("@shopmate/contracts");
  expect(publicContracts).toHaveProperty("MetricInputV1Schema");
  expect(publicContracts).toHaveProperty("MetricSnapshotV1Schema");
  expect(publicContracts).toHaveProperty("MetricComputationV1Schema");
});

it("exports metric ports and immutable inputs as public types", () => {
  expectTypeOf<import("@shopmate/contracts").MetricLeafPorts>().toEqualTypeOf<MetricLeafPorts>();
  expectTypeOf<import("@shopmate/contracts").MetricInputV1>().toEqualTypeOf<MetricInputV1>();
});

it.each(["source", "public"])(
  "rejects crossed-null VERIFIED revenue through %s contracts",
  async (entry) => {
    const contract =
      entry === "source" ? await import("./metric.schema.js") : await import("@shopmate/contracts");
    const crossed = { ...input, paymentFacts: null, inventoryFacts: [], metricCoverage: [] };
    expect(contract.MetricInputV1Schema.safeParse(crossed).success).toBe(true);
    expect(contract.MetricComputationV1Schema.safeParse({ input: crossed, snapshot }).success).toBe(
      false,
    );
  },
);
it("rejects globally VERIFIED all-null collections despite a connection watermark", () => {
  const absent = Object.fromEntries(Object.keys(collections).map((key) => [key, null]));
  expect(MetricInputV1Schema.safeParse({ ...input, ...absent, metricCoverage: [] }).success).toBe(
    false,
  );
});

it("requires metric-specific coverage rather than snapshot self-assertion", () => {
  expect(
    MetricComputationV1Schema.safeParse({ input: { ...input, metricCoverage: [] }, snapshot })
      .success,
  ).toBe(false);
});
it("preserves verified revenue when unrelated costs are unknown", () => {
  const partial = { ...input, status: "ESTIMATED", frozenCosts: null };
  expect(MetricComputationV1Schema.safeParse({ input: partial, snapshot }).success).toBe(true);
});
it.each([
  { kind: "GMV" },
  { subject: { kind: "SKU", externalSkuId: "sku-a" } },
  { collections: ["inventoryFacts"] },
  { coverageBasisPoints: 9999 },
])("rejects unrelated or incomplete revenue coverage %j", (patch) => {
  const covered = { ...input, metricCoverage: [{ ...revenueCoverage, ...patch }] };
  expect(MetricComputationV1Schema.safeParse({ input: covered, snapshot }).success).toBe(false);
});
it.each([
  { binding: { ...binding, storeId: "foreign" } },
  { inputRevision: "foreign" },
  { definitionVersion: "foreign" },
  { periodStart: "2026-10-01T17:00:00Z" },
  { visibleAt: later },
  { sourceWatermark: start },
  { observedAt: later },
  { evidenceIds: ["foreign"] },
  { collections: ["paymentFacts", "paymentFacts"] },
  { collections: [] },
  { sourceVersion: "" },
  { unexpected: true },
])("rejects detached completeness provenance %j", (patch) => {
  const covered = { ...input, metricCoverage: [{ ...revenueCoverage, ...patch }] };
  expect(MetricInputV1Schema.safeParse(covered).success).toBe(false);
});
it("rejects coverage claims for an unobserved payment collection", () => {
  expect(MetricInputV1Schema.safeParse({ ...input, paymentFacts: null }).success).toBe(false);
});
it("links completeness evidence into the resulting snapshot", () => {
  const withFact = { ...input, paymentFacts: [{ ...provenance, data: order }] };
  const factOnly = { ...snapshot, evidenceIds: ["fact-a"] };
  expect(MetricComputationV1Schema.safeParse({ input: withFact, snapshot: factOnly }).success).toBe(
    false,
  );
});

it.each(["paidMinor", "paidAt"])(
  "does not promote explicitly unknown payment %s using complete coverage",
  (field) => {
    const data = {
      ...order,
      [field]: null,
      source: { ...source, quality: { state: "PARTIAL", issues: ["PAYMENT_UNKNOWN"] } },
    };
    const partial = { ...input, paymentFacts: [{ ...provenance, data }] };
    expect(MetricInputV1Schema.safeParse(partial).success).toBe(true);
    expect(MetricComputationV1Schema.safeParse({ input: partial, snapshot }).success).toBe(false);
  },
);
it("keeps revenue verifiable when only refund data is unknown", () => {
  const data = {
    ...order,
    refundedMinor: null,
    source: { ...source, quality: { state: "PARTIAL", issues: ["REFUND_UNKNOWN"] } },
  };
  expect(
    MetricComputationV1Schema.safeParse({
      input: { ...input, paymentFacts: [{ ...provenance, data }] },
      snapshot,
    }).success,
  ).toBe(true);
});
it("allows source readers to receive explicit metric and subject coverage requests", () => {
  expectTypeOf<Parameters<MetricSourceReader["read"]>[0]["coverageRequests"]>().toEqualTypeOf<
    readonly Readonly<{
      kind: import("./metric.schema.js").MetricKind;
      subject: import("./metric.schema.js").MetricSubject;
    }>[]
  >();
});

const roasCoverage = { ...revenueCoverage, kind: "ROAS", collections: ["campaignFacts"] };
const roasSnapshot = { ...snapshot, metric: { kind: "ROAS", unit: "basisPoints", value: 30000 } };
it("rejects date-only campaign evidence as VERIFIED partial-day ROAS", () => {
  const daily = {
    ...input,
    metricCoverage: [roasCoverage],
    campaignFacts: [{ ...provenance, data: campaign, measuredCoverage: null }],
  };
  expect(MetricInputV1Schema.safeParse(daily).success).toBe(true);
  expect(
    MetricComputationV1Schema.safeParse({ input: daily, snapshot: roasSnapshot }).success,
  ).toBe(false);
});

const measuredCoverage = { ...provenance, ...window, coverageBasisPoints: 10000 };
const measuredFact = { ...provenance, data: campaign, measuredCoverage };
const measuredInput = { ...input, campaignFacts: [measuredFact], metricCoverage: [roasCoverage] };
const measuredSnapshot = { ...roasSnapshot, evidenceIds: ["sync-a", "fact-a"] };
it.each(["source", "public"])(
  "accepts explicit measured partial-day campaign coverage through %s",
  async (entry) => {
    const contract =
      entry === "source" ? await import("./metric.schema.js") : await import("@shopmate/contracts");
    expect(
      contract.MetricComputationV1Schema.safeParse({
        input: measuredInput,
        snapshot: measuredSnapshot,
      }).success,
    ).toBe(true);
  },
);
it("requires an explicit nullable measured coverage field", () => {
  const fact = { ...provenance, data: campaign };
  expect(MetricInputV1Schema.safeParse({ ...input, campaignFacts: [fact] }).success).toBe(false);
});
it("preserves unknown measured intervals as usable unavailable evidence", () => {
  const unknown = {
    ...measuredInput,
    campaignFacts: [{ ...measuredFact, measuredCoverage: null }],
  };
  const result = {
    ...measuredSnapshot,
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
    metric: { ...roasSnapshot.metric, value: null },
    issues: [
      {
        code: "ATTRIBUTION_MISSING",
        field: "campaignFacts.measuredCoverage",
        evidenceIds: ["fact-a"],
      },
    ],
  };
  const parsed = MetricComputationV1Schema.parse({ input: unknown, snapshot: result });
  expect(parsed.input.campaignFacts?.[0]?.measuredCoverage).toBeNull();
});
it.each([
  { periodEnd: later },
  { periodStart: end },
  { periodStart: "2026-10-01T15:00:00Z" },
  { periodStart: "2026-10-02T00:00:00+08:00" },
  { timezone: "UTC" },
  { currency: "USD" },
  { observedAt: later },
  { binding: { ...binding, connectionId: "foreign" } },
  { evidenceIds: ["foreign"] },
  { evidenceIds: [] },
  { sourceVersion: "" },
  { coverageBasisPoints: 10001 },
  { unexpected: true },
])("rejects detached or invalid measured campaign intervals %j", (patch) => {
  const fact = { ...measuredFact, measuredCoverage: { ...measuredCoverage, ...patch } };
  expect(MetricInputV1Schema.safeParse({ ...measuredInput, campaignFacts: [fact] }).success).toBe(
    false,
  );
});
it("rejects a measured interval outside the daily DTO date", () => {
  const fact = { ...measuredFact, data: { ...campaign, date: "2026-10-01" } };
  expect(MetricInputV1Schema.safeParse({ ...measuredInput, campaignFacts: [fact] }).success).toBe(
    false,
  );
});
it("rejects incomplete measured coverage for VERIFIED ROAS", () => {
  const fact = {
    ...measuredFact,
    measuredCoverage: { ...measuredCoverage, coverageBasisPoints: 9000 },
  };
  const partial = { ...measuredInput, campaignFacts: [fact] };
  expect(MetricInputV1Schema.safeParse(partial).success).toBe(true);
  expect(
    MetricComputationV1Schema.safeParse({ input: partial, snapshot: measuredSnapshot }).success,
  ).toBe(false);
});
it.each(["spendMinor", "attributedRevenueMinor"])(
  "rejects explicitly unknown campaign %s for VERIFIED ROAS",
  (field) => {
    const data = {
      ...campaign,
      [field]: null,
      source: { ...source, quality: { state: "PARTIAL", issues: ["MARKETING_UNKNOWN"] } },
    };
    const partial = { ...measuredInput, campaignFacts: [{ ...measuredFact, data }] };
    expect(MetricInputV1Schema.safeParse(partial).success).toBe(true);
    expect(
      MetricComputationV1Schema.safeParse({ input: partial, snapshot: measuredSnapshot }).success,
    ).toBe(false);
  },
);
it("requires measured campaign evidence in the resulting snapshot", () => {
  expect(
    MetricComputationV1Schema.safeParse({ input: measuredInput, snapshot: roasSnapshot }).success,
  ).toBe(false);
});
it("distinguishes explicit full-day coverage from partial-day coverage", () => {
  const dayEnd = "2026-10-02T16:00:00Z";
  const times = { periodEnd: dayEnd, visibleAt: dayEnd, sourceWatermark: dayEnd };
  const fact = {
    ...measuredFact,
    observedAt: dayEnd,
    measuredCoverage: { ...measuredCoverage, periodEnd: dayEnd, observedAt: dayEnd },
  };
  const full = {
    ...measuredInput,
    ...times,
    campaignFacts: [fact],
    metricCoverage: [{ ...roasCoverage, ...times, observedAt: dayEnd }],
  };
  const result = { ...measuredSnapshot, ...times, computedAt: dayEnd };
  expect(MetricComputationV1Schema.safeParse({ input: full, snapshot: result }).success).toBe(true);
  expect(MetricInputV1Schema.safeParse({ ...measuredInput, campaignFacts: [fact] }).success).toBe(
    false,
  );
});
const dayMiddle = "2026-10-02T16:00:00Z";
const twoDayEnd = "2026-10-03T16:00:00Z";
function campaignSlice(date: string, periodStart: string, periodEnd: string) {
  return {
    ...measuredFact,
    observedAt: twoDayEnd,
    data: { ...campaign, date },
    measuredCoverage: { ...measuredCoverage, periodStart, periodEnd, observedAt: twoDayEnd },
  };
}
function campaignPeriod(periodEnd: string, periodStart = start) {
  const times = { periodStart, periodEnd, visibleAt: twoDayEnd, sourceWatermark: twoDayEnd };
  return {
    input: {
      ...measuredInput,
      ...times,
      metricCoverage: [{ ...roasCoverage, ...times, observedAt: twoDayEnd }],
      campaignFacts: [
        campaignSlice("2026-10-02", periodStart, dayMiddle),
        campaignSlice("2026-10-03", dayMiddle, periodEnd),
      ],
    },
    snapshot: { ...measuredSnapshot, ...times, computedAt: twoDayEnd },
  };
}
it.each(["source", "public"])(
  "accepts two full measured campaign days through %s",
  async (entry) => {
    const contract =
      entry === "source" ? await import("./metric.schema.js") : await import("@shopmate/contracts");
    const period = campaignPeriod(twoDayEnd);
    expect(contract.MetricInputV1Schema.safeParse(period.input).success).toBe(true);
    expect(contract.MetricComputationV1Schema.safeParse(period).success).toBe(true);
  },
);
it("accepts a full measured campaign day followed by the clipped final day", () => {
  expect(MetricComputationV1Schema.safeParse(campaignPeriod(later)).success).toBe(true);
});
it("accepts the clipped first and final campaign day intersections", () => {
  const period = campaignPeriod(later, "2026-10-02T06:00:00Z");
  expect(MetricComputationV1Schema.safeParse(period).success).toBe(true);
});
it("retains measured daily campaign facts in a multi-day payment query", () => {
  const period = campaignPeriod(twoDayEnd);
  const paymentInput = {
    ...period.input,
    metricCoverage: [
      { ...period.input.metricCoverage[0], kind: "PAID_REVENUE", collections: ["paymentFacts"] },
    ],
  };
  const paymentSnapshot = { ...period.snapshot, metric: snapshot.metric };
  expect(
    MetricComputationV1Schema.safeParse({ input: paymentInput, snapshot: paymentSnapshot }).success,
  ).toBe(true);
});
it.each([{ periodStart: "2026-10-01T17:00:00Z" }, { periodEnd: "2026-10-02T06:00:00Z" }])(
  "does not promote an unexplained shorter daily measurement %j",
  (patch) => {
    const period = campaignPeriod(twoDayEnd);
    const first = period.input.campaignFacts[0];
    const partial = {
      ...period.input,
      campaignFacts: [
        { ...first, measuredCoverage: { ...first.measuredCoverage, ...patch } },
        period.input.campaignFacts[1],
      ],
    };
    expect(MetricInputV1Schema.safeParse(partial).success).toBe(true);
    expect(
      MetricComputationV1Schema.safeParse({ input: partial, snapshot: period.snapshot }).success,
    ).toBe(false);
  },
);
it.each([
  null,
  {
    ...campaignSlice("2026-10-03", dayMiddle, twoDayEnd).measuredCoverage,
    coverageBasisPoints: 9999,
  },
])("rejects unknown or incomplete final-day measurement for VERIFIED ROAS %j", (finalCoverage) => {
  const period = campaignPeriod(twoDayEnd);
  const partial = {
    ...period.input,
    campaignFacts: [
      period.input.campaignFacts[0],
      { ...period.input.campaignFacts[1], measuredCoverage: finalCoverage },
    ],
  };
  expect(MetricInputV1Schema.safeParse(partial).success).toBe(true);
  expect(
    MetricComputationV1Schema.safeParse({ input: partial, snapshot: period.snapshot }).success,
  ).toBe(false);
});
it("rejects a full-day measure substituted for the query's clipped final day", () => {
  const period = campaignPeriod(later);
  const outside = {
    ...period.input,
    campaignFacts: [
      period.input.campaignFacts[0],
      campaignSlice("2026-10-03", dayMiddle, twoDayEnd),
    ],
  };
  expect(MetricInputV1Schema.safeParse(outside).success).toBe(false);
});
it("rejects a measured interval before the query's clipped first day", () => {
  const period = campaignPeriod(twoDayEnd, end);
  const outside = {
    ...period.input,
    campaignFacts: [campaignSlice("2026-10-02", start, dayMiddle), period.input.campaignFacts[1]],
  };
  expect(MetricInputV1Schema.safeParse(outside).success).toBe(false);
});
it("types both ratio sides with nullable source measurement provenance", () => {
  type Ratio = import("./metric-ports.js").RatioEvidence<"ROAS">;
  expectTypeOf<Ratio["numeratorCoverage"]>().toEqualTypeOf<
    import("./metric.schema.js").MetricMeasuredCoverage | null
  >();
  expectTypeOf<Ratio["denominatorCoverage"]>().toEqualTypeOf<
    import("./metric.schema.js").MetricMeasuredCoverage | null
  >();
});

const ratioEvidence = {
  measure: {
    metric: roasSnapshot.metric,
    quality: {
      status: "VERIFIED",
      sampleSize: 10,
      coverageBasisPoints: 10000,
      evidenceIds: ["fact-a"],
      issues: [],
    },
  },
  numerator: 30000,
  denominator: 10000,
  window,
  coverageBasisPoints: 10000,
  numeratorCoverage: measuredCoverage,
  denominatorCoverage: measuredCoverage,
};
it("validates known same-window provenance for both ratio sides", async () => {
  const schema = await import("./metric.schema.js");
  expect(schema).toHaveProperty("MetricRatioEvidenceSchema");
});
it.each([
  { numeratorCoverage: null },
  { denominatorCoverage: null },
  { numerator: null },
  { denominator: null },
  { numeratorCoverage: { ...measuredCoverage, periodStart: "2026-10-01T17:00:00Z" } },
  { denominatorCoverage: { ...measuredCoverage, coverageBasisPoints: 9000 } },
  {
    denominatorCoverage: { ...measuredCoverage, binding: { ...binding, connectionId: "foreign" } },
  },
])("rejects VERIFIED ratio sides without matching known provenance %j", async (patch) => {
  const schema = await import("./metric.schema.js");
  expect(schema.MetricRatioEvidenceSchema.safeParse({ ...ratioEvidence, ...patch }).success).toBe(
    false,
  );
});
it("preserves null ratio provenance for unknown marketing evidence", async () => {
  const schema = await import("./metric.schema.js");
  const unknown = {
    ...ratioEvidence,
    numerator: null,
    numeratorCoverage: null,
    measure: {
      ...ratioEvidence.measure,
      quality: { ...ratioEvidence.measure.quality, status: "UNAVAILABLE" },
    },
  };
  expect(schema.MetricRatioEvidenceSchema.safeParse(unknown).success).toBe(true);
  expect(schema.MetricRatioEvidenceSchema.safeParse(ratioEvidence).success).toBe(true);
});
it("accepts aggregate ratio provenance for the complete multi-day query", async () => {
  const { MetricRatioEvidenceSchema } = await import("./metric.schema.js");
  const aggregateCoverage = { ...measuredCoverage, periodEnd: twoDayEnd, observedAt: twoDayEnd };
  const ratio = {
    ...ratioEvidence,
    window: { ...window, periodEnd: twoDayEnd },
    numeratorCoverage: aggregateCoverage,
    denominatorCoverage: aggregateCoverage,
  };
  expect(MetricRatioEvidenceSchema.safeParse(ratio).success).toBe(true);
});
it.each(["numeratorCoverage", "denominatorCoverage"])(
  "rejects a single-day %s substituted for the multi-day aggregate ratio",
  async (side) => {
    const { MetricRatioEvidenceSchema } = await import("./metric.schema.js");
    const aggregateCoverage = { ...measuredCoverage, periodEnd: twoDayEnd, observedAt: twoDayEnd };
    const ratio = {
      ...ratioEvidence,
      window: { ...window, periodEnd: twoDayEnd },
      numeratorCoverage: aggregateCoverage,
      denominatorCoverage: aggregateCoverage,
      [side]: campaignSlice("2026-10-02", start, dayMiddle).measuredCoverage,
    };
    expect(MetricRatioEvidenceSchema.safeParse(ratio).success).toBe(false);
  },
);
