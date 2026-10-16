import { expect, it } from "vitest";
import type { ContributionRequest, MetricInputV1, MetricResult } from "@shopmate/contracts";
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
