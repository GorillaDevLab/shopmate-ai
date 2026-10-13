import {
  MetricValueSchema,
  type MetricInputV1,
  type MetricMeasure,
  type MetricKind,
  type MetricFeeKind,
  type CohortMaturity,
  type CostReversalEvidence,
  type MetricWindow,
  type MetricStatus,
  type DataQualityIssueV1,
  type ConnectorOrder,
  type ConnectorRefund,
} from "@shopmate/contracts";

/** Test-only v1 contract: independent synthetic source facts and literal oracle values. */
export interface FinanceGoldenFixtureV1 {
  readonly schemaVersion: 1;
  readonly fixtureVersion: "finance-golden-v1";
  readonly caseId: string;
  readonly input: MetricInputV1;
  readonly context: Readonly<{
    paymentCohort: MetricWindow;
    settlementWindow: MetricWindow;
    cohort: CohortMaturity | null;
    costPolicyVersion: "accepted-resellable-frozen-v1";
    rounding: "HALF_AWAY_FROM_ZERO";
  }>;
  readonly expected: Readonly<{
    measures: readonly MetricMeasure<MetricKind>[];
    reversals: readonly CostReversalEvidence[];
    excludedFeeKinds: readonly MetricFeeKind[];
    feeCoverage: readonly Readonly<{ kind: MetricFeeKind; coverageBasisPoints: number }>[];
    refundRateDenominators: Readonly<{ paidOrders: number; paidMinor: number }> | null;
  }>;
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const binding = freeze({
  organizationId: "golden-org",
  workspaceId: "golden-workspace",
  storeId: "golden-store",
  connectionId: "golden-connection",
  externalStoreId: "golden-external-store",
});
export const financeGoldenWindows = freeze({
  day1: {
    periodStart: "2026-10-01T16:00:00Z",
    periodEnd: "2026-10-02T16:00:00Z",
    timezone: "Asia/Shanghai",
    currency: "CNY",
  },
  day2: {
    periodStart: "2026-10-02T16:00:00Z",
    periodEnd: "2026-10-03T16:00:00Z",
    timezone: "Asia/Shanghai",
    currency: "CNY",
  },
  partial: {
    periodStart: "2026-10-01T16:00:00Z",
    periodEnd: "2026-10-02T06:00:00Z",
    timezone: "Asia/Shanghai",
    currency: "CNY",
  },
} as const);
const { day1, day2, partial } = financeGoldenWindows;
const matureCutoff = "2026-10-04T16:00:00Z";
const sourceVersion = "synthetic-source-v1";
function source(updatedAt: string) {
  return { version: sourceVersion, updatedAt, quality: { state: "COMPLETE", issues: [] } } as const;
}
function fact<T>(evidenceId: string, observedAt: string, data: T) {
  return { binding, observedAt, sourceVersion, evidenceIds: [evidenceId], data } as const;
}
const order: ConnectorOrder = {
  externalStoreId: binding.externalStoreId,
  externalOrderId: "order-a",
  source: source("2026-10-02T00:00:00Z"),
  status: "PAID",
  orderedAt: day1.periodStart,
  paidAt: "2026-10-02T00:00:00Z",
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
      quantity: 1,
      unitPriceMinor: 4000,
      grossMinor: 4000,
      discountMinor: 2000,
      netMinor: 2000,
    },
    {
      externalLineId: "line-b",
      externalProductId: "product-b",
      externalSkuId: "sku-b",
      quantity: 2,
      unitPriceMinor: 4000,
      grossMinor: 8000,
      discountMinor: 0,
      netMinor: 8000,
    },
  ],
};
const payment = fact("payment-a", "2026-10-02T00:00:00Z", order);
const refund: ConnectorRefund = {
  externalStoreId: binding.externalStoreId,
  externalRefundId: "refund-a",
  externalOrderId: "order-a",
  externalSkuId: "sku-a",
  source: source("2026-10-02T08:00:00Z"),
  status: "SUCCEEDED",
  requestedMinor: 2000,
  succeededMinor: 2000,
  requestedAt: "2026-10-02T07:00:00Z",
  succeededAt: "2026-10-02T08:00:00Z",
  currency: "CNY",
};
const refundFact = fact("refund-a", "2026-10-02T08:00:00Z", refund);
const allocation = fact("refund-allocation-a", day1.periodEnd, {
  externalRefundId: "refund-a",
  externalOrderId: "order-a",
  externalLineId: "line-a",
  externalSkuId: "sku-a",
  merchandiseMinor: 2000,
  buyerShippingMinor: 0,
  currency: "CNY" as const,
});
const frozenA = fact("cost-a", payment.observedAt, {
  externalOrderId: "order-a",
  externalLineId: "line-a",
  externalSkuId: "sku-a",
  quantity: 1,
  frozenAt: payment.observedAt,
  skuCostVersion: "sku-a-cost-2026-09-v1",
  unitCostMinor: 1000,
  basis: "CONFIRMED" as const,
  currency: "CNY" as const,
});
const frozenB = fact("cost-b", payment.observedAt, {
  externalOrderId: "order-a",
  externalLineId: "line-b",
  externalSkuId: "sku-b",
  quantity: 2,
  frozenAt: payment.observedAt,
  skuCostVersion: "sku-b-cost-2026-09-v1",
  unitCostMinor: 2500,
  basis: "CONFIRMED" as const,
  currency: "CNY" as const,
});
function fee(kind: MetricFeeKind, amountMinor: number | null, coverageBasisPoints = 10000) {
  return fact(`fee-${kind}`, day1.periodEnd, {
    ...day1,
    kind,
    externalOrderId: null,
    amountMinor,
    coverageBasisPoints,
    basis: amountMinor === null ? ("UNAVAILABLE" as const) : ("CONFIRMED" as const),
  });
}
const fees = [
  fee("FULFILLMENT", 700),
  fee("PLATFORM", 300),
  fee("PAYMENT", 100),
  fee("ADVERTISING_PROMOTION", 800),
  fee("OTHER_OPERATING", 200),
] as const;
const completeFeeCoverage = [
  { kind: "FULFILLMENT", coverageBasisPoints: 10000 },
  { kind: "PLATFORM", coverageBasisPoints: 10000 },
  { kind: "PAYMENT", coverageBasisPoints: 10000 },
  { kind: "ADVERTISING_PROMOTION", coverageBasisPoints: 10000 },
  { kind: "OTHER_OPERATING", coverageBasisPoints: 10000 },
] as const;
const financialKinds = [
  "GMV",
  "PAID_REVENUE",
  "PAID_ORDERS",
  "PAID_UNITS",
  "REFUND_SETTLED_AMOUNT",
  "NET_REVENUE_SETTLEMENT",
  "NET_MERCHANDISE_REVENUE",
  "COGS",
  "GROSS_PROFIT",
  "CONTRIBUTION",
  "ESTIMATED_NET_PROFIT",
] as const;
const refundKinds = [
  "REFUND_SETTLED_AMOUNT",
  "NET_REVENUE_SETTLEMENT",
  "REFUNDED_COHORT_ORDERS",
  "REFUND_COHORT_ORDER_RATE",
  "REFUND_COHORT_AMOUNT_RATE",
] as const;
type Collections = Pick<
  MetricInputV1,
  "paymentFacts" | "refundFacts" | "frozenCosts" | "refundAllocations" | "returnReceipts" | "fees"
>;
const baseCollections: Collections = {
  paymentFacts: [payment],
  refundFacts: [refundFact],
  frozenCosts: [frozenA, frozenB],
  refundAllocations: [allocation],
  returnReceipts: [],
  fees,
};
const refundCollections: Collections = {
  paymentFacts: [payment],
  refundFacts: [],
  frozenCosts: null,
  refundAllocations: null,
  returnReceipts: null,
  fees: null,
};
const financialCollections = [
  "paymentFacts",
  "refundFacts",
  "frozenCosts",
  "refundAllocations",
  "returnReceipts",
  "fees",
] as const;
function input(
  revision: string,
  window: MetricWindow,
  collections: Collections,
  kinds: readonly MetricKind[],
  visibleAt = window.periodEnd,
  status: MetricStatus = "VERIFIED",
): MetricInputV1 {
  const context = {
    schemaVersion: 1 as const,
    definitionVersion: "g4-golden-v1",
    inputRevision: revision,
    binding,
    ...window,
    visibleAt,
    sourceWatermark: visibleAt,
    evidenceIds: ["golden-sync"],
  };
  const available = financialCollections.filter((key) => collections[key] !== null);
  return {
    ...context,
    status,
    ...collections,
    inventoryFacts: null,
    campaignFacts: null,
    traffic: null,
    inventoryExtensions: null,
    metricCoverage: kinds.map((kind) => ({
      ...context,
      kind,
      subject: { kind: "STORE" },
      observedAt: visibleAt,
      sourceVersion,
      collections: available,
      coverageBasisPoints: 10000,
    })),
  };
}
function issue(
  code: DataQualityIssueV1["code"],
  field: string,
  evidenceId: string,
): DataQualityIssueV1 {
  return { code, field, evidenceIds: [evidenceId] };
}
function m(
  kind: MetricKind,
  value: number | null,
  unit: "minorCNY" | "units" | "basisPoints" = "minorCNY",
  status: MetricStatus = "VERIFIED",
  coverageBasisPoints = 10000,
  sampleSize = 1,
  issues: readonly DataQualityIssueV1[] = [],
): MetricMeasure<MetricKind> {
  return {
    metric: MetricValueSchema.parse({ kind, unit, value }),
    quality: {
      status,
      coverageBasisPoints,
      sampleSize,
      evidenceIds: [...new Set(["golden-sync", ...issues.flatMap((item) => item.evidenceIds)])],
      issues,
    },
  };
}
function expected(
  measures: readonly MetricMeasure<MetricKind>[],
  extra: Partial<Omit<FinanceGoldenFixtureV1["expected"], "measures">> = {},
): FinanceGoldenFixtureV1["expected"] {
  return {
    measures,
    reversals: [],
    excludedFeeKinds: [],
    feeCoverage: [],
    refundRateDenominators: null,
    ...extra,
  };
}
function fixture(
  caseId: string,
  data: MetricInputV1,
  oracle: FinanceGoldenFixtureV1["expected"],
  context: Partial<FinanceGoldenFixtureV1["context"]> = {},
): FinanceGoldenFixtureV1 {
  return freeze({
    schemaVersion: 1,
    fixtureVersion: "finance-golden-v1",
    caseId,
    input: data,
    expected: oracle,
    context: {
      paymentCohort: day1,
      settlementWindow: {
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        timezone: data.timezone,
        currency: data.currency,
      },
      cohort: null,
      costPolicyVersion: "accepted-resellable-frozen-v1",
      rounding: "HALF_AWAY_FROM_ZERO",
      ...context,
    },
  });
}
const baseMeasures = [
  m("GMV", 12000),
  m("PAID_REVENUE", 10500),
  m("PAID_ORDERS", 1, "units"),
  m("PAID_UNITS", 3, "units"),
  m("REFUND_SETTLED_AMOUNT", 2000),
  m("NET_REVENUE_SETTLEMENT", 8500),
  m("NET_MERCHANDISE_REVENUE", 8000),
  m("COGS", 6000),
  m("GROSS_PROFIT", 2000),
  m("CONTRIBUTION", 600),
  m("ESTIMATED_NET_PROFIT", 400),
];
export const financeBaseGolden = fixture(
  "g4-base",
  input("g4-base-v1", day1, baseCollections, financialKinds),
  expected(baseMeasures, { feeCoverage: completeFeeCoverage }),
);
const missingCost = fact("cost-b", payment.observedAt, {
  ...frozenB.data,
  unitCostMinor: null,
  skuCostVersion: null,
  basis: "UNAVAILABLE" as const,
});
const costMissingIssue = [issue("COST_MISSING", "frozenCosts.line-b", "cost-b")];
export const financeMissingCostGolden = fixture(
  "missing-cogs",
  input(
    "missing-cogs-v1",
    day1,
    { ...baseCollections, frozenCosts: [frozenA, missingCost] },
    financialKinds,
    day1.periodEnd,
    "ESTIMATED",
  ),
  expected(
    [
      m("PAID_REVENUE", 10500),
      m("NET_REVENUE_SETTLEMENT", 8500),
      m("NET_MERCHANDISE_REVENUE", 8000),
      m("COGS", null, "minorCNY", "ESTIMATED", 3333, 1, costMissingIssue),
      m("GROSS_PROFIT", null, "minorCNY", "ESTIMATED", 3333, 1, costMissingIssue),
      m("CONTRIBUTION", null, "minorCNY", "ESTIMATED", 3333, 1, costMissingIssue),
      m("ESTIMATED_NET_PROFIT", null, "minorCNY", "ESTIMATED", 3333, 1, costMissingIssue),
    ],
    { feeCoverage: completeFeeCoverage },
  ),
);
export const financeUnconfiguredFeeGolden = fixture(
  "unconfigured-other-fee",
  input(
    "unconfigured-other-fee-v1",
    day1,
    {
      ...baseCollections,
      fees: [fees[0], fees[1], fees[2], fees[3], fee("OTHER_OPERATING", null, 0)],
    },
    financialKinds,
    day1.periodEnd,
    "ESTIMATED",
  ),
  expected(
    [
      m("PAID_REVENUE", 10500),
      m("GROSS_PROFIT", 2000),
      m("CONTRIBUTION", 600),
      m("ESTIMATED_NET_PROFIT", 600, "minorCNY", "ESTIMATED", 8000, 1, [
        issue("FEE_MISSING", "fees.OTHER_OPERATING", "fee-OTHER_OPERATING"),
      ]),
    ],
    {
      excludedFeeKinds: ["OTHER_OPERATING"],
      feeCoverage: [
        completeFeeCoverage[0],
        completeFeeCoverage[1],
        completeFeeCoverage[2],
        completeFeeCoverage[3],
        { kind: "OTHER_OPERATING", coverageBasisPoints: 0 },
      ],
    },
  ),
);
export const financeRefundOnlyGolden = fixture(
  "refund-only",
  input("refund-only-v1", day1, baseCollections, financialKinds),
  expected([m("COGS", 6000), m("GROSS_PROFIT", 2000)], { feeCoverage: completeFeeCoverage }),
);
const receipt = fact("receipt-a", "2026-10-02T10:00:00Z", {
  externalReceiptId: "receipt-a",
  externalRefundId: "refund-a",
  externalOrderId: "order-a",
  externalLineId: "line-a",
  externalSkuId: "sku-a",
  acceptedAt: "2026-10-02T10:00:00Z",
  resellableQuantity: 1,
});
export const financeAcceptedReturnGolden = fixture(
  "accepted-return",
  input(
    "accepted-return-v1",
    day1,
    { ...baseCollections, returnReceipts: [receipt] },
    financialKinds,
  ),
  expected(
    [
      m("NET_MERCHANDISE_REVENUE", 8000),
      m("COGS", 5000),
      m("GROSS_PROFIT", 3000),
      m("CONTRIBUTION", 1600),
      m("ESTIMATED_NET_PROFIT", 1400),
    ],
    {
      feeCoverage: completeFeeCoverage,
      reversals: [
        {
          externalOrderId: "order-a",
          externalLineId: "line-a",
          externalReceiptId: "receipt-a",
          skuCostVersion: "sku-a-cost-2026-09-v1",
          reversedQuantity: 1,
          reversedMinor: 1000,
          evidenceIds: ["cost-a", "receipt-a"],
        },
      ],
    },
  ),
);
export const financeCrossDayPaymentGolden = fixture(
  "cross-day-payment",
  input("cross-day-payment-v1", day1, refundCollections, [
    "PAID_REVENUE",
    "NET_REVENUE_SETTLEMENT",
    "REFUND_SETTLED_AMOUNT",
  ]),
  expected([
    m("PAID_REVENUE", 10500),
    m("REFUND_SETTLED_AMOUNT", 0),
    m("NET_REVENUE_SETTLEMENT", 10500),
  ]),
);
const nextDayRefund = fact("refund-next-day", "2026-10-03T00:00:00Z", {
  ...refund,
  externalRefundId: "refund-next-day",
  requestedAt: "2026-10-02T23:00:00Z",
  succeededAt: "2026-10-03T00:00:00Z",
  source: source("2026-10-03T00:00:00Z"),
});
const matureOne: CohortMaturity = {
  paymentWindow: day1,
  observedThrough: matureCutoff,
  requiredAgeHours: 24,
  elapsedAgeHours: 48,
  mature: true,
  sampleSize: 1,
};
export const financeCrossDaySettlementGolden = fixture(
  "cross-day-settlement",
  input(
    "cross-day-settlement-v1",
    day2,
    { ...refundCollections, refundFacts: [nextDayRefund] },
    ["PAID_REVENUE", ...refundKinds],
    matureCutoff,
  ),
  expected(
    [
      m("PAID_REVENUE", 0, "minorCNY", "VERIFIED", 10000, 0),
      m("REFUND_SETTLED_AMOUNT", 2000),
      m("NET_REVENUE_SETTLEMENT", -2000),
      m("REFUNDED_COHORT_ORDERS", 1, "units"),
      m("REFUND_COHORT_ORDER_RATE", 10000, "basisPoints"),
      m("REFUND_COHORT_AMOUNT_RATE", 1905, "basisPoints"),
    ],
    { refundRateDenominators: { paidOrders: 1, paidMinor: 10500 } },
  ),
  { cohort: matureOne },
);
const cancelled = fact("cancelled-unpaid", payment.observedAt, {
  ...order,
  externalOrderId: "cancelled-unpaid",
  status: "CANCELLED" as const,
  paidAt: null,
  paidMinor: 0,
});
export const financeUnpaidCancelledGolden = fixture(
  "unpaid-cancelled",
  input("unpaid-cancelled-v1", day1, { ...refundCollections, paymentFacts: [cancelled] }, [
    "GMV",
    "PAID_REVENUE",
    "PAID_ORDERS",
    "PAID_UNITS",
  ]),
  expected([
    m("GMV", 0, "minorCNY", "VERIFIED", 10000, 0),
    m("PAID_REVENUE", 0, "minorCNY", "VERIFIED", 10000, 0),
    m("PAID_ORDERS", 0, "units", "VERIFIED", 10000, 0),
    m("PAID_UNITS", 0, "units", "VERIFIED", 10000, 0),
  ]),
);
function partialRefund(id: string, orderId: string, amount: number) {
  return fact(id, nextDayRefund.observedAt, {
    ...nextDayRefund.data,
    externalRefundId: id,
    externalOrderId: orderId,
    externalSkuId: null,
    requestedMinor: amount,
    succeededMinor: amount,
  });
}
export const financeDistinctRefundRatesGolden = fixture(
  "distinct-refund-rates",
  input(
    "distinct-refund-rates-v1",
    day2,
    {
      ...refundCollections,
      paymentFacts: [
        payment,
        fact("payment-b", payment.observedAt, { ...order, externalOrderId: "order-b" }),
        fact("payment-c", payment.observedAt, { ...order, externalOrderId: "order-c" }),
      ],
      refundFacts: [
        partialRefund("partial-a1", "order-a", 500),
        partialRefund("partial-a2", "order-a", 1000),
        partialRefund("partial-b1", "order-b", 2000),
      ],
    },
    refundKinds,
    matureCutoff,
  ),
  expected(
    [
      m("REFUND_SETTLED_AMOUNT", 3500, "minorCNY", "VERIFIED", 10000, 3),
      m("NET_REVENUE_SETTLEMENT", -3500, "minorCNY", "VERIFIED", 10000, 3),
      m("REFUNDED_COHORT_ORDERS", 2, "units", "VERIFIED", 10000, 3),
      m("REFUND_COHORT_ORDER_RATE", 6667, "basisPoints", "VERIFIED", 10000, 3),
      m("REFUND_COHORT_AMOUNT_RATE", 1111, "basisPoints", "VERIFIED", 10000, 3),
    ],
    { refundRateDenominators: { paidOrders: 3, paidMinor: 31500 } },
  ),
  { cohort: { ...matureOne, sampleSize: 3 } },
);
const boundaryPayments = [
  fact("payment-at-start", day1.periodStart, {
    ...order,
    externalOrderId: "at-start",
    paidAt: day1.periodStart,
    source: source(day1.periodStart),
  }),
  fact("payment-at-end", partial.periodEnd, {
    ...order,
    externalOrderId: "at-end",
    paidAt: partial.periodEnd,
    source: source(partial.periodEnd),
  }),
];
export const financePartialWindowGolden = fixture(
  "shanghai-partial-window",
  input(
    "shanghai-partial-window-v1",
    partial,
    { ...refundCollections, paymentFacts: boundaryPayments },
    ["PAID_REVENUE", "REFUND_COHORT_ORDER_RATE"],
  ),
  expected(
    [
      m("PAID_REVENUE", 10500),
      m("REFUND_COHORT_ORDER_RATE", null, "basisPoints", "INSUFFICIENT", 10000, 1, [
        issue("IMMATURE_COHORT", "paymentCohort", "golden-sync"),
      ]),
    ],
    { refundRateDenominators: { paidOrders: 1, paidMinor: 10500 } },
  ),
  {
    paymentCohort: partial,
    cohort: {
      paymentWindow: partial,
      observedThrough: partial.periodEnd,
      requiredAgeHours: 24,
      elapsedAgeHours: 0,
      mature: false,
      sampleSize: 1,
    },
  },
);
export const financeZeroDenominatorGolden = fixture(
  "zero-denominator",
  input(
    "zero-denominator-v1",
    day2,
    { ...refundCollections, paymentFacts: [] },
    refundKinds,
    matureCutoff,
  ),
  expected(
    [
      m("REFUND_COHORT_ORDER_RATE", null, "basisPoints", "INSUFFICIENT", 10000, 0, [
        issue("ZERO_DENOMINATOR", "paidOrders", "golden-sync"),
      ]),
      m("REFUND_COHORT_AMOUNT_RATE", null, "basisPoints", "INSUFFICIENT", 10000, 0, [
        issue("ZERO_DENOMINATOR", "paidRevenue", "golden-sync"),
      ]),
    ],
    { refundRateDenominators: { paidOrders: 0, paidMinor: 0 } },
  ),
  { cohort: { ...matureOne, sampleSize: 0 } },
);

export const financeGoldenFixtures: readonly FinanceGoldenFixtureV1[] = freeze([
  financeBaseGolden,
  financeMissingCostGolden,
  financeUnconfiguredFeeGolden,
  financeRefundOnlyGolden,
  financeAcceptedReturnGolden,
  financeCrossDayPaymentGolden,
  financeCrossDaySettlementGolden,
  financeUnpaidCancelledGolden,
  financeDistinctRefundRatesGolden,
  financePartialWindowGolden,
  financeZeroDenominatorGolden,
]);
