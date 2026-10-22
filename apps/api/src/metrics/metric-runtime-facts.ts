import type {
  ContributionRequest,
  MetricError,
  MetricErrorCode,
  MetricInputV1,
  MetricKind,
  MetricMeasure,
  MetricQuality,
  MetricResult,
  MetricWindow,
} from "@shopmate/contracts";
import { exactMinorMath } from "./exact-math.js";
import { freezeRuntime } from "./metric-runtime-policy.js";

export class RuntimeMetricRejected extends Error {
  constructor(readonly detail: MetricError) {
    super(detail.code);
  }
}
export function rejectRuntime(code: MetricErrorCode, evidenceIds: readonly string[] = []): never {
  throw new RuntimeMetricRejected({ code, evidenceIds: [...new Set(evidenceIds)] });
}
export function checkedRuntime<T>(result: MetricResult<T>): T {
  if (!result.ok) throw new RuntimeMetricRejected(result.error);
  return result.value;
}
export function runtimeWindow(input: MetricInputV1): MetricWindow {
  const { periodStart, periodEnd, timezone, currency } = input;
  return { periodStart, periodEnd, timezone, currency };
}
export function paidRuntimeFacts(input: MetricInputV1) {
  return (input.paymentFacts ?? []).filter(
    ({ data }) =>
      data.paidAt !== null &&
      data.paidMinor !== null &&
      Date.parse(data.paidAt) >= Date.parse(input.periodStart) &&
      Date.parse(data.paidAt) < Date.parse(input.periodEnd),
  );
}
export function unavailableRuntime(
  kind: MetricKind,
  input: MetricInputV1,
  field: string,
): MetricMeasure<MetricKind> {
  const unit =
    kind === "INVENTORY_AVAILABLE" ? "units" : kind === "PROFIT_DELTA" ? "minorCNY" : "hours";
  return freezeRuntime({
    metric: { kind, unit, value: null },
    quality: {
      status: "UNAVAILABLE",
      sampleSize: 0,
      coverageBasisPoints: 0,
      evidenceIds: input.evidenceIds,
      issues: [{ code: "NOT_SYNCHRONIZED", field, evidenceIds: input.evidenceIds }],
    },
  } as MetricMeasure<MetricKind>);
}
export function runtimeSkuSales(
  input: MetricInputV1,
  sku: string,
  quality: MetricQuality,
): MetricMeasure<"PAID_UNITS"> {
  const lines = paidRuntimeFacts(input)
    .flatMap(({ data }) => data.items)
    .filter((line) => line.externalSkuId === sku);
  const units = checkedRuntime(exactMinorMath.add(lines.map((line) => line.quantity)));
  const unknown =
    input.paymentFacts === null ||
    quality.issues.some(({ code }) => ["PAYMENT_UNKNOWN", "SOURCE_INCONSISTENT"].includes(code));
  return { metric: { kind: "PAID_UNITS", unit: "units", value: unknown ? null : units }, quality };
}
function unknownShipping(quality: MetricQuality): ContributionRequest["netBuyerShipping"] {
  return {
    amountMinor: null,
    quality: {
      ...quality,
      status: "UNAVAILABLE",
      issues: [
        ...quality.issues,
        {
          code: "REFUND_UNKNOWN",
          field: "buyerShipping.refundAllocations",
          evidenceIds: quality.evidenceIds,
        },
      ],
    },
  };
}
export function runtimeBuyerShipping(
  input: MetricInputV1,
  quality: MetricQuality,
): ContributionRequest["netBuyerShipping"] {
  const payments = paidRuntimeFacts(input),
    ids = new Set(payments.map((row) => row.data.externalOrderId));
  const refunds = (input.refundFacts ?? []).filter(
    ({ data }) => ids.has(data.externalOrderId) && data.status === "SUCCEEDED",
  );
  if (input.paymentFacts === null || input.refundFacts === null) return unknownShipping(quality);
  const shipping: number[] = [];
  for (const refund of refunds) {
    const rows = (input.refundAllocations ?? []).filter(
      ({ data }) => data?.externalRefundId === refund.data.externalRefundId,
    );
    if (!rows.length || rows.some(({ data }) => data?.buyerShippingMinor == null))
      return unknownShipping(quality);
    shipping.push(...rows.map(({ data }) => data!.buyerShippingMinor!));
  }
  const paid = checkedRuntime(exactMinorMath.add(payments.map(({ data }) => data.shippingMinor)));
  const returned = checkedRuntime(exactMinorMath.add(shipping));
  const amountMinor = checkedRuntime(exactMinorMath.subtract(paid, returned));
  if (amountMinor < 0) rejectRuntime("INVALID_INPUT", quality.evidenceIds);
  return { amountMinor: quality.status === "UNAVAILABLE" ? null : amountMinor, quality };
}
