import { expect, it, vi } from "vitest";
import {
  DataQualityIssueV1Schema,
  MetricComputationV1Schema,
  MetricValueSchema,
} from "@shopmate/contracts";
import type {
  MetricResult,
  RefundMetrics,
  MetricInputV1,
  ConnectorOrder,
  ConnectorRefund,
  ExactMinorMath,
  MetricWindowResolver,
  MetricWindow,
  RefundMetricRequest,
  MinorRounding,
} from "@shopmate/contracts";
import {
  financeCrossDayPaymentGolden,
  financeCrossDaySettlementGolden,
  financeDistinctRefundRatesGolden,
} from "../../test/fixtures/metrics/finance-golden.fixture.js";
import { exactMinorMath } from "./exact-math.js";
import { createMetricWindowResolver } from "./metric-window.js";
import { createRefundMetricCalculator } from "./refund-metrics.js";

const windows = createMetricWindowResolver({
  snapshot: () => ({ now: "2026-10-10T00:00:00Z", revision: 1 }),
});
const calculator = createRefundMetricCalculator({
  math: exactMinorMath,
  windows,
  rounding: "HALF_AWAY_FROM_ZERO",
});
const base = financeCrossDaySettlementGolden.input;
const originalPayment = base.paymentFacts![0]!;
const originalRefund = base.refundFacts![0]!;
const kinds = [
  "REFUND_SETTLED_AMOUNT",
  "NET_REVENUE_SETTLEMENT",
  "REFUNDED_COHORT_ORDERS",
  "REFUND_COHORT_ORDER_RATE",
  "REFUND_COHORT_AMOUNT_RATE",
] as const;
function context(data: MetricInputV1) {
  const {
    schemaVersion,
    definitionVersion,
    inputRevision,
    binding,
    periodStart,
    periodEnd,
    timezone,
    currency,
    visibleAt,
    sourceWatermark,
    evidenceIds,
  } = data;
  return {
    schemaVersion,
    definitionVersion,
    inputRevision,
    binding,
    periodStart,
    periodEnd,
    timezone,
    currency,
    visibleAt,
    sourceWatermark,
    evidenceIds,
  };
}
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  const data = { ...base, ...patch };
  return {
    ...data,
    metricCoverage: kinds.map((kind) => ({
      ...context(data),
      kind,
      subject: { kind: "STORE" },
      observedAt: data.visibleAt,
      sourceVersion: "test-v1",
      collections: (["paymentFacts", "refundFacts"] as const).filter((key) => data[key] !== null),
      coverageBasisPoints: 10000,
    })),
    ...patch,
  };
}
function run(data = input(), maturityHours = 24) {
  return calculator.calculate({
    input: data,
    paymentCohort: financeCrossDaySettlementGolden.context.paymentCohort,
    maturityHours,
  });
}
function payment(patch: Partial<ConnectorOrder> = {}, id = "order-a") {
  return {
    ...originalPayment,
    observedAt: base.visibleAt,
    data: { ...originalPayment.data, externalOrderId: id, ...patch },
  };
}
function refund(patch: Partial<ConnectorRefund> = {}, id = "refund-next-day") {
  return {
    ...originalRefund,
    evidenceIds: [id],
    data: { ...originalRefund.data, externalRefundId: id, ...patch },
  };
}
function amount(paidMinor: number, id: string) {
  const item = {
    ...originalPayment.data.items[0]!,
    quantity: 1,
    unitPriceMinor: paidMinor,
    grossMinor: paidMinor,
    discountMinor: 0,
    netMinor: paidMinor,
  };
  return payment(
    {
      items: [item],
      grossMinor: paidMinor,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: paidMinor,
      paidMinor,
    },
    id,
  );
}
function paymentSource(...issues: ConnectorOrder["source"]["quality"]["issues"]) {
  return { ...originalPayment.data.source, quality: { state: "PARTIAL" as const, issues } };
}
function refundSource(...issues: ConnectorRefund["source"]["quality"]["issues"]) {
  return { ...originalRefund.data.source, quality: { state: "PARTIAL" as const, issues } };
}
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function values(result: RefundMetrics) {
  return [
    result.settledRefund,
    result.netRevenueSettlement,
    result.refundedCohortOrders,
    result.cohortOrderRate,
    result.cohortAmountRate,
  ].map((measure) => measure.metric.value);
}
it("keeps original day-one payments and next-day refund settlement separate", () => {
  const day1 = financeCrossDayPaymentGolden;
  const day2 = financeCrossDaySettlementGolden;
  const first = value(
    calculator.calculate({
      input: day1.input,
      paymentCohort: day1.context.paymentCohort,
      maturityHours: 24,
    }),
  );
  const second = value(
    calculator.calculate({
      input: day2.input,
      paymentCohort: day2.context.paymentCohort,
      maturityHours: 24,
    }),
  );
  expect(first.settledRefund.metric.value).toBe(0);
  expect(first.netRevenueSettlement.metric.value).toBe(10500);
  expect(values(second)).toEqual([2000, -2000, 1, 10000, 1905]);
  expect(day1.input.paymentFacts![0]!.data.paidMinor).toBe(10500);
  expect(day2.input.paymentFacts![0]!.data.paidMinor).toBe(10500);
});

it("counts distinct original orders and preserves original shipping-inclusive denominators", () => {
  const fixture = financeDistinctRefundRatesGolden;
  const result = value(run(fixture.input));
  expect(values(result)).toEqual([3500, -3500, 2, 6667, 1111]);
  expect(result.cohort.sampleSize).toBe(3);
  expect(fixture.input.paymentFacts!.map((fact) => fact.data.paidMinor)).toEqual([
    10500, 10500, 10500,
  ]);
});
it("distinguishes missing payments, missing refunds and confirmed empty observations", () => {
  const absentPayments = value(run(input({ paymentFacts: null })));
  expect(values(absentPayments)).toEqual([2000, null, null, null, null]);
  expect(absentPayments.settledRefund.quality.status).toBe("VERIFIED");
  expect(absentPayments.netRevenueSettlement.quality.status).toBe("UNAVAILABLE");
  expect(values(value(run(input({ refundFacts: null }))))).toEqual([null, null, null, null, null]);
  const empty = value(run(input({ paymentFacts: [], refundFacts: [] })));
  expect(values(empty)).toEqual([0, 0, 0, null, null]);
  expect(empty.cohortOrderRate.quality.issues).toContainEqual(
    expect.objectContaining({ code: "ZERO_DENOMINATOR" }),
  );
});
it.each(["REQUESTED", "APPROVED", "PROCESSING", "FAILED", "REJECTED", "CANCELLED"] as const)(
  "ignores %s without success evidence",
  (status) => {
    const result = value(
      run(input({ refundFacts: [refund({ status, succeededAt: null, succeededMinor: null })] })),
    );
    expect(values(result)).toEqual([0, 0, 0, 0, 0]);
  },
);
it("does not count zero successful monetary refunds as refunded orders", () => {
  expect(values(value(run(input({ refundFacts: [refund({ succeededMinor: 0 })] }))))).toEqual([
    0, 0, 0, 0, 0,
  ]);
});
it("supports paid cancelled and free orders but excludes known unpaid orders", () => {
  const facts = [
    payment({ status: "CANCELLED" }),
    payment({ paidAt: null, paidMinor: 0, status: "CLOSED" }, "unpaid"),
    amount(0, "free"),
  ];
  const result = value(run(input({ paymentFacts: facts, refundFacts: [] })));
  expect(result.cohort.sampleSize).toBe(2);
  expect(values(result)).toEqual([0, 0, 0, 0, 0]);
  const free = value(run(input({ paymentFacts: [amount(0, "free")], refundFacts: [] })));
  expect(values(free)).toEqual([0, 0, 0, 0, null]);
});
it.each([
  { paidMinor: null, source: paymentSource("PAYMENT_UNKNOWN") },
  { paidAt: null, source: paymentSource("PAYMENT_UNKNOWN") },
  { paidMinor: 10, source: paymentSource("SOURCE_INCONSISTENT") },
])("keeps independent settlement when payment is uncertain %j", (patch) => {
  const result = value(run(input({ paymentFacts: [payment(patch)] })));
  expect(values(result)).toEqual([2000, null, null, null, null]);
  expect(result.cohortAmountRate.quality).toMatchObject({
    status: "INSUFFICIENT",
    coverageBasisPoints: 0,
  });
});
it.each([
  { succeededMinor: null, source: refundSource("REFUND_UNKNOWN") },
  { succeededAt: null, source: refundSource("REFUND_UNKNOWN") },
  { status: "FAILED" as const, source: refundSource("SOURCE_INCONSISTENT") },
  { source: refundSource("REFUND_UNKNOWN") },
])("retains uncertain refund evidence instead of verified zero %j", (patch) => {
  const result = value(run(input({ refundFacts: [refund(patch)] })));
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(result.settledRefund.quality).toMatchObject({
    status: "INSUFFICIENT",
    coverageBasisPoints: 0,
  });
});
it("treats orphan refunds as join uncertainty without erasing settlement", () => {
  const result = value(run(input({ paymentFacts: [] })));
  expect(values(result)).toEqual([2000, null, null, null, null]);
  expect(result.netRevenueSettlement.quality.issues).toContainEqual(
    expect.objectContaining({ code: "SOURCE_INCONSISTENT", evidenceIds: ["refund-next-day"] }),
  );
});
it("rejects overrefund across settlement boundaries with payment and refund evidence", () => {
  const earlier = refund(
    {
      externalRefundId: "earlier",
      requestedMinor: 9000,
      succeededMinor: 9000,
      requestedAt: "2026-10-02T07:00:00Z",
      succeededAt: "2026-10-02T08:00:00Z",
    },
    "earlier",
  );
  expect(run(input({ refundFacts: [originalRefund, earlier] }))).toMatchObject({
    ok: false,
    error: {
      code: "CONFLICT",
      evidenceIds: expect.arrayContaining(["payment-a", "refund-next-day", "earlier"]),
    },
  });
});
it("does not verify refunds succeeding before their known original payment", () => {
  const result = value(run(input({ paymentFacts: [payment({ paidAt: "2026-10-03T01:00:00Z" })] })));
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(result.settledRefund.quality.evidenceIds).toEqual(
    expect.arrayContaining(["payment-a", "refund-next-day"]),
  );
});
it.each(["paymentFacts", "refundFacts"] as const)("rejects duplicate %s even identical", (key) => {
  const fact = key === "paymentFacts" ? originalPayment : originalRefund;
  expect(run(input({ [key]: [fact, fact] }))).toMatchObject({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: fact.evidenceIds },
  });
});

it.each(["REQUESTED", "APPROVED", "PROCESSING", "FAILED", "REJECTED", "CANCELLED"] as const)(
  "accepts %s explicit zero without a success timestamp",
  (status) => {
    const result = value(
      run(input({ refundFacts: [refund({ status, succeededMinor: 0, succeededAt: null })] })),
    );
    expect(values(result)).toEqual([0, 0, 0, 0, 0]);
    expect(result.settledRefund.quality.status).toBe("VERIFIED");
  },
);

it("uses the IANA Shanghai date during the 1991 summer offset", () => {
  const periodStart = "1991-06-30T15:00:00Z",
    periodEnd = "1991-06-30T15:30:00Z";
  const data = input({
    periodStart,
    periodEnd,
    visibleAt: periodEnd,
    sourceWatermark: periodEnd,
    paymentFacts: [],
    refundFacts: [],
  });
  const result = value(
    calculator.calculate({
      input: data,
      paymentCohort: { periodStart, periodEnd, timezone: "Asia/Shanghai", currency: "CNY" },
      maturityHours: 0,
    }),
  );
  expect(values(result)).toEqual([0, 0, 0, null, null]);
});

function request(data = input(), patch: Partial<RefundMetricRequest> = {}): RefundMetricRequest {
  return {
    input: data,
    paymentCohort: financeCrossDaySettlementGolden.context.paymentCohort,
    maturityHours: 24,
    ...patch,
  };
}
function custom(
  dependencies: {
    math?: ExactMinorMath;
    windows?: MetricWindowResolver;
    rounding?: MinorRounding;
  } = {},
) {
  return createRefundMetricCalculator({
    math: exactMinorMath,
    windows,
    rounding: "HALF_AWAY_FROM_ZERO",
    ...dependencies,
  });
}
function allFrozen(value: unknown): boolean {
  return (
    typeof value !== "object" ||
    value === null ||
    (Object.isFrozen(value) && Object.values(value).every(allFrozen))
  );
}
it("retains known subtotals without per-kind coverage and ignores the coarse status", () => {
  const result = value(run(input({ status: "INSUFFICIENT", metricCoverage: [] })));
  expect(values(result)).toEqual([2000, -2000, 1, 10000, 1905]);
  for (const row of Object.values(result).filter((row) => "quality" in row)) {
    expect(row.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 0 });
    expect(row.quality.issues).toContainEqual(
      expect.objectContaining({ code: "PARTIAL_COVERAGE" }),
    );
  }
});
it("requires every collection in a matching store proof and conservatively takes minimum coverage", () => {
  const data = input(),
    proof = data.metricCoverage[0]!;
  const result = value(
    run({
      ...data,
      metricCoverage: [...data.metricCoverage, { ...proof, coverageBasisPoints: 6500 }],
    }),
  );
  expect(result.settledRefund.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 6500,
  });
  expect(result.cohortAmountRate.quality.status).toBe("VERIFIED");
  const incomplete = data.metricCoverage.map((row) => ({
    ...row,
    collections: ["refundFacts"] as const,
  }));
  const partial = value(run({ ...data, metricCoverage: incomplete }));
  expect(partial.settledRefund.quality.status).toBe("VERIFIED");
  expect(partial.netRevenueSettlement.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 0,
  });
  const sku = data.metricCoverage.map((row) => ({
    ...row,
    subject: { kind: "SKU" as const, externalSkuId: "sku-a" },
  }));
  expect(value(run({ ...data, metricCoverage: sku })).settledRefund.quality.status).toBe(
    "ESTIMATED",
  );
});
it("uses settlement end for settlement freshness and visibleAt for cohort freshness", () => {
  const result = value(run(input({ sourceWatermark: base.periodEnd })));
  expect(result.settledRefund.quality.status).toBe("VERIFIED");
  expect(result.netRevenueSettlement.quality.status).toBe("VERIFIED");
  expect(result.refundedCohortOrders.quality.status).toBe("STALE");
  expect(result.cohortAmountRate.quality.status).toBe("STALE");
  expect(values(result)).toEqual([2000, -2000, 1, 10000, 1905]);
});
it("ranks unavailable before stale and stale before uncertain while keeping unknown values null", () => {
  const uncertainRefund = refund({ succeededMinor: null, source: refundSource("REFUND_UNKNOWN") });
  const stale = value(
    run(input({ sourceWatermark: base.periodStart, refundFacts: [uncertainRefund] })),
  );
  expect(values(stale)).toEqual([null, null, null, null, null]);
  expect(stale.settledRefund.quality).toMatchObject({ status: "STALE", coverageBasisPoints: 0 });
  expect(stale.settledRefund.quality.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "REFUND_UNKNOWN" }),
      expect.objectContaining({ code: "STALE_SOURCE" }),
    ]),
  );
  const unavailable = value(run(input({ sourceWatermark: base.periodStart, refundFacts: null })));
  expect(unavailable.settledRefund.quality.status).toBe("UNAVAILABLE");
});
it("estimates missing source update time without losing confirmed amounts", () => {
  const noTime = refund({ source: { ...refundSource("SOURCE_TIME_MISSING"), updatedAt: null } });
  const result = value(run(input({ refundFacts: [noTime] })));
  expect(values(result)).toEqual([2000, -2000, 1, 10000, 1905]);
  expect(result.settledRefund.quality.status).toBe("ESTIMATED");
  expect(result.settledRefund.quality.issues).toContainEqual(
    expect.objectContaining({ code: "SOURCE_TIME_MISSING" }),
  );
});
it("ignores unrelated source quality and payment refund summaries", () => {
  const paid = payment({
    refundedMinor: null,
    source: paymentSource("REFUND_UNKNOWN", "COST_MISSING", "CATEGORY_MISSING"),
  });
  const result = value(run(input({ paymentFacts: [paid] })));
  expect(values(result)).toEqual([2000, -2000, 1, 10000, 1905]);
  expect(result.cohortAmountRate.quality.status).toBe("VERIFIED");
});
it.each([
  [47.5, true],
  [48, true],
  [48.01, false],
  [0, true],
] as const)("honors custom maturity %s", (hours, mature) => {
  const result = value(run(input(), hours));
  expect(result.cohort).toMatchObject({
    requiredAgeHours: hours,
    elapsedAgeHours: 48,
    mature,
    sampleSize: 1,
    observedThrough: base.visibleAt,
  });
  expect(result.refundedCohortOrders.metric.value).toBe(1);
  expect(result.cohortOrderRate.metric.value).toBe(mature ? 10000 : null);
  expect(result.cohortOrderRate.quality.coverageBasisPoints).toBe(10000);
  if (!mature)
    expect(result.cohortOrderRate.quality.issues).toContainEqual(
      expect.objectContaining({ code: "IMMATURE_COHORT" }),
    );
});
it("retains fractional elapsed age and observed refund counts before maturity", () => {
  const result = value(
    run(
      input({ visibleAt: "2026-10-03T16:30:00Z", sourceWatermark: "2026-10-03T16:30:00Z" }),
      24.75,
    ),
  );
  expect(result.cohort.elapsedAgeHours).toBe(24.5);
  expect(values(result)).toEqual([2000, -2000, 1, null, null]);
});
it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid maturity %s",
  (maturityHours) => {
    expect(calculator.calculate(request(input(), { maturityHours }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  },
);
it("rejects unknown request fields and invalid rounding without accepting extra policy", () => {
  expect(calculator.calculate({ ...request(), extra: true } as RefundMetricRequest)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(custom({ rounding: "AUTO" as MinorRounding }).calculate(request())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it.each(["currency", "timezone"] as const)("rejects incompatible cohort %s", (key) => {
  const paymentCohort = {
    ...request().paymentCohort,
    [key]: key === "currency" ? "USD" : "UTC",
  } as MetricWindow;
  expect(calculator.calculate(request(input(), { paymentCohort }))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("rejects reversed, future and non-UTC cohort intervals", () => {
  const cohort = request().paymentCohort;
  for (const patch of [
    { periodStart: cohort.periodEnd },
    { periodEnd: "2026-10-05T16:00:00Z" },
    { periodEnd: "2026-10-03T00:00:00+08:00" },
  ]) {
    expect(
      calculator.calculate(request(input(), { paymentCohort: { ...cohort, ...patch } })).ok,
    ).toBe(false);
  }
});
it("rejects cross-scope, future, non-CNY and whitespace identifier refund facts", () => {
  const bad = [
    { ...originalRefund, binding: { ...base.binding, storeId: "foreign" } },
    { ...originalRefund, observedAt: "2026-10-05T00:00:00Z" },
    refund({ currency: "USD" as "CNY" }),
    refund({ externalRefundId: " refund " }),
  ];
  for (const fact of bad)
    expect(run(input({ refundFacts: [fact] }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
});
it.each(["periodStart", "periodEnd", "visibleAt", "sourceWatermark"] as const)(
  "rejects nonzero submillisecond input %s",
  (key) => {
    const time = base[key]!;
    expect(run(input({ [key]: time.replace("Z", ".0001Z") }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  },
);
it("rejects submillisecond cohort, source, payment and coverage timestamps", () => {
  const cohort = { ...request().paymentCohort, periodStart: "2026-10-01T16:00:00.0001Z" };
  expect(calculator.calculate(request(input(), { paymentCohort: cohort })).ok).toBe(false);
  expect(run(input({ paymentFacts: [payment({ paidAt: "2026-10-02T00:00:00.0001Z" })] })).ok).toBe(
    false,
  );
  expect(
    run(input({ refundFacts: [refund({ succeededAt: "2026-10-03T00:00:00.0001Z" })] })).ok,
  ).toBe(false);
  expect(
    run(
      input({
        refundFacts: [
          refund({
            source: { ...originalRefund.data.source, updatedAt: "2026-10-02T23:59:59.0001Z" },
          }),
        ],
      }),
    ).ok,
  ).toBe(false);
  const data = input();
  expect(
    run({
      ...data,
      metricCoverage: data.metricCoverage.map((proof) => ({
        ...proof,
        observedAt: "2026-10-04T15:59:59.0001Z",
      })),
    }).ok,
  ).toBe(false);
});
it("accepts Connector offset instants and extra trailing zero precision", () => {
  const paid = payment({ paidAt: "2026-10-02T08:00:00.000000+08:00" });
  const settled = refund({ succeededAt: "2026-10-03T08:00:00.0000+08:00" });
  expect(values(value(run(input({ paymentFacts: [paid], refundFacts: [settled] }))))).toEqual([
    2000, -2000, 1, 10000, 1905,
  ]);
});
it("preserves arbitrary multi-day settlement intervals", () => {
  const result = value(run(input({ periodStart: request().paymentCohort.periodStart })));
  expect(values(result)).toEqual([2000, 8500, 1, 10000, 1905]);
});
it("uses half-open success time membership for partial settlement intervals", () => {
  const atStart = refund({ requestedAt: base.periodStart, succeededAt: base.periodStart }, "start");
  const atEnd = { ...refund({ succeededAt: base.periodEnd }, "end"), observedAt: base.periodEnd };
  const result = value(
    run(input({ refundFacts: [atStart, atEnd], periodEnd: "2026-10-03T00:00:00Z" })),
  );
  expect(values(result)).toEqual([2000, -2000, 1, 10000, 3810]);
});
it("asks injected elapsed windows once for each distinct requested interval", () => {
  const elapsed = vi.fn(windows.elapsed);
  expect(custom({ windows: { ...windows, elapsed } }).calculate(request()).ok).toBe(true);
  expect(elapsed.mock.calls.map(([arg]) => arg)).toEqual([
    { businessDate: "2026-10-03", timezone: "Asia/Shanghai", visibleAt: base.visibleAt },
    { businessDate: "2026-10-02", timezone: "Asia/Shanghai", visibleAt: base.visibleAt },
  ]);
  elapsed.mockClear();
  const day1 = financeCrossDayPaymentGolden;
  expect(
    custom({ windows: { ...windows, elapsed } }).calculate(
      request(day1.input, { paymentCohort: day1.context.paymentCohort }),
    ).ok,
  ).toBe(true);
  expect(elapsed).toHaveBeenCalledTimes(1);
});
it.each([
  { periodStart: "2026-10-03T16:00:00Z", periodEnd: "2026-10-04T16:00:00Z" },
  { periodStart: "2026-10-01T16:00:00Z", periodEnd: base.periodEnd },
  { periodStart: base.periodStart, periodEnd: "2026-10-05T16:00:00Z" },
  { periodStart: base.periodStart, periodEnd: "2026-10-03T15:59:59.999Z" },
  { periodStart: base.periodStart, periodEnd: "2026-10-03T16:00:00.0001Z" },
])("rejects invalid resolver fences %j", (patch) => {
  const elapsed: MetricWindowResolver["elapsed"] = () => ({
    ok: true,
    value: { ...request().paymentCohort, ...patch },
  });
  expect(custom({ windows: { ...windows, elapsed } }).calculate(request()).ok).toBe(false);
});
it.each(["HALF_AWAY_FROM_ZERO", "TOWARD_ZERO"] as const)(
  "rounds cohort ratios independently with %s",
  (rounding) => {
    const result = value(
      custom({ rounding }).calculate(request(financeDistinctRefundRatesGolden.input)),
    );
    expect(result.cohortOrderRate.metric.value).toBe(rounding === "TOWARD_ZERO" ? 6666 : 6667);
    expect(result.cohortAmountRate.metric.value).toBe(1111);
  },
);
it("propagates checked aggregate overflow without floating point accumulation", () => {
  const data = input({
    paymentFacts: [amount(Number.MAX_SAFE_INTEGER, "max"), amount(1, "one")],
    refundFacts: [],
  });
  expect(run(data)).toMatchObject({ ok: false, error: { code: "OVERFLOW" } });
});
it.each(["add", "subtract", "multiply", "ratio"] as const)(
  "propagates typed math %s failures and their evidence",
  (operation) => {
    const fail = () => ({
      ok: false as const,
      error: { code: "SOURCE_UNAVAILABLE" as const, evidenceIds: ["math-proof"] },
    });
    const result = custom({ math: { ...exactMinorMath, [operation]: fail } }).calculate(request());
    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["math-proof"] },
    });
    expect(allFrozen(result)).toBe(true);
  },
);
it("propagates typed window failures and retained evidence", () => {
  const elapsed: MetricWindowResolver["elapsed"] = () => ({
    ok: false,
    error: { code: "WINDOW_MISMATCH", evidenceIds: ["window-proof"] },
  });
  expect(custom({ windows: { ...windows, elapsed } }).calculate(request())).toEqual({
    ok: false,
    error: { code: "WINDOW_MISMATCH", evidenceIds: ["window-proof"] },
  });
});
it("never clamps ratios exceeding the public basis-point domain", () => {
  const ratio: ExactMinorMath["ratio"] = () => ({
    ok: true,
    value: { value: 10001, reason: null },
  });
  expect(custom({ math: { ...exactMinorMath, ratio } }).calculate(request())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("returns deeply immutable output and validates public measures and wrapped snapshots", () => {
  const data = input(),
    before = JSON.stringify(data),
    result = value(run(data));
  expect(allFrozen(result)).toBe(true);
  expect(JSON.stringify(data)).toBe(before);
  expect(Object.isFrozen(data)).toBe(false);
  for (const row of [
    result.settledRefund,
    result.netRevenueSettlement,
    result.refundedCohortOrders,
    result.cohortOrderRate,
    result.cohortAmountRate,
  ]) {
    expect(MetricValueSchema.safeParse(row.metric).success).toBe(true);
    for (const item of row.quality.issues)
      expect(DataQualityIssueV1Schema.safeParse(item).success).toBe(true);
    expect(
      MetricComputationV1Schema.safeParse({
        input: data,
        snapshot: {
          ...context(data),
          ...row.quality,
          metric: row.metric,
          subject: { kind: "STORE" },
          computedAt: data.visibleAt,
        },
      }).success,
    ).toBe(true);
  }
});

it("uses supplied partial cohort paidAt boundaries without expanding its denominator", () => {
  const cohort = { ...request().paymentCohort, periodEnd: "2026-10-02T06:00:00Z" };
  const atEnd = payment({ paidAt: cohort.periodEnd }, "end");
  const result = value(
    calculator.calculate(
      request(input({ paymentFacts: [originalPayment, atEnd] }), { paymentCohort: cohort }),
    ),
  );
  expect(result.cohort.sampleSize).toBe(1);
  expect(result.cohortAmountRate.metric.value).toBe(1905);
  expect(result.cohort.paymentWindow).toEqual(cohort);
});
it.each(["paymentFacts", "refundFacts"] as const)(
  "preserves both conflicting %s evidence records",
  (key) => {
    const original = key === "paymentFacts" ? originalPayment : originalRefund;
    const second = { ...original, evidenceIds: ["duplicate-second"] };
    expect(run(input({ [key]: [original, second] }))).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", evidenceIds: [...original.evidenceIds, "duplicate-second"] },
    });
  },
);
it("keeps fully absent normalized input unavailable across every measure", () => {
  const result = value(
    run(
      input({
        status: "UNAVAILABLE",
        sourceWatermark: null,
        paymentFacts: null,
        refundFacts: null,
        metricCoverage: [],
      }),
    ),
  );
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(result.settledRefund.quality).toMatchObject({
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
  });
  expect(result.cohortOrderRate.quality.status).toBe("UNAVAILABLE");
});
it("validates public issue schemas for uncertain, stale and immature results", () => {
  const data = input({
    sourceWatermark: base.periodStart,
    refundFacts: [refund({ succeededMinor: null, source: refundSource("REFUND_UNKNOWN") })],
  });
  const result = value(run(data, 100));
  for (const row of [
    result.settledRefund,
    result.netRevenueSettlement,
    result.refundedCohortOrders,
    result.cohortOrderRate,
    result.cohortAmountRate,
  ]) {
    for (const item of row.quality.issues) {
      expect(DataQualityIssueV1Schema.safeParse(item).success).toBe(true);
      expect(item.evidenceIds.every((id) => row.quality.evidenceIds.includes(id))).toBe(true);
    }
    expect(
      MetricComputationV1Schema.safeParse({
        input: data,
        snapshot: {
          ...context(data),
          ...row.quality,
          metric: row.metric,
          subject: { kind: "STORE" },
          computedAt: data.visibleAt,
        },
      }).success,
    ).toBe(true);
  }
});
it("zero-pads early Shanghai business years before passing them to the resolver", () => {
  const periodStart = "0001-01-01T16:00:00Z",
    periodEnd = "0001-01-02T16:00:00Z";
  const data = input({
    periodStart,
    periodEnd,
    visibleAt: periodEnd,
    sourceWatermark: periodEnd,
    paymentFacts: [],
    refundFacts: [],
  });
  expect(
    calculator.calculate(
      request(data, {
        paymentCohort: { periodStart, periodEnd, timezone: "Asia/Shanghai", currency: "CNY" },
        maturityHours: 0,
      }),
    ).ok,
  ).toBe(true);
});
