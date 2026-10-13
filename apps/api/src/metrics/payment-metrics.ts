import {
  MetricInputV1Schema,
  MetricWindowSchema,
  type DataQualityIssueV1,
  type ExactMinorMath,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricMeasure,
  type MetricQuality,
  type MetricResult,
  type MetricStatus,
  type MetricWindowResolver,
  type MinorRounding,
  type PaymentMetricCalculator,
  type PaymentMetrics,
} from "@shopmate/contracts";

type PaymentFact = NonNullable<MetricInputV1["paymentFacts"]>[number];
type PaymentKind = PaymentMetrics[keyof PaymentMetrics]["metric"]["kind"];
type Dependencies = Readonly<{
  math: ExactMinorMath;
  windows: MetricWindowResolver;
  rounding: MinorRounding;
}>;
type Totals = Readonly<{ gross: number; paid: number; orders: number; units: number }>;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function success<T>(value: T): MetricResult<T> {
  return freeze({ ok: true, value });
}
function failure<T>(code: MetricErrorCode, evidenceIds: readonly string[] = []): MetricResult<T> {
  return freeze({ ok: false, error: { code, evidenceIds: [...new Set(evidenceIds)] } });
}
function exactTimestamp(time: string | null): boolean {
  if (time === null) return true;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(time)?.[1] ?? "";
  return !/[1-9]/.test(fraction.slice(3)) && Number.isFinite(Date.parse(time));
}
function validPrecision(input: MetricInputV1): boolean {
  const context = [input.periodStart, input.periodEnd, input.visibleAt, input.sourceWatermark];
  const coverage = input.metricCoverage.flatMap((proof) => [
    proof.observedAt,
    proof.sourceWatermark,
  ]);
  const payments = (input.paymentFacts ?? []).flatMap(({ observedAt, data }) => [
    observedAt,
    data.orderedAt,
    data.paidAt,
    data.source.updatedAt,
  ]);
  return [...context, ...coverage, ...payments].every(exactTimestamp);
}
function businessDate(time: number): string {
  const parts = dateFormatter.formatToParts(new Date(time));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}
function observedWindow(input: MetricInputV1, windows: MetricWindowResolver): MetricResult<null> {
  const lastIncluded = Date.parse(input.periodEnd) - 1;
  const result = windows.elapsed({
    businessDate: businessDate(lastIncluded),
    timezone: input.timezone,
    visibleAt: input.visibleAt,
  });
  if (!result.ok) return failure(result.error.code, result.error.evidenceIds);
  const parsed = MetricWindowSchema.safeParse(result.value);
  if (
    !parsed.success ||
    !exactTimestamp(parsed.data.periodStart) ||
    !exactTimestamp(parsed.data.periodEnd)
  )
    return failure("INVALID_INPUT");
  const window = parsed.data;
  if (window.timezone !== input.timezone || window.currency !== input.currency)
    return failure("SCOPE_MISMATCH");
  const start = Date.parse(window.periodStart),
    end = Date.parse(window.periodEnd);
  if (
    lastIncluded < start ||
    lastIncluded >= end ||
    end < Date.parse(input.periodEnd) ||
    end > Date.parse(input.visibleAt) ||
    businessDate(start) !== businessDate(lastIncluded)
  )
    return failure("WINDOW_MISMATCH");
  return success(null);
}
function duplicate(input: MetricInputV1): MetricResult<null> {
  const seen = new Map<string, readonly string[]>();
  for (const fact of input.paymentFacts ?? []) {
    const prior = seen.get(fact.data.externalOrderId);
    if (prior) return failure("CONFLICT", [...prior, ...fact.evidenceIds]);
    seen.set(fact.data.externalOrderId, fact.evidenceIds);
  }
  return success(null);
}
function issue(
  code: DataQualityIssueV1["code"],
  field: string,
  evidenceIds: readonly string[],
): DataQualityIssueV1 {
  return { code, field, evidenceIds: [...new Set(evidenceIds)] };
}
function paymentIssues(fact: PaymentFact): DataQualityIssueV1[] {
  const { data, evidenceIds } = fact;
  const flags = new Set(data.source.quality.issues);
  const settled = ["PAID", "FULFILLED", "COMPLETED"].includes(data.status);
  if (data.paidMinor === null || (data.paidAt === null && (settled || data.paidMinor !== 0)))
    flags.add("PAYMENT_UNKNOWN");
  if (
    (data.paidAt !== null && data.paidMinor !== null && data.paidMinor !== data.payableMinor) ||
    (data.status === "PENDING_PAYMENT" && (data.paidAt !== null || (data.paidMinor ?? 0) > 0))
  )
    flags.add("SOURCE_INCONSISTENT");
  return [...flags].flatMap((code) =>
    ["PAYMENT_UNKNOWN", "SOURCE_INCONSISTENT", "SOURCE_TIME_MISSING"].includes(code)
      ? [issue(code as DataQualityIssueV1["code"], "paymentFacts.source", evidenceIds)]
      : [],
  );
}
function uncertain(issues: readonly DataQualityIssueV1[]): boolean {
  return issues.some(({ code }) => code === "PAYMENT_UNKNOWN" || code === "SOURCE_INCONSISTENT");
}
function included(input: MetricInputV1): PaymentFact[] {
  return (input.paymentFacts ?? []).filter((fact) => {
    const paidAt = fact.data.paidAt;
    return (
      paidAt !== null &&
      !uncertain(paymentIssues(fact)) &&
      Date.parse(paidAt) >= Date.parse(input.periodStart) &&
      Date.parse(paidAt) < Date.parse(input.periodEnd)
    );
  });
}
function orderTotals(fact: PaymentFact, math: ExactMinorMath): MetricResult<Totals> {
  const products: number[] = [];
  for (const item of fact.data.items) {
    const product = math.multiply(item.unitPriceMinor, item.quantity);
    if (!product.ok) return failure(product.error.code, product.error.evidenceIds);
    if (product.value !== item.grossMinor) return failure("INVALID_INPUT", fact.evidenceIds);
    products.push(product.value);
  }
  const gross = math.add(products);
  if (!gross.ok) return failure(gross.error.code, gross.error.evidenceIds);
  const discounted = math.subtract(gross.value, fact.data.discountMinor);
  if (!discounted.ok) return failure(discounted.error.code, discounted.error.evidenceIds);
  const paid = math.add([discounted.value, fact.data.shippingMinor]);
  if (!paid.ok) return failure(paid.error.code, paid.error.evidenceIds);
  if (gross.value !== fact.data.grossMinor || paid.value !== fact.data.paidMinor)
    return failure("INVALID_INPUT", fact.evidenceIds);
  const units = math.add(fact.data.items.map((item) => item.quantity));
  if (!units.ok) return failure(units.error.code, units.error.evidenceIds);
  return success({ gross: gross.value, paid: fact.data.paidMinor, orders: 1, units: units.value });
}
function aggregate(facts: readonly PaymentFact[], math: ExactMinorMath): MetricResult<Totals> {
  const rows: Totals[] = [];
  for (const fact of facts) {
    const result = orderTotals(fact, math);
    if (!result.ok) return result;
    rows.push(result.value);
  }
  const totals = { gross: 0, paid: 0, orders: 0, units: 0 };
  for (const key of ["gross", "paid", "orders", "units"] as const) {
    const result = math.add(rows.map((row) => row[key]));
    if (!result.ok) return failure(result.error.code, result.error.evidenceIds);
    totals[key] = result.value;
  }
  return success(totals);
}
function aov(totals: Totals, rounding: MinorRounding): MetricResult<number | null> {
  if (totals.orders === 0) return success(null);
  const numerator = BigInt(totals.paid),
    denominator = BigInt(totals.orders);
  let quotient = numerator / denominator;
  // Round once in minor currency; a basis-point intermediate could overflow or double-round.
  if (rounding === "HALF_AWAY_FROM_ZERO" && (numerator % denominator) * 2n >= denominator)
    quotient += 1n;
  if (quotient > BigInt(Number.MAX_SAFE_INTEGER)) return failure("OVERFLOW");
  return success(Number(quotient));
}
function quality(
  input: MetricInputV1,
  kind: PaymentKind,
  totals: Totals,
  sourceIssues: readonly DataQualityIssueV1[],
): MetricQuality {
  const proofs = input.metricCoverage.filter(
    (proof) =>
      proof.kind === kind &&
      proof.subject.kind === "STORE" &&
      proof.collections.includes("paymentFacts"),
  );
  const evidenceIds = paymentEvidence(input, proofs, sourceIssues);
  if (input.paymentFacts === null) return missingPayments(evidenceIds);
  const coverageBasisPoints = proofs.length
    ? Math.min(...proofs.map((proof) => proof.coverageBasisPoints))
    : 0;
  const issues = [...sourceIssues];
  if (coverageBasisPoints < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", evidenceIds));
  if (kind === "AOV" && totals.orders === 0 && !uncertain(issues))
    issues.push(issue("ZERO_DENOMINATOR", "paymentFacts", evidenceIds));
  if (
    input.sourceWatermark !== null &&
    Date.parse(input.sourceWatermark) < Date.parse(input.periodEnd)
  )
    issues.push(issue("STALE_SOURCE", "sourceWatermark", evidenceIds));
  return {
    status: paymentStatus(issues),
    sampleSize: totals.orders,
    coverageBasisPoints: uncertain(issues) ? 0 : coverageBasisPoints,
    evidenceIds,
    issues,
  };
}
function missingPayments(evidenceIds: readonly string[]): MetricQuality {
  return {
    status: "UNAVAILABLE",
    sampleSize: 0,
    coverageBasisPoints: 0,
    evidenceIds,
    issues: [issue("NOT_SYNCHRONIZED", "paymentFacts", evidenceIds)],
  };
}
function paymentEvidence(
  input: MetricInputV1,
  proofs: MetricInputV1["metricCoverage"],
  issues: readonly DataQualityIssueV1[],
): string[] {
  return [
    ...new Set([
      ...input.evidenceIds,
      ...(input.paymentFacts ?? []).flatMap((fact) => fact.evidenceIds),
      ...proofs.flatMap((proof) => proof.evidenceIds),
      ...issues.flatMap((item) => item.evidenceIds),
    ]),
  ];
}
function paymentStatus(issues: readonly DataQualityIssueV1[]): MetricStatus {
  if (issues.some((item) => item.code === "STALE_SOURCE")) return "STALE";
  if (uncertain(issues)) return "INSUFFICIENT";
  if (issues.some((item) => item.code === "ZERO_DENOMINATOR")) return "INSUFFICIENT";
  return issues.length ? "ESTIMATED" : "VERIFIED";
}
function measure<K extends PaymentKind>(
  input: MetricInputV1,
  kind: K,
  value: number | null,
  totals: Totals,
  issues: readonly DataQualityIssueV1[],
): MetricMeasure<K> {
  const unknown = input.paymentFacts === null || uncertain(issues);
  const unit = kind === "PAID_ORDERS" || kind === "PAID_UNITS" ? "units" : "minorCNY";
  return {
    metric: { kind, value: unknown ? null : value, unit } as MetricMeasure<K>["metric"],
    quality: quality(input, kind, totals, issues),
  };
}
function metrics(input: MetricInputV1, totals: Totals, average: number | null): PaymentMetrics {
  const issues = (input.paymentFacts ?? []).flatMap(paymentIssues);
  return {
    gmv: measure(input, "GMV", totals.gross, totals, issues),
    paidRevenue: measure(input, "PAID_REVENUE", totals.paid, totals, issues),
    paidOrders: measure(input, "PAID_ORDERS", totals.orders, totals, issues),
    paidUnits: measure(input, "PAID_UNITS", totals.units, totals, issues),
    aov: measure(input, "AOV", average, totals, issues),
  };
}
function calculate(input: MetricInputV1, dependencies: Dependencies): MetricResult<PaymentMetrics> {
  const parsed = MetricInputV1Schema.safeParse(input);
  if (
    !parsed.success ||
    !validPrecision(parsed.data) ||
    !["HALF_AWAY_FROM_ZERO", "TOWARD_ZERO"].includes(dependencies.rounding)
  )
    return failure("INVALID_INPUT");
  const valid = parsed.data;
  const fence = observedWindow(valid, dependencies.windows);
  if (!fence.ok) return failure(fence.error.code, fence.error.evidenceIds);
  const unique = duplicate(valid);
  if (!unique.ok) return failure(unique.error.code, unique.error.evidenceIds);
  const totals = aggregate(included(valid), dependencies.math);
  if (!totals.ok) return failure(totals.error.code, totals.error.evidenceIds);
  const average = aov(totals.value, dependencies.rounding);
  if (!average.ok) return failure(average.error.code, average.error.evidenceIds);
  return success(metrics(valid, totals.value, average.value));
}

/** Pure observed-payment leaf; the supplied resolver owns the business-clock cutoff. */
export function createPaymentMetricCalculator(dependencies: Dependencies): PaymentMetricCalculator {
  return Object.freeze({ calculate: (input: MetricInputV1) => calculate(input, dependencies) });
}
