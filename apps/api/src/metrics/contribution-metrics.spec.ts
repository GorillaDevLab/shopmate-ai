import { expect, it } from "vitest";
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
    netBuyerShipping: { amountMinor: 500, quality: frozenCosts.netMerchandiseRevenue.quality },
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
  expect(result.error.evidenceIds).toEqual(expect.arrayContaining(evidence));
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
  const req = { ...request(), input: input({ [key]: null }) };
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
