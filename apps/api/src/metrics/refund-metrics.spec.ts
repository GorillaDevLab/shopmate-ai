import { expect, it } from "vitest";
import type {
  MetricResult,
  RefundMetrics,
  MetricInputV1,
  ConnectorOrder,
  ConnectorRefund,
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
    { externalRefundId: "earlier", requestedMinor: 9000, succeededMinor: 9000 },
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
