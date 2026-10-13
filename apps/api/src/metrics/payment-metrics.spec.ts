import { expect, it } from "vitest";
import {
  DataQualityIssueV1Schema,
  MetricComputationV1Schema,
  MetricValueSchema,
  type ConnectorOrder,
  type MetricInputV1,
  type MetricResult,
  type MinorRounding,
  type PaymentMetrics,
} from "@shopmate/contracts";
import {
  financeBaseGolden,
  financeUnpaidCancelledGolden,
  financePartialWindowGolden,
  financeCrossDayPaymentGolden,
  financeCrossDaySettlementGolden,
} from "../../test/fixtures/metrics/finance-golden.fixture.js";
import { exactMinorMath } from "./exact-math.js";
import { createMetricWindowResolver } from "./metric-window.js";
import { createPaymentMetricCalculator } from "./payment-metrics.js";

const kinds = ["GMV", "PAID_REVENUE", "PAID_ORDERS", "PAID_UNITS", "AOV"] as const;
const base = financeBaseGolden.input;
const original = base.paymentFacts![0]!;
const windows = createMetricWindowResolver({
  snapshot: () => ({ now: "2026-10-10T00:00:00Z", revision: 1 }),
});
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  const result = { ...base, ...patch };
  return {
    ...result,
    metricCoverage: kinds.map((kind) => ({
      ...context(result),
      kind,
      subject: { kind: "STORE" },
      observedAt: result.visibleAt,
      sourceVersion: "test-v1",
      collections: ["paymentFacts"],
      coverageBasisPoints: 10000,
    })),
    ...patch,
  };
}
function context(data: MetricInputV1) {
  return {
    schemaVersion: data.schemaVersion,
    definitionVersion: data.definitionVersion,
    inputRevision: data.inputRevision,
    binding: data.binding,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    timezone: data.timezone,
    currency: data.currency,
    visibleAt: data.visibleAt,
    sourceWatermark: data.sourceWatermark,
    evidenceIds: data.evidenceIds,
  };
}
function payment(patch: Partial<ConnectorOrder> = {}, id = "order-a") {
  return {
    ...original,
    evidenceIds: [id],
    data: { ...original.data, externalOrderId: id, ...patch },
  };
}
function amount(value: number, id: string) {
  const item = {
    ...original.data.items[0]!,
    quantity: 1,
    unitPriceMinor: value,
    grossMinor: value,
    discountMinor: 0,
    netMinor: value,
  };
  return payment(
    {
      items: [item],
      grossMinor: value,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: value,
      paidMinor: value,
    },
    id,
  );
}
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function calculate(data = input(), rounding: MinorRounding = "HALF_AWAY_FROM_ZERO") {
  return createPaymentMetricCalculator({ math: exactMinorMath, windows, rounding }).calculate(data);
}
function values(result: PaymentMetrics) {
  return Object.values(result).map((measure) => measure.metric.value);
}
function anomaly(...issues: ConnectorOrder["source"]["quality"]["issues"]) {
  return { ...original.data.source, quality: { state: "PARTIAL" as const, issues } };
}

it("calculates actual payments with discounts once and buyer shipping once", () => {
  const result = value(calculate());
  expect(values(result)).toEqual([12000, 10500, 1, 3, 10500]);
  expect(Object.values(result).every((m) => m.quality.status === "VERIFIED")).toBe(true);
  for (const measure of Object.values(result)) {
    expect(MetricValueSchema.safeParse(measure.metric).success).toBe(true);
    expect(
      MetricComputationV1Schema.safeParse({
        input: input(),
        snapshot: {
          ...context(input()),
          ...measure.quality,
          metric: measure.metric,
          subject: { kind: "STORE" },
          computedAt: base.visibleAt,
        },
      }).success,
    ).toBe(true);
  }
});

it("excludes known unpaid orders and preserves paid cancellations and free payments", () => {
  const unpaid = payment({ status: "PENDING_PAYMENT", paidAt: null, paidMinor: 0 }, "unpaid");
  const cancelled = payment({ status: "CANCELLED", refundedMinor: 10500 }, "cancelled");
  const free = amount(0, "free");
  expect(values(value(calculate(input({ paymentFacts: [unpaid, cancelled, free] }))))).toEqual([
    12000, 10500, 2, 4, 5250,
  ]);
  expect(values(value(calculate(financeUnpaidCancelledGolden.input)))).toEqual([0, 0, 0, 0, null]);
});

it("uses half-open paidAt membership and ignores later refunds", () => {
  const atEnd = payment({ paidAt: base.periodEnd }, "end");
  const observed = {
    ...atEnd,
    observedAt: base.periodEnd,
    data: { ...atEnd.data, source: { ...atEnd.data.source, updatedAt: base.periodEnd } },
  };
  expect(values(value(calculate(input({ paymentFacts: [original, observed] }))))).toEqual([
    12000, 10500, 1, 3, 10500,
  ]);
  expect(values(value(calculate(input({ ...financePartialWindowGolden.input }))))).toEqual([
    12000, 10500, 1, 3, 10500,
  ]);
  expect(value(calculate(financeCrossDayPaymentGolden.input)).paidRevenue.metric.value).toBe(10500);
  expect(value(calculate(financeCrossDaySettlementGolden.input)).paidRevenue.metric.value).toBe(0);
});

it.each([
  ["HALF_AWAY_FROM_ZERO", 2],
  ["TOWARD_ZERO", 1],
] as const)("rounds AOV exactly using %s", (rounding, expected) => {
  expect(
    value(calculate(input({ paymentFacts: [amount(1, "a"), amount(2, "b")] }), rounding)).aov.metric
      .value,
  ).toBe(expected);
});
it("retains a safe wide AOV without overflowing a scaled ratio", () => {
  expect(
    value(calculate(input({ paymentFacts: [amount(Number.MAX_SAFE_INTEGER, "max")] }))).aov.metric
      .value,
  ).toBe(Number.MAX_SAFE_INTEGER);
});
it("propagates aggregate overflow", () => {
  expect(
    calculate(input({ paymentFacts: [amount(Number.MAX_SAFE_INTEGER, "max"), amount(1, "one")] })),
  ).toMatchObject({ ok: false, error: { code: "OVERFLOW" } });
});

it("requires per-kind source proof even when input says VERIFIED", () => {
  const result = value(calculate(base));
  expect(result.gmv.quality.status).toBe("VERIFIED");
  expect(result.aov.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 0,
    issues: [expect.objectContaining({ code: "PARTIAL_COVERAGE" })],
  });
});
it("distinguishes missing collection from confirmed empty collection", () => {
  const absent = value(calculate(input({ paymentFacts: null, metricCoverage: [] })));
  expect(values(absent)).toEqual([null, null, null, null, null]);
  expect(absent.gmv.quality).toMatchObject({
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
    issues: [expect.objectContaining({ code: "NOT_SYNCHRONIZED" })],
  });
  const empty = value(calculate(input({ paymentFacts: [] })));
  expect(values(empty)).toEqual([0, 0, 0, 0, null]);
  expect(empty.aov.quality.status).toBe("INSUFFICIENT");
  expect(empty.aov.quality.issues).toContainEqual(
    expect.objectContaining({ code: "ZERO_DENOMINATOR" }),
  );
});
it.each([
  { paidMinor: null, source: anomaly("PAYMENT_UNKNOWN") },
  { paidAt: null, source: anomaly("PAYMENT_UNKNOWN") },
  { paidMinor: 10, source: anomaly("SOURCE_INCONSISTENT") },
  { status: "PENDING_PAYMENT" as const, source: anomaly("SOURCE_INCONSISTENT") },
])("nulls every measure for uncertain payment %j", (patch) => {
  const result = value(calculate(input({ paymentFacts: [payment(patch)] })));
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(result.gmv.quality).toMatchObject({ status: "INSUFFICIENT", coverageBasisPoints: 0 });
  expect(result.gmv.quality.issues.length).toBeGreaterThan(0);
  for (const issue of result.gmv.quality.issues)
    expect(DataQualityIssueV1Schema.safeParse(issue).success).toBe(true);
});
it("returns conflict evidence for identical duplicate orders", () => {
  expect(calculate(input({ paymentFacts: [original, original] }))).toMatchObject({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: ["payment-a"] },
  });
});
