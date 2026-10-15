import { z } from "zod";
import {
  DataQualityIssueV1Schema,
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricValueSchema,
  type CostReversalEvidence,
  type DataQualityIssueV1,
  type ExactMinorMath,
  type FrozenCostCalculator,
  type FrozenCostMetrics,
  type MetricError,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricMeasure,
  type MetricQuality,
  type MetricResult,
  type MetricStatus,
  type MinorRounding,
  type RefundMetricCalculator,
  type ReturnCostPolicyV1,
} from "@shopmate/contracts";

type Payment = NonNullable<MetricInputV1["paymentFacts"]>[number];
type Refund = NonNullable<MetricInputV1["refundFacts"]>[number];
type Cost = NonNullable<MetricInputV1["frozenCosts"]>[number];
type Allocation = NonNullable<MetricInputV1["refundAllocations"]>[number];
type Receipt = NonNullable<MetricInputV1["returnReceipts"]>[number];
type Kind = "NET_MERCHANDISE_REVENUE" | "COGS" | "GROSS_PROFIT";
type Issues = readonly DataQualityIssueV1[];
type Dependencies = Readonly<{
  math: ExactMinorMath;
  refunds: RefundMetricCalculator;
  rounding: MinorRounding;
}>;
type Line = Readonly<{ payment: Payment; item: Payment["data"]["items"][number] }>;
type CostTotals = Readonly<{ total: number | null; coverage: number; issues: Issues }>;
type AllocationTotals = Readonly<{ total: number; valid: readonly Allocation[]; issues: Issues }>;
type Returns = Readonly<{ reversals: readonly CostReversalEvidence[]; issues: Issues }>;
const netSources = ["paymentFacts", "refundFacts", "refundAllocations"] as const;
const costSources = [...netSources, "frozenCosts", "returnReceipts"] as const;
const policySchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.literal("accepted-resellable-frozen-v1"),
  reversalBasis: z.literal("ACCEPTED_RESELLABLE_RETURN"),
  costBasis: z.literal("FROZEN_TRANSACTION_COST"),
});
export const ACCEPTED_RESELLABLE_FROZEN_V1: ReturnCostPolicyV1 = Object.freeze({
  schemaVersion: 1,
  version: "accepted-resellable-frozen-v1",
  reversalBasis: "ACCEPTED_RESELLABLE_RETURN",
  costBasis: "FROZEN_TRANSACTION_COST",
});

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function ids(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}
function failure(code: MetricErrorCode, evidenceIds: readonly string[] = []): MetricResult<never> {
  return freeze({ ok: false, error: { code, evidenceIds: ids(evidenceIds) } });
}
// A local signal keeps checked arithmetic linear; only this typed signal is caught at the boundary.
class Rejected extends Error {
  constructor(readonly detail: MetricError) {
    super(detail.code);
  }
}
function checked<T>(result: MetricResult<T>): T {
  if (!result.ok) throw new Rejected(result.error);
  return result.value;
}
function reject(code: MetricErrorCode, evidenceIds: readonly string[]): never {
  throw new Rejected({ code, evidenceIds });
}
function issue(code: DataQualityIssueV1["code"], field: string, evidenceIds: readonly string[]) {
  return { code, field, evidenceIds: ids(evidenceIds) };
}
function included(input: MetricInputV1): Payment[] {
  return (input.paymentFacts ?? []).filter(({ data }) => {
    return (
      data.paidAt !== null &&
      data.paidMinor !== null &&
      !data.source.quality.issues.some((code) =>
        ["PAYMENT_UNKNOWN", "SOURCE_INCONSISTENT"].includes(code),
      ) &&
      Date.parse(data.paidAt) >= Date.parse(input.periodStart) &&
      Date.parse(data.paidAt) < Date.parse(input.periodEnd)
    );
  });
}
function lines(payments: readonly Payment[]): Line[] {
  return payments.flatMap((payment) => payment.data.items.map((item) => ({ payment, item })));
}
function findLine(rows: readonly Line[], order: string, line: string): Line | undefined {
  return rows.find(
    (row) => row.payment.data.externalOrderId === order && row.item.externalLineId === line,
  );
}
function findCost(input: MetricInputV1, row: Line): Cost | undefined {
  return input.frozenCosts?.find(
    ({ data }) =>
      data?.externalOrderId === row.payment.data.externalOrderId &&
      data.externalLineId === row.item.externalLineId,
  );
}
function costTotals(input: MetricInputV1, rows: readonly Line[], deps: Dependencies): CostTotals {
  const amounts: number[] = [],
    known: number[] = [],
    issues: DataQualityIssueV1[] = [];
  for (const row of rows) {
    const fact = findCost(input, row),
      data = fact?.data;
    if (!data || data.unitCostMinor === null || data.skuCostVersion === null) {
      issues.push(
        issue("COST_MISSING", "frozenCosts", fact?.evidenceIds ?? row.payment.evidenceIds),
      );
      continue;
    }
    amounts.push(checked(deps.math.multiply(data.unitCostMinor, row.item.quantity)));
    known.push(row.item.quantity);
    if (data.basis === "ESTIMATED")
      issues.push(issue("COST_ESTIMATED", "frozenCosts", fact!.evidenceIds));
  }
  const sold = checked(deps.math.add(rows.map((row) => row.item.quantity)));
  const knownUnits = checked(deps.math.add(known));
  const coverage =
    sold === 0 ? 10000 : checked(deps.math.ratio(knownUnits, sold, deps.rounding)).value!;
  return {
    total: issues.some((row) => row.code === "COST_MISSING")
      ? null
      : checked(deps.math.add(amounts)),
    coverage,
    issues,
  };
}
function successful(fact: Refund): boolean {
  return (
    fact.data.status === "SUCCEEDED" &&
    fact.data.succeededMinor !== null &&
    fact.data.succeededAt !== null
  );
}
function cohortRefunds(input: MetricInputV1, payments: readonly Payment[]): Refund[] {
  const orders = new Set(payments.map((row) => row.data.externalOrderId));
  return (input.refundFacts ?? []).filter((row) => orders.has(row.data.externalOrderId));
}
function allocationTotals(
  input: MetricInputV1,
  refunds: readonly Refund[],
  deps: Dependencies,
): AllocationTotals {
  const amounts: number[] = [],
    valid: Allocation[] = [],
    issues: DataQualityIssueV1[] = [];
  for (const refund of refunds) {
    if (!successful(refund) || refund.data.succeededMinor === 0) continue;
    const rows = (input.refundAllocations ?? []).filter(
      (row) => row.data?.externalRefundId === refund.data.externalRefundId,
    );
    if (
      !rows.length ||
      rows.some((row) => row.data?.merchandiseMinor == null || row.data.buyerShippingMinor === null)
    ) {
      issues.push(
        issue(
          "REFUND_UNKNOWN",
          "refundAllocations",
          ids(refund.evidenceIds, ...rows.map((row) => row.evidenceIds)),
        ),
      );
      continue;
    }
    const total = checked(
      deps.math.add(
        rows.flatMap((row) => [row.data!.merchandiseMinor!, row.data!.buyerShippingMinor!]),
      ),
    );
    if (total !== refund.data.succeededMinor)
      reject("CONFLICT", ids(refund.evidenceIds, ...rows.map((row) => row.evidenceIds)));
    valid.push(...rows);
    amounts.push(...rows.map((row) => row.data!.merchandiseMinor!));
  }
  return { total: checked(deps.math.add(amounts)), valid, issues };
}
function reversal(
  input: MetricInputV1,
  row: Line,
  receipt: Receipt,
  allocation: Allocation,
  refund: Refund,
  deps: Dependencies,
): CostReversalEvidence | null {
  const cost = findCost(input, row),
    data = cost?.data;
  if (!data || data.unitCostMinor === null || data.skuCostVersion === null) return null;
  return {
    externalOrderId: row.payment.data.externalOrderId,
    externalLineId: row.item.externalLineId,
    externalReceiptId: receipt.data!.externalReceiptId,
    skuCostVersion: data.skuCostVersion,
    reversedQuantity: receipt.data!.resellableQuantity!,
    reversedMinor: checked(
      deps.math.multiply(data.unitCostMinor, receipt.data!.resellableQuantity!),
    ),
    evidenceIds: ids(
      cost!.evidenceIds,
      receipt.evidenceIds,
      refund.evidenceIds,
      row.payment.evidenceIds,
      allocation.evidenceIds,
    ),
  };
}
function returns(
  input: MetricInputV1,
  rows: readonly Line[],
  refunds: readonly Refund[],
  allocations: AllocationTotals,
  deps: Dependencies,
): Returns {
  const reversals: CostReversalEvidence[] = [],
    issues: DataQualityIssueV1[] = [];
  for (const receipt of input.returnReceipts ?? []) {
    const data = receipt.data;
    if (!data) {
      issues.push(issue("RETURN_UNKNOWN", "returnReceipts", receipt.evidenceIds));
      continue;
    }
    const row = findLine(rows, data.externalOrderId, data.externalLineId);
    if (!row) continue;
    const refund = refunds.find((fact) => fact.data.externalRefundId === data.externalRefundId);
    if (!refund || !successful(refund) || data.resellableQuantity === 0) continue;
    if (data.acceptedAt === null || data.resellableQuantity === null) {
      issues.push(issue("RETURN_UNKNOWN", "returnReceipts", receipt.evidenceIds));
      continue;
    }
    const allocation = allocations.valid.find(
      (fact) =>
        fact.data?.externalRefundId === data.externalRefundId &&
        fact.data.externalLineId === data.externalLineId,
    );
    if (!allocation) {
      issues.push(issue("RETURN_UNKNOWN", "returnReceipts", receipt.evidenceIds));
      continue;
    }
    const result = reversal(input, row, receipt, allocation, refund, deps);
    if (result) reversals.push(result);
  }
  return { reversals, issues };
}
function uncertain(issues: Issues): boolean {
  return issues.some((row) =>
    ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN", "SOURCE_INCONSISTENT", "RETURN_UNKNOWN"].includes(
      row.code,
    ),
  );
}
function status(issues: Issues): MetricStatus {
  if (issues.some((row) => row.code === "NOT_SYNCHRONIZED")) return "UNAVAILABLE";
  if (issues.some((row) => row.code === "STALE_SOURCE")) return "STALE";
  if (uncertain(issues)) return "INSUFFICIENT";
  return issues.length ? "ESTIMATED" : "VERIFIED";
}
function proofsFor(input: MetricInputV1, kind: Kind) {
  const required = kind === "NET_MERCHANDISE_REVENUE" ? netSources : costSources;
  return input.metricCoverage.filter(
    (proof) =>
      proof.kind === kind &&
      proof.subject.kind === "STORE" &&
      required.every((key) => proof.collections.includes(key)),
  );
}
function quality(
  input: MetricInputV1,
  kind: Kind,
  payments: readonly Payment[],
  extra: Issues,
  coverage: number,
): MetricQuality {
  const required = kind === "NET_MERCHANDISE_REVENUE" ? netSources : costSources;
  const proofs = proofsFor(input, kind);
  const evidenceIds = ids(
    input.evidenceIds,
    ...required.flatMap((key) => (input[key] ?? []).map((row) => row.evidenceIds)),
    ...proofs.map((row) => row.evidenceIds),
    ...extra.map((row) => row.evidenceIds),
  );
  const missing = required.filter((key) => input[key] === null);
  const issues = [...extra, ...missing.map((key) => issue("NOT_SYNCHRONIZED", key, evidenceIds))];
  const proofCoverage = proofs.length
    ? Math.min(...proofs.map((row) => row.coverageBasisPoints))
    : 0;
  if (!missing.length && proofCoverage < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", evidenceIds));
  if (
    input.sourceWatermark !== null &&
    Date.parse(input.sourceWatermark) < Date.parse(input.visibleAt)
  )
    issues.push(issue("STALE_SOURCE", "sourceWatermark", evidenceIds));
  return {
    status: status(issues),
    sampleSize: missing.length ? 0 : payments.length,
    coverageBasisPoints: missing.length ? 0 : Math.min(proofCoverage, coverage),
    evidenceIds,
    issues,
  };
}
function measure<K extends Kind>(
  input: MetricInputV1,
  kind: K,
  amount: number | null,
  payments: readonly Payment[],
  issues: Issues,
  coverage = 10000,
): MetricMeasure<K> {
  const result = quality(input, kind, payments, issues, coverage);
  const unknown = result.status === "UNAVAILABLE" || uncertain(result.issues);
  return {
    metric: {
      kind,
      value: unknown ? null : amount,
      unit: "minorCNY",
    } as MetricMeasure<K>["metric"],
    quality: result,
  };
}
function context(input: MetricInputV1) {
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
  } = input;
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
function validOutput(input: MetricInputV1, result: FrozenCostMetrics): boolean {
  return [result.netMerchandiseRevenue, result.cogs, result.grossProfit].every(
    (row) =>
      MetricValueSchema.safeParse(row.metric).success &&
      row.quality.issues.every((item) => DataQualityIssueV1Schema.safeParse(item).success) &&
      MetricComputationV1Schema.safeParse({
        input,
        snapshot: {
          ...context(input),
          ...row.quality,
          metric: row.metric,
          subject: { kind: "STORE" },
          computedAt: input.visibleAt,
        },
      }).success,
  );
}
function commonIssues(input: MetricInputV1, deps: Dependencies): Issues {
  const common = checked(
    deps.refunds.calculate({
      input,
      paymentCohort: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        timezone: input.timezone,
        currency: input.currency,
      },
      maturityHours: 0,
    }),
  );
  return common.refundedCohortOrders.quality.issues.filter((row) =>
    ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN", "SOURCE_INCONSISTENT", "SOURCE_TIME_MISSING"].includes(
      row.code,
    ),
  );
}
function assemble(input: MetricInputV1, deps: Dependencies): FrozenCostMetrics {
  const common = commonIssues(input, deps);
  const payments = included(input),
    sold = lines(payments),
    refunds = cohortRefunds(input, payments);
  const allocations = allocationTotals(input, refunds, deps);
  const costs = costTotals(input, sold, deps);
  const returned = returns(input, sold, refunds, allocations, deps);
  const revenue = checked(
    deps.math.subtract(
      checked(deps.math.add(sold.map((row) => row.item.netMinor))),
      allocations.total,
    ),
  );
  const reversed = checked(deps.math.add(returned.reversals.map((row) => row.reversedMinor)));
  const cogs = costs.total === null ? null : checked(deps.math.subtract(costs.total, reversed));
  const netIssues = [...common, ...allocations.issues];
  const costIssues = [...netIssues, ...costs.issues, ...returned.issues];
  return {
    netMerchandiseRevenue: measure(input, "NET_MERCHANDISE_REVENUE", revenue, payments, netIssues),
    cogs: measure(input, "COGS", cogs, payments, costIssues, costs.coverage),
    grossProfit: measure(
      input,
      "GROSS_PROFIT",
      cogs === null ? null : checked(deps.math.subtract(revenue, cogs)),
      payments,
      costIssues,
      costs.coverage,
    ),
    reversals: returned.reversals,
    policyVersion: ACCEPTED_RESELLABLE_FROZEN_V1.version,
  };
}
function calculate(
  input: MetricInputV1,
  policy: ReturnCostPolicyV1,
  deps: Dependencies,
): MetricResult<FrozenCostMetrics> {
  const parsed = MetricInputV1Schema.safeParse(input);
  if (
    !parsed.success ||
    !policySchema.safeParse(policy).success ||
    !["HALF_AWAY_FROM_ZERO", "TOWARD_ZERO"].includes(deps.rounding)
  )
    return failure("INVALID_INPUT");
  try {
    const result = assemble(parsed.data, deps);
    return validOutput(parsed.data, result)
      ? freeze({ ok: true, value: result })
      : failure("INVALID_INPUT", parsed.data.evidenceIds);
  } catch (error) {
    if (error instanceof Rejected) return failure(error.detail.code, error.detail.evidenceIds);
    throw error;
  }
}
/** Pure paid-cohort observation using original transaction costs and explicit physical receipts. */
export function createFrozenCostCalculator(dependencies: Dependencies): FrozenCostCalculator {
  return Object.freeze({
    calculate: (input: MetricInputV1, policy: ReturnCostPolicyV1) =>
      calculate(input, policy, dependencies),
  });
}
