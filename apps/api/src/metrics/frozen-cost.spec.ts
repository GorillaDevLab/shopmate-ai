import { expect, it } from "vitest";
import type { FrozenCostMetrics, MetricInputV1, MetricResult } from "@shopmate/contracts";
import {
  financeAcceptedReturnGolden,
  financeBaseGolden,
  financeMissingCostGolden,
  financeRefundOnlyGolden,
} from "../../test/fixtures/metrics/finance-golden.fixture.js";
import { exactMinorMath } from "./exact-math.js";
import { createMetricWindowResolver } from "./metric-window.js";
import { createRefundMetricCalculator } from "./refund-metrics.js";
import { createFrozenCostCalculator } from "./frozen-cost.js";

const rounding = "HALF_AWAY_FROM_ZERO" as const;
const windows = createMetricWindowResolver({
  snapshot: () => ({ now: "2026-10-10T00:00:00Z", revision: 1 }),
});
const refunds = createRefundMetricCalculator({ math: exactMinorMath, windows, rounding });
const calculator = createFrozenCostCalculator({ math: exactMinorMath, refunds, rounding });
const policy = {
  schemaVersion: 1,
  version: "accepted-resellable-frozen-v1",
  reversalBasis: "ACCEPTED_RESELLABLE_RETURN",
  costBasis: "FROZEN_TRANSACTION_COST",
} as const;
const base = financeBaseGolden.input;
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function run(data: MetricInputV1 = base): FrozenCostMetrics {
  return value(calculator.calculate(data, policy));
}
function amounts(result: FrozenCostMetrics) {
  return [result.netMerchandiseRevenue, result.cogs, result.grossProfit].map(
    (row) => row.metric.value,
  );
}
it("computes literal G4 merchandise revenue, frozen COGS and profit", () => {
  const result = run();
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
  expect(result.policyVersion).toBe("accepted-resellable-frozen-v1");
  expect(result.cogs.quality.status).toBe("VERIFIED");
});
it("retains all frozen cost for a monetary-only refund", () => {
  const result = run(financeRefundOnlyGolden.input);
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
  expect(result.reversals).toEqual([]);
});
it("reverses only the original accepted resellable unit cost", () => {
  const result = run(financeAcceptedReturnGolden.input);
  expect(amounts(result)).toEqual([8000, 5000, 3000]);
  expect(result.reversals[0]).toMatchObject({
    externalReceiptId: "receipt-a",
    skuCostVersion: "sku-a-cost-2026-09-v1",
    reversedQuantity: 1,
    reversedMinor: 1000,
  });
});
it("discloses missing two-of-three cost units without erasing revenue", () => {
  const result = run(financeMissingCostGolden.input);
  expect(amounts(result)).toEqual([8000, null, null]);
  expect(result.cogs.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 3333 });
  expect(result.cogs.quality.issues.map((row) => row.code)).toContain("COST_MISSING");
  expect(result.netMerchandiseRevenue.quality.status).toBe("VERIFIED");
});
