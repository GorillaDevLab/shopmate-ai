import { expect, it, vi } from "vitest";
import {
  DataQualityIssueV1Schema,
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricValueSchema,
  type ConnectorOrder,
  type MetricInputV1,
  type MetricResult,
  type MinorRounding,
  type PaymentMetrics,
  type ExactMinorMath,
  type MetricWindowResolver,
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

it("uses conservative minimum coverage for each metric kind", () => {
  const complete = input();
  const revenue = complete.metricCoverage.find((proof) => proof.kind === "PAID_REVENUE")!;
  const partial = { ...revenue, coverageBasisPoints: 6000 };
  const result = value(
    calculate({ ...complete, metricCoverage: [...complete.metricCoverage, partial] }),
  );
  expect(result.paidRevenue.metric.value).toBe(10500);
  expect(result.paidRevenue.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 6000,
  });
  expect(result.gmv.quality.status).toBe("VERIFIED");
});
it("does not accept SKU proof or another collection as STORE payment completeness", () => {
  const data = input();
  const metricCoverage = data.metricCoverage.map((proof) =>
    proof.kind === "GMV"
      ? { ...proof, subject: { kind: "SKU" as const, externalSkuId: "sku-a" } }
      : { ...proof, collections: ["refundFacts" as const] },
  );
  for (const measure of Object.values(value(calculate({ ...data, metricCoverage })))) {
    expect(measure.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 0 });
  }
});
it("labels known values stale when the source watermark precedes periodEnd", () => {
  const result = value(calculate(input({ sourceWatermark: "2026-10-02T15:00:00Z" })));
  expect(values(result)).toEqual([12000, 10500, 1, 3, 10500]);
  expect(result.gmv.quality).toMatchObject({ status: "STALE", coverageBasisPoints: 10000 });
  expect(result.gmv.quality.issues).toContainEqual(
    expect.objectContaining({ code: "STALE_SOURCE" }),
  );
});
it("retains unknown null values when stale quality outranks insufficiency", () => {
  const result = value(
    calculate(
      input({
        sourceWatermark: "2026-10-02T15:00:00Z",
        paymentFacts: [payment({ paidMinor: null, source: anomaly("PAYMENT_UNKNOWN") })],
      }),
    ),
  );
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(result.gmv.quality).toMatchObject({ status: "STALE", coverageBasisPoints: 0 });
  expect(result.gmv.quality.issues.map((item) => item.code)).toContain("PAYMENT_UNKNOWN");
  expect(result.gmv.quality.issues.map((item) => item.code)).toContain("STALE_SOURCE");
});
it("does not fabricate AOV zero for a stale empty source", () => {
  const result = value(
    calculate(input({ paymentFacts: [], sourceWatermark: "2026-10-02T15:00:00Z" })),
  );
  expect(result.aov.metric.value).toBeNull();
  expect(result.aov.quality.status).toBe("STALE");
  expect(result.aov.quality.issues.map((item) => item.code)).toEqual([
    "ZERO_DENOMINATOR",
    "STALE_SOURCE",
  ]);
});
it("retains known payment values while reporting missing source time", () => {
  const source = { ...anomaly("SOURCE_TIME_MISSING"), updatedAt: null };
  const result = value(calculate(input({ paymentFacts: [payment({ source })] })));
  expect(values(result)).toEqual([12000, 10500, 1, 3, 10500]);
  expect(result.gmv.quality.status).toBe("ESTIMATED");
  expect(result.gmv.quality.issues).toContainEqual({
    code: "SOURCE_TIME_MISSING",
    field: "paymentFacts.source",
    evidenceIds: ["order-a"],
  });
});
it("ignores unrelated source issues and blanket input status", () => {
  const result = value(
    calculate(
      input({
        status: "INSUFFICIENT",
        paymentFacts: [
          payment({ refundedMinor: null, source: anomaly("COST_MISSING", "REFUND_UNKNOWN") }),
        ],
      }),
    ),
  );
  expect(values(result)).toEqual([12000, 10500, 1, 3, 10500]);
  expect(result.gmv.quality.status).toBe("VERIFIED");
  expect(result.gmv.quality.issues).toEqual([]);
});
it("retains associated evidence and known sample size for a mixed uncertain collection", () => {
  const known = payment({}, "known");
  const unknown = payment({ paidAt: null, source: anomaly("PAYMENT_UNKNOWN") }, "unknown");
  const result = value(calculate(input({ paymentFacts: [known, unknown] })));
  expect(result.paidOrders.metric.value).toBeNull();
  expect(result.paidOrders.quality.sampleSize).toBe(1);
  expect(result.gmv.quality.evidenceIds).toEqual(["golden-sync", "known", "unknown"]);
  expect(result.aov.quality.issues.map((item) => item.code)).not.toContain("ZERO_DENOMINATOR");
});
it("does not guess window membership for an unknown payment", () => {
  const unknown = payment({
    paidMinor: null,
    source: anomaly("PAYMENT_UNKNOWN"),
    paidAt: "2026-10-01T16:00:00Z",
  });
  const result = value(
    calculate(input({ periodStart: "2026-10-01T17:00:00Z", paymentFacts: [unknown] })),
  );
  expect(values(result)).toEqual([null, null, null, null, null]);
});
it("returns deeply immutable results without mutating frozen inputs", () => {
  const before = JSON.stringify(financeBaseGolden.input);
  const result = calculate(financeBaseGolden.input);
  expect(JSON.stringify(financeBaseGolden.input)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
  for (const measure of Object.values(value(result))) {
    expect(
      [
        measure,
        measure.metric,
        measure.quality,
        measure.quality.evidenceIds,
        measure.quality.issues,
      ].every(Object.isFrozen),
    ).toBe(true);
    for (const issue of measure.quality.issues) {
      expect(Object.isFrozen(issue)).toBe(true);
      expect(Object.isFrozen(issue.evidenceIds)).toBe(true);
    }
  }
});

it.each([
  { ...input(), unexpected: true },
  { ...input(), currency: "USD" },
  { ...input(), visibleAt: "2026-10-02T01:00:00Z" },
  { ...input(), periodStart: base.periodEnd },
  { ...input(), paymentFacts: [{ ...original, binding: { ...base.binding, storeId: "other" } }] },
  { ...input(), paymentFacts: [{ ...original, observedAt: "2026-10-03T00:00:00Z" }] },
])("rejects malformed scope/window/visibility input %#", (data) => {
  expect(calculate(data as MetricInputV1)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it.each(["periodStart", "periodEnd", "visibleAt", "sourceWatermark"] as const)(
  "rejects submillisecond %s",
  (field) => {
    const data = input({ [field]: base[field]!.replace("Z", ".0001Z") });
    expect(calculate(data)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  },
);
it.each(["orderedAt", "paidAt"] as const)("rejects submillisecond connector %s", (field) => {
  const data = input({
    paymentFacts: [payment({ [field]: original.data[field]!.replace("Z", ".0001Z") })],
  });
  expect(calculate(data)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("rejects submillisecond source time and future fact observation within a millisecond", () => {
  const updatedAt = original.data.source.updatedAt!.replace("Z", ".0001Z");
  const future = { ...original, observedAt: base.visibleAt.replace("Z", ".0001Z") };
  expect(
    calculate(
      input({ paymentFacts: [payment({ source: { ...original.data.source, updatedAt } })] }),
    ),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(calculate(input({ paymentFacts: [future] }))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("rejects submillisecond proof observations that Date.parse would truncate", () => {
  const data = input();
  const metricCoverage = data.metricCoverage.map((proof) => ({
    ...proof,
    observedAt: data.visibleAt.replace("Z", ".0001Z"),
  }));
  expect(MetricInputV1Schema.safeParse({ ...data, metricCoverage }).success).toBe(true);
  expect(calculate({ ...data, metricCoverage })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("uses actual offset instants and accepts additional zero timestamp precision", () => {
  const paidAt = "2026-10-02T08:00:00.000000+08:00";
  expect(
    value(calculate(input({ paymentFacts: [payment({ paidAt })] }))).paidRevenue.metric.value,
  ).toBe(10500);
  expect(
    value(calculate(input({ paymentFacts: [payment({ paidAt: "2026-10-02T00:00:00+08:00" })] })))
      .paidOrders.metric.value,
  ).toBe(1);
});
it("rejects nonzero submillisecond offsets", () => {
  expect(
    calculate(input({ paymentFacts: [payment({ paidAt: "2026-10-02T08:00:00.000001+08:00" })] })),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("fences multi-day input on its last included Shanghai business day once", () => {
  const elapsed = vi.fn(windows.elapsed);
  const data = input({
    periodStart: "2026-09-30T17:00:00Z",
    periodEnd: "2026-10-03T06:00:00Z",
    visibleAt: "2026-10-03T06:00:00Z",
    sourceWatermark: "2026-10-03T06:00:00Z",
  });
  const calculator = createPaymentMetricCalculator({
    math: exactMinorMath,
    windows: { ...windows, elapsed },
    rounding: "HALF_AWAY_FROM_ZERO",
  });
  expect(value(calculator.calculate(data)).paidRevenue.metric.value).toBe(10500);
  expect(elapsed).toHaveBeenCalledExactlyOnceWith({
    businessDate: "2026-10-03",
    timezone: "Asia/Shanghai",
    visibleAt: data.visibleAt,
  });
});
it("fences a midnight exclusive end through the preceding business day", () => {
  const elapsed = vi.fn(windows.elapsed);
  const calculator = createPaymentMetricCalculator({
    math: exactMinorMath,
    windows: { ...windows, elapsed },
    rounding: "HALF_AWAY_FROM_ZERO",
  });
  expect(value(calculator.calculate(input())).paidOrders.metric.value).toBe(1);
  expect(elapsed.mock.calls[0]![0].businessDate).toBe("2026-10-02");
});
it("uses paidAt rather than the resolver whole-day start for a partial interval", () => {
  const data = input({ periodStart: "2026-10-02T01:00:00Z", periodEnd: "2026-10-02T06:00:00Z" });
  expect(values(value(calculate(data)))).toEqual([0, 0, 0, 0, null]);
});
it("respects injected business clock future fences", () => {
  const early = createMetricWindowResolver({
    snapshot: () => ({ now: "2026-10-02T01:00:00Z", revision: 1 }),
  });
  const calculator = createPaymentMetricCalculator({
    math: exactMinorMath,
    windows: early,
    rounding: "TOWARD_ZERO",
  });
  expect(calculator.calculate(input())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it.each(["multiply", "subtract", "add"] as const)(
  "propagates injected %s failure evidence",
  (method) => {
    const math: ExactMinorMath = {
      ...exactMinorMath,
      [method]: () => ({ ok: false, error: { code: "OVERFLOW", evidenceIds: ["math-proof"] } }),
    };
    const calculator = createPaymentMetricCalculator({ math, windows, rounding: "TOWARD_ZERO" });
    expect(calculator.calculate(input())).toEqual({
      ok: false,
      error: { code: "OVERFLOW", evidenceIds: ["math-proof"] },
    });
  },
);
it("propagates injected resolver failure evidence", () => {
  const port: MetricWindowResolver = {
    ...windows,
    elapsed: () => ({
      ok: false,
      error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["clock-proof"] },
    }),
  };
  const calculator = createPaymentMetricCalculator({
    math: exactMinorMath,
    windows: port,
    rounding: "TOWARD_ZERO",
  });
  expect(calculator.calculate(input())).toEqual({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["clock-proof"] },
  });
});
it.each([
  { ...context(base), periodEnd: "2026-10-02T15:00:00Z" },
  { ...context(base), periodEnd: "2026-10-03T16:00:00Z" },
  { ...context(base), periodStart: "2026-09-30T16:00:00Z" },
])("rejects an injected resolver window that cannot fence the requested interval %#", (patch) => {
  const port = {
    ...windows,
    elapsed: () => ({
      ok: true as const,
      value: {
        periodStart: patch.periodStart,
        periodEnd: patch.periodEnd,
        currency: "CNY" as const,
        timezone: "Asia/Shanghai" as const,
      },
    }),
  };
  const calculator = createPaymentMetricCalculator({
    math: exactMinorMath,
    windows: port,
    rounding: "TOWARD_ZERO",
  });
  expect(calculator.calculate(input())).toMatchObject({
    ok: false,
    error: { code: "WINDOW_MISMATCH" },
  });
});
it("rejects invalid runtime rounding rather than assuming a default", () => {
  const calculator = createPaymentMetricCalculator({
    math: exactMinorMath,
    windows,
    rounding: "INVALID" as MinorRounding,
  });
  expect(calculator.calculate(input())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

it("keeps merchandise GMV for a fully discounted paid free order", () => {
  const items = original.data.items.map((item) => ({
    ...item,
    discountMinor: item.grossMinor,
    netMinor: 0,
  }));
  const free = payment({
    items,
    discountMinor: 12000,
    shippingMinor: 0,
    payableMinor: 0,
    paidMinor: 0,
  });
  expect(values(value(calculate(input({ paymentFacts: [free] }))))).toEqual([12000, 0, 1, 3, 0]);
});
it("checks unit aggregation overflow even for free orders", () => {
  const free = amount(0, "free");
  const item = { ...free.data.items[0]!, quantity: Number.MAX_SAFE_INTEGER };
  const huge = { ...free, data: { ...free.data, items: [item] } };
  expect(calculate(input({ paymentFacts: [huge, amount(0, "extra")] }))).toMatchObject({
    ok: false,
    error: { code: "OVERFLOW" },
  });
});
it("retains both conflicting source versions as duplicate evidence", () => {
  const revised = {
    ...original,
    sourceVersion: "revised-v2",
    evidenceIds: ["revision-proof"],
    data: { ...original.data, status: "CANCELLED" as const },
  };
  const result = calculate(input({ paymentFacts: [original, revised] }));
  expect(result).toEqual({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: ["payment-a", "revision-proof"] },
  });
  if (!result.ok) expect(Object.isFrozen(result.error.evidenceIds)).toBe(true);
});
it("retains explicit source inconsistency even when amounts reconcile", () => {
  const result = value(
    calculate(input({ paymentFacts: [payment({ source: anomaly("SOURCE_INCONSISTENT") })] })),
  );
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(result.paidRevenue.quality.issues).toEqual([
    { code: "SOURCE_INCONSISTENT", field: "paymentFacts.source", evidenceIds: ["order-a"] },
  ]);
});
it("preserves unsynchronized null facts as unavailable", () => {
  const data = input({
    paymentFacts: null,
    refundFacts: null,
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    sourceWatermark: null,
    status: "UNAVAILABLE",
    metricCoverage: [],
  });
  const result = value(calculate(data));
  expect(values(result)).toEqual([null, null, null, null, null]);
  expect(Object.values(result).every((measure) => measure.quality.status === "UNAVAILABLE")).toBe(
    true,
  );
});
it("rejects malformed evidence and mismatched payment external store", () => {
  expect(calculate(input({ evidenceIds: [] }))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(
    calculate(input({ paymentFacts: [payment({ externalStoreId: "other-external-store" })] })),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
