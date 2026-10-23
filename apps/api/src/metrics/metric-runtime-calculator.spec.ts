import { expect, it } from "vitest";
import {
  MetricComputationV1Schema,
  type MetricCalculationRequest,
  type MetricInputV1,
  type MetricKind,
  type MetricResult,
} from "@shopmate/contracts";
import {
  financeBaseGolden,
  financeMissingCostGolden,
  financeCrossDaySettlementGolden,
  financeUnpaidCancelledGolden,
} from "../../test/fixtures/metrics/finance-golden.fixture.js";
import {
  createMetricRuntimeCalculator,
  METRIC_RUNTIME_DEFINITION_VERSION,
  METRIC_RUNTIME_DEFINITION_HASH,
  METRIC_RUNTIME_DEFINITION_MANIFEST,
} from "./metric-runtime-calculator.js";
import { createMetricEvidenceHasher } from "./metric-evidence-hash.js";
import { createMetricDefinitionRegistry } from "./metric-definition-registry.js";

const now = "2026-10-10T00:00:00Z";
const calculator = createMetricRuntimeCalculator({
  clock: { snapshot: () => ({ now, revision: 1 }) },
});
const hasher = createMetricEvidenceHasher(
  createMetricDefinitionRegistry([
    { definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION, calculator },
  ]),
);
function input(source: MetricInputV1 = financeBaseGolden.input): MetricInputV1 {
  return {
    ...source,
    definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
    metricCoverage: source.metricCoverage.map((row) => ({
      ...row,
      definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
    })),
  };
}
function request(kind: MetricKind, source = input()): MetricCalculationRequest {
  return { kind, input: source, subject: { kind: "STORE" }, computedAt: now };
}
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function inputHash({ input, kind, subject }: MetricCalculationRequest): string {
  return value(hasher.create({ input, kind, subject })).inputHash;
}
it.each(financeBaseGolden.expected.measures)(
  "dispatches the literal G4 $metric.kind oracle",
  (oracle) => {
    const result = value(calculator.calculate(request(oracle.metric.kind)));
    expect(result.snapshot.metric).toEqual(oracle.metric);
    expect(result.snapshot.status).toBe("VERIFIED");
    expect(MetricComputationV1Schema.safeParse(result).success).toBe(true);
    expect(Object.isFrozen(result.input.paymentFacts)).toBe(true);
    expect(Object.isFrozen(result.snapshot.issues)).toBe(true);
  },
);
it("keeps confirmed paid revenue independent of missing frozen costs", () => {
  const source = input(financeMissingCostGolden.input);
  expect(value(calculator.calculate(request("PAID_REVENUE", source))).snapshot).toMatchObject({
    metric: { value: 10500 },
    status: "VERIFIED",
  });
  const cost = value(calculator.calculate(request("GROSS_PROFIT", source))).snapshot;
  expect(cost.metric.value).toBeNull();
  expect(cost.status).toBe("UNAVAILABLE");
  expect(cost.coverageBasisPoints).toBe(3333);
  expect(cost.issues).toContainEqual(expect.objectContaining({ code: "COST_MISSING" }));
});
it("uses the settlement window for a next-day refund without moving its payment", () => {
  const source = input(financeCrossDaySettlementGolden.input);
  expect(value(calculator.calculate(request("PAID_REVENUE", source))).snapshot.metric.value).toBe(
    0,
  );
  expect(
    value(calculator.calculate(request("REFUND_SETTLED_AMOUNT", source))).snapshot.metric.value,
  ).toBe(2000);
  expect(
    value(calculator.calculate(request("NET_REVENUE_SETTLEMENT", source))).snapshot.metric.value,
  ).toBe(-2000);
});
it.each(["GMV", "PAID_REVENUE", "PAID_ORDERS", "PAID_UNITS"] as const)(
  "keeps unpaid cancelled %s zero",
  (kind) => {
    const result = value(
      calculator.calculate(request(kind, input(financeUnpaidCancelledGolden.input))),
    );
    expect(result.snapshot).toMatchObject({
      metric: { value: 0 },
      status: "VERIFIED",
      sampleSize: 0,
    });
  },
);
it("keeps the unsupported aligned baseline explicit", () => {
  const result = value(calculator.calculate(request("PROFIT_DELTA"))).snapshot;
  expect(result).toMatchObject({ metric: { value: null }, status: "UNAVAILABLE" });
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "NOT_SYNCHRONIZED", field: "baseline" }),
  );
});
it.each(["CONVERSION_RATE", "CART_RATE", "CHECKOUT_RATE", "ROAS"] as const)(
  "routes %s with absent extensions truthfully",
  (kind) => {
    const result = value(calculator.calculate(request(kind))).snapshot;
    expect(result.metric.value).toBeNull();
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.issues.length).toBeGreaterThan(0);
  },
);
it.each([
  "AOV",
  "REFUNDED_COHORT_ORDERS",
  "REFUND_COHORT_ORDER_RATE",
  "REFUND_COHORT_AMOUNT_RATE",
] as const)("deliberately routes %s", (kind) => {
  const result = value(calculator.calculate(request(kind))).snapshot;
  expect(result.metric.kind).toBe(kind);
  expect(MetricComputationV1Schema.safeParse({ input: input(), snapshot: result }).success).toBe(
    true,
  );
});
it.each(["INVENTORY_AVAILABLE", "INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"] as const)(
  "keeps absent SKU %s unavailable",
  (kind) => {
    const req = { ...request(kind), subject: { kind: "SKU", externalSkuId: "sku-a" } } as const;
    const result = value(calculator.calculate(req)).snapshot;
    expect(result).toMatchObject({ metric: { kind, value: null }, status: "UNAVAILABLE" });
  },
);
it("rejects a non-store payment subject and a non-SKU inventory subject", () => {
  expect(
    calculator.calculate({
      ...request("PAID_REVENUE"),
      subject: { kind: "SKU", externalSkuId: "sku-a" },
    }),
  ).toMatchObject({ ok: false, error: { code: "SCOPE_MISMATCH" } });
  expect(calculator.calculate(request("INVENTORY_AVAILABLE"))).toMatchObject({
    ok: false,
    error: { code: "SCOPE_MISMATCH" },
  });
});
it("rejects unknown versions and submillisecond computation times", () => {
  expect(calculator.calculate(request("PAID_REVENUE", financeBaseGolden.input))).toMatchObject({
    ok: false,
    error: { code: "VERSION_MISMATCH" },
  });
  expect(
    calculator.calculate({ ...request("PAID_REVENUE"), computedAt: "2026-10-10T00:00:00.0001Z" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("rejects unknown kinds and unsafe monetary input without throwing", () => {
  const unknown = {
    ...request("PAID_REVENUE"),
    kind: "UNKNOWN",
  } as unknown as MetricCalculationRequest;
  expect(calculator.calculate(unknown)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  const base = input(),
    payment = base.paymentFacts![0]!;
  const unsafe = {
    ...base,
    paymentFacts: [
      { ...payment, data: { ...payment.data, paidMinor: Number.MAX_SAFE_INTEGER + 1 } },
    ],
  };
  expect(calculator.calculate(request("PAID_REVENUE", unsafe))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
function inventoryWrapper(base: MetricInputV1) {
  return {
    binding: base.binding,
    observedAt: base.visibleAt,
    sourceVersion: "stock-v1",
    evidenceIds: ["stock"],
  };
}
function inventoryStocks(base: MetricInputV1) {
  return [
    {
      ...inventoryWrapper(base),
      data: {
        externalStoreId: base.binding.externalStoreId,
        externalSkuId: "sku-a",
        externalLocationId: "location-a",
        available: 12,
        onHand: 20,
        reserved: 2,
        safetyStock: 4,
        leadTimeDays: 7,
        source: {
          version: "stock-v1",
          updatedAt: base.visibleAt,
          quality: { state: "COMPLETE" as const, issues: [] },
        },
      },
    },
  ];
}
function inventoryExtras(base: MetricInputV1) {
  return [
    {
      ...inventoryWrapper(base),
      data: {
        externalSkuId: "sku-a",
        externalLocationId: "location-a",
        asOf: base.visibleAt,
        quarantine: 3,
        inbound: 100,
        leadTimeHours: 3,
        safetyBufferHours: 1,
        eta: null,
      },
    },
  ];
}
function inventorySource(): MetricInputV1 {
  const base = input(),
    proof = base.metricCoverage[0]!;
  const metricCoverage = [
    ...base.metricCoverage,
    ...(["INVENTORY_AVAILABLE", "INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"] as const).map(
      (kind) => ({
        ...proof,
        kind,
        subject: { kind: "SKU" as const, externalSkuId: "sku-a" },
        collections: ["inventoryFacts", "inventoryExtensions", "paymentFacts"] as const,
      }),
    ),
  ];
  return {
    ...base,
    inventoryFacts: inventoryStocks(base),
    inventoryExtensions: inventoryExtras(base),
    metricCoverage,
  };
}
function skuRequest(kind: MetricKind, source = inventorySource()): MetricCalculationRequest {
  return { ...request(kind, source), subject: { kind: "SKU", externalSkuId: "sku-a" } };
}
function onlyRequestedCoverage(source: MetricInputV1, kind: MetricKind): MetricInputV1 {
  return {
    ...source,
    metricCoverage: source.metricCoverage.filter((proof) => proof.kind === kind),
  };
}
it("uses only the requested SKU proof for inventory sales without changing input integrity", () => {
  const source = onlyRequestedCoverage(inventorySource(), "INVENTORY_HOURS_REMAINING");
  const req = skuRequest("INVENTORY_HOURS_REMAINING", source);
  const before = inputHash(req);
  const result = value(calculator.calculate(req));
  expect(result.snapshot).toMatchObject({
    metric: { value: 288 },
    status: "VERIFIED",
    coverageBasisPoints: 10000,
  });
  expect(result.input).toEqual(source);
  expect(result.input.metricCoverage).toHaveLength(1);
  expect(Object.isFrozen(result.input.metricCoverage)).toBe(true);
  expect(inputHash({ ...req, input: result.input })).toBe(before);
  expect(inputHash(req)).toBe(before);
});
it.each([
  ["CONTRIBUTION", 600],
  ["ESTIMATED_NET_PROFIT", 400],
] as const)("uses only the requested %s proof for frozen-cost dependencies", (kind, expected) => {
  const source = onlyRequestedCoverage(input(), kind),
    req = request(kind, source);
  const before = inputHash(req);
  const result = value(calculator.calculate(req));
  expect(result.snapshot).toMatchObject({
    metric: { value: expected },
    status: "VERIFIED",
    coverageBasisPoints: 10000,
  });
  expect(result.input).toEqual(source);
  expect(result.input.metricCoverage).toHaveLength(1);
  expect(Object.isFrozen(result.input.metricCoverage)).toBe(true);
  expect(inputHash({ ...req, input: result.input })).toBe(before);
  expect(inputHash(req)).toBe(before);
});
it("retains partial requested coverage through internal frozen-cost dependencies", () => {
  const base = onlyRequestedCoverage(input(), "CONTRIBUTION");
  const source = {
    ...base,
    metricCoverage: base.metricCoverage.map((proof) => ({ ...proof, coverageBasisPoints: 7000 })),
  };
  expect(value(calculator.calculate(request("CONTRIBUTION", source))).snapshot).toMatchObject({
    metric: { value: 600 },
    status: "ESTIMATED",
    coverageBasisPoints: 7000,
  });
});
it.each(["unrequested kind", "different SKU", "missing payment collection"] as const)(
  "does not project inventory completeness from %s",
  (scenario) => {
    const base = onlyRequestedCoverage(inventorySource(), "INVENTORY_HOURS_REMAINING");
    const proof = base.metricCoverage[0]!;
    const changed =
      scenario === "unrequested kind"
        ? { ...proof, kind: "INVENTORY_AVAILABLE" as const }
        : scenario === "different SKU"
          ? { ...proof, subject: { kind: "SKU" as const, externalSkuId: "sku-b" } }
          : { ...proof, collections: ["inventoryFacts", "inventoryExtensions"] as const };
    const source = { ...base, metricCoverage: [changed] };
    expect(
      value(calculator.calculate(skuRequest("INVENTORY_HOURS_REMAINING", source))).snapshot,
    ).toMatchObject({
      metric: { value: null },
      status: scenario === "missing payment collection" ? "INSUFFICIENT" : "UNAVAILABLE",
      coverageBasisPoints: 0,
    });
  },
);
it.each(["CONTRIBUTION", "ESTIMATED_NET_PROFIT"] as const)(
  "preserves missing-cost uncertainty with only requested %s coverage",
  (kind) => {
    const source = onlyRequestedCoverage(input(financeMissingCostGolden.input), kind);
    const result = value(calculator.calculate(request(kind, source))).snapshot;
    expect(result).toMatchObject({ metric: { value: null }, status: "UNAVAILABLE" });
    expect(result.coverageBasisPoints).toBeLessThan(10000);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "COST_MISSING" }));
  },
);
it("retains payment uncertainty despite complete requested SKU coverage", () => {
  const base = onlyRequestedCoverage(inventorySource(), "INVENTORY_HOURS_REMAINING");
  const payment = base.paymentFacts![0]!;
  const source = {
    ...base,
    paymentFacts: [
      {
        ...payment,
        data: {
          ...payment.data,
          paidMinor: null,
          source: {
            ...payment.data.source,
            quality: { state: "PARTIAL" as const, issues: ["PAYMENT_UNKNOWN" as const] },
          },
        },
      },
    ],
  };
  const result = value(
    calculator.calculate(skuRequest("INVENTORY_HOURS_REMAINING", source)),
  ).snapshot;
  expect(result).toMatchObject({
    metric: { value: null },
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
  });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "PAYMENT_UNKNOWN" }));
});
it.each([
  { inputRevision: "other-revision" },
  { definitionVersion: "other-version" },
  { visibleAt: now },
  { periodStart: "2026-10-01T15:00:00Z" },
  { sourceWatermark: "2026-10-02T15:59:00Z" },
])("rejects requested coverage with mismatched context %j before projection", (change) => {
  const base = onlyRequestedCoverage(input(), "CONTRIBUTION");
  const source = {
    ...base,
    metricCoverage: base.metricCoverage.map((proof) => ({ ...proof, ...change })),
  };
  expect(calculator.calculate(request("CONTRIBUTION", source))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("uses the exact SKU's one paid unit instead of three storewide units", () => {
  const before = inventorySource();
  const result = value(
    calculator.calculate(skuRequest("INVENTORY_HOURS_REMAINING", before)),
  ).snapshot;
  expect(result).toMatchObject({ metric: { value: 288 }, status: "VERIFIED" });
  expect(before.paymentFacts![0]!.data.items.map((item) => item.quantity)).toEqual([1, 2]);
});
it("does not infer unknown inventory extensions from legacy safety stock or lead time", () => {
  const source = withoutExtensions(inventorySource(), ["inventoryExtensions"]);
  expect(
    value(calculator.calculate(skuRequest("INVENTORY_AVAILABLE", source))).snapshot,
  ).toMatchObject({ metric: { value: 12 }, status: "VERIFIED" });
  for (const kind of ["INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"] as const) {
    expect(value(calculator.calculate(skuRequest(kind, source))).snapshot).toMatchObject({
      metric: { value: null },
      status: "UNAVAILABLE",
    });
  }
});
it("does not pick an arbitrary inventory location", () => {
  const source = inventorySource(),
    stock = source.inventoryFacts![0]!;
  const ambiguous = {
    ...source,
    inventoryFacts: [
      stock,
      {
        ...stock,
        data: { ...stock.data, externalLocationId: "location-b", available: 19, onHand: 30 },
      },
    ],
  };
  expect(
    value(calculator.calculate(skuRequest("INVENTORY_AVAILABLE", ambiguous))).snapshot,
  ).toMatchObject({ metric: { value: null }, status: "UNAVAILABLE" });
});
it("preserves zero denominators and immature cohorts through the quality reducer", () => {
  const source = { ...input(), paymentFacts: [] };
  expect(value(calculator.calculate(request("AOV", source))).snapshot).toMatchObject({
    metric: { value: null },
    status: "UNAVAILABLE",
  });
  const cohortInput = input(),
    proof = cohortInput.metricCoverage[0]!;
  const cohort = value(
    calculator.calculate(
      request("REFUND_COHORT_ORDER_RATE", {
        ...cohortInput,
        metricCoverage: [
          ...cohortInput.metricCoverage,
          { ...proof, kind: "REFUND_COHORT_ORDER_RATE" },
        ],
      }),
    ),
  ).snapshot;
  expect(cohort).toMatchObject({ metric: { value: null }, status: "INSUFFICIENT" });
  expect(cohort.issues).toContainEqual(expect.objectContaining({ code: "IMMATURE_COHORT" }));
});
it("refuses to infer a buyer shipping split from aggregate refund amounts", () => {
  const base = input(),
    allocation = base.refundAllocations![0]!;
  const source = {
    ...base,
    refundAllocations: [{ ...allocation, data: { ...allocation.data!, buyerShippingMinor: null } }],
  };
  const result = value(calculator.calculate(request("CONTRIBUTION", source))).snapshot;
  expect(result).toMatchObject({ metric: { value: null }, status: "UNAVAILABLE" });
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "REFUND_UNKNOWN", field: "buyerShipping.refundAllocations" }),
  );
});
it("keeps P2's absent financial extensions null while confirmed payment stays known", () => {
  const source = withoutExtensions(input(), [
    "frozenCosts",
    "refundAllocations",
    "returnReceipts",
    "fees",
  ]);
  expect(value(calculator.calculate(request("PAID_REVENUE", source))).snapshot).toMatchObject({
    metric: { value: 10500 },
    status: "VERIFIED",
  });
  for (const kind of ["COGS", "GROSS_PROFIT", "CONTRIBUTION", "ESTIMATED_NET_PROFIT"] as const) {
    expect(value(calculator.calculate(request(kind, source))).snapshot).toMatchObject({
      metric: { value: null },
      status: "UNAVAILABLE",
    });
  }
});
type Extension =
  | "frozenCosts"
  | "refundAllocations"
  | "returnReceipts"
  | "fees"
  | "inventoryExtensions";
function withoutExtensions(base: MetricInputV1, keys: readonly Extension[]): MetricInputV1 {
  return {
    ...base,
    ...Object.fromEntries(keys.map((key) => [key, null])),
    metricCoverage: base.metricCoverage
      .map((proof) => ({
        ...proof,
        collections: proof.collections.filter((key) => !keys.includes(key as Extension)),
      }))
      .filter((proof) => proof.collections.length > 0),
  };
}
function campaignSource(): MetricInputV1 {
  const base = input(),
    observedAt = base.visibleAt;
  const campaignFacts = [
    {
      binding: base.binding,
      observedAt,
      sourceVersion: "campaign-v1",
      evidenceIds: ["campaign"],
      measuredCoverage: null,
      data: {
        externalStoreId: base.binding.externalStoreId,
        externalCampaignId: "campaign-a",
        date: "2026-10-02",
        impressions: 2000,
        clicks: 200,
        attributedOrders: 50,
        spendMinor: 10000,
        attributedRevenueMinor: 30000,
        currency: "CNY" as const,
        source: {
          version: "campaign-v1",
          updatedAt: observedAt,
          quality: { state: "COMPLETE" as const, issues: [] },
        },
      },
    },
  ];
  const proof = {
    ...base.metricCoverage[0]!,
    kind: "ROAS" as const,
    subject: { kind: "CAMPAIGN" as const, externalCampaignId: "campaign-a" },
    collections: ["campaignFacts"] as const,
  };
  return { ...base, campaignFacts, metricCoverage: [...base.metricCoverage, proof] };
}
it("does not treat a campaign date as proof of its measured interval", () => {
  const req = {
    ...request("ROAS", campaignSource()),
    subject: { kind: "CAMPAIGN" as const, externalCampaignId: "campaign-a" },
  };
  const result = value(calculator.calculate(req)).snapshot;
  expect(result).toMatchObject({ metric: { value: null }, status: "UNAVAILABLE" });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "ATTRIBUTION_MISSING" }));
});
function measuredMarketingSource(): MetricInputV1 {
  const base = campaignSource(),
    campaign = base.campaignFacts![0]!;
  const window = {
    periodStart: base.periodStart,
    periodEnd: base.periodEnd,
    timezone: base.timezone,
    currency: base.currency,
  };
  const observation = {
    binding: base.binding,
    observedAt: base.visibleAt,
    evidenceIds: campaign.evidenceIds,
    sourceVersion: campaign.sourceVersion,
  };
  const measuredCoverage = { ...observation, ...window, coverageBasisPoints: 10000 };
  const trafficData = {
    ...window,
    visitors: 1000,
    cart: 300,
    checkout: 200,
    paidOrders: 100,
    coverageBasisPoints: 10000,
  };
  const traffic = [{ ...observation, data: trafficData }];
  const proof = base.metricCoverage[0]!;
  const metricCoverage = [
    ...base.metricCoverage,
    ...(["CONVERSION_RATE", "CART_RATE", "CHECKOUT_RATE"] as const).map((kind) => ({
      ...proof,
      kind,
      collections: ["traffic"] as const,
    })),
  ];
  return { ...base, metricCoverage, traffic, campaignFacts: [{ ...campaign, measuredCoverage }] };
}
it("dispatches measured funnel ratios and campaign-specific ROAS through real leaves", () => {
  const source = measuredMarketingSource();
  for (const [kind, expected] of [
    ["CONVERSION_RATE", 1000],
    ["CART_RATE", 3000],
    ["CHECKOUT_RATE", 2000],
  ] as const) {
    expect(value(calculator.calculate(request(kind, source))).snapshot).toMatchObject({
      metric: { value: expected },
      status: "VERIFIED",
    });
  }
  const req = {
    ...request("ROAS", source),
    subject: { kind: "CAMPAIGN" as const, externalCampaignId: "campaign-a" },
  };
  expect(value(calculator.calculate(req)).snapshot).toMatchObject({
    metric: { value: 30000 },
    status: "VERIFIED",
  });
});
it("keeps payment uncertainty stronger than a stale source", () => {
  const source = input(),
    payment = source.paymentFacts![0]!;
  const sourceWatermark = "2026-10-02T12:00:00Z";
  const uncertain = {
    ...source,
    sourceWatermark,
    paymentFacts: [
      {
        ...payment,
        data: {
          ...payment.data,
          paidMinor: null,
          source: {
            ...payment.data.source,
            quality: { state: "PARTIAL" as const, issues: ["PAYMENT_UNKNOWN" as const] },
          },
        },
      },
    ],
    metricCoverage: source.metricCoverage.map((proof) => ({ ...proof, sourceWatermark })),
  };
  const result = value(calculator.calculate(request("PAID_REVENUE", uncertain))).snapshot;
  expect(result).toMatchObject({
    metric: { value: null },
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
  });
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["PAYMENT_UNKNOWN", "STALE_SOURCE"]),
  );
});
it("returns a truthful unavailable result for an entirely absent source", () => {
  const source: MetricInputV1 = {
    ...input(),
    status: "UNAVAILABLE",
    sourceWatermark: null,
    paymentFacts: null,
    refundFacts: null,
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    metricCoverage: [],
  };
  expect(value(calculator.calculate(request("PAID_REVENUE", source))).snapshot).toMatchObject({
    metric: { value: null },
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
  });
});
it("returns typed overflow from actual exact payment accumulation", () => {
  const source = input(),
    payment = source.paymentFacts![0]!;
  const data = {
    ...payment.data,
    grossMinor: Number.MAX_SAFE_INTEGER,
    discountMinor: 0,
    shippingMinor: 0,
    payableMinor: Number.MAX_SAFE_INTEGER,
    paidMinor: Number.MAX_SAFE_INTEGER,
    items: [
      {
        ...payment.data.items[0]!,
        quantity: 1,
        unitPriceMinor: Number.MAX_SAFE_INTEGER,
        grossMinor: Number.MAX_SAFE_INTEGER,
        discountMinor: 0,
        netMinor: Number.MAX_SAFE_INTEGER,
      },
    ],
  };
  const paymentFacts = [payment, { ...payment, data: { ...data, externalOrderId: "large-order" } }];
  expect(calculator.calculate(request("PAID_REVENUE", { ...source, paymentFacts }))).toMatchObject({
    ok: false,
    error: { code: "OVERFLOW" },
  });
});
it("rejects fractional source timestamps and cross-store provenance", () => {
  const source = input(),
    payment = source.paymentFacts![0]!;
  const fractional = {
    ...source,
    paymentFacts: [{ ...payment, observedAt: "2026-10-02T00:00:00.0001Z" }],
  };
  expect(calculator.calculate(request("PAID_REVENUE", fractional))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  const crossed = {
    ...source,
    paymentFacts: [{ ...payment, binding: { ...payment.binding, storeId: "other" } }],
  };
  expect(calculator.calculate(request("PAID_REVENUE", crossed))).toMatchObject({ ok: false });
});
it("keeps G4 paid10500 when only opaque version and evidence strings look like timestamps", () => {
  const base = input(),
    opaque = "2026-10-01T00:00:00.0001Z";
  const paymentFacts = base.paymentFacts!.map((payment) => ({
    ...payment,
    sourceVersion: opaque,
    data: { ...payment.data, source: { ...payment.data.source, version: opaque } },
  }));
  const source = { ...base, paymentFacts, evidenceIds: [...base.evidenceIds, opaque] };
  expect(value(calculator.calculate(request("PAID_REVENUE", source))).snapshot.metric.value).toBe(
    10500,
  );
});
function fractionalTime(time: string): string {
  return `${time.replace(/Z$/u, "").split(".")[0]}.0001Z`;
}
it.each(["orderedAt", "paidAt"] as const)("rejects submillisecond business %s", (field) => {
  const base = input(),
    payment = base.paymentFacts![0]!;
  const source = {
    ...base,
    paymentFacts: [
      { ...payment, data: { ...payment.data, [field]: fractionalTime(payment.data[field]!) } },
    ],
  };
  expect(calculator.calculate(request("PAID_REVENUE", source))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it.each(["periodStart", "periodEnd", "visibleAt", "sourceWatermark"] as const)(
  "rejects submillisecond input %s",
  (field) => {
    const base = input();
    const source = { ...base, [field]: fractionalTime(base[field]!) };
    expect(calculator.calculate(request("PAID_REVENUE", source))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  },
);
it.each(["periodStart", "periodEnd", "visibleAt", "sourceWatermark", "observedAt"] as const)(
  "rejects submillisecond coverage %s",
  (field) => {
    const base = input();
    const metricCoverage = base.metricCoverage.map((proof) => ({
      ...proof,
      [field]: fractionalTime(proof[field]!),
    }));
    expect(
      calculator.calculate(request("PAID_REVENUE", { ...base, metricCoverage })),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  },
);
it("rejects submillisecond business clock timestamps", () => {
  const clock = createMetricRuntimeCalculator({
    clock: { snapshot: () => ({ now: fractionalTime(now), revision: 1 }) },
  });
  expect(clock.calculate(request("PAID_REVENUE"))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("exports an immutable versioned semantic definition for explicit provisioning", () => {
  expect(METRIC_RUNTIME_DEFINITION_VERSION).toBe("metrics-g4-v1");
  expect(METRIC_RUNTIME_DEFINITION_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(METRIC_RUNTIME_DEFINITION_MANIFEST.qualityPolicy.rules)).toBe(true);
  expect(METRIC_RUNTIME_DEFINITION_MANIFEST.baseline).toContain("UNAVAILABLE");
});
it("retains the oldest relevant proof's freshness instead of replacing it with a newer proof", () => {
  const base = input(),
    visibleAt = "2026-10-05T16:00:00Z";
  const proofs = base.metricCoverage.map((proof) => ({
    ...proof,
    visibleAt,
    sourceWatermark: visibleAt,
  }));
  const source = {
    ...base,
    visibleAt,
    sourceWatermark: visibleAt,
    metricCoverage: [
      ...proofs,
      { ...proofs.find((proof) => proof.kind === "PAID_REVENUE")!, observedAt: visibleAt },
    ],
  };
  expect(value(calculator.calculate(request("PAID_REVENUE", source))).snapshot).toMatchObject({
    metric: { value: 10500 },
    status: "STALE",
  });
});
it("accepts a later audit computation time while fencing source visibility by business time", () => {
  const businessNow = input().visibleAt;
  const historical = createMetricRuntimeCalculator({
    clock: { snapshot: () => ({ now: businessNow, revision: 1 }) },
  });
  const result = value(historical.calculate(request("PAID_REVENUE"))).snapshot;
  expect(result.computedAt).toBe(now);
  expect(result.metric.value).toBe(10500);
  const beforeSource = createMetricRuntimeCalculator({
    clock: { snapshot: () => ({ now: input().periodStart, revision: 1 }) },
  });
  expect(beforeSource.calculate(request("PAID_REVENUE"))).toMatchObject({
    ok: false,
    error: { code: "WINDOW_MISMATCH" },
  });
});
