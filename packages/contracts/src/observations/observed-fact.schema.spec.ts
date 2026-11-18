import { expect, it } from "vitest";
import * as api from "../index.js";
import {
  MockObservedGenerationConfigV3Schema,
  ObservedDomainSchema,
  ObservedFactV1Schema,
  ObservedSubjectSchema,
} from "./observed-fact.schema.js";

const binding = {
  organizationId: "org-A",
  workspaceId: "ws-A",
  storeId: "store-A",
  connectionId: "conn-A",
  externalStoreId: "shop-A",
};
const start = "2026-11-01T16:00:00.000Z";
const end = "2026-11-02T16:00:00.000Z";
const later = "2026-11-04T16:00:00.000Z";
const window = { periodStart: start, periodEnd: end, timezone: "Asia/Shanghai", currency: "CNY" };
const sku = { kind: "SKU", externalSkuId: "sku-A" };
const store = { kind: "STORE" };
const campaignSubject = { kind: "CAMPAIGN", externalCampaignId: "c1" };
const connection = { kind: "CONNECTION", connectionId: "conn-A" };
const hash = "a".repeat(64);
const common = {
  schemaVersion: 1,
  ledgerVersion: "observed-facts-v1",
  binding,
  generation: 0,
  factId: "f1",
  sequence: 1,
  sourceVersion: "observed-v1:g:0:e:1",
  priorVersion: null,
  producerVersion: "mock-finance-v1",
  modelVersion: "mock-business-observed-v1",
  occurredAt: end,
  observedAt: end,
  payloadHash: hash,
};
const line = { externalSkuId: "sku-A", externalOrderId: "o1", externalLineId: "l1" };
const location = { externalSkuId: "sku-A", externalLocationId: "loc1" };

const cost = {
  ...common,
  domain: "FROZEN_COST",
  subject: sku,
  payload: {
    ...line,
    quantity: 2,
    frozenAt: end,
    skuCostVersion: "cost-7",
    unitCostMinor: 180,
    basis: "CONFIRMED",
    currency: "CNY",
    reason: null,
  },
};
const refund = {
  ...common,
  factId: "f2",
  domain: "REFUND_ALLOCATION",
  subject: sku,
  payload: {
    ...line,
    externalRefundId: "r1",
    quantity: 1,
    merchandiseMinor: 180,
    buyerShippingMinor: 5,
    settledAt: end,
    currency: "CNY",
    reason: null,
  },
};
const receipt = {
  ...common,
  factId: "f3",
  domain: "RETURN_RECEIPT",
  subject: sku,
  payload: {
    ...line,
    externalRefundId: "r1",
    externalReceiptId: "rr1",
    acceptedAt: end,
    resellableQuantity: 1,
    reason: null,
  },
};
const fee = {
  ...common,
  factId: "f4",
  domain: "FEE",
  subject: store,
  payload: {
    chargeId: "ch1",
    kind: "FULFILLMENT",
    externalOrderId: "o1",
    externalCampaignId: null,
    window,
    amountMinor: 0,
    basis: "CONFIRMED",
    coverageBasisPoints: 10000,
    reason: null,
  },
};
const traffic = {
  ...common,
  factId: "f5",
  domain: "TRAFFIC",
  subject: store,
  payload: {
    window,
    visitors: 10,
    cart: 4,
    checkout: 2,
    paidOrders: 1,
    measurementVersion: "m1",
    coverageBasisPoints: 10000,
    reason: null,
  },
};
const campaign = {
  ...common,
  factId: "f6",
  domain: "CAMPAIGN_MEASUREMENT",
  subject: campaignSubject,
  payload: {
    externalCampaignId: "c1",
    businessDate: "2026-11-02",
    window,
    spendMinor: 100,
    attributedRevenueMinor: 300,
    eligibleCount: 10,
    measuredCount: 8,
    measurementVersion: "m1",
    attributionPolicyVersion: "a1",
    coverageBasisPoints: 8000,
    currency: "CNY",
    reason: "PARTIAL_COVERAGE",
  },
};
const listing = {
  ...common,
  factId: "f7",
  domain: "LISTING",
  subject: sku,
  payload: {
    externalSkuId: "sku-A",
    listedAt: end,
    effectiveAt: end,
    fromStatus: "UNLISTED",
    toStatus: "LISTED",
  },
};
const price = {
  ...common,
  factId: "f8",
  domain: "PRICE",
  subject: sku,
  payload: {
    externalSkuId: "sku-A",
    effectiveAt: end,
    priorPriceMinor: null,
    priceMinor: 199,
    priceVersion: "price-v1",
    currency: "CNY",
  },
};
const lot = {
  ...common,
  factId: "f9",
  domain: "INVENTORY_LOT",
  subject: sku,
  payload: {
    ...location,
    externalLotId: "lot1",
    externalReceiptId: "in1",
    receivedAt: start,
    movementAt: end,
    reason: "SALE",
    deltaQuantity: -2,
    beforeQuantity: 5,
    afterQuantity: 3,
  },
};
const notice = {
  ...common,
  factId: "f10",
  domain: "SUPPLIER_NOTICE",
  subject: sku,
  payload: {
    ...location,
    noticeId: "n1",
    purchaseOrderId: "po1",
    announcedAt: end,
    priorEta: end,
    newEta: later,
    inboundQuantity: 8,
    promisedLeadHours: 24,
    reason: null,
  },
};
const position = {
  ...common,
  factId: "f11",
  domain: "INVENTORY_POSITION",
  subject: sku,
  payload: {
    ...location,
    asOf: end,
    quarantine: 0,
    inbound: 8,
    safetyBufferHours: 1.5,
    reason: null,
  },
};
const sync = {
  ...common,
  factId: "f12",
  domain: "SYNC_TRANSITION",
  subject: connection,
  payload: {
    jobId: "j1",
    fence: 0,
    stream: "ORDERS",
    status: "FAILED",
    errorCode: "TEMPORARY",
    successfulThrough: null,
    watermark: null,
    businessObservedAt: end,
    transitionSequence: 1,
  },
};

function accepts(fact: unknown) {
  expect(ObservedFactV1Schema.parse(fact)).toEqual(fact);
}
function rejects(fact: unknown) {
  expect(ObservedFactV1Schema.safeParse(fact).success).toBe(false);
}
function withPayload<T extends { payload: object }>(fact: T, changes: object) {
  return { ...fact, payload: { ...fact.payload, ...changes } };
}

const domains = [
  cost,
  refund,
  receipt,
  fee,
  traffic,
  campaign,
  listing,
  price,
  lot,
  notice,
  position,
  sync,
];

it("exports the fact and subject schemas from the package root", () => {
  expect(api.ObservedFactV1Schema.parse(cost)).toEqual(cost);
  expect(api.ObservedDomainSchema.parse("FROZEN_COST")).toBe("FROZEN_COST");
  expect(api.ObservedSubjectSchema.parse(sku)).toEqual(sku);
});

const requiredIdentities = [
  [cost, "externalOrderId"],
  [refund, "externalRefundId"],
  [receipt, "externalReceiptId"],
  [fee, "chargeId"],
  [traffic, "measurementVersion"],
  [campaign, "externalCampaignId"],
  [listing, "externalSkuId"],
  [price, "priceVersion"],
  [lot, "externalLotId"],
  [notice, "noticeId"],
  [position, "externalLocationId"],
  [sync, "jobId"],
] as const;
it.each(requiredIdentities.map(([fact, key]) => ({ fact, key, domain: fact.domain })))(
  "requires $key for $domain",
  ({ fact, key }) => {
    const payload: Record<string, unknown> = { ...fact.payload };
    delete payload[key];
    rejects({ ...fact, payload });
  },
);

it.each(domains)("preserves a valid $domain fact and subject", (fact) => {
  expect(ObservedDomainSchema.parse(fact.domain)).toBe(fact.domain);
  expect(ObservedSubjectSchema.parse(fact.subject)).toEqual(fact.subject);
  accepts(fact);
});

it.each(domains)("rejects unauthorized top-level and payload data in $domain", (fact) => {
  for (const key of [
    "customerId",
    "sessionId",
    "scenarioId",
    "expected",
    "forbidden",
    "failureRules",
    "rawError",
    "forecastStockout",
    "profit",
    "credentials",
  ]) {
    rejects({ ...fact, [key]: "private-value" });
    rejects(withPayload(fact, { [key]: "private-value" }));
  }
});

it("keeps the original schedule for priced lines", () => {
  rejects(withPayload(cost, { skuCostVersion: null }));
  rejects(withPayload(cost, { basis: "ESTIMATED" }));
  accepts(withPayload(cost, { basis: "ESTIMATED", reason: "COST_ESTIMATED" }));
  accepts(withPayload(cost, { basis: "UNAVAILABLE", unitCostMinor: null, reason: "COST_MISSING" }));
  rejects(withPayload(cost, { basis: "UNAVAILABLE", unitCostMinor: 0, reason: "COST_MISSING" }));
  rejects(withPayload(cost, { externalOrderId: undefined }));
  rejects(withPayload(cost, { externalSkuId: "sku-other" }));
  rejects(withPayload(cost, { frozenAt: later }));
});

it("preserves unknown refund allocations and requires acceptance for measured returns", () => {
  rejects(withPayload(refund, { merchandiseMinor: 9007199254740992 }));
  rejects(withPayload(refund, { buyerShippingMinor: undefined }));
  rejects(withPayload(refund, { quantity: null }));
  accepts(withPayload(refund, { quantity: null, reason: "REFUND_UNKNOWN" }));
  accepts(withPayload(refund, { quantity: 0, merchandiseMinor: 0, buyerShippingMinor: 0 }));
  rejects(withPayload(refund, { settledAt: later }));
  rejects(withPayload(receipt, { acceptedAt: later }));
  rejects(withPayload(receipt, { acceptedAt: null }));
  rejects(withPayload(receipt, { acceptedAt: null, resellableQuantity: 0 }));
  accepts(
    withPayload(receipt, { acceptedAt: null, resellableQuantity: null, reason: "RETURN_UNKNOWN" }),
  );
  accepts(withPayload(receipt, { resellableQuantity: 0 }));
});

it("distinguishes a measured zero charge from missing, estimated and partial fees", () => {
  accepts(withPayload(fee, { externalOrderId: null }));
  accepts(withPayload(fee, { basis: "UNAVAILABLE", amountMinor: null, reason: "FEE_MISSING" }));
  rejects(withPayload(fee, { basis: "UNAVAILABLE", reason: "FEE_MISSING" }));
  rejects(withPayload(fee, { basis: "ESTIMATED", amountMinor: null, reason: "FEE_ESTIMATED" }));
  accepts(
    withPayload(fee, { basis: "ESTIMATED", coverageBasisPoints: 8000, reason: "FEE_ESTIMATED" }),
  );
  rejects(
    withPayload(fee, { basis: "ESTIMATED", coverageBasisPoints: 8000, reason: "PARTIAL_COVERAGE" }),
  );
  accepts(withPayload(fee, { coverageBasisPoints: 8000, reason: "PARTIAL_COVERAGE" }));
  rejects(withPayload(fee, { window: { ...window, periodEnd: later } }));
});

it("keeps store and SKU counts separate and allows later-stage events from earlier cohorts", () => {
  accepts({ ...traffic, subject: sku });
  accepts(withPayload(traffic, { cart: 1, checkout: 2, paidOrders: 3 }));
  accepts(
    withPayload(traffic, {
      visitors: null,
      cart: null,
      checkout: null,
      paidOrders: null,
      coverageBasisPoints: 0,
      reason: "TRAFFIC_MISSING",
    }),
  );
  rejects(withPayload(traffic, { visitors: null }));
  rejects(
    withPayload(traffic, { visitors: null, coverageBasisPoints: 8000, reason: "PARTIAL_COVERAGE" }),
  );
  accepts(withPayload(traffic, { coverageBasisPoints: 8000, reason: "PARTIAL_COVERAGE" }));
  rejects(withPayload(traffic, { window: { ...window, periodEnd: later } }));
  rejects(withPayload(traffic, { window: { ...window, periodEnd: start } }));
  rejects(withPayload(traffic, { window: { ...window, periodStart: "2026-11-01T16:00:00Z" } }));
  rejects(withPayload(traffic, { window: { ...window, credentials: {} } }));
  rejects({ ...traffic, subject: campaignSubject });
});

it("keeps partial campaign windows inside their named Shanghai business day", () => {
  accepts(
    withPayload(campaign, { window: { ...window, periodStart: "2026-11-02T00:00:00.000Z" } }),
  );
  accepts(withPayload(campaign, { spendMinor: null, reason: "ATTRIBUTION_MISSING" }));
  rejects(withPayload(campaign, { spendMinor: null }));
  rejects(withPayload(campaign, { measuredCount: 11 }));
  rejects(withPayload(campaign, { businessDate: "2026-11-03" }));
  rejects(
    withPayload(campaign, { window: { ...window, periodStart: "2026-11-01T15:59:59.999Z" } }),
  );
  rejects({
    ...withPayload(campaign, { window: { ...window, periodEnd: "2026-11-02T16:00:00.001Z" } }),
    observedAt: later,
  });
  rejects({ ...campaign, subject: { ...campaignSubject, externalCampaignId: "c2" } });
});

it("validates actual listing and price changes for the subject SKU", () => {
  rejects(withPayload(listing, { fromStatus: "LISTED" }));
  rejects(withPayload(listing, { listedAt: start }));
  rejects(withPayload(listing, { effectiveAt: later }));
  rejects(withPayload(listing, { listedAt: later }));
  accepts(withPayload(listing, { listedAt: start, fromStatus: "DELISTED" }));
  rejects(withPayload(price, { externalSkuId: "sku-B" }));
  rejects(withPayload(price, { effectiveAt: later }));
  accepts(withPayload(price, { priorPriceMinor: 0 }));
});

it("keeps lot identity and conserves signed inventory units", () => {
  accepts(withPayload(lot, { reason: "TRANSFER_IN", deltaQuantity: 2, afterQuantity: 7 }));
  rejects(withPayload(lot, { deltaQuantity: 2, afterQuantity: 7 }));
  rejects(withPayload(lot, { afterQuantity: 4 }));
  rejects(withPayload(lot, { deltaQuantity: 0, afterQuantity: 5 }));
  rejects(withPayload(lot, { receivedAt: later }));
  rejects(withPayload(lot, { movementAt: later }));
  rejects(withPayload(lot, { externalReceiptId: undefined }));
  accepts(
    withPayload(lot, {
      beforeQuantity: Number.MAX_SAFE_INTEGER,
      deltaQuantity: -1,
      afterQuantity: Number.MAX_SAFE_INTEGER - 1,
    }),
  );
  rejects(
    withPayload(lot, {
      beforeQuantity: Number.MAX_SAFE_INTEGER,
      deltaQuantity: 1,
      reason: "RETURN",
      afterQuantity: Number.MAX_SAFE_INTEGER,
    }),
  );
});

it.each([NaN, Infinity, 1.25, "2", 9007199254740992])(
  "rejects malformed lot arithmetic inputs %s without throwing",
  (value) => {
    rejects(withPayload(lot, { deltaQuantity: value }));
    rejects(withPayload(lot, { beforeQuantity: value }));
    rejects(withPayload(lot, { afterQuantity: value }));
  },
);

it("keeps future supplier ETAs and requires reasons that match present gaps", () => {
  accepts(withPayload(notice, { priorEta: null, promisedLeadHours: 24.5 }));
  accepts(withPayload(notice, { priorEta: later, newEta: later }));
  accepts(withPayload(notice, { newEta: null, reason: "LEAD_TIME_MISSING" }));
  accepts(withPayload(notice, { inboundQuantity: null, reason: "INVENTORY_UNKNOWN" }));
  rejects(withPayload(notice, { inboundQuantity: null, reason: "LEAD_TIME_MISSING" }));
  rejects(withPayload(notice, { newEta: null, reason: "INVENTORY_UNKNOWN" }));
  rejects(withPayload(notice, { announcedAt: later }));
  accepts(withPayload(position, { safetyBufferHours: null, reason: "LEAD_TIME_MISSING" }));
  accepts(withPayload(position, { inbound: null, reason: "INVENTORY_UNKNOWN" }));
  rejects(withPayload(position, { quarantine: null, reason: "LEAD_TIME_MISSING" }));
  rejects(withPayload(position, { asOf: later }));
  rejects(withPayload(position, { safetyBufferHours: -1 }));
  rejects(withPayload(position, { safetyBufferHours: Infinity }));
});

it("represents initial failures without a successful cutoff and rejects raw connector errors", () => {
  accepts(withPayload(sync, { status: "SUCCEEDED", errorCode: null }));
  rejects(withPayload(sync, { errorCode: "request failed with secret response" }));
  rejects(withPayload(sync, { status: "SUCCEEDED" }));
  rejects(withPayload(sync, { errorCode: null }));
  rejects(withPayload(sync, { successfulThrough: later }));
  rejects(withPayload(sync, { watermark: later }));
  rejects(withPayload(sync, { businessObservedAt: start }));
  rejects(withPayload(sync, { transitionSequence: 0 }));
  rejects({ ...sync, subject: { ...connection, connectionId: "conn-B" } });
});

it("binds source versions to their actual generation and sequence", () => {
  const next = { ...cost, sequence: 8, sourceVersion: "observed-v1:g:0:e:8" };
  accepts(next);
  accepts({ ...next, priorVersion: "observed-v1:g:0:e:3" });
  rejects({ ...next, priorVersion: "observed-v1:g:0:e:8" });
  rejects({ ...next, priorVersion: "observed-v1:g:0:e:9" });
  rejects({ ...next, priorVersion: "observed-v1:g:1:e:3" });
  rejects({ ...next, priorVersion: "observed-v1:g:0:e:0" });
  rejects({ ...next, priorVersion: "observed-v1:g:00:e:3" });
  rejects({ ...next, sourceVersion: "observed-v1:g:0:e:1" });
  rejects({ ...next, sourceVersion: "observed-v1:g:2147483648:e:8" });
  rejects({ ...cost, sequence: 0, sourceVersion: "observed-v1:g:0:e:0" });
  accepts({ ...cost, generation: 2147483647, sourceVersion: "observed-v1:g:2147483647:e:1" });
  rejects({ ...cost, generation: 2147483648, sourceVersion: "observed-v1:g:2147483648:e:1" });
  rejects({ ...cost, generation: -1, sourceVersion: "observed-v1:g:-1:e:1" });
  accepts({
    ...cost,
    sequence: Number.MAX_SAFE_INTEGER,
    sourceVersion: "observed-v1:g:0:e:9007199254740991",
  });
  rejects({
    ...cost,
    sequence: 9007199254740992,
    sourceVersion: "observed-v1:g:0:e:9007199254740992",
  });
});

it.each([
  "2026-11-02T16:00:00.0001Z",
  "2026-11-03T00:00:00.000+08:00",
  "2026-11-02T16:00:00Z",
  "2026-02-30T16:00:00.000Z",
  "0000-11-02T16:00:00.000Z",
])("rejects noncanonical observation time %s", (observedAt) => {
  rejects({ ...withPayload(cost, { frozenAt: observedAt }), occurredAt: observedAt, observedAt });
});

it("rejects malformed identities, invalid tags, and open nested records", () => {
  rejects({ ...cost, occurredAt: later });
  rejects({ ...cost, domain: "PROFIT" });
  rejects({ ...cost, modelVersion: "mock-business-observed-v2" });
  rejects({ ...cost, payloadHash: "A".repeat(64) });
  rejects({ ...cost, payloadHash: "a".repeat(63) });
  rejects({ ...cost, factId: " f1" });
  rejects({ ...cost, factId: "f1\u200b" });
  accepts({ ...cost, factId: "批次-1" });
  rejects({ ...cost, binding: { ...binding, customerId: "customer" } });
  rejects({ ...cost, subject: { ...sku, sessionId: "session" } });
  expect(ObservedDomainSchema.safeParse("PROFIT").success).toBe(false);
  expect(ObservedSubjectSchema.safeParse({ ...store, externalSkuId: "sku-A" }).success).toBe(false);
});

const config = {
  modelVersion: "mock-business-observed-v1",
  binding,
  seed: 0,
  profile: "growing",
  historyStart: start,
  days: 120,
  productCount: 10,
  variantsPerProduct: 2,
  dailyOrders: 30,
  growthBps: 0,
  refundBps: 0,
  adSpendMinor: 100,
  scenarioPlan: null,
};
const configEnvelope = {
  generatorVersion: "mock-source-v3",
  generation: 0,
  configHash: hash,
  config,
};
const scenarioMutation = {
  skuIndex: 19,
  retainDemandBps: 5000,
  priceBps: 10000,
  discountBps: 100,
  refundBps: 500,
  cancelBps: 0,
  restockBps: 10000,
  launchRampDays: 1,
  restockDelayDays: 2,
};
const scenarioPlan = {
  version: "mock-scenario-v1",
  scenarioId: "SCENARIO_001",
  externalStoreId: binding.externalStoreId,
  startDay: 10,
  endDay: 120,
  mutations: [scenarioMutation, { ...scenarioMutation, skuIndex: 0 }],
  campaignSpendBps: 10000,
  campaignConversionBps: 7000,
  delivery: { kind: "INTERRUPT", durationMs: 1000 },
};

function withConfig(changes: object) {
  return { ...configEnvelope, config: { ...config, ...changes } };
}

it("exposes a strictly opted-in, generation-scoped configuration from the package root", () => {
  expect(api.MockObservedGenerationConfigV3Schema.parse(configEnvelope)).toEqual(configEnvelope);
  expect(
    MockObservedGenerationConfigV3Schema.safeParse({ ...configEnvelope, generation: 2147483647 })
      .success,
  ).toBe(true);
  for (const generation of [-1, 2147483648, 0.5]) {
    expect(
      MockObservedGenerationConfigV3Schema.safeParse({ ...configEnvelope, generation }).success,
    ).toBe(false);
  }
  for (const generatorVersion of ["mock-source-v1", "mock-source-v2"]) {
    expect(
      MockObservedGenerationConfigV3Schema.safeParse({ ...configEnvelope, generatorVersion })
        .success,
    ).toBe(false);
  }
  expect(
    MockObservedGenerationConfigV3Schema.safeParse({
      ...configEnvelope,
      configHash: "A".repeat(64),
    }).success,
  ).toBe(false);
  expect(
    MockObservedGenerationConfigV3Schema.safeParse({ ...configEnvelope, credentials: {} }).success,
  ).toBe(false);
});

it.each([
  ["modelVersion", undefined],
  ["modelVersion", "mock-business-observed-v2"],
  ["scenarioPlan", undefined],
  ["seed", -1],
  ["seed", 4294967296],
  ["seed", "0"],
  ["seed", NaN],
  ["profile", "unknown"],
  ["days", 0],
  ["days", 366],
  ["productCount", 101],
  ["variantsPerProduct", 4],
  ["dailyOrders", 301],
  ["growthBps", 10001],
  ["refundBps", 5001],
  ["adSpendMinor", 100000001],
  ["adSpendMinor", Infinity],
  ["historyStart", "2026-11-01T16:01:00.000Z"],
  ["historyStart", "2026-11-02T00:00:00.000+08:00"],
  ["historyStart", "0000-11-01T16:00:00.000Z"],
  ["expected", "WINNER"],
] as const)("rejects v3 %s value %s", (key, value) => {
  expect(MockObservedGenerationConfigV3Schema.safeParse(withConfig({ [key]: value })).success).toBe(
    false,
  );
});

it("admits maximum supported generator settings and the latest midnight with room for its run", () => {
  const maxSettings = withConfig({
    seed: 4294967295,
    days: 365,
    productCount: 100,
    variantsPerProduct: 3,
    dailyOrders: 300,
    growthBps: 10000,
    refundBps: 5000,
    adSpendMinor: 100000000,
  });
  expect(MockObservedGenerationConfigV3Schema.parse(maxSettings)).toEqual(maxSettings);
  const latest = withConfig({ historyStart: "9999-12-25T16:00:00.000Z", days: 1 });
  expect(MockObservedGenerationConfigV3Schema.parse(latest)).toEqual(latest);
  const tooLate = withConfig({ historyStart: "9999-12-26T16:00:00.000Z", days: 1 });
  expect(MockObservedGenerationConfigV3Schema.safeParse(tooLate).success).toBe(false);
});

it("restricts scenarios to the same store, in-range SKU indices and the generation horizon", () => {
  const withScenario = withConfig({ scenarioPlan });
  expect(MockObservedGenerationConfigV3Schema.parse(withScenario)).toEqual(withScenario);
  for (const override of [
    { externalStoreId: "shop-other" },
    { endDay: 121 },
    { mutations: [{ ...scenarioMutation, skuIndex: 20 }] },
    { forbidden: "hidden answer" },
    { delivery: { kind: "INTERRUPT", durationMs: 1000, failureRules: [] } },
  ]) {
    const invalid = withConfig({ scenarioPlan: { ...scenarioPlan, ...override } });
    expect(MockObservedGenerationConfigV3Schema.safeParse(invalid).success).toBe(false);
  }
});

function reversedFields(fields: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(fields).reverse());
}

it("decodes the v3 hash preimage in schema order with an explicit null scenario", () => {
  const parsed = MockObservedGenerationConfigV3Schema.parse(
    withConfig({ binding: reversedFields(binding) }),
  );
  expect(JSON.stringify(parsed.config)).toBe(JSON.stringify(config));
});

it("preserves scenario hash field order and the original order of mutations", () => {
  const unorderedScenario = reversedFields({
    ...scenarioPlan,
    mutations: scenarioPlan.mutations.map(reversedFields),
    delivery: reversedFields(scenarioPlan.delivery),
  });
  const parsed = MockObservedGenerationConfigV3Schema.parse({
    ...configEnvelope,
    config: reversedFields({
      ...config,
      binding: reversedFields(binding),
      scenarioPlan: unorderedScenario,
    }),
  });
  expect(JSON.stringify(parsed.config)).toBe(JSON.stringify({ ...config, scenarioPlan }));
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.config)).toBe(true);
  expect(Object.isFrozen(parsed.config.scenarioPlan)).toBe(true);
  expect(Object.isFrozen(parsed.config.scenarioPlan?.mutations)).toBe(true);
  expect(Object.isFrozen(parsed.config.scenarioPlan?.mutations[0])).toBe(true);
  expect(Object.isFrozen(parsed.config.scenarioPlan?.delivery)).toBe(true);
});
