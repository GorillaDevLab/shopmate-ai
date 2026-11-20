import { expect, expectTypeOf, it } from "vitest";
import * as api from "../index.js";
import type {
  AppendObservedPageV1,
  AuthorizedObservedSelectionPort,
  FactPage,
  ObservedCaptureRequestV1,
  ObservedCaptureV1,
  ObservedCausalDependencies,
  ObservedConsumerPort,
  ObservedDemandPageV1,
  ObservedDemandProducerPort,
  ObservedError,
  ObservedErrorCode,
  ObservedFinancePageV1,
  ObservedFinanceProducerPort,
  ObservedFinanceProducerRequestV1,
  ObservedProducerRunV1,
  ObservedPublicationReadV1,
  ObservedPublicationRequestV1,
  ObservedPublicationV1,
  ObservedPublishedPageV1,
  ObservedPublisherPort,
  ObservedReaderPort,
  ObservedReadRequestV1,
  ObservedReceiptV1,
  ObservedResult,
  ObservedSelectionRequestV1,
  ObservedSupplyPageV1,
  ObservedSupplyProducerPort,
  ScopedMetricInputV1,
} from "../index.js";
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

it.each([
  [
    "accepts a full Shanghai day during daylight saving time",
    "1991-07-01",
    "1991-06-30T15:00:00.000Z",
    "1991-07-01T15:00:00.000Z",
    true,
  ],
  [
    "rejects a fixed UTC+08 window that spills past the Shanghai day",
    "1991-07-01",
    "1991-06-30T16:00:00.000Z",
    "1991-07-01T16:00:00.000Z",
    false,
  ],
  [
    "accepts the 25-hour Shanghai day when daylight saving time ended",
    "1991-09-15",
    "1991-09-14T15:00:00.000Z",
    "1991-09-15T16:00:00.000Z",
    true,
  ],
  [
    "rejects the first millisecond after that 25-hour Shanghai day",
    "1991-09-15",
    "1991-09-14T15:00:00.000Z",
    "1991-09-15T16:00:00.001Z",
    false,
  ],
  [
    "accepts a four-digit business date at the minimum UTC year",
    "0001-01-01",
    "0001-01-01T00:00:00.000Z",
    "0001-01-01T00:00:00.001Z",
    true,
  ],
  [
    "rejects a malformed start without a refinement exception",
    "2026-11-02",
    "2026-11-02T99:00:00.000Z",
    "2026-11-02T16:00:00.000Z",
    false,
  ],
] as const)("%s", (_, businessDate, periodStart, periodEnd, accepted) => {
  const fact = {
    ...withPayload(campaign, { businessDate, window: { ...window, periodStart, periodEnd } }),
    occurredAt: periodEnd,
    observedAt: periodEnd,
  };
  expect(ObservedFactV1Schema.safeParse(fact).success).toBe(accepted);
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

const configHash = "d".repeat(64);
const publicationHash = "e".repeat(64);
const pageHash = "f".repeat(64);
const partition = { binding, generation: 0, domain: "TRAFFIC", subject: store, window };
const publication = {
  ...partition,
  publicationId: "pub1",
  publicationHash,
  modelVersion: common.modelVersion,
  configHash,
  producerVersion: "traffic-v1",
  through: end,
  clockRevision: 2,
  publicationSequence: 1,
  pageCount: 1,
  recordCount: 0,
  chainHash: hash,
  availableAt: end,
  recordedAt: later,
};
const page = {
  pageId: "pg1",
  pageIndex: 0,
  pageHash,
  priorPageHash: null,
  expectedCursor: null,
  nextCursor: null,
  records: [],
  terminalCoverage: { coverageBasisPoints: 10000 },
};
const { records: noRecords, ...pageMembership } = page;
const zeroReceipt = {
  ...partition,
  ...pageMembership,
  receiptId: "rc1",
  publicationId: publication.publicationId,
  publicationHash,
  modelVersion: publication.modelVersion,
  configHash,
  through: end,
  recordedAt: later,
  recordCount: 0,
  factRefs: [],
};
const publicationRequest = {
  ...partition,
  grantId: "grant1",
  modelVersion: publication.modelVersion,
  configHash,
  through: end,
  expectedSequence: 1,
};
const readPublication = {
  ...partition,
  grantId: "grant1",
  publicationId: publication.publicationId,
  publicationHash,
  pageIndex: 0,
};
const appendPage = { ...readPublication, ...page, fence: 1, through: end };
const pageFact = { ...traffic, producerVersion: publication.producerVersion };

it("accepts the sealed zero traffic publication and immutable returned receipt", () => {
  expect(api.ObservedPublicationRequestV1Schema.parse(publicationRequest)).toEqual(
    publicationRequest,
  );
  expect(api.ObservedPublicationV1Schema.parse(publication)).toEqual(publication);
  expect(api.ObservedPublicationReadV1Schema.parse(readPublication)).toEqual(readPublication);
  expect(api.ObservedPublishedPageV1Schema.parse({ publication, ...page }).records).toEqual(
    noRecords,
  );
  expect(api.AppendObservedPageV1Schema.parse(appendPage)).toEqual(appendPage);
  const parsed = api.ObservedReceiptV1Schema.parse(zeroReceipt);
  expect(parsed).toEqual(zeroReceipt);
  expect(Object.isFrozen(parsed.factRefs)).toBe(true);
  expect(Object.isFrozen(parsed.terminalCoverage)).toBe(true);
});

it.each([
  ["publisher-provided terminal", { terminalCoverage: page.terminalCoverage }],
  ["unclosed window", { through: start }],
  ["zero ordinal", { expectedSequence: 0 }],
  ["unsafe ordinal", { expectedSequence: Number.MAX_SAFE_INTEGER + 1 }],
  ["invalid hash", { configHash: "?" }],
  ["generation out of range", { generation: 2147483648 }],
  ["domain-subject mismatch", { domain: "FROZEN_COST" }],
  ["caller-supplied store identity", { subject: { ...store, storeId: binding.storeId } }],
])("rejects publication request with %s", (_label, change) => {
  expect(
    api.ObservedPublicationRequestV1Schema.safeParse({ ...publicationRequest, ...change }).success,
  ).toBe(false);
});

it.each([
  ["early availability", { availableAt: start }],
  ["empty nonterminal chain", { pageCount: 2 }],
  ["page count overflow", { pageCount: 4097 }],
  ["record count overflow", { recordCount: 819201 }],
  ["malformed hash", { publicationHash: "x".repeat(64) }],
])("rejects a certificate with %s", (_label, change) => {
  expect(api.ObservedPublicationV1Schema.safeParse({ ...publication, ...change }).success).toBe(
    false,
  );
});

it.each([
  ["binding swap", { binding: { ...binding, externalStoreId: "other" } }],
  ["domain swap", { domain: "FEE", payload: fee.payload }],
  ["generation swap", { generation: 1, sourceVersion: "observed-v1:g:1:e:1" }],
  ["subject swap", { subject: sku }],

  ["future observation", { observedAt: later }],
  [
    "outside measurement",
    {
      payload: {
        ...traffic.payload,
        window: { ...window, periodStart: "2026-10-31T16:00:00.000Z" },
      },
    },
  ],
  ["forged origin", { receiptId: "origin" }],
  ["forged security time", { recordedAt: later }],
])("rejects a page member with %s", (_label, change) => {
  const records = [{ ...pageFact, ...change }];
  expect(
    api.ObservedPublishedPageV1Schema.safeParse({
      publication: { ...publication, recordCount: 1 },
      ...page,
      records,
    }).success,
  ).toBe(false);
  expect(api.AppendObservedPageV1Schema.safeParse({ ...appendPage, records }).success).toBe(false);
});

it("accepts sparse original source sequences under an independent publication ordinal", () => {
  const second = {
    ...pageFact,
    factId: "f-other",
    sequence: 7,
    sourceVersion: "observed-v1:g:0:e:7",
  };
  const result = {
    ...page,
    publication: { ...publication, publicationSequence: 4, recordCount: 2 },
    records: [pageFact, second],
  };
  expect(api.ObservedPublishedPageV1Schema.safeParse(result).success).toBe(true);
  expect(
    api.ObservedPublishedPageV1Schema.safeParse({ ...result, records: [second, pageFact] }).success,
  ).toBe(false);
  expect(
    api.AppendObservedPageV1Schema.safeParse({ ...appendPage, records: Array(201).fill(pageFact) })
      .success,
  ).toBe(false);
});

it.each([
  ["first page has cursor", { expectedCursor: "c1" }],
  ["missing prior hash", { pageIndex: 1, expectedCursor: "c1" }],
  ["terminal page has next cursor", { nextCursor: "c1" }],
  ["nonterminal page without cursor", { terminalCoverage: null }],
  ["DB-only receipt ID", { receiptId: "forged" }],
])("rejects append with %s", (_label, change) => {
  expect(api.AppendObservedPageV1Schema.safeParse({ ...appendPage, ...change }).success).toBe(
    false,
  );
});

const memberRef = {
  factId: pageFact.factId,
  sourceVersion: pageFact.sourceVersion,
  payloadHash: pageFact.payloadHash,
  originReceiptId: zeroReceipt.receiptId,
};

it("keeps membership origin explicit and checks reference uniqueness and generation", () => {
  const received = {
    ...zeroReceipt,
    recordCount: 1,
    factRefs: [{ ...memberRef, originReceiptId: "earlier" }],
  };
  expect(api.ObservedReceiptV1Schema.parse(received)).toEqual(received);
  expect(
    api.StoredObservedFactV1Schema.parse({
      fact: pageFact,
      receiptId: "earlier",
      recordedAt: later,
    }).receiptId,
  ).toBe("earlier");
  const invalid = [
    { ...received, recordCount: 0 },
    { ...received, recordCount: 2, factRefs: [memberRef, { ...memberRef, factId: "other" }] },
    { ...received, factRefs: [{ ...memberRef, sourceVersion: "observed-v1:g:1:e:1" }] },
    { ...received, factRefs: [{ ...memberRef, originReceiptId: undefined }] },
  ];
  for (const value of invalid)
    expect(api.ObservedReceiptV1Schema.safeParse(value).success).toBe(false);
});

it("pins the published producer while leaving append certification to the service", () => {
  const records = [{ ...pageFact, producerVersion: "other-v1" }];
  expect(
    api.ObservedPublishedPageV1Schema.safeParse({
      ...page,
      publication: { ...publication, recordCount: 1 },
      records,
    }).success,
  ).toBe(false);
  expect(api.AppendObservedPageV1Schema.safeParse({ ...appendPage, records }).success).toBe(true);
});

const revision = "p2-observed-v1:" + hash;
const definitionVersion = "metrics-g4-observed-v2";
const actor = {
  userId: "user-A",
  merchantId: "merchant-A",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "ANALYST",
  permissions: ["tenant:read"],
};
const base = {
  binding,
  generation: 0,
  window,
  visibleAt: end,
  inputRevision: "p2-normalized-v1:" + hash,
  receipts: ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"].map((stream) => ({
    stream,
    pageId: "base-" + stream,
    pageHash,
  })),
};
const zeroCoverage = {
  ...partition,
  status: "COMPLETE",
  coverageBasisPoints: 10000,
  receiptIds: [zeroReceipt.receiptId],
  reason: null,
};
const zeroCapture = {
  binding,
  generation: 0,
  window,
  visibleAt: end,
  domains: ["TRAFFIC"],
  inputRevision: revision,
  ledgerVersion: common.ledgerVersion,
  mappingVersion: "p2-observed-v1",
  definitionVersion,
  definitionSelectorVersion: "selector-v1",
  modelVersion: common.modelVersion,
  configHash,
  clockRevision: 2,
  capturedAt: later,
  base,
  comparisons: [],
  publications: [publication],
  receipts: [zeroReceipt],
  facts: [],
  coverage: [zeroCoverage],
};
const captureRequest = {
  actor,
  binding,
  generation: 0,
  window,
  visibleAt: end,
  domains: ["TRAFFIC"],
  comparisonWindows: [],
};

it("keeps security recording separate from the certified empty business window", () => {
  expect(api.ObservedCaptureV1Schema.parse(zeroCapture)).toEqual(zeroCapture);
  const request = api.ObservedCaptureRequestV1Schema.parse(captureRequest);
  expect(request).toEqual(captureRequest);
  expect(Object.isFrozen(request.actor)).toBe(true);
  expect(Object.isFrozen(request.actor.permissions)).toBe(true);
  expect(
    api.ObservedReadRequestV1Schema.parse({ ...captureRequest, inputRevision: revision })
      .inputRevision,
  ).toBe(revision);
});

const pastWindow = { ...window, periodStart: "2026-10-31T16:00:00.000Z", periodEnd: start };
const comparisonWindow = { window: pastWindow, visibleAt: start };
const comparisonRef = {
  binding,
  generation: 0,
  ...comparisonWindow,
  inputRevision: "p2-observed-v1:" + "b".repeat(64),
  definitionVersion,
};

it.each([
  ["same revision", { inputRevision: revision }],
  ["another store", { binding: { ...binding, storeId: "other-store" } }],
  ["another generation", { generation: 2147483648 }],
  ["future cutoff", { visibleAt: later }],
  ["unclosed window", { window }],
])("rejects comparison ref with %s", (_label, change) => {
  expect(
    api.ObservedCaptureV1Schema.safeParse({ ...zeroCapture, comparisons: [comparisonRef] }).success,
  ).toBe(true);
  expect(
    api.ObservedCaptureV1Schema.safeParse({
      ...zeroCapture,
      comparisons: [{ ...comparisonRef, ...change }],
    }).success,
  ).toBe(false);
});

it.each([
  ["actor organization mismatch", { actor: { ...actor, organizationId: "other-org" } }],
  ["actor workspace mismatch", { actor: { ...actor, workspaceId: "other-ws" } }],
  ["duplicate domains", { domains: ["TRAFFIC", "TRAFFIC"] }],
  ["empty domains", { domains: [] }],
  ["open current window", { visibleAt: start }],
  [
    "unclosed comparison",
    { comparisonWindows: [{ ...comparisonWindow, visibleAt: "2026-11-01T00:00:00.000Z" }] },
  ],
  [
    "duplicate comparison windows",
    { comparisonWindows: [comparisonWindow, { ...comparisonWindow, visibleAt: end }] },
  ],
  ["five comparisons", { comparisonWindows: Array(5).fill(comparisonWindow) }],
])("rejects capture request with %s", (_label, change) => {
  expect(
    api.ObservedCaptureRequestV1Schema.safeParse({ ...captureRequest, ...change }).success,
  ).toBe(false);
});

it.each([
  ["no matching normalized base", { base: null }],
  ["unrepresented requested domain", { domains: ["TRAFFIC", "FEE"] }],
  ["unjoined revision", { inputRevision: base.inputRevision }],
  ["duplicate coverage", { coverage: [zeroCoverage, zeroCoverage] }],
  ["duplicate receipt ID", { receipts: [zeroReceipt, zeroReceipt] }],
  ["duplicate publication ID", { publications: [publication, publication] }],
  ["late publication availability", { publications: [{ ...publication, availableAt: later }] }],
  ["publication hash mismatch", { publications: [{ ...publication, publicationHash: hash }] }],
  ["receipt cutoff mismatch", { receipts: [{ ...zeroReceipt, through: later }] }],
  ["receipt kind mismatch", { receipts: [{ ...zeroReceipt, domain: "FEE" }] }],
  ["receipt subject mismatch", { receipts: [{ ...zeroReceipt, subject: sku }] }],
  ["receipt generation mismatch", { receipts: [{ ...zeroReceipt, generation: 1 }] }],
  [
    "receipt binding mismatch",
    { receipts: [{ ...zeroReceipt, binding: { ...binding, connectionId: "conn-B" } }] },
  ],
  ["receipt configuration mismatch", { receipts: [{ ...zeroReceipt, configHash: hash }] }],
  ["receipt page ID overflow", { receipts: Array(4097).fill(zeroReceipt) }],
  ["fact array overflow", { facts: Array(50001) }],
  ["base stream missing", { base: { ...base, receipts: base.receipts.slice(1) } }],
  [
    "duplicate stream and page pair",
    { base: { ...base, receipts: [...base.receipts, base.receipts[0]] } },
  ],
  ["base identity mismatch", { base: { ...base, visibleAt: later } }],
])("rejects capture with %s", (_label, change) => {
  expect(api.ObservedCaptureV1Schema.safeParse({ ...zeroCapture, ...change }).success).toBe(false);
});

type TestFact = Omit<typeof common, "priorVersion"> & {
  priorVersion: string | null;
  domain: string;
  subject: object;
  payload: object;
};
function returnedFact<T extends TestFact>(fact: T, receiptId: string, recordedAt = later) {
  return { fact, receiptId, recordedAt };
}

function membership({ fact, receiptId }: ReturnType<typeof returnedFact>) {
  return {
    factId: fact.factId,
    sourceVersion: fact.sourceVersion,
    payloadHash: fact.payloadHash,
    originReceiptId: receiptId,
  };
}

type StoredTestFact = ReturnType<typeof returnedFact>;
function snapshot(facts: readonly StoredTestFact[], index: number, through: string) {
  const { domain, subject, producerVersion } = facts[0].fact;
  const selectedPartition = { ...partition, domain, subject };
  const certificate = {
    ...publication,
    ...selectedPartition,
    publicationId: "P" + index,
    publicationHash: String(index).repeat(64),
    publicationSequence: index,
    through,
    availableAt: through,
    producerVersion,
    recordCount: facts.length,
  };
  const certifiedReceipt = {
    ...zeroReceipt,
    ...selectedPartition,
    receiptId: "R" + index,
    publicationId: certificate.publicationId,
    publicationHash: certificate.publicationHash,
    pageId: "PG" + index,
    pageHash: String(index + 3).repeat(64),
    through,
    recordCount: facts.length,
    factRefs: facts.map(membership),
  };
  return {
    certificate,
    certifiedReceipt,
    coverageRow: {
      ...zeroCoverage,
      ...selectedPartition,
      receiptIds: [certifiedReceipt.receiptId],
    },
  };
}

function captured(
  facts: readonly ReturnType<typeof returnedFact>[],
  current: ReturnType<typeof snapshot>,
  history?: ReturnType<typeof snapshot>,
) {
  const publications = history ? [history.certificate, current.certificate] : [current.certificate];
  const receipts = history
    ? [history.certifiedReceipt, current.certifiedReceipt]
    : [current.certifiedReceipt];
  const { through, domain } = current.certificate;
  return {
    ...zeroCapture,
    domains: [domain],
    visibleAt: through,
    inputRevision: "p2-observed-v1:" + current.certificate.publicationHash,
    base: domain === "SYNC_TRANSITION" ? null : { ...base, visibleAt: through },
    publications,
    receipts,
    facts,
    coverage: [current.coverageRow],
  };
}

const a1 = returnedFact(
  {
    ...cost,
    factId: "A",
    payload: {
      ...cost.payload,
      externalOrderId: "oA",
      externalLineId: "lA",
      quantity: 1,
      unitCostMinor: 100,
      skuCostVersion: "cost-v1",
    },
  },
  "R1",
);
const b1 = returnedFact(
  {
    ...cost,
    factId: "B",
    sequence: 2,
    sourceVersion: "observed-v1:g:0:e:2",
    payloadHash: "b".repeat(64),
    payload: {
      ...cost.payload,
      externalOrderId: "oB",
      externalLineId: "lB",
      quantity: 1,
      unitCostMinor: 150,
      skuCostVersion: "cost-v1",
    },
  },
  "R1",
);
const t2 = "2026-11-03T16:00:00.000Z";
const b2 = returnedFact(
  {
    ...b1.fact,
    sequence: 3,
    sourceVersion: "observed-v1:g:0:e:3",
    priorVersion: b1.fact.sourceVersion,
    payloadHash: "c".repeat(64),
    observedAt: t2,
    payload: { ...b1.fact.payload, unitCostMinor: 155, skuCostVersion: "cost-v2" },
  },
  "R2",
  "2026-11-05T16:00:00.000Z",
);
const firstSnapshot = snapshot([a1, b1], 1, end);
const correctedSnapshot = snapshot([a1, b2], 2, t2);
const firstCapture = captured([a1, b1], firstSnapshot);
const correctedCapture = captured([a1, b2], correctedSnapshot, firstSnapshot);

it("selects the corrected snapshot while preserving the original A1 insertion and T1 replay", () => {
  const earlier = api.ObservedCaptureV1Schema.parse(firstCapture);
  const current = api.ObservedCaptureV1Schema.parse(correctedCapture);
  const currentPage = api.ObservedPublishedPageV1Schema.parse({
    ...page,
    pageId: correctedSnapshot.certifiedReceipt.pageId,
    pageHash: correctedSnapshot.certifiedReceipt.pageHash,
    publication: correctedSnapshot.certificate,
    records: [a1.fact, b2.fact],
  });
  expect(currentPage.records.map(({ sequence }) => sequence)).toEqual([1, 3]);
  expect(current.facts.map(({ fact, receiptId }) => [fact.sourceVersion, receiptId])).toEqual([
    [a1.fact.sourceVersion, "R1"],
    [b2.fact.sourceVersion, "R2"],
  ]);
  expect(current.facts[0]).toEqual(earlier.facts[0]);
  expect(current.coverage[0]?.receiptIds).toEqual(["R2"]);
  expect(current.receipts.flatMap(({ factRefs }) => factRefs)).toHaveLength(4);
  expect(
    new Set(
      current.receipts.flatMap(({ factRefs }) =>
        factRefs.map(({ sourceVersion }) => sourceVersion),
      ),
    ).size,
  ).toBe(3);
  expect(api.ObservedCaptureV1Schema.parse(firstCapture)).toEqual(earlier);
  expect(earlier.inputRevision).toBe(firstCapture.inputRevision);
  expect(earlier.facts).toEqual([a1, b1]);
});

it("rejects two certificates occupying the same ordinal of one partition", () => {
  const [origin, current] = correctedCapture.publications;
  const occupied = { ...current, publicationSequence: origin.publicationSequence };
  const publications = [origin, occupied];
  expect(api.ObservedPublicationV1Schema.safeParse(occupied).success).toBe(true);
  const result = api.ObservedCaptureV1Schema.safeParse({ ...correctedCapture, publications });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain("INVALID_CAPTURE_GRAPH");
});

it("allows sparse supplied ordinals for seals from the same partition", () => {
  const [origin, current] = correctedCapture.publications;
  const publications = [origin, { ...current, publicationSequence: 8 }];
  const capture = api.ObservedCaptureV1Schema.parse({ ...correctedCapture, publications });
  expect(capture.publications.map(({ publicationSequence }) => publicationSequence)).toEqual([
    1, 8,
  ]);
});

it("rejects a correction pointing to a known version of another fact", () => {
  const wrong = { ...b2, fact: { ...b2.fact, priorVersion: a1.fact.sourceVersion } };
  expect(api.ObservedFactV1Schema.safeParse(wrong.fact).success).toBe(true);
  const result = api.ObservedCaptureV1Schema.safeParse({ ...correctedCapture, facts: [a1, wrong] });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain("INVALID_CAPTURE_GRAPH");
});

const captureWithoutB1 = captured([a1, b2], correctedSnapshot, snapshot([a1], 1, end));

it("accepts correction history with an unavailable predecessor", () => {
  expect(api.ObservedCaptureV1Schema.safeParse(captureWithoutB1).success).toBe(true);
});

it("does not resolve an absent predecessor against a different domain stream", () => {
  const other = returnedFact(
    { ...traffic, sequence: 2, sourceVersion: b1.fact.sourceVersion },
    "R3",
  );
  const partition = snapshot([other], 3, end);
  const capture = {
    ...captureWithoutB1,
    domains: [...captureWithoutB1.domains, other.fact.domain],
    facts: [...captureWithoutB1.facts, other],
    coverage: [...captureWithoutB1.coverage, partition.coverageRow],
    publications: [...captureWithoutB1.publications, partition.certificate],
    receipts: [...captureWithoutB1.receipts, partition.certifiedReceipt],
  };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
});

it("rejects a known predecessor that assigns the corrected fact to a different subject", () => {
  const otherSku = { ...sku, externalSkuId: "sku-B" };
  const moved = {
    ...b1.fact,
    subject: otherSku,
    payload: { ...b1.fact.payload, externalSkuId: "sku-B" },
  };
  const witness = returnedFact(
    { ...moved, factId: "C", sequence: 4, sourceVersion: "observed-v1:g:0:e:4" },
    "R3",
  );
  const origin = snapshot([returnedFact(moved, "R3"), witness], 3, end);
  const current = snapshot([witness], 4, t2);
  const capture = {
    ...captureWithoutB1,
    facts: [...captureWithoutB1.facts, witness],
    coverage: [...captureWithoutB1.coverage, current.coverageRow],
    publications: [...captureWithoutB1.publications, origin.certificate, current.certificate],
    receipts: [...captureWithoutB1.receipts, origin.certifiedReceipt, current.certifiedReceipt],
  };
  const result = api.ObservedCaptureV1Schema.safeParse(capture);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain("INVALID_CAPTURE_GRAPH");
});

const b4 = returnedFact(
  {
    ...b1.fact,
    sequence: 4,
    sourceVersion: "observed-v1:g:0:e:4",
    priorVersion: b1.fact.sourceVersion,
    payloadHash: "d".repeat(64),
  },
  "R1",
);
const repeatedFactOrigin = snapshot([a1, b1, b4], 1, end);

it("rejects the same logical fact at different versions on one returned receipt", () => {
  const records = [a1.fact, b1.fact, b4.fact];
  const { certificate, certifiedReceipt } = repeatedFactOrigin;
  const publisher = api.ObservedPublishedPageV1Schema.safeParse({
    ...page,
    pageId: certifiedReceipt.pageId,
    pageHash: certifiedReceipt.pageHash,
    publication: certificate,
    records,
  });
  expect(publisher.error?.issues.map(({ message }) => message)).toContain("INVALID_PUBLISHED_PAGE");
  const append = api.AppendObservedPageV1Schema.safeParse({
    ...appendPage,
    ...partition,
    domain: "FROZEN_COST",
    subject: sku,
    records,
  });
  expect(append.error?.issues.map(({ message }) => message)).toContain("INVALID_PAGE_RECORDS");
  const result = api.ObservedReceiptV1Schema.safeParse(certifiedReceipt);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain(
    "INVALID_RECEIPT_MEMBERSHIP",
  );
});

it("rejects duplicate logical IDs even when a receipt is reached only as an origin", () => {
  const capture = captured([a1, b2], correctedSnapshot, repeatedFactOrigin);
  const result = api.ObservedCaptureV1Schema.safeParse(capture);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain(
    "INVALID_RECEIPT_MEMBERSHIP",
  );
});

it.each(["fact ID", "payload hash", "origin receipt", "publication cutoff"])(
  "rejects a contradictory %s for an immutable source version in a historical receipt",
  (conflict) => {
    const [historical, current] = correctedCapture.receipts;
    const correctedMember = membership(b2);
    const contradictory = {
      ...correctedMember,
      factId: conflict === "fact ID" ? "other-fact" : correctedMember.factId,
      payloadHash: conflict === "payload hash" ? b1.fact.payloadHash : correctedMember.payloadHash,
      originReceiptId: conflict === "origin receipt" ? historical.receiptId : current.receiptId,
    };
    const changed = { ...historical, factRefs: [membership(a1), contradictory] };
    expect(api.ObservedReceiptV1Schema.safeParse(changed).success).toBe(true);
    const result = api.ObservedCaptureV1Schema.safeParse({
      ...correctedCapture,
      receipts: [changed, current],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toContain("INVALID_CAPTURE_GRAPH");
  },
);

it("rejects conflicting claims for an unselected version shared by two origin receipts", () => {
  const c = returnedFact(
    { ...a1.fact, factId: "C", sequence: 4, sourceVersion: "observed-v1:g:0:e:4" },
    "R3",
  );
  const active = snapshot([a1, b2, c], 2, t2);
  const otherOrigin = snapshot([b1, c], 3, end);
  const capture = captured([a1, b2, c], active, firstSnapshot);
  const historical = {
    ...capture,
    publications: [...capture.publications, otherOrigin.certificate],
    receipts: [...capture.receipts, otherOrigin.certifiedReceipt],
  };
  expect(api.ObservedCaptureV1Schema.safeParse(historical).success).toBe(true);
  const conflictingOrigin = {
    ...otherOrigin.certifiedReceipt,
    factRefs: [{ ...membership(b1), payloadHash: b2.fact.payloadHash }, membership(c)],
  };
  expect(
    api.ObservedCaptureV1Schema.safeParse({
      ...historical,
      receipts: [...capture.receipts, conflictingOrigin],
    }).success,
  ).toBe(false);
});

it.each([
  [
    "two snapshots as one chain",
    { coverage: [{ ...correctedSnapshot.coverageRow, receiptIds: ["R1", "R2"] }] },
  ],
  ["missing origin receipt", { receipts: [correctedSnapshot.certifiedReceipt] }],
  ["missing origin certificate", { publications: [correctedSnapshot.certificate] }],
  ["wrong original insertion", { facts: [{ ...a1, receiptId: "R2" }, b2] }],
  [
    "origin lacks self-origin",
    {
      receipts: [
        {
          ...firstSnapshot.certifiedReceipt,
          factRefs: [{ ...membership(a1), originReceiptId: "R2" }, membership(b1)],
        },
        correctedSnapshot.certifiedReceipt,
      ],
    },
  ],
  ["missing selected A1", { facts: [b2] }],
  ["superseded selected B1", { facts: [a1, b1] }],
  ["two selected B versions", { facts: [a1, b1, b2] }],
  ["retimed A1", { facts: [{ ...a1, fact: { ...a1.fact, observedAt: t2 } }, b2] }],
  ["turned-forward replay", { visibleAt: end, base }],
  [
    "origin with overlapping ID from another SKU",
    {
      receipts: [
        { ...firstSnapshot.certifiedReceipt, subject: { ...sku, externalSkuId: "sku-B" } },
        correctedSnapshot.certifiedReceipt,
      ],
    },
  ],
  [
    "origin with overlapping ID from another generation",
    {
      receipts: [
        { ...firstSnapshot.certifiedReceipt, generation: 1 },
        correctedSnapshot.certifiedReceipt,
      ],
    },
  ],
  [
    "origin with overlapping ID from another store",
    {
      receipts: [
        { ...firstSnapshot.certifiedReceipt, binding: { ...binding, storeId: "store-B" } },
        correctedSnapshot.certifiedReceipt,
      ],
    },
  ],
])("rejects corrected lineage with %s", (_label, change) => {
  expect(api.ObservedCaptureV1Schema.safeParse({ ...correctedCapture, ...change }).success).toBe(
    false,
  );
});

const firstPage = {
  ...firstSnapshot.certifiedReceipt,
  nextCursor: "c1",
  terminalCoverage: null,
  recordCount: 1,
  factRefs: [membership(a1)],
};
const lastPage = {
  ...firstSnapshot.certifiedReceipt,
  receiptId: "second",
  pageId: "pg2",
  pageIndex: 1,
  priorPageHash: firstPage.pageHash,
  expectedCursor: firstPage.nextCursor,
  pageHash: hash,
  recordCount: 1,
  factRefs: [{ ...membership(b1), originReceiptId: "second" }],
};
const twoPageCapture = {
  ...firstCapture,
  publications: [{ ...firstSnapshot.certificate, pageCount: 2 }],
  receipts: [firstPage, lastPage],
  facts: [a1, { ...b1, receiptId: "second" }],
  coverage: [{ ...firstSnapshot.coverageRow, receiptIds: ["R1", "second"] }],
};
const partialCoverage = {
  ...firstSnapshot.coverageRow,
  status: "PARTIAL",
  coverageBasisPoints: 8000,
  reason: "PARTIAL_COVERAGE",
};

it("requires each chain link and preserves the known portion of a partial capture", () => {
  expect(api.ObservedCaptureV1Schema.safeParse(twoPageCapture).success).toBe(true);
  expect(
    api.ObservedCaptureV1Schema.safeParse({
      ...twoPageCapture,
      receipts: [firstPage],
      facts: [a1],
      coverage: [partialCoverage],
    }).success,
  ).toBe(true);
  for (const page of [
    { ...lastPage, expectedCursor: "bad" },
    { ...lastPage, priorPageHash: hash },
    { ...lastPage, terminalCoverage: { coverageBasisPoints: 9000 } },
    { ...lastPage, factRefs: [membership(a1)] },
  ]) {
    expect(
      api.ObservedCaptureV1Schema.safeParse({ ...twoPageCapture, receipts: [firstPage, page] })
        .success,
    ).toBe(false);
  }
});

it("uses an explicit unavailable domain row for a missing observed partition", () => {
  const unavailable = {
    ...zeroCapture,
    publications: [],
    receipts: [],
    coverage: [
      {
        ...zeroCoverage,
        status: "UNAVAILABLE",
        coverageBasisPoints: 0,
        receiptIds: [],
        reason: "TRAFFIC_MISSING",
      },
    ],
  };
  expect(api.ObservedCaptureV1Schema.safeParse(unavailable).success).toBe(true);
  expect(api.ObservedCaptureV1Schema.safeParse({ ...unavailable, coverage: [] }).success).toBe(
    false,
  );
  expect(
    api.ObservedCaptureV1Schema.safeParse({ ...unavailable, coverage: [zeroCoverage] }).success,
  ).toBe(false);
});

it("accepts an actual failed initial synchronization without invented commerce evidence", () => {
  const failure = returnedFact(sync, "R1");
  const initial = captured([failure], snapshot([failure], 1, end));
  expect(api.ObservedCaptureV1Schema.parse(initial).base).toBeNull();
  expect(api.ObservedCaptureV1Schema.safeParse({ ...initial, domains: ["TRAFFIC"] }).success).toBe(
    false,
  );
});

it("admits an announced future ETA and excludes late observations at an earlier cutoff", () => {
  const original = returnedFact(notice, "R1");
  const earlierNotice = captured([original], snapshot([original], 1, end));
  const lateNotice = { ...original, fact: { ...notice, occurredAt: start, observedAt: later } };
  expect(api.ObservedCaptureV1Schema.parse(earlierNotice).facts[0]?.fact.payload).toEqual(
    notice.payload,
  );
  expect(
    api.ObservedCaptureV1Schema.safeParse({ ...earlierNotice, facts: [lateNotice] }).success,
  ).toBe(false);
});

it("checks raw capture collection limits before decoding publication records", () => {
  const oversized = { ...zeroCapture, publications: [{ ...publication }], facts: Array(50001) };
  Object.defineProperty(oversized.publications[0], "publicationId", {
    get() {
      throw new Error("unexpected nested decode");
    },
  });
  const result = api.ObservedCaptureV1Schema.safeParse(oversized);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.message).toBe("OVERFLOW");
});

const joinedMetricContext = {
  schemaVersion: 1,
  binding,
  ...window,
  visibleAt: end,
  sourceWatermark: end,
  definitionVersion,
  inputRevision: revision,
};
const blankMetricCollections = {
  paymentFacts: null,
  refundFacts: null,
  inventoryFacts: null,
  campaignFacts: null,
  frozenCosts: null,
  refundAllocations: null,
  returnReceipts: null,
  fees: null,
  traffic: null,
  inventoryExtensions: null,
};

function metricInput(subject: object, kind: string, collections: string[], evidenceIds: string[]) {
  return {
    ...joinedMetricContext,
    ...blankMetricCollections,
    status: "VERIFIED",
    evidenceIds,
    metricCoverage: [
      {
        ...joinedMetricContext,
        subject,
        kind,
        collections,
        evidenceIds,
        observedAt: end,
        sourceVersion: common.sourceVersion,
        coverageBasisPoints: 10000,
      },
    ],
  };
}

const skuTraffic = returnedFact({ ...pageFact, subject: sku }, "rc1");
const skuTrafficReceipt = {
  ...zeroReceipt,
  subject: sku,
  recordCount: 1,
  factRefs: [membership(skuTraffic)],
};
const skuCapture = {
  ...zeroCapture,
  publications: [{ ...publication, subject: sku, recordCount: 1 }],
  coverage: [{ ...zeroCoverage, subject: sku }],
  receipts: [skuTrafficReceipt],
  facts: [skuTraffic],
};
const trafficMetricRow = {
  binding,
  observedAt: end,
  sourceVersion: skuTraffic.fact.sourceVersion,
  evidenceIds: ["rc1"],
  data: {
    ...window,
    visitors: 10,
    cart: 4,
    checkout: 2,
    paidOrders: 1,
    coverageBasisPoints: 10000,
  },
};
const skuMetricInput = {
  ...metricInput(sku, "CONVERSION_RATE", ["traffic"], ["rc1"]),
  traffic: [trafficMetricRow],
};
const trafficSelectionRequest = {
  ...captureRequest,
  inputRevision: revision,
  subject: sku,
  kind: "CONVERSION_RATE",
};
const trafficSelection = { subject: sku, input: skuMetricInput, selectionReceiptIds: ["rc1"] };
const trafficProof = {
  request: trafficSelectionRequest,
  capture: skuCapture,
  selection: trafficSelection,
};

function withPublicationDecodeProbe(changes: object = {}) {
  const [certificate] = skuCapture.publications;
  let touches = 0;
  return {
    capture: {
      ...skuCapture,
      ...changes,
      publications: [
        {
          ...certificate,
          get publicationId() {
            touches += 1;
            return certificate.publicationId;
          },
        },
      ],
    },
    touches: () => touches,
  };
}

const captureOverflowCases = [
  ["receipt members", { receipts: [{ ...skuTrafficReceipt, factRefs: Array<unknown>(201) }] }],
  [
    "coverage receipt IDs",
    { coverage: [{ ...skuCapture.coverage[0], receiptIds: Array<unknown>(4097) }] },
  ],
] as const;

it.each(captureOverflowCases)(
  "preflights oversized %s on capture before certificate decoding",
  (_label, changes) => {
    const { capture, touches } = withPublicationDecodeProbe(changes);
    const result = api.ObservedCaptureV1Schema.safeParse(capture);
    expect.soft(touches()).toBe(0);
    expect.soft(result.error?.issues[0]).toMatchObject({ message: "OVERFLOW", path: [] });
  },
);

it.each([
  ...captureOverflowCases.map(([label, changes]) => ({ label, changes, proofChanges: {} })),
  {
    label: "request actor permissions",
    changes: {},
    proofChanges: {
      request: {
        ...trafficProof.request,
        actor: { ...trafficProof.request.actor, permissions: Array<unknown>(11) },
      },
    },
  },
  {
    label: "legacy nested evidence IDs",
    changes: {},
    proofChanges: {
      selection: withMetricInput({
        traffic: [{ ...trafficMetricRow, evidenceIds: Array<unknown>(4097) }],
      }),
    },
  },
])(
  "preflights oversized $label on selection proof before certificate decoding",
  ({ changes, proofChanges }) => {
    const { capture, touches } = withPublicationDecodeProbe(changes);
    const result = api.ObservedSelectionProofV1Schema.safeParse({
      ...trafficProof,
      capture,
      ...proofChanges,
    });
    expect.soft(touches()).toBe(0);
    expect.soft(result.error?.issues[0]).toMatchObject({ message: "OVERFLOW", path: [] });
  },
);

it.each([
  ["capture", api.ObservedCaptureRequestV1Schema, captureRequest],
  ["read", api.ObservedReadRequestV1Schema, { ...captureRequest, inputRevision: revision }],
  ["selection", api.ObservedSelectionRequestV1Schema, trafficSelectionRequest],
] as const)(
  "reports actor permission overflow at the %s request boundary",
  (_label, schema, request) => {
    const result = schema.safeParse({
      ...request,
      actor: { ...request.actor, permissions: Array<unknown>(11) },
    });
    expect(result.error?.issues[0]).toMatchObject({ message: "OVERFLOW", path: [] });
  },
);

it("retains the standalone receipt member cap", () => {
  const result = api.ObservedReceiptV1Schema.safeParse(captureOverflowCases[0][1].receipts[0]);
  expect(result.error?.issues[0]).toMatchObject({
    message: "INVALID_ARRAY_LENGTH",
    path: ["factRefs"],
  });
});

it("returns a three-key scoped SKU traffic input with its immutable source evidence", () => {
  expect(api.ObservedSelectionRequestV1Schema.parse(trafficSelectionRequest)).toEqual(
    trafficSelectionRequest,
  );
  const proved = api.ObservedSelectionProofV1Schema.parse(trafficProof);
  expect(proved.selection).toEqual(trafficSelection);
  expect(Object.keys(api.ScopedMetricInputV1Schema.parse(trafficSelection))).toEqual([
    "subject",
    "input",
    "selectionReceiptIds",
  ]);
  expect(Object.isFrozen(proved.selection.input.traffic?.[0]?.data)).toBe(true);
});

function withMetricInput(changes: object) {
  return { ...trafficSelection, input: { ...skuMetricInput, ...changes } };
}

it.each([
  [
    "input revision elsewhere",
    { selection: withMetricInput({ inputRevision: "p2-observed-v1:" + configHash }) },
  ],
  ["legacy definition", { selection: withMetricInput({ definitionVersion: "metrics-g4-v1" }) }],
  ["relabel store traffic as SKU", { capture: zeroCapture }],
  ["missing traffic data", { selection: withMetricInput({ traffic: null }) }],
  ["missing measured projection", { selection: withMetricInput({ traffic: [] }) }],
  [
    "data window moved",
    {
      selection: withMetricInput({
        traffic: [
          {
            ...trafficMetricRow,
            data: { ...trafficMetricRow.data, periodStart: start.replace("16:", "17:") },
          },
        ],
      }),
    },
  ],
  [
    "base or observed evidence mismatch",
    {
      selection: withMetricInput({
        traffic: [{ ...trafficMetricRow, evidenceIds: ["base-ORDERS"] }],
      }),
    },
  ],
  [
    "extra receipt",
    { selection: { ...trafficSelection, selectionReceiptIds: ["rc1", "base-MARKETING"] } },
  ],
  ["unknown receipt", { selection: { ...trafficSelection, selectionReceiptIds: ["missing"] } }],
  [
    "duplicate receipt",
    { selection: { ...trafficSelection, selectionReceiptIds: ["rc1", "rc1"] } },
  ],
  ["kind swap", { request: { ...trafficSelectionRequest, kind: "CART_RATE" } }],
  [
    "comparison request missing from capture",
    { request: { ...trafficSelectionRequest, comparisonWindows: [comparisonWindow] } },
  ],
  [
    "input watermark before window end",
    {
      selection: withMetricInput({
        sourceWatermark: start,
        metricCoverage: [{ ...skuMetricInput.metricCoverage[0], sourceWatermark: start }],
      }),
    },
  ],
  [
    "root evidence from another receipt",
    { selection: withMetricInput({ evidenceIds: ["foreign"] }) },
  ],
  [
    "nulls labeled verified",
    {
      selection: withMetricInput({
        traffic: [{ ...trafficMetricRow, data: { ...trafficMetricRow.data, visitors: null } }],
      }),
    },
  ],
])("rejects a traffic proof with %s", (_label, change) => {
  expect(api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, ...change }).success).toBe(
    false,
  );
});

it.each([
  ["external store binding", { binding: { ...binding, externalStoreId: "shop-B" } }],
  ["connection binding", { binding: { ...binding, connectionId: "conn-B" } }],
  ["generation", { generation: 1 }],
  ["SKU", { subject: { ...sku, externalSkuId: "sku-B" } }],
  ["publication hash", { publicationHash: hash }],
  [
    "source version",
    { factRefs: [{ ...membership(skuTraffic), sourceVersion: "observed-v1:g:0:e:2" }] },
  ],
  ["payload hash", { factRefs: [{ ...membership(skuTraffic), payloadHash: configHash }] }],
])("rejects an overlapping receipt ID with swapped %s", (_label, change) => {
  const capture = { ...skuCapture, receipts: [{ ...skuTrafficReceipt, ...change }] };
  expect(api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, capture }).success).toBe(
    false,
  );
});

it("rejects mismatching measured counters with the same source and receipt IDs", () => {
  const facts = [{ ...skuTraffic, fact: withPayload(skuTraffic.fact, { paidOrders: 9 }) }];
  const capture = { ...skuCapture, facts };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
  expect(api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, capture }).success).toBe(
    false,
  );
});

it("preserves a nullable traffic measurement independently of publication completeness", () => {
  const fact = withPayload(skuTraffic.fact, { visitors: null, reason: "TRAFFIC_MISSING" });
  const capture = { ...skuCapture, facts: [{ ...skuTraffic, fact }] };
  const traffic = [{ ...trafficMetricRow, data: { ...trafficMetricRow.data, visitors: null } }];
  const selection = withMetricInput({ traffic, status: "INSUFFICIENT" });
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, capture, selection }).success,
  ).toBe(true);
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...trafficProof,
      capture,
      selection: withMetricInput({ traffic }),
    }).success,
  ).toBe(false);
});

const zeroTrafficProof = {
  request: { ...trafficSelectionRequest, subject: store },
  capture: zeroCapture,
  selection: {
    subject: store,
    selectionReceiptIds: ["rc1"],
    input: { ...metricInput(store, "CONVERSION_RATE", ["traffic"], ["rc1"]), traffic: [] },
  },
};
it("accepts zero rows only from an exact certified terminal measurement", () => {
  expect(api.ObservedSelectionProofV1Schema.safeParse(zeroTrafficProof).success).toBe(true);
  const incomplete = {
    ...zeroCapture,
    publications: [{ ...publication, pageCount: 2, recordCount: 1 }],
    receipts: [{ ...zeroReceipt, nextCursor: "next", terminalCoverage: null }],
    coverage: [
      { ...zeroCoverage, status: "PARTIAL", coverageBasisPoints: 8000, reason: "PARTIAL_COVERAGE" },
    ],
  };
  expect(api.ObservedCaptureV1Schema.safeParse(incomplete).success).toBe(true);
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...zeroTrafficProof, capture: incomplete })
      .success,
  ).toBe(false);
});

it("pins exact comparison window/cutoff pairs and does not accept another store", () => {
  const request = { ...trafficSelectionRequest, comparisonWindows: [comparisonWindow] };
  const capture = { ...skuCapture, comparisons: [comparisonRef] };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, request, capture }).success,
  ).toBe(true);
  const replacedCutoff = {
    ...request,
    comparisonWindows: [{ ...comparisonWindow, visibleAt: end }],
  };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...trafficProof,
      request: replacedCutoff,
      capture,
    }).success,
  ).toBe(false);
  const otherStore = { ...comparisonRef, binding: { ...binding, storeId: "foreign-store" } };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...trafficProof,
      request,
      capture: { ...capture, comparisons: [otherStore] },
    }).success,
  ).toBe(false);
});

it.each([
  ["too many input evidence IDs", { evidenceIds: Array(4097) }],
  ["too many coverage entries", { metricCoverage: Array(4097) }],
  [
    "too many coverage evidence IDs",
    { metricCoverage: [{ ...skuMetricInput.metricCoverage[0], evidenceIds: Array(4097) }] },
  ],
  [
    "too many nested evidence IDs",
    { traffic: [{ ...trafficMetricRow, evidenceIds: Array(4097) }] },
  ],
  ["over aggregate fact budget", { paymentFacts: Array(25000), traffic: Array(25001) }],
])("preflights %s before decoding legacy metric objects", (_label, changes) => {
  const result = api.ScopedMetricInputV1Schema.safeParse(withMetricInput(changes));
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.message).toBe("OVERFLOW");
});

const hasSource = {
  version: "base-version",
  updatedAt: end,
  quality: { state: "COMPLETE", issues: [] },
};
const c1 = returnedFact(
  {
    ...campaign,
    factId: "C1",
    payload: {
      ...campaign.payload,
      spendMinor: 100,
      attributedRevenueMinor: 200,
      eligibleCount: 5,
      measuredCount: 5,
      coverageBasisPoints: 10000,
      reason: null,
    },
  },
  "R1",
);
const c2 = returnedFact(
  {
    ...campaign,
    factId: "C2",
    sequence: 2,
    sourceVersion: "observed-v1:g:0:e:2",
    subject: { ...campaignSubject, externalCampaignId: "c2" },
    payload: {
      ...campaign.payload,
      externalCampaignId: "c2",
      spendMinor: 300,
      attributedRevenueMinor: 1200,
      eligibleCount: 8,
      measuredCount: 7,
      coverageBasisPoints: 10000,
      reason: null,
    },
  },
  "R2",
);
const campaignSnapshot1 = snapshot([c1], 1, end);
const campaignSnapshot2 = snapshot([c2], 2, end);
const marketing2 = { stream: "MARKETING", pageId: "base-MARKETING-2", pageHash };
const storeRoaSCapture = {
  ...zeroCapture,
  domains: ["CAMPAIGN_MEASUREMENT"],
  publications: [
    campaignSnapshot1.certificate,
    { ...campaignSnapshot2.certificate, publicationSequence: 1 },
  ],
  receipts: [campaignSnapshot1.certifiedReceipt, campaignSnapshot2.certifiedReceipt],
  coverage: [campaignSnapshot1.coverageRow, campaignSnapshot2.coverageRow],
  facts: [c1, c2],
  base: { ...base, receipts: [...base.receipts, marketing2] },
};

function campaignMetricRow(stored: typeof c1 | typeof c2, marketingPage: string) {
  const { receiptId, fact } = stored;
  const { externalCampaignId, businessDate, spendMinor, attributedRevenueMinor } = fact.payload;
  const factContext = { binding, observedAt: end, sourceVersion: fact.sourceVersion };
  return {
    ...factContext,
    evidenceIds: [receiptId, marketingPage],
    data: {
      externalStoreId: binding.externalStoreId,
      externalCampaignId,
      date: businessDate,
      impressions: 10,
      clicks: 5,
      attributedOrders: 2,
      spendMinor,
      attributedRevenueMinor,
      currency: "CNY",
      source: hasSource,
    },
    measuredCoverage: {
      ...factContext,
      ...window,
      coverageBasisPoints: 10000,
      evidenceIds: [receiptId],
    },
  };
}

const campaignRows = [
  campaignMetricRow(c1, "base-MARKETING"),
  campaignMetricRow(c2, marketing2.pageId),
];
const campaignWitnessIds = ["R1", "R2", "base-MARKETING", marketing2.pageId];
const roasInput = {
  ...metricInput(store, "ROAS", ["campaignFacts"], campaignWitnessIds),
  campaignFacts: campaignRows,
};
const storeRoaSProof = {
  request: {
    ...trafficSelectionRequest,
    subject: store,
    kind: "ROAS",
    domains: ["CAMPAIGN_MEASUREMENT"],
  },
  capture: storeRoaSCapture,
  selection: { subject: store, selectionReceiptIds: campaignWitnessIds, input: roasInput },
};

it("binds STORE ROAS to both campaign-day rows and all marketing pages", () => {
  const proof = api.ObservedSelectionProofV1Schema.parse(storeRoaSProof);
  expect(proof.selection.input.campaignFacts?.map((row) => row.data.externalCampaignId)).toEqual([
    "c1",
    "c2",
  ]);
  expect(proof.selection.selectionReceiptIds).toEqual(campaignWitnessIds);
});

const exactCampaignWitnessIds = ["R1", "base-MARKETING"];
const exactCampaignRoaSProof = {
  ...storeRoaSProof,
  request: { ...storeRoaSProof.request, subject: campaignSubject },
  selection: {
    subject: campaignSubject,
    selectionReceiptIds: exactCampaignWitnessIds,
    input: {
      ...metricInput(campaignSubject, "ROAS", ["campaignFacts"], exactCampaignWitnessIds),
      campaignFacts: [campaignRows[0]],
    },
  },
};

it.each([
  ["STORE", storeRoaSProof],
  ["CAMPAIGN", exactCampaignRoaSProof],
] as const)(
  "rejects VERIFIED %s ROAS with inconsistent retained source amounts",
  (_scope, proof) => {
    const [row, ...others] = proof.selection.input.campaignFacts;
    const source = { ...hasSource, quality: { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] } };
    const campaignFacts = [{ ...row, data: { ...row.data, source } }, ...others];
    const input = { ...proof.selection.input, campaignFacts };
    const selection = { ...proof.selection, input };
    expect(api.MetricInputV1Schema.safeParse(input).success).toBe(true);
    expect.soft(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(false);
    expect
      .soft(api.ObservedSelectionProofV1Schema.safeParse({ ...proof, selection }).success)
      .toBe(false);
  },
);

it.each([
  ["STORE", storeRoaSProof],
  ["CAMPAIGN", exactCampaignRoaSProof],
] as const)(
  "retains known VERIFIED %s ROAS amounts with an unknown optional field",
  (_scope, proof) => {
    const [row, ...others] = proof.selection.input.campaignFacts;
    const source = { ...hasSource, quality: { state: "PARTIAL", issues: ["MARKETING_UNKNOWN"] } };
    const campaignFacts = [{ ...row, data: { ...row.data, impressions: null, source } }, ...others];
    const selection = { ...proof.selection, input: { ...proof.selection.input, campaignFacts } };
    expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(true);
    const parsed = api.ObservedSelectionProofV1Schema.parse({ ...proof, selection });
    expect(parsed.selection.input.campaignFacts?.[0]?.data).toMatchObject({
      impressions: null,
      spendMinor: 100,
      attributedRevenueMinor: 200,
    });
  },
);

it.each([
  ["missing observed receipt", ["R1", "base-MARKETING", marketing2.pageId]],
  ["missing marketing page", ["R1", "R2", "base-MARKETING"]],
])("rejects STORE ROAS with a %s", (_label, selectionReceiptIds) => {
  const input = {
    ...metricInput(store, "ROAS", ["campaignFacts"], selectionReceiptIds),
    campaignFacts: campaignRows.map((row) => ({
      ...row,
      evidenceIds: row.evidenceIds.filter((id) => selectionReceiptIds.includes(id)),
      measuredCoverage: {
        ...row.measuredCoverage,
        evidenceIds: row.measuredCoverage.evidenceIds.filter((id) =>
          selectionReceiptIds.includes(id),
        ),
      },
    })),
  };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...storeRoaSProof,
      selection: { ...storeRoaSProof.selection, selectionReceiptIds, input },
    }).success,
  ).toBe(false);
});

it.each([
  ["omitted campaign", [campaignRows[0]]],
  ["duplicate campaign/day", [campaignRows[0], campaignRows[0]]],
  [
    "swapped per-campaign revenue",
    campaignRows.map((row, index) => ({
      ...row,
      data: {
        ...row.data,
        attributedRevenueMinor: campaignRows[1 - index].data.attributedRevenueMinor,
      },
    })),
  ],
  ["missing measured interval", [campaignRows[0], { ...campaignRows[1], measuredCoverage: null }]],
  [
    "unknown attributed amount",
    [
      campaignRows[0],
      {
        ...campaignRows[1],
        data: {
          ...campaignRows[1].data,
          attributedRevenueMinor: null,
          source: { ...hasSource, quality: { state: "PARTIAL", issues: ["MARKETING_UNKNOWN"] } },
        },
      },
    ],
  ],
])("rejects STORE ROAS with %s", (_label, campaignFacts) => {
  const selection = { ...storeRoaSProof.selection, input: { ...roasInput, campaignFacts } };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...storeRoaSProof, selection }).success,
  ).toBe(false);
});

it("keeps campaign and SKU selections separate from the STORE component graph", () => {
  for (const subject of [campaignSubject, sku]) {
    const request = { ...storeRoaSProof.request, subject };
    const input = {
      ...metricInput(subject, "ROAS", ["campaignFacts"], campaignWitnessIds),
      campaignFacts: campaignRows,
    };
    const selection = { subject, input, selectionReceiptIds: campaignWitnessIds };
    expect(
      api.ObservedSelectionProofV1Schema.safeParse({ ...storeRoaSProof, request, selection })
        .success,
    ).toBe(false);
  }
});

it("rejects complete STORE ROAS when an enumerated campaign partition is partial", () => {
  const partial = {
    ...campaignSnapshot2.coverageRow,
    status: "PARTIAL",
    coverageBasisPoints: 8000,
    reason: "PARTIAL_COVERAGE",
  };
  const capture = { ...storeRoaSCapture, coverage: [campaignSnapshot1.coverageRow, partial] };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
  expect(api.ObservedSelectionProofV1Schema.safeParse({ ...storeRoaSProof, capture }).success).toBe(
    false,
  );
});

function orderItem(externalLineId: string, externalSkuId: string, grossMinor: number) {
  return {
    externalLineId,
    externalSkuId,
    externalProductId: "product-A",
    quantity: 1,
    unitPriceMinor: grossMinor,
    grossMinor,
    netMinor: grossMinor,
    discountMinor: 0,
  };
}
const originalOrder = {
  externalStoreId: binding.externalStoreId,
  externalOrderId: "o1",
  source: hasSource,
  status: "PAID",
  orderedAt: start,
  paidAt: end,
  currency: "CNY",
  items: [orderItem("l1", "sku-A", 100), orderItem("l2", "sku-B", 200)],
  grossMinor: 300,
  discountMinor: 0,
  shippingMinor: 5,
  payableMinor: 305,
  paidMinor: 305,
  refundedMinor: 0,
};
const orderRow = {
  binding,
  observedAt: end,
  sourceVersion: "base-order-1",
  evidenceIds: ["base-ORDERS"],
  data: originalOrder,
};
const skuOrdersInput = {
  ...metricInput(sku, "GMV", ["paymentFacts"], ["base-ORDERS"]),
  paymentFacts: [orderRow],
};
const skuOrdersProof = {
  request: { ...trafficSelectionRequest, kind: "GMV" },
  capture: zeroCapture,
  selection: { subject: sku, input: skuOrdersInput, selectionReceiptIds: ["base-ORDERS"] },
};
it("retains the full original multi-line order and requires a matching SKU and ORDERS page", () => {
  const output = api.ObservedSelectionProofV1Schema.parse(skuOrdersProof);
  expect(output.selection.input.paymentFacts?.[0]?.data).toEqual(originalOrder);
  const otherSku = { kind: "SKU", externalSkuId: "sku-C" };
  const selection = {
    subject: otherSku,
    selectionReceiptIds: ["base-ORDERS"],
    input: {
      ...skuOrdersInput,
      metricCoverage: [{ ...skuOrdersInput.metricCoverage[0], subject: otherSku }],
    },
  };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...skuOrdersProof,
      request: { ...skuOrdersProof.request, subject: otherSku },
      selection,
    }).success,
  ).toBe(false);
  const wrongPage = { ...orderRow, evidenceIds: ["base-REFUNDS"] };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...skuOrdersProof,
      selection: {
        ...skuOrdersProof.selection,
        input: { ...skuOrdersInput, paymentFacts: [wrongPage] },
      },
    }).success,
  ).toBe(false);
});

const financeA = returnedFact({ ...a1.fact, payload: { ...a1.fact.payload, ...line } }, "R1");
const financeB = returnedFact(
  {
    ...b1.fact,
    subject: { ...sku, externalSkuId: "sku-B" },
    payload: { ...b1.fact.payload, ...line, externalSkuId: "sku-B", externalLineId: "l2" },
  },
  "R2",
);

function costMetricRow(stored: typeof financeA | typeof financeB) {
  const {
    externalOrderId,
    externalLineId,
    externalSkuId,
    quantity,
    frozenAt,
    skuCostVersion,
    unitCostMinor,
    basis,
    currency,
  } = stored.fact.payload;
  return {
    binding,
    observedAt: end,
    sourceVersion: stored.fact.sourceVersion,
    evidenceIds: [stored.receiptId],
    data: {
      externalOrderId,
      externalLineId,
      externalSkuId,
      quantity,
      frozenAt,
      skuCostVersion,
      unitCostMinor,
      basis,
      currency,
    },
  };
}
const financeSnapshotA = snapshot([financeA], 1, end);
const financeSnapshotB = snapshot([financeB], 2, end);
const financeStoreCapture = {
  ...zeroCapture,
  domains: ["FROZEN_COST"],
  facts: [financeA, financeB],
  publications: [financeSnapshotA.certificate, financeSnapshotB.certificate],
  receipts: [financeSnapshotA.certifiedReceipt, financeSnapshotB.certifiedReceipt],
  coverage: [financeSnapshotA.coverageRow, financeSnapshotB.coverageRow],
};
const financeEvidence = ["R1", "R2", "base-ORDERS"];
const financeInput = {
  ...metricInput(store, "GMV", ["paymentFacts", "frozenCosts"], financeEvidence),
  paymentFacts: [orderRow],
  frozenCosts: [costMetricRow(financeA), costMetricRow(financeB)],
};
const storeCostProof = {
  request: { ...skuOrdersProof.request, subject: store, domains: ["FROZEN_COST"] },
  capture: financeStoreCapture,
  selection: { subject: store, input: financeInput, selectionReceiptIds: financeEvidence },
};

it("retains each confirmed SKU cost under its own matching original STORE order line", () => {
  expect(api.ObservedSelectionProofV1Schema.safeParse(storeCostProof).success).toBe(true);
  const costs = financeInput.frozenCosts.map((row) => ({
    ...row,
    data: { ...row.data, externalLineId: "l1" },
  }));
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...storeCostProof,
      selection: { ...storeCostProof.selection, input: { ...financeInput, frozenCosts: costs } },
    }).success,
  ).toBe(false);
  const incomplete = {
    ...financeStoreCapture,
    facts: [financeA],
    coverage: [financeSnapshotA.coverageRow],
    publications: [financeSnapshotA.certificate],
    receipts: [financeSnapshotA.certifiedReceipt],
  };
  const evidence = ["R1", "base-ORDERS"];
  const input = {
    ...financeInput,
    ...metricInput(store, "GMV", ["paymentFacts", "frozenCosts"], evidence),
    paymentFacts: [orderRow],
    frozenCosts: [costMetricRow(financeA)],
  };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...storeCostProof,
      capture: incomplete,
      selection: { subject: store, input, selectionReceiptIds: evidence },
    }).success,
  ).toBe(false);
});

it("keeps an unavailable cost unknown even when the partition is fully enumerated", () => {
  const changed = {
    ...financeA,
    fact: withPayload(financeA.fact, {
      basis: "UNAVAILABLE",
      unitCostMinor: null,
      skuCostVersion: null,
      reason: "COST_MISSING",
    }),
  };
  const capture = { ...financeStoreCapture, facts: [changed, financeB] };
  const first = costMetricRow(financeA);
  const frozenCosts = [
    {
      ...first,
      data: { ...first.data, basis: "UNAVAILABLE", unitCostMinor: null, skuCostVersion: null },
    },
    costMetricRow(financeB),
  ];
  const input = { ...financeInput, frozenCosts };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...storeCostProof,
      capture,
      selection: { ...storeCostProof.selection, input },
    }).success,
  ).toBe(false);
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({
      ...storeCostProof,
      capture,
      selection: { ...storeCostProof.selection, input: { ...input, status: "INSUFFICIENT" } },
    }).success,
  ).toBe(true);
});

const cogsEvidence = ["R1", "base-ORDERS", "base-REFUNDS"];
const cogsInput = {
  ...metricInput(
    sku,
    "COGS",
    ["paymentFacts", "refundFacts", "frozenCosts", "refundAllocations", "returnReceipts"],
    cogsEvidence,
  ),
  paymentFacts: [orderRow],
  refundFacts: [],
  frozenCosts: [costMetricRow(financeA)],
  refundAllocations: [],
  returnReceipts: [],
};

const paidInWindow = "2026-11-02T01:00:00.000Z";
const cohortPayment = { ...orderRow, data: { ...orderRow.data, paidAt: paidInWindow } };
const costAtPayment = {
  ...financeA,
  fact: {
    ...financeA.fact,
    occurredAt: paidInWindow,
    payload: { ...financeA.fact.payload, frozenAt: paidInWindow },
  },
};

function emptyFinancePartition(domain: string, subject: object, index: number) {
  const sample = returnedFact({ ...common, domain, subject, payload: {} }, "R" + index);
  const { certificate, certifiedReceipt, coverageRow } = snapshot([sample], index, end);
  return {
    certificate: { ...certificate, recordCount: 0 },
    certifiedReceipt: { ...certifiedReceipt, recordCount: 0, factRefs: [] },
    coverageRow,
  };
}

function completeCostProof(
  subject: typeof sku | typeof store,
  orders: readonly (Omit<typeof orderRow, "data"> & { data: api.ConnectorOrder })[],
  skuCosts: readonly { subject: typeof sku; rows: readonly (typeof financeA)[] }[],
) {
  const domains = ["FROZEN_COST", "REFUND_ALLOCATION", "RETURN_RECEIPT"];
  const partitions = domains.flatMap((domain, domainIndex) =>
    skuCosts.map(({ subject, rows }, skuIndex) => {
      const ordinal = domainIndex * skuCosts.length + skuIndex + 1;
      return domain === "FROZEN_COST" && rows.length > 0
        ? snapshot(rows, ordinal, end)
        : emptyFinancePartition(domain, subject, ordinal);
    }),
  );
  const receipts = partitions.map(({ certifiedReceipt }) => certifiedReceipt);
  const facts = skuCosts.flatMap(({ rows }) => rows);
  const evidence = [...receipts.map(({ receiptId }) => receiptId), "base-ORDERS", "base-REFUNDS"];
  const collections = cogsInput.metricCoverage[0].collections;
  return {
    request: { ...trafficSelectionRequest, subject, domains, kind: "COGS" },
    capture: {
      ...zeroCapture,
      domains,
      facts,
      receipts,
      publications: partitions.map(({ certificate }) => certificate),
      coverage: partitions.map(({ coverageRow }) => coverageRow),
    },
    selection: {
      subject,
      selectionReceiptIds: evidence,
      input: {
        ...metricInput(subject, "COGS", collections, evidence),
        paymentFacts: orders,
        frozenCosts: facts.map(costMetricRow),
        refundFacts: [],
        refundAllocations: [],
        returnReceipts: [],
      },
    },
  };
}

function cohortOrder(changes: Partial<api.ConnectorOrder> = {}) {
  return {
    ...cohortPayment,
    data: { ...api.ConnectorOrderSchema.parse(cohortPayment.data), ...changes },
  };
}

const skuB = { ...sku, externalSkuId: "sku-B" };
const secondCostAtPayment = {
  ...financeB,
  fact: {
    ...financeB.fact,
    occurredAt: paidInWindow,
    payload: { ...financeB.fact.payload, frozenAt: paidInWindow },
  },
};
const storeCogsCosts = [
  { subject: sku, rows: [costAtPayment] },
  { subject: skuB, rows: [secondCostAtPayment] },
];

function costWith(changes: Partial<typeof costAtPayment.fact.payload>) {
  return {
    ...costAtPayment,
    fact: { ...costAtPayment.fact, payload: { ...costAtPayment.fact.payload, ...changes } },
  };
}

it.each([
  ["omitted cost", []],
  ["wrong paid quantity", [costWith({ quantity: 2 })]],
  ["wrong freeze instant", [costWith({ frozenAt: start })]],
  [
    "two costs for one paid line",
    [
      costAtPayment,
      {
        ...costAtPayment,
        fact: {
          ...costAtPayment.fact,
          factId: "extra",
          sequence: 3,
          sourceVersion: "observed-v1:g:0:e:3",
        },
      },
    ],
  ],
] as const)("rejects VERIFIED STORE COGS with %s", (_label, rows) => {
  const proof = completeCostProof(
    store,
    [cohortOrder()],
    [{ subject: sku, rows }, storeCogsCosts[1]],
  );
  expect(api.ObservedCaptureV1Schema.safeParse(proof.capture).success).toBe(true);
  const result = api.ObservedSelectionProofV1Schema.safeParse(proof);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain(
    "INVALID_SELECTION_EVIDENCE",
  );
});

it("requires confirmed cost for a SKU line while retaining the full original paid order", () => {
  const orders = [cohortOrder({ paidAt: paidInWindow.replace(".000Z", "Z") })];
  const proof = completeCostProof(sku, orders, [
    { subject: sku, rows: [costWith({ unitCostMinor: 0 })] },
  ]);
  const { input } = api.ObservedSelectionProofV1Schema.parse(proof).selection;
  expect(input.paymentFacts?.[0]?.data).toEqual(orders[0].data);
  expect(input.frozenCosts?.map(({ data }) => data?.unitCostMinor)).toEqual([0]);
  expect(
    api.ObservedSelectionProofV1Schema.safeParse(completeCostProof(store, orders, storeCogsCosts))
      .success,
  ).toBe(true);
});

it.each([
  ["same instant with extra fractional zeros", "2026-11-02T01:00:00.000000Z", true],
  ["same instant with an explicit offset", "2026-11-02T09:00:00+08:00", true],
  ["later instant truncated by Date.parse", "2026-11-02T01:00:00.0001Z", false],
] as const)("checks the frozen payment instant for %s", (_label, paidAt, matches) => {
  const proof = completeCostProof(
    sku,
    [cohortOrder({ paidAt })],
    [{ subject: sku, rows: [costAtPayment] }],
  );
  expect(api.ObservedSelectionProofV1Schema.safeParse(proof).success).toBe(matches);
});

it.each([start, end, pastWindow.periodStart])(
  "uses half-open payment eligibility for a payment at %s",
  (paidAt) => {
    const proof = completeCostProof(
      sku,
      [cohortOrder({ paidAt, orderedAt: paidAt })],
      [{ subject: sku, rows: [] }],
    );
    expect(api.ObservedSelectionProofV1Schema.safeParse(proof).success).toBe(paidAt !== start);
  },
);

it("retains a supplied historical cost outside the paid cohort", () => {
  const historicalCost = costWith({ frozenAt: pastWindow.periodStart });
  const historicalOrder = cohortOrder({
    paidAt: pastWindow.periodStart,
    orderedAt: pastWindow.periodStart,
  });
  const proof = completeCostProof(
    sku,
    [historicalOrder],
    [{ subject: sku, rows: [historicalCost] }],
  );
  expect(api.ObservedSelectionProofV1Schema.safeParse(proof).success).toBe(true);
});

it("accepts witnessed zero STORE costs for orders paid at the exclusive window end", () => {
  const partitions = storeCogsCosts.map(({ subject }) => ({ subject, rows: [] }));
  const proof = completeCostProof(store, [cohortOrder({ paidAt: end })], partitions);
  expect(api.ObservedSelectionProofV1Schema.safeParse(proof).success).toBe(true);
});

it("preserves an explicitly estimated frozen cost for an in-window payment", () => {
  const proof = completeCostProof(sku, [cohortOrder()], [{ subject: sku, rows: [costAtPayment] }]);
  const estimate = { basis: "ESTIMATED", unitCostMinor: 0 };
  const [fact] = proof.capture.facts;
  const capture = {
    ...proof.capture,
    facts: [{ ...fact, fact: withPayload(fact.fact, { ...estimate, reason: "COST_ESTIMATED" }) }],
  };
  const [cost] = proof.selection.input.frozenCosts;
  const input = {
    ...proof.selection.input,
    status: "ESTIMATED",
    frozenCosts: [{ ...cost, data: { ...cost.data, ...estimate } }],
  };
  const selection = { ...proof.selection, input };
  const result = api.ObservedSelectionProofV1Schema.parse({ ...proof, capture, selection });
  expect(result.selection.input.frozenCosts?.[0]?.data).toMatchObject(estimate);
});

it("distinguishes a certified empty cohort from an unknown payment and preserves missing cost", () => {
  const partitions = [{ subject: sku, rows: [] }];
  const unpaid = cohortOrder({ status: "PENDING_PAYMENT", paidAt: null, paidMinor: 0 });
  const unknown = cohortOrder({
    paidAt: null,
    paidMinor: null,
    source: { ...unpaid.data.source, quality: { state: "PARTIAL", issues: ["PAYMENT_UNKNOWN"] } },
  });
  for (const orders of [[], [unpaid]]) {
    expect(
      api.ObservedSelectionProofV1Schema.safeParse(completeCostProof(sku, orders, partitions))
        .success,
    ).toBe(true);
  }
  const ambiguous = completeCostProof(sku, [unknown], partitions);
  expect(api.ObservedSelectionProofV1Schema.safeParse(ambiguous).success).toBe(false);
  for (const orders of [[unknown], [cohortOrder()]]) {
    const proof = completeCostProof(sku, orders, partitions);
    const selection = {
      ...proof.selection,
      input: { ...proof.selection.input, status: "INSUFFICIENT" },
    };
    expect(api.ObservedSelectionProofV1Schema.safeParse({ ...proof, selection }).success).toBe(
      true,
    );
  }
});

it.each(["CLOSED", "CANCELLED"] as const)(
  "rejects a VERIFIED payment with inconsistent amount on a %s order",
  (status) => {
    const order = cohortOrder({ status, paidMinor: 100 });
    const proof = completeCostProof(sku, [order], [{ subject: sku, rows: [costAtPayment] }]);
    expect(api.MetricInputV1Schema.safeParse(proof.selection.input).success).toBe(true);
    expect(api.ScopedMetricInputV1Schema.safeParse(proof.selection).success).toBe(false);
    expect(api.ObservedSelectionProofV1Schema.safeParse(proof).success).toBe(false);
    const selection = {
      ...proof.selection,
      input: { ...proof.selection.input, status: "INSUFFICIENT" },
    };
    expect(api.ObservedSelectionProofV1Schema.safeParse({ ...proof, selection }).success).toBe(
      true,
    );
  },
);

it("keeps a fully paid closed order and a known unpaid cancelled order distinguishable", () => {
  const closed = cohortOrder({ status: "CLOSED" });
  const cancelled = cohortOrder({ status: "CANCELLED", paidAt: null, paidMinor: 0 });
  const withCost = completeCostProof(sku, [closed], [{ subject: sku, rows: [costAtPayment] }]);
  const empty = completeCostProof(sku, [cancelled], [{ subject: sku, rows: [] }]);
  expect(api.ObservedSelectionProofV1Schema.safeParse(withCost).success).toBe(true);
  expect(api.ObservedSelectionProofV1Schema.safeParse(empty).success).toBe(true);
});

it("treats a genuine zero-payable paid order as a paid line with its own cost", () => {
  const free = cohortOrder({
    items: [orderItem("l1", "sku-A", 0)],
    grossMinor: 0,
    shippingMinor: 0,
    payableMinor: 0,
    paidMinor: 0,
  });
  const measured = completeCostProof(
    sku,
    [free],
    [{ subject: sku, rows: [costWith({ unitCostMinor: 0 })] }],
  );
  const empty = completeCostProof(sku, [free], [{ subject: sku, rows: [] }]);
  expect(api.ObservedSelectionProofV1Schema.safeParse(measured).success).toBe(true);
  expect(api.ObservedSelectionProofV1Schema.safeParse(empty).success).toBe(false);
});

it("rejects a pending-payment order with provider-flagged paid activity as VERIFIED", () => {
  const order = cohortOrder({
    status: "PENDING_PAYMENT",
    source: {
      ...cohortOrder().data.source,
      quality: { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] },
    },
  });
  const proof = completeCostProof(sku, [order], [{ subject: sku, rows: [costAtPayment] }]);
  expect(api.MetricInputV1Schema.safeParse(proof.selection.input).success).toBe(true);
  expect(api.ScopedMetricInputV1Schema.safeParse(proof.selection).success).toBe(false);
});

it.each([
  {
    basis: "UNAVAILABLE",
    unitCostMinor: null,
    skuCostVersion: null,
    nonVerified: "INSUFFICIENT",
  },
  { basis: "ESTIMATED", unitCostMinor: 0, skuCostVersion: "cost-v1", nonVerified: "ESTIMATED" },
])("requires independently confirmed cost for standalone VERIFIED COGS ($basis)", (cost) => {
  const { nonVerified, ...data } = cost;
  const [row] = cogsInput.frozenCosts;
  const input = { ...cogsInput, frozenCosts: [{ ...row, data: { ...row.data, ...data } }] };
  const selection = { subject: sku, selectionReceiptIds: cogsEvidence, input };
  const result = api.ScopedMetricInputV1Schema.safeParse(selection);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(({ message }) => message)).toContain("INVALID_METRIC_PROJECTION");
  const accepted = api.ScopedMetricInputV1Schema.parse({
    ...selection,
    input: { ...input, status: nonVerified },
  });
  expect(accepted.input.frozenCosts?.[0]?.data).toMatchObject(data);
});

it("preserves a confirmed zero unit cost in standalone VERIFIED COGS", () => {
  const [row] = cogsInput.frozenCosts;
  const input = {
    ...cogsInput,
    frozenCosts: [{ ...row, data: { ...row.data, unitCostMinor: 0 } }],
  };
  const selection = api.ScopedMetricInputV1Schema.parse({
    subject: sku,
    selectionReceiptIds: cogsEvidence,
    input,
  });
  expect(selection.input.frozenCosts?.[0]?.data?.unitCostMinor).toBe(0);
});

const allocationData = {
  ...line,
  externalRefundId: refund.payload.externalRefundId,
  merchandiseMinor: refund.payload.merchandiseMinor,
  buyerShippingMinor: refund.payload.buyerShippingMinor,
  currency: refund.payload.currency,
};
const returnData = {
  ...line,
  externalRefundId: receipt.payload.externalRefundId,
  externalReceiptId: receipt.payload.externalReceiptId,
  acceptedAt: receipt.payload.acceptedAt,
  resellableQuantity: receipt.payload.resellableQuantity,
};
const feeData = {
  ...window,
  kind: "FULFILLMENT",
  externalOrderId: "o1",
  amountMinor: 0,
  coverageBasisPoints: 10000,
  basis: "CONFIRMED",
};
const projectionRow = {
  binding,
  observedAt: end,
  sourceVersion: common.sourceVersion,
  evidenceIds: cogsEvidence,
};
const contributionInput = {
  ...cogsInput,
  metricCoverage: [
    {
      ...cogsInput.metricCoverage[0],
      subject: store,
      kind: "CONTRIBUTION",
      collections: [...cogsInput.metricCoverage[0].collections, "fees"],
    },
  ],
  fees: [{ ...projectionRow, data: feeData }],
};

it.each([
  [
    "unknown merchandise allocation",
    {
      refundAllocations: [
        { ...projectionRow, data: { ...allocationData, merchandiseMinor: null } },
      ],
    },
  ],
  [
    "unknown buyer shipping allocation",
    {
      refundAllocations: [
        { ...projectionRow, data: { ...allocationData, buyerShippingMinor: null } },
      ],
    },
  ],
  [
    "unknown return acceptance",
    { returnReceipts: [{ ...projectionRow, data: { ...returnData, acceptedAt: null } }] },
  ],
  [
    "unknown resellable quantity",
    { returnReceipts: [{ ...projectionRow, data: { ...returnData, resellableQuantity: null } }] },
  ],
])("requires known finance for standalone VERIFIED COGS with %s", (_label, changes) => {
  const input = { ...cogsInput, ...changes };
  expect(api.MetricInputV1Schema.safeParse(input).success).toBe(true);
  const selection = { subject: sku, selectionReceiptIds: cogsEvidence, input };
  expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(false);
  expect(
    api.ScopedMetricInputV1Schema.safeParse({
      ...selection,
      input: { ...input, status: "INSUFFICIENT" },
    }).success,
  ).toBe(true);
});

it.each([
  { basis: "UNAVAILABLE", amountMinor: null, coverageBasisPoints: 10000 },
  { basis: "ESTIMATED", amountMinor: 0, coverageBasisPoints: 10000 },
  { basis: "CONFIRMED", amountMinor: 0, coverageBasisPoints: 100 },
])("requires complete confirmed fee data for VERIFIED CONTRIBUTION (%o)", (changes) => {
  const fees = [{ ...projectionRow, data: { ...feeData, ...changes } }];
  const input = { ...contributionInput, fees };
  const selection = { subject: store, selectionReceiptIds: cogsEvidence, input };
  expect(api.MetricInputV1Schema.safeParse(input).success).toBe(true);
  expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(false);
  const estimated = api.ScopedMetricInputV1Schema.parse({
    ...selection,
    input: { ...input, status: "ESTIMATED" },
  });
  expect(estimated.input.fees?.[0]?.data).toMatchObject(changes);
});

it("retains confirmed zero fees and certified absence of charges for VERIFIED CONTRIBUTION", () => {
  for (const fees of [contributionInput.fees, []]) {
    const input = { ...contributionInput, fees };
    const selection = { subject: store, selectionReceiptIds: cogsEvidence, input };
    expect(api.ScopedMetricInputV1Schema.parse(selection).input.fees).toEqual(fees);
  }
});

it("retains known zero allocation amounts and zero resellable quantity", () => {
  const input = {
    ...cogsInput,
    refundAllocations: [
      { ...projectionRow, data: { ...allocationData, merchandiseMinor: 0, buyerShippingMinor: 0 } },
    ],
    returnReceipts: [{ ...projectionRow, data: { ...returnData, resellableQuantity: 0 } }],
  };
  const selection = { subject: sku, selectionReceiptIds: cogsEvidence, input };
  expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(true);
});

it("keeps VERIFIED GMV independent of quality in a nonrequired fee collection", () => {
  const fees = [
    { ...projectionRow, data: { ...feeData, basis: "UNAVAILABLE", amountMinor: null } },
  ];
  const input = {
    ...metricInput(store, "GMV", ["paymentFacts", "fees"], cogsEvidence),
    paymentFacts: [orderRow],
    fees,
  };
  const selection = { subject: store, selectionReceiptIds: cogsEvidence, input };
  expect(api.ScopedMetricInputV1Schema.parse(selection).input.fees).toEqual(fees);
});

it.each(["PAYMENT_UNKNOWN", "SOURCE_INCONSISTENT", "SOURCE_TIME_MISSING"] as const)(
  "rejects standalone VERIFIED COGS with payment quality %s",
  (code) => {
    const order = cohortOrder();
    const source = { ...order.data.source, quality: { state: "PARTIAL" as const, issues: [code] } };
    const paymentFacts = [{ ...order, data: { ...order.data, source } }];
    const input = { ...cogsInput, paymentFacts };
    expect(api.MetricInputV1Schema.safeParse(input).success).toBe(true);
    const selection = { subject: sku, selectionReceiptIds: cogsEvidence, input };
    expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(false);
    const proof = completeCostProof(sku, paymentFacts, [{ subject: sku, rows: [costAtPayment] }]);
    expect(api.ObservedSelectionProofV1Schema.safeParse(proof).success).toBe(false);
  },
);

const baseRefund = {
  ...projectionRow,
  sourceVersion: "base-refund-1",
  evidenceIds: ["base-REFUNDS"],
  data: {
    externalStoreId: binding.externalStoreId,
    externalRefundId: refund.payload.externalRefundId,
    externalOrderId: line.externalOrderId,
    externalSkuId: line.externalSkuId,
    source: hasSource,
    status: "SUCCEEDED",
    requestedMinor: 185,
    succeededMinor: 185,
    requestedAt: paidInWindow,
    succeededAt: end,
    currency: "CNY",
  },
};

it("rejects standalone VERIFIED when a required settled refund has an unknown amount", () => {
  const data = {
    ...baseRefund.data,
    succeededMinor: null,
    source: { ...hasSource, quality: { state: "PARTIAL", issues: ["REFUND_UNKNOWN"] } },
  };
  const input = { ...cogsInput, refundFacts: [{ ...baseRefund, data }] };
  expect(api.MetricInputV1Schema.safeParse(input).success).toBe(true);
  const selection = { subject: sku, selectionReceiptIds: cogsEvidence, input };
  expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(false);
});

it("keeps allocation quantity as a full-graph source quality check", () => {
  const proof = completeCostProof(sku, [cohortOrder()], [{ subject: sku, rows: [costAtPayment] }]);
  const [costPage, , returnPage] = proof.capture.receipts;
  const [costSeal, , returnSeal] = proof.capture.publications;
  const [costCoverage, , returnCoverage] = proof.capture.coverage;
  const source = returnedFact(refund, "R2");
  const allocation = snapshot([source], 2, end);
  const capture = {
    ...proof.capture,
    facts: [...proof.capture.facts, source],
    receipts: [costPage, allocation.certifiedReceipt, returnPage],
    publications: [costSeal, allocation.certificate, returnSeal],
    coverage: [costCoverage, allocation.coverageRow, returnCoverage],
  };
  const input = {
    ...proof.selection.input,
    refundFacts: [baseRefund],
    refundAllocations: [{ ...projectionRow, evidenceIds: ["R2"], data: allocationData }],
  };
  const selection = { ...proof.selection, input };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...proof, selection, capture }).success,
  ).toBe(true);
  const unknown = {
    ...source,
    fact: withPayload(source.fact, { quantity: null, reason: "REFUND_UNKNOWN" }),
  };
  expect(api.ScopedMetricInputV1Schema.safeParse(selection).success).toBe(true);
  const unknownCapture = { ...capture, facts: [...proof.capture.facts, unknown] };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...proof, selection, capture: unknownCapture })
      .success,
  ).toBe(false);
});

it("keeps VERIFIED traffic independent of an unavailable cost in the capture", () => {
  const unavailable = withPayload(financeA.fact, {
    basis: "UNAVAILABLE",
    unitCostMinor: null,
    skuCostVersion: null,
    reason: "COST_MISSING",
  });
  const domains = ["TRAFFIC", "FROZEN_COST"];
  const capture = {
    ...skuCapture,
    domains,
    facts: [...skuCapture.facts, { ...financeA, fact: unavailable }],
    publications: [...skuCapture.publications, financeSnapshotA.certificate],
    receipts: [...skuCapture.receipts, financeSnapshotA.certifiedReceipt],
    coverage: [...skuCapture.coverage, financeSnapshotA.coverageRow],
  };
  const proof = api.ObservedSelectionProofV1Schema.parse({
    ...trafficProof,
    request: { ...trafficProof.request, domains },
    capture,
  });
  expect(proof.selection.input.status).toBe("VERIFIED");
  expect(proof.selection.input.frozenCosts).toBeNull();
});

const positionFact = returnedFact(position, "R1");
const noticeFact = returnedFact(
  { ...notice, sequence: 2, sourceVersion: "observed-v1:g:0:e:2" },
  "R2",
);
const positionSnapshot = snapshot([positionFact], 1, end);
const noticeSnapshot = snapshot([noticeFact], 2, end);
const extensionCapture = {
  ...zeroCapture,
  domains: ["INVENTORY_POSITION", "SUPPLIER_NOTICE"],
  facts: [positionFact, noticeFact],
  publications: [positionSnapshot.certificate, noticeSnapshot.certificate],
  receipts: [positionSnapshot.certifiedReceipt, noticeSnapshot.certifiedReceipt],
  coverage: [positionSnapshot.coverageRow, noticeSnapshot.coverageRow],
};
const extensionRow = {
  binding,
  observedAt: end,
  sourceVersion: positionFact.fact.sourceVersion,
  evidenceIds: ["R1", "R2"],
  data: {
    ...location,
    asOf: end,
    quarantine: 0,
    inbound: 8,
    leadTimeHours: 24,
    safetyBufferHours: 1.5,
    eta: later,
  },
};
const extensionsInput = {
  ...metricInput(sku, "LEAD_TIME_HOURS", ["inventoryExtensions"], ["R1", "R2"]),
  inventoryExtensions: [extensionRow],
};
const extensionProof = {
  request: {
    ...trafficSelectionRequest,
    kind: "LEAD_TIME_HOURS",
    domains: extensionCapture.domains,
  },
  capture: extensionCapture,
  selection: { subject: sku, input: extensionsInput, selectionReceiptIds: ["R1", "R2"] },
};

it("joins position provenance with a visible notice at the same SKU and location", () => {
  expect(api.ObservedSelectionProofV1Schema.safeParse(extensionProof).success).toBe(true);
  for (const change of [
    { data: { ...extensionRow.data, inbound: 9 } },
    { data: { ...extensionRow.data, eta: end } },
    { evidenceIds: ["R1"] },
    { sourceVersion: noticeFact.fact.sourceVersion },
  ]) {
    const input = { ...extensionsInput, inventoryExtensions: [{ ...extensionRow, ...change }] };
    expect(
      api.ObservedSelectionProofV1Schema.safeParse({
        ...extensionProof,
        selection: { ...extensionProof.selection, input },
      }).success,
    ).toBe(false);
  }
});

it("rejects a selection ID shared by an observed receipt and an unrelated base page", () => {
  const collision = { stream: "MARKETING", pageId: "rc1", pageHash };
  const capture = { ...skuCapture, base: { ...base, receipts: [...base.receipts, collision] } };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
  expect(api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, capture }).success).toBe(
    false,
  );
});

it.each([
  ["null verified source row", { traffic: [{ ...trafficMetricRow, data: null }] }],
  [
    "unknown verified traffic",
    { traffic: [{ ...trafficMetricRow, data: { ...trafficMetricRow.data, visitors: null } }] },
  ],
  [
    "partial verified traffic",
    {
      traffic: [
        { ...trafficMetricRow, data: { ...trafficMetricRow.data, coverageBasisPoints: 5000 } },
      ],
    },
  ],
])("rejects a standalone scoped input with %s", (_label, change) => {
  expect(api.ScopedMetricInputV1Schema.safeParse(withMetricInput(change)).success).toBe(false);
});

it("retains an earlier-window origin for an eligible history fact", () => {
  const fact = { ...a1.fact, occurredAt: start, payload: { ...a1.fact.payload, frozenAt: start } };
  const historyCertificate = { ...firstSnapshot.certificate, window: pastWindow };
  const historyReceipt = { ...firstSnapshot.certifiedReceipt, window: pastWindow };
  const currentCertificate = { ...correctedSnapshot.certificate, publicationSequence: 1 };
  const capture = {
    ...correctedCapture,
    facts: [{ ...a1, fact }, b2],
    publications: [historyCertificate, currentCertificate],
    receipts: [historyReceipt, correctedSnapshot.certifiedReceipt],
  };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
});

it("preserves measured zero counters with their exact STORE source evidence", () => {
  const zeros = { visitors: 0, cart: 0, checkout: 0, paidOrders: 0 };
  const stored = returnedFact(withPayload(pageFact, zeros), "rc1");
  const capture = {
    ...zeroCapture,
    facts: [stored],
    publications: [{ ...publication, recordCount: 1 }],
    receipts: [{ ...zeroReceipt, recordCount: 1, factRefs: [membership(stored)] }],
  };
  const input = {
    ...zeroTrafficProof.selection.input,
    traffic: [{ ...trafficMetricRow, data: { ...trafficMetricRow.data, ...zeros } }],
  };
  const selection = { ...zeroTrafficProof.selection, input };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...zeroTrafficProof, capture, selection })
      .success,
  ).toBe(true);
});

it.each([
  { reason: "PARTIAL_COVERAGE", coverageBasisPoints: 9000 },
  { reason: "ATTRIBUTION_MISSING", eligibleCount: null },
])("rejects STORE ROAS with faithfully projected but incomplete source quality %o", (change) => {
  const fact = withPayload(c2.fact, change);
  const capture = { ...storeRoaSCapture, facts: [c1, { ...c2, fact }] };
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
  const row = campaignRows[1];
  const measuredCoverage = {
    ...row.measuredCoverage,
    coverageBasisPoints: change.coverageBasisPoints ?? 10000,
  };
  const selection = {
    ...storeRoaSProof.selection,
    input: { ...roasInput, campaignFacts: [campaignRows[0], { ...row, measuredCoverage }] },
  };
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...storeRoaSProof, capture, selection }).success,
  ).toBe(false);
});

it("rejects overlapping exact-window traffic measurements without discarding one source", () => {
  const second = returnedFact(
    {
      ...skuTraffic.fact,
      factId: "overlap",
      sequence: 2,
      sourceVersion: "observed-v1:g:0:e:2",
    },
    "rc1",
  );
  const capture = {
    ...skuCapture,
    facts: [skuTraffic, second],
    publications: [{ ...skuCapture.publications[0], recordCount: 2 }],
    receipts: [
      {
        ...skuTrafficReceipt,
        recordCount: 2,
        factRefs: [membership(skuTraffic), membership(second)],
      },
    ],
  };
  const secondRow = { ...trafficMetricRow, sourceVersion: second.fact.sourceVersion };
  const selection = withMetricInput({ traffic: [trafficMetricRow, secondRow] });
  expect(api.ObservedCaptureV1Schema.safeParse(capture).success).toBe(true);
  expect(
    api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, capture, selection }).success,
  ).toBe(false);
  expect(api.ObservedSelectionProofV1Schema.safeParse({ ...trafficProof, capture }).success).toBe(
    false,
  );
});

const producerRun = { config: configEnvelope, window, through: end, cursor: null, limit: 200 };
const payment = {
  binding,
  generation: 0,
  eventId: "event-payment-1",
  observedAt: end,
  event: { kind: "PAYMENT", ...line, quantity: 1, paidAt: end },
};
const feeCharge = {
  kind: "FEE_CHARGE",
  chargeId: "charge-1",
  feeKind: "FULFILLMENT",
  externalOrderId: "o1",
  externalCampaignId: null,
  window,
  chargedAt: end,
};
const refundSettlement = {
  kind: "REFUND_SETTLEMENT",
  ...line,
  externalRefundId: "refund-1",
  quantity: 0,
  merchandiseMinor: 0,
  buyerShippingMinor: 0,
  settledAt: end,
  reason: null,
};
const returnAccepted = {
  kind: "RETURN_ACCEPTED",
  ...line,
  externalRefundId: "refund-1",
  externalReceiptId: "return-1",
  acceptedAt: end,
  resellableQuantity: 0,
};

it("exports a closed, readonly observed error from the package root", () => {
  const errorCodes = [
    "INVALID_INPUT",
    "OVERFLOW",
    "CONFLICT",
    "VERSION_MISMATCH",
    "NOT_FOUND",
    "FORBIDDEN",
    "SOURCE_UNAVAILABLE",
  ];
  for (const code of errorCodes) {
    const parsed = api.ObservedErrorSchema.safeParse({ code });
    expect(parsed).toMatchObject({ success: true, data: { code } });
    expect(Object.isFrozen(parsed.data)).toBe(true);
  }
  expect(api.ObservedErrorSchema.safeParse({ code: "SCOPE_MISMATCH" }).success).toBe(false);
});

it.each(["message", "query", "stack", "payload", "secret"])(
  "rejects %s on a typed observation failure",
  (field) => {
    expect(api.ObservedErrorSchema.safeParse({ code: "FORBIDDEN", [field]: "extra" }).success).toBe(
      false,
    );
  },
);

it("accepts a closed scoped producer run with a nullable opaque cursor", () => {
  const parsed = api.ObservedProducerRunV1Schema.safeParse(producerRun);
  expect(parsed).toMatchObject({ success: true, data: producerRun });
  expect(Object.isFrozen(parsed.data)).toBe(true);
  const continuation = { ...producerRun, cursor: "opaque:resume/1", limit: 1 };
  expect(api.ObservedProducerRunV1Schema.safeParse(continuation).success).toBe(true);
});

it.each([
  { through: start },
  { cursor: undefined },
  { cursor: "x".repeat(1025) },
  { limit: 0 },
  { limit: 201 },
  { config: { ...configEnvelope, generation: 2147483648 } },
  { failureRule: "refund-failure" },
  { grantId: "service-grant" },
])("rejects a producer run outside its closed bounds %o", (changes) => {
  expect(api.ObservedProducerRunV1Schema.safeParse({ ...producerRun, ...changes }).success).toBe(
    false,
  );
});

it.each([payment.event, feeCharge, refundSettlement, returnAccepted])(
  "decodes a readonly finance event from $kind",
  (event) => {
    const envelope = { ...payment, event };
    const parsed = api.ObservedFinanceEventV1Schema.safeParse(envelope);
    expect(parsed).toMatchObject({ success: true, data: envelope });
    expect(Object.isFrozen(parsed.data)).toBe(true);
    expect(Object.isFrozen(parsed.data?.event)).toBe(true);
  },
);

it.each([
  { ...payment.event, paidAt: later },
  { ...payment.event, quantity: 0 },
  { ...payment.event, currentPriceMinor: 100 },
  { ...payment.event, scenarioHint: "winner" },
  { ...feeCharge, chargedAt: later },
  { ...feeCharge, window: { ...window, periodEnd: later } },
  { ...feeCharge, feeKind: "UNKNOWN_CHARGE" },
  { ...feeCharge, externalOrderId: undefined },
  { ...refundSettlement, settledAt: later },
  { ...refundSettlement, merchandiseMinor: null },
  { ...refundSettlement, buyerShippingMinor: null },
  { ...refundSettlement, buyerShippingMinor: null, reason: undefined },
  { ...refundSettlement, reason: "REFUND_UNKNOWN" },
  { ...refundSettlement, quantity: null },
  { ...returnAccepted, acceptedAt: later },
  { ...returnAccepted, resellableQuantity: -1 },
  { ...returnAccepted, expectedStockout: true },
  { kind: "MARGIN_DROP" },
])("rejects invalid or embellished finance event payload %o", (event) => {
  expect(api.ObservedFinanceEventV1Schema.safeParse({ ...payment, event }).success).toBe(false);
});

it.each(["merchandiseMinor", "buyerShippingMinor"])(
  "accepts an explicitly unknown refund allocation for %s",
  (field) => {
    const event = { ...refundSettlement, [field]: null, reason: "REFUND_UNKNOWN" };
    expect(api.ObservedFinanceEventV1Schema.safeParse({ ...payment, event }).success).toBe(true);
  },
);

it.each([
  { generation: -1 },
  { generation: 2147483648 },
  { eventId: "event\u200b" },
  { failureRule: "always-fail" },
  { payload: {} },
])("rejects invalid finance event envelope fields %o", (changes) => {
  expect(api.ObservedFinanceEventV1Schema.safeParse({ ...payment, ...changes }).success).toBe(
    false,
  );
});

it("pins a synthetic PAYMENT to its run at both generation boundaries", () => {
  const limits = [0, 2147483647];
  for (const generation of limits) {
    const request = {
      run: { ...producerRun, config: { ...configEnvelope, generation } },
      event: { ...payment, generation },
    };
    const parsed = api.ObservedFinanceProducerRequestV1Schema.safeParse(request);
    expect(parsed).toMatchObject({ success: true, data: request });
    expect(Object.isFrozen(parsed.data)).toBe(true);
  }
});

it.each(Object.keys(binding))("pins the finance event's %s to the producer run", (field) => {
  const event = { ...payment, binding: { ...binding, [field]: "other" } };
  expect(api.ObservedFinanceEventV1Schema.safeParse(event).success).toBe(true);
  expect(
    api.ObservedFinanceProducerRequestV1Schema.safeParse({ run: producerRun, event }).success,
  ).toBe(false);
});

it.each([{ generation: 1 }, { observedAt: later }])(
  "rejects mismatched finance event generation or cutoff %o",
  (changes) => {
    const event = { ...payment, ...changes };
    expect(api.ObservedFinanceEventV1Schema.safeParse(event).success).toBe(true);
    expect(
      api.ObservedFinanceProducerRequestV1Schema.safeParse({ run: producerRun, event }).success,
    ).toBe(false);
  },
);

const supplyRecords = [listing, price, lot, notice, position];
const financeRecords = [cost, refund, receipt, fee];
const produced = { records: domains, nextCursor: "opaque:page/2" };
const demand = {
  records: [traffic, campaign],
  orders: [originalOrder],
  financeEvents: [payment],
  nextCursor: null,
};

it("exports produced pages without a receipt or completeness claim", () => {
  const parsed = api.ObservedProducedPageV1Schema.safeParse(produced);
  expect(parsed).toMatchObject({ success: true, data: produced });
  expect(Object.isFrozen(parsed.data?.records)).toBe(true);
  expect(Object.isFrozen(parsed.data?.records[0])).toBe(true);
  expect(
    api.ObservedProducedPageV1Schema.safeParse({ records: [], nextCursor: null }).success,
  ).toBe(true);
});

it.each([
  { records: Array.from({ length: 201 }, () => cost) },
  { nextCursor: undefined },
  { nextCursor: "" },
  { receiptId: "receipt-1" },
  { grantId: "grant-1" },
  { terminalCoverage: { coverageBasisPoints: 10000 } },
  { config: configEnvelope },
])("rejects unbounded or unauthorized produced page case %#", (changes) => {
  expect(api.ObservedProducedPageV1Schema.safeParse({ ...produced, ...changes }).success).toBe(
    false,
  );
});

it("decodes readonly demand facts, causal finance events and original orders", () => {
  const parsed = api.ObservedDemandPageV1Schema.safeParse(demand);
  expect(parsed).toMatchObject({ success: true, data: demand });
  expect(Object.isFrozen(parsed.data)).toBe(true);
  expect(Object.isFrozen(parsed.data?.records)).toBe(true);
  expect(Object.isFrozen(parsed.data?.records[0])).toBe(true);
  expect(Object.isFrozen(parsed.data?.financeEvents)).toBe(true);
  expect(Object.isFrozen(parsed.data?.orders)).toBe(true);
});

it.each([
  { records: [sync] },
  { records: [price] },
  { records: Array.from({ length: 201 }, () => traffic) },
  { financeEvents: Array.from({ length: 201 }, () => payment) },
  { financeEvents: [{ ...payment, scenarioHint: "winner" }] },
  { orders: Array.from({ length: 201 }, () => originalOrder) },
  { orders: [{ ...originalOrder, buyerEmail: "extra" }] },
  { failureRule: "ad-delivery" },
])("rejects disallowed demand output case %#", (changes) => {
  expect(api.ObservedDemandPageV1Schema.safeParse({ ...demand, ...changes }).success).toBe(false);
});

it("decodes only finance source records on a readonly finance page", () => {
  const page = { records: financeRecords, nextCursor: null };
  const parsed = api.ObservedFinancePageV1Schema.safeParse(page);
  expect(parsed).toMatchObject({ success: true, data: page });
  expect(Object.isFrozen(parsed.data?.records)).toBe(true);
  expect(Object.isFrozen(parsed.data?.records[0])).toBe(true);
  expect(api.ObservedFinancePageV1Schema.safeParse({ ...page, records: [listing] }).success).toBe(
    false,
  );
});

it("decodes only supply source records on a readonly supply page", () => {
  const page = { records: supplyRecords, nextCursor: null };
  const parsed = api.ObservedSupplyPageV1Schema.safeParse(page);
  expect(parsed).toMatchObject({ success: true, data: page });
  expect(Object.isFrozen(parsed.data?.records)).toBe(true);
  expect(Object.isFrozen(parsed.data?.records[0])).toBe(true);
  expect(api.ObservedSupplyPageV1Schema.safeParse({ ...page, records: [cost] }).success).toBe(
    false,
  );
});

it("exports readonly publisher and consumer contracts with distinct requests and results", () => {
  expectTypeOf<ObservedPublisherPort>().toEqualTypeOf<
    Readonly<{
      publishObserved: (
        request: ObservedPublicationRequestV1,
      ) => Promise<ObservedResult<ObservedPublicationV1>>;
      readPublishedPage: (
        request: ObservedPublicationReadV1,
      ) => Promise<ObservedResult<ObservedPublishedPageV1>>;
    }>
  >();
  expectTypeOf<ObservedConsumerPort>().toEqualTypeOf<
    Readonly<{
      appendObservedPage: (
        request: AppendObservedPageV1,
      ) => Promise<ObservedResult<ObservedReceiptV1>>;
    }>
  >();
  expectTypeOf<
    Parameters<ObservedConsumerPort["appendObservedPage"]>[0]
  >().toEqualTypeOf<AppendObservedPageV1>();
});

it("exports readonly reader and authorized selection contracts", () => {
  expectTypeOf<ObservedReaderPort>().toEqualTypeOf<
    Readonly<{
      captureObserved: (
        request: ObservedCaptureRequestV1,
      ) => Promise<ObservedResult<ObservedCaptureV1>>;
      readObserved: (request: ObservedReadRequestV1) => Promise<ObservedResult<ObservedCaptureV1>>;
    }>
  >();
  expectTypeOf<AuthorizedObservedSelectionPort>().toEqualTypeOf<
    Readonly<{
      selectObserved: (
        request: ObservedSelectionRequestV1,
      ) => Promise<ObservedResult<ScopedMetricInputV1>>;
    }>
  >();
  expectTypeOf<ReturnType<AuthorizedObservedSelectionPort["selectObserved"]>>().toEqualTypeOf<
    Promise<ObservedResult<ScopedMetricInputV1>>
  >();
});

it("exports readonly causal producer calls with their schema-derived pages", () => {
  expectTypeOf<ObservedFinanceProducerPort>().toEqualTypeOf<
    Readonly<{
      reduceFinance: (
        request: ObservedFinanceProducerRequestV1,
      ) => Promise<ObservedResult<ObservedFinancePageV1>>;
    }>
  >();
  expectTypeOf<ObservedSupplyProducerPort>().toEqualTypeOf<
    Readonly<{
      produceSupply: (
        request: ObservedProducerRunV1,
      ) => Promise<ObservedResult<ObservedSupplyPageV1>>;
    }>
  >();
  expectTypeOf<ObservedDemandProducerPort>().toEqualTypeOf<
    Readonly<{
      produceDemand: (
        request: ObservedProducerRunV1,
      ) => Promise<ObservedResult<ObservedDemandPageV1>>;
    }>
  >();
  expectTypeOf<ObservedCausalDependencies>().toEqualTypeOf<
    Readonly<{ supply: ObservedSupplyProducerPort; finance: ObservedFinanceProducerPort }>
  >();
});

it("keeps producer schema outputs and fact-page domains identical", () => {
  expectTypeOf<ReturnType<typeof api.ObservedFinancePageV1Schema.parse>>().toEqualTypeOf<
    FactPage<"FROZEN_COST" | "REFUND_ALLOCATION" | "RETURN_RECEIPT" | "FEE">
  >();
  expectTypeOf<ReturnType<typeof api.ObservedSupplyPageV1Schema.parse>>().toEqualTypeOf<
    FactPage<"LISTING" | "PRICE" | "INVENTORY_LOT" | "SUPPLIER_NOTICE" | "INVENTORY_POSITION">
  >();
  expectTypeOf<Pick<ObservedDemandPageV1, "records" | "nextCursor">>().toEqualTypeOf<
    FactPage<"TRAFFIC" | "CAMPAIGN_MEASUREMENT">
  >();
});

it("exports the exact closed error codes and readonly value-or-error result", () => {
  expectTypeOf<ObservedErrorCode>().toEqualTypeOf<
    | "INVALID_INPUT"
    | "OVERFLOW"
    | "CONFLICT"
    | "VERSION_MISMATCH"
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "SOURCE_UNAVAILABLE"
  >();
  expectTypeOf<ObservedError>().toEqualTypeOf<Readonly<{ code: ObservedErrorCode }>>();
  expectTypeOf<ObservedResult<string>>().toEqualTypeOf<
    Readonly<
      { ok: true; value: string } | { ok: false; error: Readonly<{ code: ObservedErrorCode }> }
    >
  >();
});
