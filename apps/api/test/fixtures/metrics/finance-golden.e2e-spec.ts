import { expect, it } from "vitest";
import { MetricInputV1Schema, MetricComputationV1Schema } from "@shopmate/contracts";
import type { MetricKind, MetricWindow } from "@shopmate/contracts";
import { financeGoldenFixtures } from "./finance-golden.fixture.js";

function golden(caseId: string) {
  const fixture = financeGoldenFixtures.find((item) => item.caseId === caseId);
  if (!fixture) throw new Error(`Missing finance golden case: ${caseId}`);
  return fixture;
}
function measure(caseId: string, kind: MetricKind) {
  const result = golden(caseId).expected.measures.find((item) => item.metric.kind === kind);
  if (!result) throw new Error(`Missing ${caseId} expectation: ${kind}`);
  return result;
}
function inside(timestamp: string | null, window: MetricWindow) {
  return (
    timestamp !== null &&
    Date.parse(timestamp) >= Date.parse(window.periodStart) &&
    Date.parse(timestamp) < Date.parse(window.periodEnd)
  );
}
function payments(caseId: string, window: MetricWindow) {
  return (golden(caseId).input.paymentFacts ?? []).filter(
    ({ data }) => data.paidMinor !== null && data.paidMinor > 0 && inside(data.paidAt, window),
  );
}

it("contains every approved financial edge case exactly once", () => {
  expect(financeGoldenFixtures.map(({ caseId }) => caseId)).toEqual([
    "g4-base",
    "missing-cogs",
    "unconfigured-other-fee",
    "refund-only",
    "accepted-return",
    "cross-day-payment",
    "cross-day-settlement",
    "unpaid-cancelled",
    "distinct-refund-rates",
    "shanghai-partial-window",
    "zero-denominator",
  ]);
});

it("retains the approved 10500 paid golden amount in schema-valid source input", () => {
  const fixture = golden("g4-base");
  expect(MetricInputV1Schema.safeParse(fixture.input).success).toBe(true);
  expect(measure("g4-base", "PAID_REVENUE").metric.value).toBe(10500);
  expect(fixture.input.paymentFacts).toHaveLength(1);
});

it("deducts discounts once and conserves each approved money step", () => {
  const input = golden("g4-base").input;
  const order = input.paymentFacts?.[0]?.data;
  if (!order) throw new Error("Base order is required");
  const merchandise = order.items.reduce((total, line) => total + line.netMinor, 0);
  const refund = input.refundAllocations?.[0]?.data?.merchandiseMinor;
  const cogs = (input.frozenCosts ?? []).reduce(
    (total, fact) => total + (fact.data?.unitCostMinor ?? 0) * (fact.data?.quantity ?? 0),
    0,
  );
  expect(order.grossMinor - order.discountMinor + order.shippingMinor).toBe(10500);
  expect(merchandise).toBe(10000);
  expect(refund).toBe(2000);
  expect(cogs).toBe(6000);
  expect(merchandise - 2000 - cogs).toBe(2000);
  expect(2000 + order.shippingMinor - 700 - 300 - 100 - 800).toBe(600);
  expect(600 - 200).toBe(400);
});

it("freezes the complete literal base expectations", () => {
  expect(
    golden("g4-base").expected.measures.map(({ metric }) => [metric.kind, metric.value]),
  ).toEqual([
    ["GMV", 12000],
    ["PAID_REVENUE", 10500],
    ["PAID_ORDERS", 1],
    ["PAID_UNITS", 3],
    ["REFUND_SETTLED_AMOUNT", 2000],
    ["NET_REVENUE_SETTLEMENT", 8500],
    ["NET_MERCHANDISE_REVENUE", 8000],
    ["COGS", 6000],
    ["GROSS_PROFIT", 2000],
    ["CONTRIBUTION", 600],
    ["ESTIMATED_NET_PROFIT", 400],
  ]);
  expect(golden("g4-base").input.fees?.map(({ data }) => data?.amountMinor)).toEqual([
    700, 300, 100, 800, 200,
  ]);
});

it("preserves missing historical cost as null with unit coverage and estimated quality", () => {
  const fixture = golden("missing-cogs");
  expect(fixture.input.frozenCosts?.[1]?.data).toMatchObject({
    unitCostMinor: null,
    skuCostVersion: null,
    basis: "UNAVAILABLE",
  });
  for (const kind of ["COGS", "GROSS_PROFIT", "CONTRIBUTION", "ESTIMATED_NET_PROFIT"] as const) {
    expect(measure("missing-cogs", kind)).toMatchObject({
      metric: { value: null },
      quality: { status: "ESTIMATED", coverageBasisPoints: 3333 },
    });
    expect(measure("missing-cogs", kind).quality.issues[0]?.code).toBe("COST_MISSING");
  }
  expect(Math.round((1 / 3) * 10000)).toBe(3333);
  expect(measure("missing-cogs", "PAID_REVENUE").quality.status).toBe("VERIFIED");
});

it("excludes an unconfigured fee without inventing a zero charge", () => {
  const fixture = golden("unconfigured-other-fee");
  expect(fixture.input.fees?.[4]?.data).toMatchObject({
    kind: "OTHER_OPERATING",
    amountMinor: null,
    basis: "UNAVAILABLE",
    coverageBasisPoints: 0,
  });
  expect(fixture.expected.excludedFeeKinds).toEqual(["OTHER_OPERATING"]);
  expect(fixture.expected.feeCoverage).toContainEqual({
    kind: "OTHER_OPERATING",
    coverageBasisPoints: 0,
  });
  expect(measure("unconfigured-other-fee", "CONTRIBUTION")).toMatchObject({
    metric: { value: 600 },
    quality: { status: "VERIFIED" },
  });
  expect(measure("unconfigured-other-fee", "ESTIMATED_NET_PROFIT")).toMatchObject({
    metric: { value: 600 },
    quality: { status: "ESTIMATED", coverageBasisPoints: 8000 },
  });
});

it("requires accepted resellable receipt evidence before reversing the frozen cost", () => {
  const refundOnly = golden("refund-only");
  const returned = golden("accepted-return");
  expect(refundOnly.input.returnReceipts).toEqual([]);
  expect(refundOnly.expected.reversals).toEqual([]);
  expect(measure("refund-only", "COGS").metric.value).toBe(6000);
  const receipt = returned.input.returnReceipts?.[0]?.data;
  const frozen = returned.input.frozenCosts?.[0]?.data;
  expect(receipt).toMatchObject({
    acceptedAt: "2026-10-02T10:00:00Z",
    resellableQuantity: 1,
    externalLineId: frozen?.externalLineId,
  });
  expect(returned.expected.reversals[0]).toMatchObject({
    externalOrderId: "order-a",
    externalLineId: "line-a",
    externalReceiptId: "receipt-a",
    skuCostVersion: "sku-a-cost-2026-09-v1",
    reversedQuantity: 1,
    reversedMinor: 1000,
    evidenceIds: ["cost-a", "receipt-a"],
  });
  expect((frozen?.unitCostMinor ?? 0) * (receipt?.resellableQuantity ?? 0)).toBe(1000);
  expect(measure("accepted-return", "COGS").metric.value).toBe(5000);
  expect(measure("accepted-return", "GROSS_PROFIT").metric.value).toBe(3000);
  expect(measure("accepted-return", "ESTIMATED_NET_PROFIT").metric.value).toBe(1400);
});

it("keeps original payment facts immutable across next-day settlement and cohort views", () => {
  const day1 = golden("cross-day-payment");
  const day2 = golden("cross-day-settlement");
  expect(day1.input.paymentFacts).toEqual(day2.input.paymentFacts);
  expect(day1.input.refundFacts).toEqual([]);
  expect(day2.input.refundFacts?.[0]?.data.succeededAt).toBe("2026-10-03T00:00:00Z");
  expect(measure("cross-day-payment", "PAID_REVENUE").metric.value).toBe(10500);
  expect(measure("cross-day-payment", "NET_REVENUE_SETTLEMENT").metric.value).toBe(10500);
  expect(measure("cross-day-settlement", "PAID_REVENUE").metric.value).toBe(0);
  expect(measure("cross-day-settlement", "NET_REVENUE_SETTLEMENT").metric.value).toBe(-2000);
  expect(payments("cross-day-settlement", day2.context.paymentCohort)).toHaveLength(1);
  expect(payments("cross-day-settlement", day2.context.settlementWindow)).toHaveLength(0);
  const settlements = day2.input.refundFacts ?? [];
  expect(settlements.filter(({ data }) => inside(data.succeededAt, day1.input))).toHaveLength(0);
  expect(settlements.filter(({ data }) => inside(data.succeededAt, day2.input))).toHaveLength(1);
  expect(measure("cross-day-settlement", "REFUND_COHORT_AMOUNT_RATE").metric.value).toBe(
    Math.round((2000 / 10500) * 10000),
  );
  expect(day2.context.cohort).toMatchObject({
    requiredAgeHours: 24,
    elapsedAgeHours: 48,
    mature: true,
    sampleSize: 1,
  });
});

it("excludes unpaid cancellation from payment amounts orders and units", () => {
  const fixture = golden("unpaid-cancelled");
  expect(fixture.input.paymentFacts?.[0]?.data).toMatchObject({
    status: "CANCELLED",
    paidAt: null,
    paidMinor: 0,
  });
  expect(payments("unpaid-cancelled", fixture.context.paymentCohort)).toEqual([]);
  for (const kind of ["GMV", "PAID_REVENUE", "PAID_ORDERS", "PAID_UNITS"] as const)
    expect(measure("unpaid-cancelled", kind)).toMatchObject({
      metric: { value: 0 },
      quality: { status: "VERIFIED", sampleSize: 0 },
    });
});

it("distinguishes refunded orders from refund events and paid-cohort amount denominators", () => {
  const fixture = golden("distinct-refund-rates");
  const orders = payments("distinct-refund-rates", fixture.context.paymentCohort);
  const refunds = fixture.input.refundFacts ?? [];
  const refundedOrders = new Set(refunds.map(({ data }) => data.externalOrderId));
  const paidMinor = orders.reduce((sum, { data }) => sum + (data.paidMinor ?? 0), 0);
  const refundedMinor = refunds.reduce((sum, { data }) => sum + (data.succeededMinor ?? 0), 0);
  expect(refunds).toHaveLength(3);
  expect(refundedOrders.size).toBe(2);
  expect(paidMinor).toBe(31500);
  expect(refundedMinor).toBe(3500);
  expect(fixture.expected.refundRateDenominators).toEqual({ paidOrders: 3, paidMinor: 31500 });
  expect(measure("distinct-refund-rates", "REFUND_COHORT_ORDER_RATE").metric.value).toBe(
    Math.round((2 / 3) * 10000),
  );
  expect(measure("distinct-refund-rates", "REFUND_COHORT_AMOUNT_RATE").metric.value).toBe(
    Math.round((3500 / 31500) * 10000),
  );
  expect(fixture.context.rounding).toBe("HALF_AWAY_FROM_ZERO");
  expect(fixture.context.cohort).toMatchObject({
    mature: true,
    elapsedAgeHours: 48,
    sampleSize: 3,
  });
});

it("uses Shanghai midnight and excludes the exact end of a partial UTC interval", () => {
  const fixture = golden("shanghai-partial-window");
  expect(fixture.input.periodStart).toBe("2026-10-01T16:00:00Z");
  expect(fixture.input.periodEnd).toBe("2026-10-02T06:00:00Z");
  expect(Date.parse("2026-10-02T00:00:00+08:00")).toBe(Date.parse(fixture.input.periodStart));
  expect(payments("shanghai-partial-window", fixture.input)).toHaveLength(1);
  expect(inside(fixture.input.paymentFacts?.[0]?.data.paidAt ?? null, fixture.input)).toBe(true);
  expect(inside(fixture.input.paymentFacts?.[1]?.data.paidAt ?? null, fixture.input)).toBe(false);
  expect(measure("shanghai-partial-window", "PAID_REVENUE").metric.value).toBe(10500);
  expect(fixture.context.cohort?.mature).toBe(false);
  expect(
    measure("shanghai-partial-window", "REFUND_COHORT_ORDER_RATE").quality.issues[0]?.code,
  ).toBe("IMMATURE_COHORT");
});

it("preserves observed empty denominators and null refund rates", () => {
  const fixture = golden("zero-denominator");
  expect(fixture.input.paymentFacts).toEqual([]);
  expect(fixture.input.refundFacts).toEqual([]);
  expect(fixture.expected.refundRateDenominators).toEqual({ paidOrders: 0, paidMinor: 0 });
  for (const kind of ["REFUND_COHORT_ORDER_RATE", "REFUND_COHORT_AMOUNT_RATE"] as const)
    expect(measure("zero-denominator", kind)).toMatchObject({
      metric: { value: null },
      quality: {
        status: "INSUFFICIENT",
        coverageBasisPoints: 10000,
        sampleSize: 0,
        issues: [{ code: "ZERO_DENOMINATOR" }],
      },
    });
});

it("deep freezes fixtures and every source and expected sub-object", () => {
  function frozen(value: unknown): boolean {
    return (
      typeof value !== "object" ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen))
    );
  }
  expect(frozen(financeGoldenFixtures)).toBe(true);
});

it("keeps every case compatible with public input and computation schemas", () => {
  for (const fixture of financeGoldenFixtures) {
    expect(MetricInputV1Schema.parse(fixture.input)).toEqual(fixture.input);
    for (const { metric, quality } of fixture.expected.measures) {
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
      } = fixture.input;
      const snapshot = {
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
        computedAt: visibleAt,
        subject: { kind: "STORE" },
        metric,
        ...quality,
      };
      expect(
        MetricComputationV1Schema.parse({ input: fixture.input, snapshot }).snapshot.metric,
      ).toEqual(metric);
    }
  }
});
