import { expect, it } from "vitest";
import {
  MetricComputationV1Schema,
  type ExactMinorMath,
  type MetricQuality,
} from "@shopmate/contracts";
import type {
  ContributionRequest,
  MetricFee,
  MetricInputV1,
  MetricResult,
} from "@shopmate/contracts";
import {
  financeBaseGolden,
  financeMissingCostGolden,
} from "../../test/fixtures/metrics/finance-golden.fixture.js";
import { exactMinorMath } from "./exact-math.js";
import { createMetricWindowResolver } from "./metric-window.js";
import { createRefundMetricCalculator } from "./refund-metrics.js";
import { ACCEPTED_RESELLABLE_FROZEN_V1, createFrozenCostCalculator } from "./frozen-cost.js";
import { createContributionCalculator } from "./contribution-metrics.js";

const rounding = "HALF_AWAY_FROM_ZERO" as const;
const windows = createMetricWindowResolver({
  snapshot: () => ({ now: "2026-10-10T00:00:00Z", revision: 1 }),
});
const refunds = createRefundMetricCalculator({ math: exactMinorMath, windows, rounding });
const costs = createFrozenCostCalculator({ math: exactMinorMath, refunds, rounding });
const calculator = createContributionCalculator({ math: exactMinorMath, rounding });
const base = financeBaseGolden.input;
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function request(input: MetricInputV1 = base): ContributionRequest {
  const frozenCosts = value(costs.calculate(input, ACCEPTED_RESELLABLE_FROZEN_V1));
  return {
    input,
    frozenCosts,
    netBuyerShipping: {
      amountMinor: frozenCosts.netMerchandiseRevenue.quality.status === "UNAVAILABLE" ? null : 500,
      quality: frozenCosts.netMerchandiseRevenue.quality,
    },
  };
}
function run(input: MetricInputV1 = base) {
  return value(calculator.calculate(request(input)));
}
it("computes literal contribution 600 and estimated operating profit 400", () => {
  const result = run();
  expect(result.contribution.metric.value).toBe(600);
  expect(result.estimatedNetProfit.metric.value).toBe(400);
  expect(result.contribution.quality.status).toBe("VERIFIED");
  expect(result.excludedFeeKinds).toEqual([]);
});
it("keeps contribution verified when other operating expenses are unconfigured", () => {
  const result = run({
    ...base,
    fees: base.fees!.filter((row) => row.data!.kind !== "OTHER_OPERATING"),
  });
  expect(result.contribution.metric.value).toBe(600);
  expect(result.contribution.quality.status).toBe("VERIFIED");
  expect(result.estimatedNetProfit.metric.value).toBe(600);
  expect(result.estimatedNetProfit.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 8000,
  });
  expect(result.excludedFeeKinds).toEqual(["OTHER_OPERATING"]);
});
it("preserves missing frozen costs as null with literal 3333 coverage", () => {
  const result = run(financeMissingCostGolden.input);
  for (const row of [result.contribution, result.estimatedNetProfit]) {
    expect(row.metric.value).toBeNull();
    expect(row.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 3333 });
  }
});
it("never deducts the already applied 2000 discount again", () => {
  const req = request();
  expect(req.input.paymentFacts![0]!.data.discountMinor).toBe(2000);
  expect(req.frozenCosts.grossProfit.metric.value).toBe(2000);
  expect(value(calculator.calculate(req)).contribution.metric.value).toBe(600);
});
type FeeData = NonNullable<MetricFee["data"]>;
function fee(patch: Partial<FeeData> = {}, id = "changed-fee"): MetricFee {
  return { ...base.fees![0]!, evidenceIds: [id], data: { ...base.fees![0]!.data!, ...patch } };
}
function input(patch: Partial<MetricInputV1>): MetricInputV1 {
  const data = { ...base, ...patch };
  const metricCoverage = base.metricCoverage.map((proof) => ({
    ...proof,
    visibleAt: data.visibleAt,
    observedAt: data.visibleAt,
    sourceWatermark: data.sourceWatermark,
    collections: proof.collections.filter((key) => data[key] !== null),
  }));
  return { ...data, metricCoverage, ...patch };
}
function replaceFee(patch: Partial<FeeData>): MetricInputV1 {
  return input({ fees: [fee(patch), ...base.fees!.slice(1)] });
}
function rejected(
  req: ContributionRequest,
  code = "INVALID_INPUT",
  evidence: readonly string[] = [],
) {
  const result = calculator.calculate(req);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejection");
  expect(result.error.code).toBe(code);
  expect(result.error.evidenceIds).toEqual(expect.arrayContaining([...evidence]));
}
function anchoredRequest(): ContributionRequest {
  const req = request();
  const quality = { ...req.netBuyerShipping.quality, evidenceIds: ["golden-sync"] };
  return {
    ...req,
    frozenCosts: {
      ...req.frozenCosts,
      netMerchandiseRevenue: { ...req.frozenCosts.netMerchandiseRevenue, quality },
      cogs: { ...req.frozenCosts.cogs, quality },
      grossProfit: { ...req.frozenCosts.grossProfit, quality },
    },
    netBuyerShipping: { ...req.netBuyerShipping, quality },
  };
}
function snapshotContext(data: MetricInputV1) {
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
it("known empty fees disclose every category without asserting configured zero", () => {
  const result = run(input({ fees: [] }));
  expect(result.contribution.metric.value).toBe(2500);
  expect(result.estimatedNetProfit.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 0,
  });
  expect(result.excludedFeeKinds).toHaveLength(5);
});
it("explicit confirmed zero fees preserve verified profit", () => {
  const fees = base.fees!.map((row) => ({ ...row, data: { ...row.data!, amountMinor: 0 } }));
  const result = run(input({ fees }));
  expect(result.estimatedNetProfit.metric.value).toBe(2500);
  expect(result.estimatedNetProfit.quality.status).toBe("VERIFIED");
});
it("ambiguous null fee records degrade all categories", () => {
  const result = run(input({ fees: [...base.fees!, { ...fee(), data: null }] }));
  expect(result.contribution.metric.value).toBe(600);
  expect(result.contribution.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 0,
  });
  expect(result.excludedFeeKinds).toHaveLength(5);
});
it.each(["PLATFORM", "ADVERTISING_PROMOTION"] as const)(
  "excludes unknown %s with explicit evidence",
  (kind) => {
    const fees = base.fees!.map((row) =>
      row.data!.kind === kind
        ? { ...row, data: { ...row.data!, amountMinor: null, basis: "UNAVAILABLE" as const } }
        : row,
    );
    const result = run(input({ fees }));
    expect(result.contribution.metric.value).toBe(kind === "PLATFORM" ? 900 : 1400);
    expect(result.contribution.quality).toMatchObject({
      status: "ESTIMATED",
      coverageBasisPoints: 7500,
    });
    expect(result.excludedFeeKinds).toEqual([kind]);
    expect(result.contribution.quality.issues).toContainEqual(
      expect.objectContaining({ code: "FEE_MISSING", evidenceIds: [`fee-${kind}`] }),
    );
  },
);
it("subtracts partial known fees once and averages category coverage", () => {
  const result = run(replaceFee({ coverageBasisPoints: 5000 }));
  expect(result.contribution.metric.value).toBe(600);
  expect(result.contribution.quality.coverageBasisPoints).toBe(8750);
  expect(result.estimatedNetProfit.quality.coverageBasisPoints).toBe(9000);
  expect(result.contribution.quality.issues.map((row) => row.code)).toContain("PARTIAL_COVERAGE");
  expect(result.excludedFeeKinds).toEqual(["FULFILLMENT"]);
});
it("estimated zero fees stay estimated with complete category coverage", () => {
  const result = run(replaceFee({ amountMinor: 0, basis: "ESTIMATED" }));
  expect(result.contribution.metric.value).toBe(1300);
  expect(result.contribution.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 10000,
  });
  expect(result.contribution.quality.issues.map((row) => row.code)).toContain("FEE_ESTIMATED");
});
it.each([
  "paymentFacts",
  "refundFacts",
  "frozenCosts",
  "refundAllocations",
  "returnReceipts",
  "fees",
] as const)("null %s overrides a numeric upstream stub", (key) => {
  const req = { ...anchoredRequest(), input: input({ [key]: null }) };
  const result = value(calculator.calculate(req));
  for (const row of [result.contribution, result.estimatedNetProfit]) {
    expect(row.metric.value).toBeNull();
    expect(row.quality).toMatchObject({
      status: "UNAVAILABLE",
      sampleSize: 0,
      coverageBasisPoints: 0,
    });
    expect(row.quality.issues.map((item) => item.code)).toContain("NOT_SYNCHRONIZED");
  }
});
it("missing output proofs degrade each output independently", () => {
  const result = run(
    input({
      metricCoverage: base.metricCoverage.filter((row) => row.kind !== "ESTIMATED_NET_PROFIT"),
    }),
  );
  expect(result.contribution.quality.status).toBe("VERIFIED");
  expect(result.estimatedNetProfit.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 0,
  });
});
it("combines all matching proofs conservatively", () => {
  const proof = base.metricCoverage.find((row) => row.kind === "CONTRIBUTION")!;
  const result = run(
    input({ metricCoverage: [...base.metricCoverage, { ...proof, coverageBasisPoints: 4321 }] }),
  );
  expect(result.contribution.quality.coverageBasisPoints).toBe(4321);
  expect(result.estimatedNetProfit.quality.coverageBasisPoints).toBe(10000);
});
it("stale cutoff remains stale even when missing costs keep the value unknown", () => {
  const data = input({ visibleAt: "2026-10-03T16:00:00Z", sourceWatermark: base.visibleAt });
  const req = request(data);
  const grossProfit = {
    metric: { kind: "GROSS_PROFIT" as const, unit: "minorCNY" as const, value: null },
    quality: {
      ...req.frozenCosts.grossProfit.quality,
      status: "ESTIMATED" as const,
      coverageBasisPoints: 3333,
      issues: [{ code: "COST_MISSING" as const, field: "frozenCosts", evidenceIds: ["cost-a"] }],
    },
  };
  const result = value(
    calculator.calculate({ ...req, frozenCosts: { ...req.frozenCosts, grossProfit } }),
  );
  expect(result.contribution.metric.value).toBeNull();
  expect(result.contribution.quality.status).toBe("STALE");
});
it("sums different original cohort orders without treating sourceVersion as an identity", () => {
  const second = {
    ...base.paymentFacts![0]!,
    evidenceIds: ["payment-b"],
    data: { ...base.paymentFacts![0]!.data, externalOrderId: "order-b" },
  };
  const fees = [
    fee({ externalOrderId: "order-a", amountMinor: 300 }, "fee-a"),
    fee({ externalOrderId: "order-b", amountMinor: 400 }, "fee-b"),
    ...base.fees!.slice(1),
  ];
  const req = {
    ...request(),
    input: input({ fees, paymentFacts: [...base.paymentFacts!, second] }),
  };
  expect(value(calculator.calculate(req)).contribution.metric.value).toBe(600);
});
it.each(["same version", "different version", "aggregate overlap"])(
  "rejects duplicate fee recognition: %s",
  (mode) => {
    const extra = {
      ...fee({ externalOrderId: mode === "aggregate overlap" ? "order-a" : null }, "duplicate-fee"),
      sourceVersion: mode === "different version" ? "v2" : base.fees![0]!.sourceVersion,
    };
    rejected({ ...request(), input: input({ fees: [...base.fees!, extra] }) }, "CONFLICT", [
      "fee-FULFILLMENT",
      "duplicate-fee",
    ]);
  },
);
it("ignores identifiable unrelated orders and disjoint windows", () => {
  const unrelated = fee({ externalOrderId: "unrelated", amountMinor: 9000 });
  const disjoint = fee(
    { periodStart: "2026-09-30T16:00:00Z", periodEnd: base.periodStart, amountMinor: 9000 },
    "old-fee",
  );
  expect(run(input({ fees: [...base.fees!, unrelated, disjoint] })).contribution.metric.value).toBe(
    600,
  );
});
it.each([base.periodStart, "2026-10-02T00:00:00Z"])(
  "rejects nonmatching overlapping fee interval beginning %s",
  (periodStart) => {
    const data = replaceFee({ periodStart, periodEnd: "2026-10-02T15:00:00Z" });
    rejected({ ...request(), input: data }, "WINDOW_MISMATCH", ["changed-fee"]);
  },
);
it("recognizes equal fee instants with trailing zero precision", () => {
  const result = run(
    replaceFee({ periodStart: "2026-10-01T16:00:00.0000Z", periodEnd: "2026-10-02T16:00:00.000Z" }),
  );
  expect(result.contribution.metric.value).toBe(600);
});
function unknownShipping(quality: Partial<MetricQuality> = {}): ContributionRequest {
  const req = request();
  return {
    ...req,
    netBuyerShipping: {
      amountMinor: null,
      quality: {
        ...req.netBuyerShipping.quality,
        status: "INSUFFICIENT",
        issues: [{ code: "REFUND_UNKNOWN", field: "shipping", evidenceIds: ["refund-a"] }],
        ...quality,
      },
    },
  };
}
it("unknown shipping keeps both outputs null with dependency quality", () => {
  const result = value(calculator.calculate(unknownShipping()));
  expect(result.contribution.metric.value).toBeNull();
  expect(result.estimatedNetProfit.metric.value).toBeNull();
  expect(result.contribution.quality.status).toBe("INSUFFICIENT");
});
it("retains signed negative operating profit", () => {
  const result = run(replaceFee({ amountMinor: 3000 }));
  expect(result.contribution.metric.value).toBe(-1700);
  expect(result.estimatedNetProfit.metric.value).toBe(-1900);
});
it("does not freeze or mutate caller input and deep-freezes returned measures", () => {
  const req = structuredClone(request());
  const before = structuredClone(req);
  const result = value(calculator.calculate(req));
  expect(req).toEqual(before);
  expect(Object.isFrozen(req.input)).toBe(false);
  expect(Object.isFrozen(req.frozenCosts.grossProfit.quality.issues)).toBe(false);
  expect(Object.isFrozen(result.contribution.quality.issues)).toBe(true);
  expect(Object.isFrozen(result.feeCoverage[0])).toBe(true);
  expect(Object.isFrozen(result.excludedFeeKinds)).toBe(true);
});
it("copies dependency issues before deep freezing", () => {
  const req = structuredClone(unknownShipping());
  const result = value(calculator.calculate(req));
  expect(Object.isFrozen(req.netBuyerShipping.quality.issues[0])).toBe(false);
  expect(Object.isFrozen(req.netBuyerShipping.quality.issues[0]!.evidenceIds)).toBe(false);
  expect(Object.isFrozen(result.contribution.quality.issues[0])).toBe(true);
});
it.each([null, {}, { extra: true }, { frozenCosts: null }, { netBuyerShipping: null }])(
  "rejects malformed request %j",
  (patch) => {
    const req =
      patch === null || Object.keys(patch).length === 0 ? patch : { ...request(), ...patch };
    rejected(req as unknown as ContributionRequest);
  },
);
it.each([
  [
    "fractional shipping",
    (req: ContributionRequest) => ({
      ...req,
      netBuyerShipping: { ...req.netBuyerShipping, amountMinor: 0.5 },
    }),
  ],
  [
    "negative shipping",
    (req: ContributionRequest) => ({
      ...req,
      netBuyerShipping: { ...req.netBuyerShipping, amountMinor: -1 },
    }),
  ],
  [
    "unsafe shipping",
    (req: ContributionRequest) => ({
      ...req,
      netBuyerShipping: { ...req.netBuyerShipping, amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    }),
  ],
  [
    "unknown shipping keys",
    (req: ContributionRequest) => ({
      ...req,
      netBuyerShipping: { ...req.netBuyerShipping, extra: 1 },
    }),
  ],
  [
    "wrong gross kind",
    (req: ContributionRequest) => ({
      ...req,
      frozenCosts: { ...req.frozenCosts, grossProfit: req.frozenCosts.cogs },
    }),
  ],
  [
    "wrong gross units",
    (req: ContributionRequest) => ({
      ...req,
      frozenCosts: {
        ...req.frozenCosts,
        grossProfit: {
          ...req.frozenCosts.grossProfit,
          metric: { kind: "GROSS_PROFIT", unit: "units", value: 2000 },
        },
      },
    }),
  ],
  [
    "empty policy version",
    (req: ContributionRequest) => ({
      ...req,
      frozenCosts: { ...req.frozenCosts, policyVersion: "" },
    }),
  ],
  [
    "malformed reversal",
    (req: ContributionRequest) => ({
      ...req,
      frozenCosts: { ...req.frozenCosts, reversals: [{ reversedMinor: 1 }] },
    }),
  ],
  [
    "fractional gross",
    (req: ContributionRequest) => ({
      ...req,
      frozenCosts: {
        ...req.frozenCosts,
        grossProfit: {
          ...req.frozenCosts.grossProfit,
          metric: { ...req.frozenCosts.grossProfit.metric, value: 1.5 },
        },
      },
    }),
  ],
] as const)("rejects %s", (_label, change) => {
  rejected(change(request()) as ContributionRequest);
});
it.each([
  { status: "VERIFIED", coverageBasisPoints: 9000 },
  {
    status: "VERIFIED",
    issues: [{ code: "COST_MISSING", field: "cost", evidenceIds: ["cost-a"] }],
  },
  { status: "ESTIMATED", issues: [] },
  { status: "unknown" },
  { coverageBasisPoints: 10001 },
  { sampleSize: -1 },
  { evidenceIds: [] },
  { evidenceIds: ["not-source-evidence"] },
  { evidenceIds: ["golden-sync", "golden-sync"] },
  { issues: [{ code: "COST_MISSING", field: "cost", evidenceIds: [] }] },
  { issues: [{ code: "COST_MISSING", field: "cost", evidenceIds: ["not-source-evidence"] }] },
  { extra: true },
])("rejects malformed dependency quality %j", (patch) => {
  const req = request();
  rejected({
    ...req,
    netBuyerShipping: {
      ...req.netBuyerShipping,
      quality: { ...req.netBuyerShipping.quality, ...patch } as MetricQuality,
    },
  });
});
it("rejects verified unknown shipping", () => {
  rejected({
    ...request(),
    netBuyerShipping: { ...request().netBuyerShipping, amountMinor: null },
  });
});
it("rejects verified unknown gross profit", () => {
  const req = request();
  rejected({
    ...req,
    frozenCosts: {
      ...req.frozenCosts,
      grossProfit: {
        ...req.frozenCosts.grossProfit,
        metric: { ...req.frozenCosts.grossProfit.metric, value: null },
      },
    },
  });
});
it.each(["periodStart", "periodEnd", "observedAt"] as const)(
  "rejects nonzero submillisecond fee %s",
  (field) => {
    const row = fee();
    const malformed =
      field === "observedAt"
        ? { ...row, observedAt: "2026-10-02T16:00:00.0001Z" }
        : { ...row, data: { ...row.data!, [field]: `${row.data![field].slice(0, -1)}.0001Z` } };
    rejected({ ...request(), input: input({ fees: [malformed, ...base.fees!.slice(1)] }) });
  },
);
it.each(["periodStart", "periodEnd", "visibleAt", "sourceWatermark"] as const)(
  "rejects nonzero submillisecond context %s",
  (key) => {
    const data = input({ [key]: `${base[key]!.slice(0, -1)}.0001Z` });
    rejected({ ...request(), input: data });
  },
);
it("rejects submillisecond proof observation", () => {
  const metricCoverage = base.metricCoverage.map((row) => ({
    ...row,
    observedAt: "2026-10-02T16:00:00.0001Z",
  }));
  rejected({ ...request(), input: input({ metricCoverage }) });
});
it.each([
  { observedAt: "2026-10-03T16:00:00Z" },
  { binding: { ...base.binding, storeId: "other-store" } },
  { data: { ...base.fees![0]!.data!, currency: "USD" } },
  { data: { ...base.fees![0]!.data!, amountMinor: 0.5 } },
  { data: { ...base.fees![0]!.data!, extra: 1 } },
])("validates even unrelated fee rows before filtering %j", (patch) => {
  const row = { ...fee({ externalOrderId: "unrelated" }), ...patch } as MetricFee;
  rejected({ ...request(), input: input({ fees: [...base.fees!, row] }) });
});
it("requires explicit supported rounding", () => {
  const invalid = createContributionCalculator({
    math: exactMinorMath,
    rounding: undefined as unknown as "TOWARD_ZERO",
  });
  expect(invalid.calculate(request())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("uses supplied rounding for category mean", () => {
  const data = replaceFee({ coverageBasisPoints: 3 });
  const half = value(calculator.calculate(request(data)));
  const toward = createContributionCalculator({ math: exactMinorMath, rounding: "TOWARD_ZERO" });
  expect(half.contribution.quality.coverageBasisPoints).toBe(7501);
  expect(value(toward.calculate(request(data))).contribution.quality.coverageBasisPoints).toBe(
    7500,
  );
  expect(half.estimatedNetProfit.quality.coverageBasisPoints).toBe(8001);
});
it("rejects checked gross plus shipping overflow", () => {
  const req = request();
  const grossProfit = {
    ...req.frozenCosts.grossProfit,
    metric: { ...req.frozenCosts.grossProfit.metric, value: Number.MAX_SAFE_INTEGER },
  };
  rejected({ ...req, frozenCosts: { ...req.frozenCosts, grossProfit } }, "OVERFLOW");
});
it("rejects checked fee total overflow", () => {
  const fees = base.fees!.map((row) => ({
    ...row,
    data: { ...row.data!, amountMinor: Number.MAX_SAFE_INTEGER },
  }));
  rejected({ ...request(), input: input({ fees }) }, "OVERFLOW");
});
it("preserves typed math failure code and immutable copied evidence", () => {
  const evidence = ["math-proof", "math-proof"];
  const math: ExactMinorMath = {
    ...exactMinorMath,
    add: () => ({ ok: false, error: { code: "SOURCE_UNAVAILABLE", evidenceIds: evidence } }),
  };
  const result = createContributionCalculator({ math, rounding }).calculate(request());
  expect(result).toEqual({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["math-proof"] },
  });
  expect(Object.isFrozen(evidence)).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect(Object.isFrozen(result.error.evidenceIds)).toBe(true);
});
it("wraps each output in a valid public computation under unchanged context", () => {
  const result = run();
  const context = snapshotContext(base);
  for (const row of [result.contribution, result.estimatedNetProfit]) {
    expect(
      MetricComputationV1Schema.safeParse({
        input: base,
        snapshot: {
          ...context,
          ...row.quality,
          metric: row.metric,
          subject: { kind: "STORE" },
          computedAt: base.visibleAt,
        },
      }).success,
    ).toBe(true);
  }
});
it("upstream stale or insufficient unknown reasons cannot yield numeric profits", () => {
  const req = unknownShipping({
    status: "STALE",
    issues: [
      { code: "STALE_SOURCE", field: "shipping", evidenceIds: ["golden-sync"] },
      { code: "REFUND_UNKNOWN", field: "shipping", evidenceIds: ["refund-a"] },
    ],
  });
  const result = value(calculator.calculate(req));
  expect(result.contribution.quality.status).toBe("STALE");
  expect(result.contribution.metric.value).toBeNull();
});
it("unknown relevant payment overrides optimistic supplied gross and shipping", () => {
  const row = base.paymentFacts![0]!;
  const paymentFacts = [
    {
      ...row,
      data: {
        ...row.data,
        paidMinor: null,
        paidAt: null,
        source: {
          ...row.data.source,
          quality: { state: "PARTIAL" as const, issues: ["PAYMENT_UNKNOWN" as const] },
        },
      },
    },
  ];
  const req = { ...anchoredRequest(), input: input({ paymentFacts }) };
  const result = value(calculator.calculate(req));
  expect(result.contribution.metric.value).toBeNull();
  expect(result.contribution.quality.status).toBe("INSUFFICIENT");
  expect(result.contribution.quality.issues.map((row) => row.code)).toContain("PAYMENT_UNKNOWN");
});
it("cutoff freshness is checked independently of optimistic upstream quality", () => {
  const req = { ...anchoredRequest(), input: input({ visibleAt: "2026-10-03T16:00:00Z" }) };
  const result = value(calculator.calculate(req));
  expect(result.contribution.quality.status).toBe("STALE");
  expect(result.contribution.metric.value).toBe(600);
});
it("fully unsynchronized input returns unavailable unknown profit", () => {
  const data = {
    ...input({}),
    status: "UNAVAILABLE" as const,
    sourceWatermark: null,
    paymentFacts: null,
    refundFacts: null,
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    metricCoverage: [],
  };
  const result = run(data);
  expect(result.contribution.metric.value).toBeNull();
  expect(result.estimatedNetProfit.quality).toMatchObject({
    status: "UNAVAILABLE",
    sampleSize: 0,
    coverageBasisPoints: 0,
  });
});
it("unknown other expense preserves independent contribution verification", () => {
  const fees = base.fees!.map((row) =>
    row.data!.kind === "OTHER_OPERATING"
      ? { ...row, data: { ...row.data!, amountMinor: null, basis: "UNAVAILABLE" as const } }
      : row,
  );
  const result = run(input({ fees }));
  expect(result.contribution.quality.status).toBe("VERIFIED");
  expect(result.estimatedNetProfit.metric.value).toBe(600);
  expect(result.estimatedNetProfit.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 8000,
  });
});
it("fee category coverage is the minimum across different order rows", () => {
  const second = {
    ...base.paymentFacts![0]!,
    evidenceIds: ["payment-b"],
    data: { ...base.paymentFacts![0]!.data, externalOrderId: "order-b" },
  };
  const fees = [
    fee({ externalOrderId: "order-a", amountMinor: 300, coverageBasisPoints: 2000 }, "fee-a"),
    fee({ externalOrderId: "order-b", amountMinor: 400, coverageBasisPoints: 9000 }, "fee-b"),
    ...base.fees!.slice(1),
  ];
  const result = value(
    calculator.calculate({
      ...anchoredRequest(),
      input: input({ fees, paymentFacts: [...base.paymentFacts!, second] }),
    }),
  );
  expect(result.feeCoverage[0]).toEqual({ kind: "FULFILLMENT", coverageBasisPoints: 2000 });
  expect(result.contribution.quality.coverageBasisPoints).toBe(8000);
  expect(result.contribution.metric.value).toBe(600);
});
it("calculates net profit by subtracting other expense from checked contribution", () => {
  const req = request();
  const fees = base.fees!.map((row) => ({
    ...row,
    data: {
      ...row.data!,
      amountMinor:
        row.data!.kind === "FULFILLMENT"
          ? Number.MAX_SAFE_INTEGER
          : row.data!.kind === "OTHER_OPERATING"
            ? 1
            : 0,
    },
  }));
  const grossProfit = {
    ...req.frozenCosts.grossProfit,
    metric: { ...req.frozenCosts.grossProfit.metric, value: Number.MAX_SAFE_INTEGER },
  };
  const result = value(
    calculator.calculate({
      ...req,
      frozenCosts: { ...req.frozenCosts, grossProfit },
      input: input({ fees }),
      netBuyerShipping: { ...req.netBuyerShipping, amountMinor: 0 },
    }),
  );
  expect(result.contribution.metric.value).toBe(0);
  expect(result.estimatedNetProfit.metric.value).toBe(-1);
});
it("partial source proofs require all source domains for this output", () => {
  const metricCoverage = base.metricCoverage.map((row) =>
    row.kind === "CONTRIBUTION"
      ? { ...row, collections: row.collections.filter((key) => key !== "fees") }
      : row,
  );
  const result = run(input({ metricCoverage }));
  expect(result.contribution.quality).toMatchObject({
    status: "ESTIMATED",
    coverageBasisPoints: 0,
  });
  expect(result.estimatedNetProfit.quality.status).toBe("VERIFIED");
});
it("uses minimum independent upstream sample and coverage", () => {
  const req = request();
  const quality = {
    ...req.netBuyerShipping.quality,
    status: "ESTIMATED" as const,
    sampleSize: 0,
    coverageBasisPoints: 3210,
    issues: [
      { code: "PARTIAL_COVERAGE" as const, field: "shipping", evidenceIds: ["golden-sync"] },
    ],
  };
  const result = value(
    calculator.calculate({ ...req, netBuyerShipping: { ...req.netBuyerShipping, quality } }),
  );
  expect(result.contribution.quality).toMatchObject({
    status: "ESTIMATED",
    sampleSize: 0,
    coverageBasisPoints: 3210,
  });
});
it("retains matching output proof evidence from optional source collections", () => {
  const traffic = [{ ...base.fees![0]!, evidenceIds: ["optional-proof"], data: null }];
  const metricCoverage = base.metricCoverage.map((row) =>
    row.kind === "CONTRIBUTION" ? { ...row, evidenceIds: ["optional-proof"] } : row,
  );
  const result = run(input({ traffic, metricCoverage }));
  expect(result.contribution.quality.status).toBe("VERIFIED");
  expect(result.contribution.quality.evidenceIds).toContain("optional-proof");
});
it("accepts publicly valid upstream evidence from an optional supplied fact", () => {
  const req = anchoredRequest();
  const traffic = [{ ...base.fees![0]!, evidenceIds: ["optional-proof"], data: null }];
  const grossProfit = {
    ...req.frozenCosts.grossProfit,
    quality: { ...req.frozenCosts.grossProfit.quality, evidenceIds: ["optional-proof"] },
  };
  const result = value(
    calculator.calculate({
      ...req,
      input: input({ traffic }),
      frozenCosts: { ...req.frozenCosts, grossProfit },
    }),
  );
  expect(result.contribution.quality.evidenceIds).toContain("optional-proof");
});
