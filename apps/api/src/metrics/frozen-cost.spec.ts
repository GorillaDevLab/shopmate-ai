import { expect, it, vi } from "vitest";
import {
  DataQualityIssueV1Schema,
  MetricComputationV1Schema,
  MetricValueSchema,
  type ConnectorOrder,
  type ConnectorRefund,
  type ExactMinorMath,
  type FrozenCostMetrics,
  type MetricInputV1,
  type MetricResult,
  type MinorRounding,
  type RefundMetricCalculator,
  type ReturnCostPolicyV1,
} from "@shopmate/contracts";
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
const originalCost = base.frozenCosts![0]!;
const originalAllocation = base.refundAllocations![0]!;
const originalReceipt = financeAcceptedReturnGolden.input.returnReceipts![0]!;
type CostData = NonNullable<typeof originalCost.data>;
type AllocationData = NonNullable<typeof originalAllocation.data>;
type ReceiptData = NonNullable<typeof originalReceipt.data>;
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  const data = { ...base, ...patch };
  const metricCoverage = base.metricCoverage.map((proof) => ({
    ...proof,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    visibleAt: data.visibleAt,
    observedAt: data.visibleAt,
    sourceWatermark: data.sourceWatermark,
    inputRevision: data.inputRevision,
    collections: proof.collections.filter((key) => data[key] !== null),
  }));
  return { ...data, metricCoverage, ...patch };
}
function cost(patch: Partial<CostData> = {}, id = "cost-modified") {
  return { ...originalCost, evidenceIds: [id], data: { ...originalCost.data!, ...patch } };
}
function allocation(patch: Partial<AllocationData> = {}, id = "allocation-modified") {
  return {
    ...originalAllocation,
    evidenceIds: [id],
    data: { ...originalAllocation.data!, ...patch },
  };
}
function receipt(patch: Partial<ReceiptData> = {}, id = "receipt-modified") {
  return { ...originalReceipt, evidenceIds: [id], data: { ...originalReceipt.data!, ...patch } };
}
function refund(patch: Partial<ConnectorRefund> = {}, id = "refund-a") {
  const original = base.refundFacts![0]!;
  return {
    ...original,
    evidenceIds: [id],
    data: { ...original.data, externalRefundId: id, ...patch },
  };
}
function payment(patch: Partial<ConnectorOrder> = {}, id = "order-a") {
  const original = base.paymentFacts![0]!;
  return {
    ...original,
    evidenceIds: [id],
    data: { ...original.data, externalOrderId: id, ...patch },
  };
}
function error(data: MetricInputV1, code = "CONFLICT", evidence?: string[]) {
  const result = calculator.calculate(data, policy);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejected metric input");
  expect(result.error.code).toBe(code);
  if (evidence) expect(result.error.evidenceIds).toEqual(expect.arrayContaining(evidence));
}
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
it.each([
  ["duplicate frozen cost", () => ({ frozenCosts: [...base.frozenCosts!, cost()] })],
  ["wrong frozen cost SKU", () => ({ frozenCosts: [cost({ externalSkuId: "wrong" })] })],
  ["wrong frozen cost line", () => ({ frozenCosts: [cost({ externalLineId: "wrong" })] })],
  ["wrong sold quantity", () => ({ frozenCosts: [cost({ quantity: 2 })] })],
  [
    "later frozen timestamp",
    () => ({ frozenCosts: [cost({ frozenAt: "2026-10-02T00:00:01Z" }), base.frozenCosts![1]!] }),
  ],
  [
    "duplicate refund allocation",
    () => ({ refundAllocations: [originalAllocation, allocation()] }),
  ],
  [
    "allocation wrong order",
    () => ({ refundAllocations: [allocation({ externalOrderId: "wrong" })] }),
  ],
  ["allocation wrong SKU", () => ({ refundAllocations: [allocation({ externalSkuId: "wrong" })] })],
  [
    "allocation wrong line",
    () => ({ refundAllocations: [allocation({ externalLineId: "wrong" })] }),
  ],
  [
    "allocation wrong refund",
    () => ({ refundAllocations: [allocation({ externalRefundId: "wrong" })] }),
  ],
  [
    "allocation not conserving",
    () => ({ refundAllocations: [allocation({ merchandiseMinor: 1999 })] }),
  ],
  ["duplicate receipt", () => ({ returnReceipts: [originalReceipt, receipt()] })],
  ["receipt wrong SKU", () => ({ returnReceipts: [receipt({ externalSkuId: "wrong" })] })],
  ["receipt wrong line", () => ({ returnReceipts: [receipt({ externalLineId: "wrong" })] })],
  ["receipt wrong refund", () => ({ returnReceipts: [receipt({ externalRefundId: "wrong" })] })],
  [
    "receipt wrong order for known refund",
    () => ({ returnReceipts: [receipt({ externalOrderId: "wrong" })] }),
  ],
  [
    "receipt before payment",
    () => ({ returnReceipts: [receipt({ acceptedAt: "2026-10-01T23:59:59Z" })] }),
  ],
  ["excess returned units", () => ({ returnReceipts: [receipt({ resellableQuantity: 2 })] })],
  [
    "cumulative returned units",
    () => ({ returnReceipts: [originalReceipt, receipt({ externalReceiptId: "receipt-b" })] }),
  ],
] satisfies [string, () => Partial<MetricInputV1>][])(
  "rejects %s with typed conflict",
  (_name, patch) => {
    let data = input(patch());
    if (_name === "later frozen timestamp")
      data = input({
        frozenCosts: data.frozenCosts!.map((row) => ({ ...row, observedAt: base.visibleAt })),
      });
    error(data);
  },
);
it("preserves both records' evidence on duplicate cost", () => {
  error(input({ frozenCosts: [...base.frozenCosts!, cost()] }), "CONFLICT", [
    "cost-a",
    "cost-modified",
  ]);
});
it.each([
  [
    "cost frozenAt",
    () => input({ frozenCosts: [cost({ frozenAt: "2026-10-02T00:00:00.0001Z" })] }),
  ],
  [
    "cost observedAt",
    () => input({ frozenCosts: [{ ...originalCost, observedAt: "2026-10-02T00:00:00.0001Z" }] }),
  ],
  [
    "allocation observedAt",
    () =>
      input({
        refundAllocations: [{ ...originalAllocation, observedAt: "2026-10-02T15:00:00.0001Z" }],
      }),
  ],
  [
    "receipt acceptedAt",
    () => input({ returnReceipts: [receipt({ acceptedAt: "2026-10-02T09:00:00.0001Z" })] }),
  ],
  [
    "receipt observedAt",
    () =>
      input({ returnReceipts: [{ ...originalReceipt, observedAt: "2026-10-02T10:00:00.0001Z" }] }),
  ],
] satisfies [string, () => MetricInputV1][])("rejects nonzero submillisecond %s", (_name, data) => {
  error(data(), "INVALID_INPUT");
});
it("discloses an ambiguous null cost record even alongside all known line costs", () => {
  const result = run(
    input({ frozenCosts: [...base.frozenCosts!, { ...originalCost, data: null }] }),
  );
  expect(result.cogs.metric.value).toBeNull();
  expect(result.cogs.quality.status).toBe("ESTIMATED");
  expect(result.cogs.quality.issues.map((row) => row.code)).toContain("COST_MISSING");
});
it("discloses ambiguous null allocation data", () => {
  const result = run(
    input({
      refundAllocations: [...base.refundAllocations!, { ...originalAllocation, data: null }],
    }),
  );
  expect(result.netMerchandiseRevenue.metric.value).toBeNull();
  expect(result.netMerchandiseRevenue.quality.status).toBe("INSUFFICIENT");
});
it("preserves precise original COGS for known pending acceptance", () => {
  const result = run(input({ returnReceipts: [receipt({ acceptedAt: null })] }));
  expect(result.reversals).toEqual([]);
  expect(result.cogs.metric.value).toBe(6000);
  expect(result.cogs.quality.status).toBe("VERIFIED");
});
it("rejects merchandise allocated above the original sold line net", () => {
  error(
    input({
      refundFacts: [refund({ requestedMinor: 2500, succeededMinor: 2500 })],
      refundAllocations: [allocation({ merchandiseMinor: 2500 })],
    }),
  );
});
it("rejects cumulative merchandise allocations across refund IDs above line net", () => {
  error(
    input({
      refundFacts: [refund(), refund({ requestedMinor: 1, succeededMinor: 1 }, "refund-b")],
      refundAllocations: [
        originalAllocation,
        allocation({ externalRefundId: "refund-b", merchandiseMinor: 1 }),
      ],
    }),
  );
});
it("rejects shipping allocations above the original buyer shipping", () => {
  error(
    input({ refundAllocations: [allocation({ merchandiseMinor: 1400, buyerShippingMinor: 600 })] }),
  );
});
it("rejects cumulative shipping over multiple refund IDs", () => {
  error(
    input({
      refundFacts: [
        refund({ requestedMinor: 300, succeededMinor: 300 }),
        refund({ requestedMinor: 300, succeededMinor: 300 }, "refund-b"),
      ],
      refundAllocations: [
        allocation({ merchandiseMinor: 0, buyerShippingMinor: 300 }),
        allocation(
          { externalRefundId: "refund-b", merchandiseMinor: 0, buyerShippingMinor: 300 },
          "shipping-b",
        ),
      ],
    }),
  );
});
it("subtracts merchandise only from a mixed shipping refund", () => {
  const result = run(
    input({ refundAllocations: [allocation({ merchandiseMinor: 1500, buyerShippingMinor: 500 })] }),
  );
  expect(amounts(result)).toEqual([8500, 6000, 2500]);
});
it("leaves merchandise revenue unchanged for shipping-only refunds", () => {
  const result = run(
    input({
      refundFacts: [refund({ requestedMinor: 500, succeededMinor: 500 })],
      refundAllocations: [allocation({ merchandiseMinor: 0, buyerShippingMinor: 500 })],
    }),
  );
  expect(amounts(result)).toEqual([10000, 6000, 4000]);
});
it("conserves multiple explicit merchandise allocations for a single refund", () => {
  const result = run(
    input({
      refundFacts: [refund({ externalSkuId: null })],
      refundAllocations: [
        allocation({ merchandiseMinor: 1000 }),
        allocation(
          { externalLineId: "line-b", externalSkuId: "sku-b", merchandiseMinor: 1000 },
          "allocation-b",
        ),
      ],
    }),
  );
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
});
it("keeps refunds in the paid cohort after periodEnd through the new cutoff", () => {
  const laterRefund = refund({
    requestedAt: "2026-10-03T07:00:00Z",
    succeededAt: "2026-10-03T08:00:00Z",
  });
  const later = input({
    visibleAt: "2026-10-04T16:00:00Z",
    sourceWatermark: "2026-10-04T16:00:00Z",
    inputRevision: "later-v2",
    refundFacts: [{ ...laterRefund, observedAt: "2026-10-03T08:00:00Z" }],
    refundAllocations: [{ ...originalAllocation, observedAt: "2026-10-03T09:00:00Z" }],
    returnReceipts: [
      { ...receipt({ acceptedAt: "2026-10-03T10:00:00Z" }), observedAt: "2026-10-03T10:00:00Z" },
    ],
  });
  const earlier = input({ refundFacts: [], refundAllocations: [], returnReceipts: [] });
  expect(amounts(run(earlier))).toEqual([10000, 6000, 4000]);
  expect(amounts(run(later))).toEqual([8000, 5000, 3000]);
  expect(amounts(run(earlier))).toEqual([10000, 6000, 4000]);
  expect(later.paymentFacts![0]!.data.paidMinor).toBe(10500);
});
it("permits receipt acceptance before refund success, after original payment", () => {
  const result = run(input({ returnReceipts: [receipt({ acceptedAt: "2026-10-02T06:00:00Z" })] }));
  expect(amounts(result)).toEqual([8000, 5000, 3000]);
});
it("supports multiple partial receipts for the same frozen line", () => {
  const result = run(
    input({
      refundFacts: [refund({ externalSkuId: "sku-b" })],
      refundAllocations: [allocation({ externalLineId: "line-b", externalSkuId: "sku-b" })],
      returnReceipts: [
        receipt({ externalLineId: "line-b", externalSkuId: "sku-b" }),
        receipt(
          { externalReceiptId: "receipt-b", externalLineId: "line-b", externalSkuId: "sku-b" },
          "receipt-b",
        ),
      ],
    }),
  );
  expect(amounts(result)).toEqual([8000, 1000, 7000]);
  expect(result.reversals.map((row) => row.reversedMinor)).toEqual([2500, 2500]);
});
it("keeps non-resellable physical goods in original COGS", () => {
  expect(amounts(run(input({ returnReceipts: [receipt({ resellableQuantity: 0 })] })))).toEqual([
    8000, 6000, 2000,
  ]);
});
it("keeps planned allocations and receipts of a requested refund out of totals", () => {
  const result = run(
    input({
      refundFacts: [refund({ status: "REQUESTED", succeededAt: null, succeededMinor: null })],
      returnReceipts: [originalReceipt],
    }),
  );
  expect(amounts(result)).toEqual([10000, 6000, 4000]);
  expect(result.reversals).toEqual([]);
});
it.each([
  ["missing allocations", { refundAllocations: [] }],
  ["unknown merchandise", { refundAllocations: [allocation({ merchandiseMinor: null })] }],
  ["unknown buyer shipping", { refundAllocations: [allocation({ buyerShippingMinor: null })] }],
] satisfies [string, Partial<MetricInputV1>][])(
  "discloses %s as refund uncertainty",
  (_name, patch) => {
    const result = run(input(patch));
    expect(amounts(result)).toEqual([null, null, null]);
    expect(result.netMerchandiseRevenue.quality.status).toBe("INSUFFICIENT");
    expect(result.netMerchandiseRevenue.quality.issues.map((row) => row.code)).toContain(
      "REFUND_UNKNOWN",
    );
  },
);
it.each([
  ["unknown resellability", [receipt({ resellableQuantity: null })]],
  ["unknown receipt data", [{ ...originalReceipt, data: null }]],
  ["unknown pending receipt", [receipt({ acceptedAt: null, resellableQuantity: null })]],
] satisfies [string, MetricInputV1["returnReceipts"]][])(
  "discloses %s without inventing reversal evidence",
  (_name, returnReceipts) => {
    const result = run(input({ returnReceipts }));
    expect(amounts(result)).toEqual([8000, null, null]);
    expect(result.cogs.quality.status).toBe("INSUFFICIENT");
    expect(result.reversals).toEqual([]);
  },
);
it("does not invent reversal evidence for a return with unavailable frozen cost", () => {
  const result = run(
    input({
      ...financeMissingCostGolden.input,
      frozenCosts: [
        cost({ basis: "UNAVAILABLE", unitCostMinor: null, skuCostVersion: null }),
        base.frozenCosts![1]!,
      ],
      returnReceipts: [originalReceipt],
    }),
  );
  expect(result.reversals).toEqual([]);
  expect(result.cogs.metric.value).toBeNull();
});
