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
it.each([
  "paymentFacts",
  "refundFacts",
  "refundAllocations",
  "frozenCosts",
  "returnReceipts",
] as const)("keeps null %s unavailable for its dependent measures", (key) => {
  const result = run(input({ [key]: null }));
  expect(result.cogs.metric.value).toBeNull();
  expect(result.cogs.quality).toMatchObject({
    status: "UNAVAILABLE",
    coverageBasisPoints: 0,
    sampleSize: 0,
  });
  expect(result.cogs.quality.issues.map((row) => row.code)).toContain("NOT_SYNCHRONIZED");
  const netMissing = ["paymentFacts", "refundFacts", "refundAllocations"].includes(key);
  expect(result.netMerchandiseRevenue.metric.value).toBe(netMissing ? null : 8000);
});
it("preserves completely unsynchronized source availability", () => {
  const data = input({
    paymentFacts: null,
    refundFacts: null,
    refundAllocations: null,
    frozenCosts: null,
    returnReceipts: null,
    fees: null,
    status: "UNAVAILABLE",
    sourceWatermark: null,
    metricCoverage: [],
  });
  const result = run(data);
  expect(amounts(result)).toEqual([null, null, null]);
  expect(result.netMerchandiseRevenue.quality.status).toBe("UNAVAILABLE");
});
it("verifies observed empty collections with complete per-kind proof", () => {
  const result = run(
    input({
      paymentFacts: [],
      refundFacts: [],
      refundAllocations: [],
      frozenCosts: [],
      returnReceipts: [],
    }),
  );
  expect(amounts(result)).toEqual([0, 0, 0]);
  expect(result.cogs.quality).toMatchObject({
    status: "VERIFIED",
    sampleSize: 0,
    coverageBasisPoints: 10000,
  });
});
it("keeps an absent frozen line missing with actual known unit coverage", () => {
  const result = run(input({ frozenCosts: [originalCost] }));
  expect(amounts(result)).toEqual([8000, null, null]);
  expect(result.cogs.quality.coverageBasisPoints).toBe(3333);
});
it("preserves confirmed zero historical unit costs", () => {
  const result = run(input({ frozenCosts: [cost({ unitCostMinor: 0 }), base.frozenCosts![1]!] }));
  expect(amounts(result)).toEqual([8000, 5000, 3000]);
  expect(result.cogs.quality.status).toBe("VERIFIED");
});
it("labels estimated frozen costs and uses their original version on returns", () => {
  const result = run(
    input({
      frozenCosts: [cost({ basis: "ESTIMATED", unitCostMinor: 1200 }), base.frozenCosts![1]!],
      returnReceipts: [originalReceipt],
    }),
  );
  expect(amounts(result)).toEqual([8000, 5000, 3000]);
  expect(result.cogs.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 10000 });
  expect(result.reversals[0]).toMatchObject({
    skuCostVersion: originalCost.data!.skuCostVersion,
    reversedMinor: 1200,
  });
  expect(result.netMerchandiseRevenue.quality.status).toBe("VERIFIED");
});
it.each(["CANCELLED", "CLOSED"] as const)("includes known paid %s orders", (status) => {
  expect(amounts(run(input({ paymentFacts: [payment({ status })] })))).toEqual([8000, 6000, 2000]);
});
it("excludes known unpaid orders even when payable is positive", () => {
  const result = run(
    input({
      paymentFacts: [payment({ status: "PENDING_PAYMENT", paidAt: null, paidMinor: 0 })],
      refundFacts: [],
      refundAllocations: [],
      frozenCosts: [],
      returnReceipts: [],
    }),
  );
  expect(amounts(result)).toEqual([0, 0, 0]);
  expect(result.cogs.quality.sampleSize).toBe(0);
});
it("includes genuinely paid free merchandise without inventing paid revenue", () => {
  const order = payment({
    items: base.paymentFacts![0]!.data.items.map((item) => ({
      ...item,
      discountMinor: item.grossMinor,
      netMinor: 0,
    })),
    discountMinor: 12000,
    shippingMinor: 0,
    payableMinor: 0,
    paidMinor: 0,
  });
  const result = run(input({ paymentFacts: [order], refundFacts: [], refundAllocations: [] }));
  expect(amounts(result)).toEqual([0, 6000, -6000]);
  expect(result.cogs.quality.sampleSize).toBe(1);
});
it("does not infer unknown payments from payable amounts", () => {
  const original = base.paymentFacts![0]!.data.source;
  const result = run(
    input({
      paymentFacts: [
        payment({
          paidMinor: null,
          source: { ...original, quality: { state: "PARTIAL", issues: ["PAYMENT_UNKNOWN"] } },
        }),
      ],
    }),
  );
  expect(amounts(result)).toEqual([null, null, null]);
  expect(result.netMerchandiseRevenue.quality.status).toBe("INSUFFICIENT");
});
it("does not treat unreconciled actual paid amounts as known", () => {
  const original = base.paymentFacts![0]!.data.source;
  const result = run(
    input({
      paymentFacts: [
        payment({
          paidMinor: 10000,
          source: { ...original, quality: { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] } },
        }),
      ],
    }),
  );
  expect(amounts(result)).toEqual([null, null, null]);
});
it("retains source-time missing reasons and avoids verified output", () => {
  const source = {
    ...base.paymentFacts![0]!.data.source,
    updatedAt: null,
    quality: { state: "PARTIAL" as const, issues: ["SOURCE_TIME_MISSING" as const] },
  };
  const result = run(input({ paymentFacts: [payment({ source })] }));
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
  expect(result.cogs.quality.status).toBe("ESTIMATED");
});
it("ignores unrelated cost flags when revenue facts are independently known", () => {
  const source = {
    ...base.paymentFacts![0]!.data.source,
    quality: { state: "PARTIAL" as const, issues: ["COST_MISSING" as const] },
  };
  expect(
    run(input({ paymentFacts: [payment({ source })] })).netMerchandiseRevenue.quality.status,
  ).toBe("VERIFIED");
});
it("requires as-of-cutoff freshness even when the sale window is already complete", () => {
  const result = run(input({ visibleAt: "2026-10-03T16:00:00Z" }));
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
  expect(result.cogs.quality.status).toBe("STALE");
});
it("keeps unknown amounts null when stale precedence outranks insufficient", () => {
  const result = run(input({ visibleAt: "2026-10-03T16:00:00Z", refundAllocations: [] }));
  expect(amounts(result)).toEqual([null, null, null]);
  expect(result.cogs.quality.status).toBe("STALE");
  expect(result.cogs.quality.issues.map((row) => row.code)).toEqual(
    expect.arrayContaining(["REFUND_UNKNOWN", "STALE_SOURCE"]),
  );
});
it("uses the conservative minimum of matching source proofs", () => {
  const proof = base.metricCoverage.find((row) => row.kind === "COGS")!;
  const result = run(
    input({ metricCoverage: [...base.metricCoverage, { ...proof, coverageBasisPoints: 2500 }] }),
  );
  expect(result.cogs.metric.value).toBe(6000);
  expect(result.cogs.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 2500 });
  expect(result.netMerchandiseRevenue.quality.status).toBe("VERIFIED");
});
it("does not infer completeness without matching kind/store/collections proof", () => {
  const result = run(input({ metricCoverage: [] }));
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
  expect(result.cogs.quality).toMatchObject({ status: "ESTIMATED", coverageBasisPoints: 0 });
});
it("keeps explicitly unrelated extension facts outside cohort amounts", () => {
  const result = run(
    input({
      frozenCosts: [...base.frozenCosts!, cost({ externalOrderId: "other-order" })],
      refundAllocations: [
        ...base.refundAllocations!,
        allocation({ externalOrderId: "other-order", externalRefundId: "other-refund" }),
      ],
      returnReceipts: [
        receipt({ externalOrderId: "other-order", externalRefundId: "other-refund" }),
      ],
    }),
  );
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
});
it("does not infer an included line's cost from a matching SKU on another order", () => {
  const result = run(
    input({ frozenCosts: [cost({ externalOrderId: "other-order" }), base.frozenCosts![1]!] }),
  );
  expect(result.cogs.metric.value).toBeNull();
  expect(result.cogs.quality.coverageBasisPoints).toBe(6667);
});
it("preserves original historical version and all supporting reversal evidence", () => {
  const result = run(financeAcceptedReturnGolden.input);
  expect(result.reversals[0]!.evidenceIds).toEqual(
    expect.arrayContaining(["cost-a", "receipt-a", "refund-a", "payment-a", "refund-allocation-a"]),
  );
  expect(new Set(result.reversals[0]!.evidenceIds).size).toBe(
    result.reversals[0]!.evidenceIds.length,
  );
});
it("rejects duplicate historical versions rather than substituting newer catalog cost", () => {
  error(
    input({
      frozenCosts: [
        ...base.frozenCosts!,
        cost({ skuCostVersion: "later-catalog-v2", unitCostMinor: 9999 }),
      ],
    }),
  );
});
it.each([
  [
    "future cost",
    () => input({ frozenCosts: [{ ...originalCost, observedAt: "2026-10-03T00:00:00Z" }] }),
  ],
  [
    "future acceptance",
    () => input({ returnReceipts: [receipt({ acceptedAt: "2026-10-03T00:00:00Z" })] }),
  ],
  [
    "future allocation",
    () =>
      input({ refundAllocations: [{ ...originalAllocation, observedAt: "2026-10-03T00:00:00Z" }] }),
  ],
  ["future source watermark", () => input({ sourceWatermark: "2026-10-03T00:00:00Z" })],
  [
    "cross scope",
    () =>
      input({ frozenCosts: [{ ...originalCost, binding: { ...base.binding, storeId: "wrong" } }] }),
  ],
  ["non-CNY cost", () => input({ frozenCosts: [cost({ currency: "USD" as "CNY" })] })],
  [
    "non-CNY allocation",
    () => input({ refundAllocations: [allocation({ currency: "USD" as "CNY" })] }),
  ],
  ["fractional cost", () => input({ frozenCosts: [cost({ unitCostMinor: 1.5 })] })],
  [
    "negative return quantity",
    () => input({ returnReceipts: [receipt({ resellableQuantity: -1 })] }),
  ],
  ["nonzero subms context", () => input({ visibleAt: "2026-10-02T16:00:00.0001Z" })],
  [
    "nonzero subms proof",
    () =>
      input({
        metricCoverage: base.metricCoverage.map((row) => ({
          ...row,
          observedAt: "2026-10-02T15:59:59.0001Z",
        })),
      }),
  ],
  [
    "nonzero subms payment source",
    () =>
      input({
        paymentFacts: [
          payment({
            source: {
              ...base.paymentFacts![0]!.data.source,
              updatedAt: "2026-10-01T23:59:59.0001Z",
            },
          }),
        ],
      }),
  ],
  [
    "nonzero subms refund source",
    () =>
      input({
        refundFacts: [
          refund({
            source: {
              ...base.refundFacts![0]!.data.source,
              updatedAt: "2026-10-02T07:59:59.0001Z",
            },
          }),
        ],
      }),
  ],
] satisfies [string, () => MetricInputV1][])("rejects malformed %s", (_name, data) => {
  error(data(), "INVALID_INPUT");
});
it.each([
  null,
  { ...policy, version: "unsupported-v2" },
  { ...policy, schemaVersion: 2 },
  { ...policy, reversalBasis: "REFUND_SETTLED" },
  { ...policy, costBasis: "LIVE_CATALOG" },
  { ...policy, extra: true },
])("rejects unsupported or malformed policy %#", (invalid) => {
  const result = calculator.calculate(base, invalid as unknown as ReturnCostPolicyV1);
  expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
});
it.each([null, {}, { ...base, extra: true }])(
  "rejects malformed runtime input %# without throwing",
  (invalid) => {
    expect(calculator.calculate(invalid as MetricInputV1, policy).ok).toBe(false);
  },
);
it("interprets connector timestamp offsets as the original same instant", () => {
  const result = run(input({ paymentFacts: [payment({ paidAt: "2026-10-02T08:00:00+08:00" })] }));
  expect(amounts(result)).toEqual([8000, 6000, 2000]);
});
it("accepts trailing zero submillisecond digits without changing the instant", () => {
  expect(
    amounts(
      run(
        input({
          frozenCosts: [cost({ frozenAt: "2026-10-02T00:00:00.0000Z" }), base.frozenCosts![1]!],
        }),
      ),
    ),
  ).toEqual([8000, 6000, 2000]);
});
function withMath(math: ExactMinorMath, rounding: MinorRounding = "HALF_AWAY_FROM_ZERO") {
  return createFrozenCostCalculator({ math, refunds, rounding });
}
function twoKnownUnits(): MetricInputV1 {
  const [a, b] = base.paymentFacts![0]!.data.items;
  return input({
    paymentFacts: [
      payment({
        items: [
          { ...a!, quantity: 2, grossMinor: 8000, netMinor: 6000 },
          { ...b!, quantity: 1, grossMinor: 4000, netMinor: 4000 },
        ],
      }),
    ],
    frozenCosts: [
      cost({ quantity: 2 }),
      {
        ...base.frozenCosts![1]!,
        data: {
          ...base.frozenCosts![1]!.data!,
          quantity: 1,
          basis: "UNAVAILABLE",
          unitCostMinor: null,
          skuCostVersion: null,
        },
      },
    ],
  });
}
it.each([
  ["HALF_AWAY_FROM_ZERO", 6667],
  ["TOWARD_ZERO", 6666],
] as const)("uses explicit %s rounding on known-unit coverage", (rounding, expected) => {
  const ratio = vi.fn(exactMinorMath.ratio);
  const result = value(
    withMath({ ...exactMinorMath, ratio }, rounding).calculate(twoKnownUnits(), policy),
  );
  expect(result.cogs.quality.coverageBasisPoints).toBe(expected);
  expect(ratio).toHaveBeenCalledWith(2, 3, rounding);
});
it("rejects an unsupported runtime rounding value", () => {
  expect(withMath(exactMinorMath, "BANKERS" as MinorRounding).calculate(base, policy).ok).toBe(
    false,
  );
});
it("propagates checked unit-cost multiplication overflow", () => {
  error(
    input({
      frozenCosts: [
        originalCost,
        {
          ...base.frozenCosts![1]!,
          data: { ...base.frozenCosts![1]!.data!, unitCostMinor: Number.MAX_SAFE_INTEGER },
        },
      ],
    }),
    "OVERFLOW",
  );
});
it.each(["add", "subtract", "multiply", "ratio"] as const)(
  "propagates typed %s dependency errors and evidence",
  (operation) => {
    const math: ExactMinorMath = {
      ...exactMinorMath,
      [operation]: () => ({
        ok: false,
        error: { code: "OVERFLOW", evidenceIds: ["math-evidence"] },
      }),
    };
    expect(withMath(math).calculate(base, policy)).toEqual({
      ok: false,
      error: { code: "OVERFLOW", evidenceIds: ["math-evidence"] },
    });
  },
);
it("invokes the public refund dependency exactly once with the original cohort", () => {
  const calculate = vi.fn(refunds.calculate);
  const local = createFrozenCostCalculator({
    math: exactMinorMath,
    refunds: { calculate },
    rounding,
  });
  value(local.calculate(base, policy));
  expect(calculate).toHaveBeenCalledTimes(1);
  expect(calculate).toHaveBeenCalledWith({
    input: base,
    paymentCohort: {
      periodStart: base.periodStart,
      periodEnd: base.periodEnd,
      timezone: base.timezone,
      currency: base.currency,
    },
    maturityHours: 0,
  });
});
it("propagates refund dependency failures without replacing evidence", () => {
  const unavailable: RefundMetricCalculator = {
    calculate: () => ({
      ok: false,
      error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["refund-outage"] },
    }),
  };
  const local = createFrozenCostCalculator({
    math: exactMinorMath,
    refunds: unavailable,
    rounding,
  });
  expect(local.calculate(base, policy)).toEqual({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: ["refund-outage"] },
  });
});
function assertFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(assertFrozen);
}
it("deep freezes results and errors while preserving caller-owned objects", () => {
  const data = structuredClone(financeAcceptedReturnGolden.input);
  const before = structuredClone(data);
  const result = calculator.calculate(data, { ...policy });
  assertFrozen(result);
  assertFrozen(
    calculator.calculate({ ...data, frozenCosts: [originalCost, originalCost] }, policy),
  );
  expect(data).toEqual(before);
  expect(Object.isFrozen(data)).toBe(false);
  expect(Object.isFrozen(data.paymentFacts![0]!.data.items)).toBe(false);
});
function snapshotContext(data: MetricInputV1) {
  const proof = data.metricCoverage[0]!;
  const {
    kind: _kind,
    subject: _subject,
    collections: _collections,
    coverageBasisPoints: _coverage,
    observedAt: _observed,
    sourceVersion: _source,
    ...context
  } = proof;
  return context;
}
it("validates every public metric, issue and context-wrapped snapshot", () => {
  const result = run(financeMissingCostGolden.input);
  for (const row of [result.netMerchandiseRevenue, result.cogs, result.grossProfit]) {
    expect(MetricValueSchema.safeParse(row.metric).success).toBe(true);
    row.quality.issues.forEach((issue) =>
      expect(DataQualityIssueV1Schema.safeParse(issue).success).toBe(true),
    );
    expect(
      MetricComputationV1Schema.safeParse({
        input: financeMissingCostGolden.input,
        snapshot: {
          ...snapshotContext(financeMissingCostGolden.input),
          ...row.quality,
          metric: row.metric,
          subject: { kind: "STORE" },
          computedAt: base.visibleAt,
        },
      }).success,
    ).toBe(true);
  }
});
it("reverses a free paid item's original cost on an allocated successful zero refund", () => {
  const order = payment({
    items: base.paymentFacts![0]!.data.items.map((item) => ({
      ...item,
      discountMinor: item.grossMinor,
      netMinor: 0,
    })),
    discountMinor: 12000,
    shippingMinor: 0,
    payableMinor: 0,
    paidMinor: 0,
  });
  const result = run(
    input({
      paymentFacts: [order],
      refundFacts: [refund({ requestedMinor: 0, succeededMinor: 0 })],
      refundAllocations: [allocation({ merchandiseMinor: 0, buyerShippingMinor: 0 })],
      returnReceipts: [originalReceipt],
    }),
  );
  expect(amounts(result)).toEqual([0, 5000, -5000]);
  expect(result.reversals[0]!.reversedMinor).toBe(1000);
  expect(result.cogs.quality.status).toBe("VERIFIED");
});
it("rejects nonzero allocations for a successful zero refund", () => {
  error(
    input({
      refundFacts: [refund({ requestedMinor: 0, succeededMinor: 0 })],
      refundAllocations: [allocation({ merchandiseMinor: 1 })],
    }),
  );
});
it("does not require allocation records for a zero refund without physical returns", () => {
  const result = run(
    input({
      refundFacts: [refund({ requestedMinor: 0, succeededMinor: 0 })],
      refundAllocations: [],
    }),
  );
  expect(amounts(result)).toEqual([10000, 6000, 4000]);
});
it("discloses a physical zero-refund return without the required line allocation", () => {
  const result = run(
    input({
      refundFacts: [refund({ requestedMinor: 0, succeededMinor: 0 })],
      refundAllocations: [],
      returnReceipts: [originalReceipt],
    }),
  );
  expect(amounts(result)).toEqual([10000, null, null]);
  expect(result.cogs.quality.issues.map((row) => row.code)).toContain("RETURN_UNKNOWN");
});
it("bounds return units cumulatively across different refund IDs", () => {
  const data = input({
    refundFacts: [
      refund({ requestedMinor: 500, succeededMinor: 500 }),
      refund({ requestedMinor: 500, succeededMinor: 500 }, "refund-b"),
    ],
    refundAllocations: [
      allocation({ merchandiseMinor: 500 }),
      allocation({ externalRefundId: "refund-b", merchandiseMinor: 500 }, "allocation-b"),
    ],
    returnReceipts: [
      originalReceipt,
      receipt({ externalReceiptId: "receipt-b", externalRefundId: "refund-b" }, "receipt-b"),
    ],
  });
  error(data, "CONFLICT", ["receipt-a", "receipt-b"]);
});
it("does not share a historical unit cost across separate lines of the same SKU", () => {
  const order = payment({
    items: base.paymentFacts![0]!.data.items.map((item) => ({ ...item, externalSkuId: "sku-a" })),
  });
  const result = run(input({ paymentFacts: [order], frozenCosts: [originalCost] }));
  expect(result.cogs.metric.value).toBeNull();
  expect(result.cogs.quality.coverageBasisPoints).toBe(3333);
});
it("checks frozen monetary aggregate overflow even when individual products fit", () => {
  error(
    input({
      frozenCosts: [
        cost({ unitCostMinor: Number.MAX_SAFE_INTEGER }),
        { ...base.frozenCosts![1]!, data: { ...base.frozenCosts![1]!.data!, unitCostMinor: 1 } },
      ],
    }),
    "OVERFLOW",
  );
});
it("checks aggregate sold-unit overflow independently of zero-priced merchandise", () => {
  const items = base.paymentFacts![0]!.data.items.map((item, index) => ({
    ...item,
    quantity: index === 0 ? Number.MAX_SAFE_INTEGER : 1,
    unitPriceMinor: 0,
    grossMinor: 0,
    discountMinor: 0,
    netMinor: 0,
  }));
  error(
    input({
      paymentFacts: [
        payment({
          items,
          grossMinor: 0,
          discountMinor: 0,
          shippingMinor: 0,
          payableMinor: 0,
          paidMinor: 0,
        }),
      ],
      refundFacts: [],
      refundAllocations: [],
      frozenCosts: [],
    }),
    "OVERFLOW",
  );
});
