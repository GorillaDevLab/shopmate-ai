import { z } from "zod";
import {
  DataQualityIssueV1Schema,
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricValueSchema,
  MetricWindowSchema,
  type DataQualityIssueV1,
  type ExactMinorMath,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricMeasure,
  type MetricQuality,
  type MetricResult,
  type MetricStatus,
  type MetricWindow,
  type MetricWindowResolver,
  type MinorRounding,
  type RefundMetricCalculator,
  type RefundMetricRequest,
  type RefundMetrics,
} from "@shopmate/contracts";

type Payment = NonNullable<MetricInputV1["paymentFacts"]>[number];
type Refund = NonNullable<MetricInputV1["refundFacts"]>[number];
type Kind = RefundMetrics[Exclude<keyof RefundMetrics, "cohort">]["metric"]["kind"];
type Dependencies = Readonly<{
  math: ExactMinorMath;
  windows: MetricWindowResolver;
  rounding: MinorRounding;
}>;
type Issues = readonly DataQualityIssueV1[];
type Totals = Readonly<{
  settled: number;
  paid: number;
  cohortPaid: number;
  orders: number;
  refundedOrders: number;
  cohortRefund: number;
}>;
type Analysis = Readonly<{
  totals: Totals;
  refundIssues: Issues;
  paymentIssues: Issues;
  joinIssues: Issues;
}>;
const requestSchema = z.strictObject({
  input: MetricInputV1Schema,
  paymentCohort: MetricWindowSchema,
  maturityHours: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
});
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
function issue(
  code: DataQualityIssueV1["code"],
  field: string,
  evidenceIds: readonly string[],
): DataQualityIssueV1 {
  return { code, field, evidenceIds: [...new Set(evidenceIds)] };
}
function exact(time: string | null): boolean {
  if (time === null) return true;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(time)?.[1] ?? "";
  return !/[1-9]/.test(fraction.slice(3)) && Number.isFinite(Date.parse(time));
}
function precision(request: RefundMetricRequest): boolean {
  const { input, paymentCohort } = request;
  const times = [
    input.periodStart,
    input.periodEnd,
    input.visibleAt,
    input.sourceWatermark,
    paymentCohort.periodStart,
    paymentCohort.periodEnd,
  ];
  for (const proof of input.metricCoverage)
    times.push(
      proof.periodStart,
      proof.periodEnd,
      proof.visibleAt,
      proof.observedAt,
      proof.sourceWatermark,
    );
  for (const fact of input.paymentFacts ?? [])
    times.push(fact.observedAt, fact.data.orderedAt, fact.data.paidAt, fact.data.source.updatedAt);
  for (const fact of input.refundFacts ?? [])
    times.push(
      fact.observedAt,
      fact.data.requestedAt,
      fact.data.succeededAt,
      fact.data.source.updatedAt,
    );
  return times.every(exact);
}
function contains(window: MetricWindow, time: string | null): boolean {
  return (
    time !== null &&
    Date.parse(time) >= Date.parse(window.periodStart) &&
    Date.parse(time) < Date.parse(window.periodEnd)
  );
}
function businessDate(time: number): string {
  const parts = dateFormatter.formatToParts(new Date(time));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${read("year").padStart(4, "0")}-${read("month")}-${read("day")}`;
}
function fence(
  window: MetricWindow,
  input: MetricInputV1,
  windows: MetricWindowResolver,
): MetricResult<null> {
  const last = Date.parse(window.periodEnd) - 1;
  const result = windows.elapsed({
    businessDate: businessDate(last),
    timezone: "Asia/Shanghai",
    visibleAt: input.visibleAt,
  });
  if (!result.ok) return failure(result.error.code, result.error.evidenceIds);
  const parsed = MetricWindowSchema.safeParse(result.value);
  if (!parsed.success || !exact(parsed.data.periodStart) || !exact(parsed.data.periodEnd))
    return failure("INVALID_INPUT");
  if (parsed.data.timezone !== input.timezone || parsed.data.currency !== input.currency)
    return failure("SCOPE_MISMATCH");
  if (
    !contains(parsed.data, new Date(last).toISOString()) ||
    Date.parse(parsed.data.periodEnd) > Date.parse(input.visibleAt) ||
    businessDate(Date.parse(parsed.data.periodStart)) !== businessDate(last)
  )
    return failure("WINDOW_MISMATCH");
  return success(null);
}
function validateWindows(
  request: RefundMetricRequest,
  windows: MetricWindowResolver,
): MetricResult<null> {
  const { input, paymentCohort } = request;
  if (paymentCohort.currency !== input.currency || paymentCohort.timezone !== input.timezone)
    return failure("SCOPE_MISMATCH");
  if (Date.parse(paymentCohort.periodEnd) > Date.parse(input.visibleAt))
    return failure("WINDOW_MISMATCH");
  const settlement = fence(input, input, windows);
  if (!settlement.ok) return settlement;
  if (
    input.periodStart === paymentCohort.periodStart &&
    input.periodEnd === paymentCohort.periodEnd
  )
    return settlement;
  return fence(paymentCohort, input, windows);
}
function duplicates(input: MetricInputV1): MetricResult<null> {
  const orders = new Map<string, readonly string[]>(),
    refunds = new Map<string, readonly string[]>();
  for (const fact of input.paymentFacts ?? []) {
    const prior = orders.get(fact.data.externalOrderId);
    if (prior) return failure("CONFLICT", [...prior, ...fact.evidenceIds]);
    orders.set(fact.data.externalOrderId, fact.evidenceIds);
  }
  for (const fact of input.refundFacts ?? []) {
    const prior = refunds.get(fact.data.externalRefundId);
    if (prior) return failure("CONFLICT", [...prior, ...fact.evidenceIds]);
    refunds.set(fact.data.externalRefundId, fact.evidenceIds);
  }
  return success(null);
}
function paymentIssues(fact: Payment): DataQualityIssueV1[] {
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
function refundIssues(fact: Refund): DataQualityIssueV1[] {
  const { data, evidenceIds } = fact;
  const flags = new Set(data.source.quality.issues);
  if (data.status === "SUCCEEDED" && (data.succeededMinor === null || data.succeededAt === null))
    flags.add("REFUND_UNKNOWN");
  if (data.status !== "SUCCEEDED" && (data.succeededAt !== null || (data.succeededMinor ?? 0) > 0))
    flags.add("SOURCE_INCONSISTENT");
  return [...flags].flatMap((code) =>
    ["REFUND_UNKNOWN", "SOURCE_INCONSISTENT", "SOURCE_TIME_MISSING"].includes(code)
      ? [issue(code as DataQualityIssueV1["code"], "refundFacts.source", evidenceIds)]
      : [],
  );
}
function uncertain(issues: Issues): boolean {
  return issues.some(({ code }) =>
    ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN", "SOURCE_INCONSISTENT"].includes(code),
  );
}
function knownPayment(fact: Payment): boolean {
  return fact.data.paidAt !== null && !uncertain(paymentIssues(fact));
}
function successful(fact: Refund): boolean {
  return (
    fact.data.status === "SUCCEEDED" &&
    fact.data.succeededMinor !== null &&
    fact.data.succeededAt !== null
  );
}
function reconcile(fact: Payment, math: ExactMinorMath): MetricResult<null> {
  const products: number[] = [];
  for (const item of fact.data.items) {
    const product = math.multiply(item.unitPriceMinor, item.quantity);
    if (!product.ok) return failure(product.error.code, product.error.evidenceIds);
    if (product.value !== item.grossMinor) return failure("INVALID_INPUT", fact.evidenceIds);
    products.push(product.value);
  }
  const gross = math.add(products);
  if (!gross.ok) return failure(gross.error.code, gross.error.evidenceIds);
  const net = math.subtract(gross.value, fact.data.discountMinor);
  if (!net.ok) return failure(net.error.code, net.error.evidenceIds);
  const paid = math.add([net.value, fact.data.shippingMinor]);
  if (!paid.ok) return failure(paid.error.code, paid.error.evidenceIds);
  return paid.value === fact.data.paidMinor
    ? success(null)
    : failure("INVALID_INPUT", fact.evidenceIds);
}
function association(
  input: MetricInputV1,
  payments: readonly Payment[],
  math: ExactMinorMath,
): MetricResult<{ refund: Issues; join: Issues }> {
  const refund: DataQualityIssueV1[] = [],
    join: DataQualityIssueV1[] = [];
  for (const fact of input.refundFacts ?? []) {
    if (!successful(fact)) continue;
    const payment = payments.find((row) => row.data.externalOrderId === fact.data.externalOrderId);
    if (!payment) {
      if (input.paymentFacts !== null)
        join.push(issue("SOURCE_INCONSISTENT", "refundFacts.externalOrderId", fact.evidenceIds));
      continue;
    }
    if (Date.parse(fact.data.succeededAt!) < Date.parse(payment.data.paidAt!))
      refund.push(
        issue("SOURCE_INCONSISTENT", "refundFacts.succeededAt", [
          ...payment.evidenceIds,
          ...fact.evidenceIds,
        ]),
      );
  }
  const conservation = overrefund(input, payments, math);
  return conservation.ok ? success({ refund, join }) : conservation;
}
function overrefund(
  input: MetricInputV1,
  payments: readonly Payment[],
  math: ExactMinorMath,
): MetricResult<never | null> {
  for (const payment of payments) {
    const refunds = (input.refundFacts ?? []).filter(
      (fact) => successful(fact) && fact.data.externalOrderId === payment.data.externalOrderId,
    );
    const total = math.add(refunds.map((fact) => fact.data.succeededMinor!));
    if (!total.ok) return failure(total.error.code, total.error.evidenceIds);
    if (total.value > payment.data.paidMinor!)
      return failure("CONFLICT", [
        ...payment.evidenceIds,
        ...refunds.flatMap((fact) => fact.evidenceIds),
      ]);
  }
  return success(null);
}
function sumFields(
  fields: Record<keyof Totals, readonly number[]>,
  math: ExactMinorMath,
): MetricResult<Totals> {
  const output = {
    settled: 0,
    paid: 0,
    cohortPaid: 0,
    orders: 0,
    refundedOrders: 0,
    cohortRefund: 0,
  };
  for (const key of Object.keys(output) as (keyof Totals)[]) {
    const sum = math.add(fields[key]);
    if (!sum.ok) return failure(sum.error.code, sum.error.evidenceIds);
    output[key] = sum.value;
  }
  return success(output);
}
function totals(
  request: RefundMetricRequest,
  payments: readonly Payment[],
  math: ExactMinorMath,
): MetricResult<Totals> {
  const cohort = payments.filter((fact) => contains(request.paymentCohort, fact.data.paidAt));
  const refunds = (request.input.refundFacts ?? []).filter(
    (fact) => successful(fact) && !uncertain(refundIssues(fact)),
  );
  const cohortIds = new Set(cohort.map((fact) => fact.data.externalOrderId));
  const cohortRefunds = refunds.filter((fact) => cohortIds.has(fact.data.externalOrderId));
  const refunded = new Set(
    cohortRefunds
      .filter((fact) => fact.data.succeededMinor! > 0)
      .map((fact) => fact.data.externalOrderId),
  );
  const fields = {
    settled: refunds
      .filter((fact) => contains(request.input, fact.data.succeededAt))
      .map((fact) => fact.data.succeededMinor!),
    paid: payments
      .filter((fact) => contains(request.input, fact.data.paidAt))
      .map((fact) => fact.data.paidMinor!),
    cohortPaid: cohort.map((fact) => fact.data.paidMinor!),
    orders: cohort.map(() => 1),
    refundedOrders: [...refunded].map(() => 1),
    cohortRefund: cohortRefunds.map((fact) => fact.data.succeededMinor!),
  };
  return sumFields(fields, math);
}
function analyze(request: RefundMetricRequest, math: ExactMinorMath): MetricResult<Analysis> {
  const payments = (request.input.paymentFacts ?? []).filter(knownPayment);
  for (const payment of payments) {
    const result = reconcile(payment, math);
    if (!result.ok) return failure(result.error.code, result.error.evidenceIds);
  }
  const associated = association(request.input, payments, math);
  if (!associated.ok) return associated;
  const sums = totals(request, payments, math);
  if (!sums.ok) return sums;
  return success({
    totals: sums.value,
    paymentIssues: (request.input.paymentFacts ?? []).flatMap(paymentIssues),
    refundIssues: [
      ...(request.input.refundFacts ?? []).flatMap(refundIssues),
      ...associated.value.refund,
    ],
    joinIssues: associated.value.join,
  });
}
function sources(kind: Kind) {
  return kind === "REFUND_SETTLED_AMOUNT"
    ? (["refundFacts"] as const)
    : (["paymentFacts", "refundFacts"] as const);
}
function sourceIssues(kind: Kind, analysis: Analysis): DataQualityIssueV1[] {
  return kind === "REFUND_SETTLED_AMOUNT"
    ? [...analysis.refundIssues]
    : [...analysis.refundIssues, ...analysis.paymentIssues, ...analysis.joinIssues];
}
function status(issues: Issues): MetricStatus {
  if (issues.some((row) => row.code === "NOT_SYNCHRONIZED")) return "UNAVAILABLE";
  if (issues.some((row) => row.code === "STALE_SOURCE")) return "STALE";
  if (
    uncertain(issues) ||
    issues.some((row) => ["IMMATURE_COHORT", "ZERO_DENOMINATOR"].includes(row.code))
  )
    return "INSUFFICIENT";
  return issues.length ? "ESTIMATED" : "VERIFIED";
}
function quality(
  request: RefundMetricRequest,
  kind: Kind,
  analysis: Analysis,
  extra: Issues,
): MetricQuality {
  const { input } = request,
    required = sources(kind);
  const proofs = input.metricCoverage.filter(
    (proof) =>
      proof.kind === kind &&
      proof.subject.kind === "STORE" &&
      required.every((key) => proof.collections.includes(key)),
  );
  const issues = [...sourceIssues(kind, analysis), ...extra];
  const evidenceIds = evidence(input, kind, proofs, issues);
  const missing = required.filter((key) => input[key] === null);
  let coverageBasisPoints = proofs.length
    ? Math.min(...proofs.map((proof) => proof.coverageBasisPoints))
    : 0;
  if (missing.length) {
    return unavailable(missing, evidenceIds);
  }
  if (coverageBasisPoints < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", evidenceIds));
  issues.push(...freshness(input, kind, evidenceIds));
  if (uncertain(issues)) coverageBasisPoints = 0;
  return {
    status: status(issues),
    sampleSize: analysis.totals.orders,
    coverageBasisPoints,
    evidenceIds,
    issues,
  };
}
function freshness(input: MetricInputV1, kind: Kind, evidenceIds: readonly string[]): Issues {
  const cutoff =
    kind === "REFUND_SETTLED_AMOUNT" || kind === "NET_REVENUE_SETTLEMENT"
      ? input.periodEnd
      : input.visibleAt;
  return input.sourceWatermark !== null && Date.parse(input.sourceWatermark) < Date.parse(cutoff)
    ? [issue("STALE_SOURCE", "sourceWatermark", evidenceIds)]
    : [];
}
function evidence(
  input: MetricInputV1,
  kind: Kind,
  proofs: MetricInputV1["metricCoverage"],
  issues: Issues,
): string[] {
  return [
    ...new Set([
      ...input.evidenceIds,
      ...sources(kind).flatMap((key) => (input[key] ?? []).flatMap((fact) => fact.evidenceIds)),
      ...proofs.flatMap((proof) => proof.evidenceIds),
      ...issues.flatMap((row) => row.evidenceIds),
    ]),
  ];
}
function unavailable(missing: readonly string[], evidenceIds: readonly string[]): MetricQuality {
  return {
    status: "UNAVAILABLE",
    sampleSize: 0,
    coverageBasisPoints: 0,
    evidenceIds,
    issues: missing.map((key) => issue("NOT_SYNCHRONIZED", key, evidenceIds)),
  };
}
function measure<K extends Kind>(
  request: RefundMetricRequest,
  kind: K,
  value: number | null,
  analysis: Analysis,
  extra: Issues = [],
): MetricMeasure<K> {
  const resultQuality = quality(request, kind, analysis, extra);
  const unknown = resultQuality.status === "UNAVAILABLE" || uncertain(resultQuality.issues);
  const unit =
    kind === "REFUNDED_COHORT_ORDERS"
      ? "units"
      : kind === "REFUND_COHORT_ORDER_RATE" || kind === "REFUND_COHORT_AMOUNT_RATE"
        ? "basisPoints"
        : "minorCNY";
  return {
    metric: { kind, value: unknown ? null : value, unit } as MetricMeasure<K>["metric"],
    quality: resultQuality,
  };
}
function rates(
  request: RefundMetricRequest,
  analysis: Analysis,
  dependencies: Dependencies,
): MetricResult<{ order: number | null; amount: number | null }> {
  const order = dependencies.math.ratio(
    analysis.totals.refundedOrders,
    analysis.totals.orders,
    dependencies.rounding,
  );
  if (!order.ok) return failure(order.error.code, order.error.evidenceIds);
  const amount = dependencies.math.ratio(
    analysis.totals.cohortRefund,
    analysis.totals.cohortPaid,
    dependencies.rounding,
  );
  if (!amount.ok) return failure(amount.error.code, amount.error.evidenceIds);
  return success({ order: order.value.value, amount: amount.value.value });
}
function maturity(request: RefundMetricRequest, analysis: Analysis) {
  const elapsedAgeHours =
    (Date.parse(request.input.visibleAt) - Date.parse(request.paymentCohort.periodEnd)) / 3600000;
  return {
    paymentWindow: request.paymentCohort,
    observedThrough: request.input.visibleAt,
    requiredAgeHours: request.maturityHours,
    elapsedAgeHours,
    mature: elapsedAgeHours >= request.maturityHours,
    sampleSize: analysis.totals.orders,
  };
}
function rateIssues(
  request: RefundMetricRequest,
  mature: boolean,
  denominator: number,
  field: string,
): Issues {
  if (!mature) return [issue("IMMATURE_COHORT", "paymentCohort", request.input.evidenceIds)];
  return denominator === 0 ? [issue("ZERO_DENOMINATOR", field, request.input.evidenceIds)] : [];
}
function assemble(
  request: RefundMetricRequest,
  analysis: Analysis,
  dependencies: Dependencies,
): MetricResult<RefundMetrics> {
  const net = dependencies.math.subtract(analysis.totals.paid, analysis.totals.settled);
  if (!net.ok) return failure(net.error.code, net.error.evidenceIds);
  const ratios = rates(request, analysis, dependencies);
  if (!ratios.ok) return ratios;
  const cohort = maturity(request, analysis),
    sums = analysis.totals;
  const result = {
    settledRefund: measure(request, "REFUND_SETTLED_AMOUNT", sums.settled, analysis),
    netRevenueSettlement: measure(request, "NET_REVENUE_SETTLEMENT", net.value, analysis),
    refundedCohortOrders: measure(request, "REFUNDED_COHORT_ORDERS", sums.refundedOrders, analysis),
    cohortOrderRate: measure(
      request,
      "REFUND_COHORT_ORDER_RATE",
      cohort.mature ? ratios.value.order : null,
      analysis,
      rateIssues(request, cohort.mature, sums.orders, "paymentFacts"),
    ),
    cohortAmountRate: measure(
      request,
      "REFUND_COHORT_AMOUNT_RATE",
      cohort.mature ? ratios.value.amount : null,
      analysis,
      rateIssues(request, cohort.mature, sums.cohortPaid, "paymentFacts.paidMinor"),
    ),
    cohort,
  };
  return validOutput(request.input, result) ? success(result) : failure("INVALID_INPUT");
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
function validOutput(input: MetricInputV1, result: RefundMetrics): boolean {
  const measures = [
    result.settledRefund,
    result.netRevenueSettlement,
    result.refundedCohortOrders,
    result.cohortOrderRate,
    result.cohortAmountRate,
  ];
  return measures.every(
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
function calculate(
  request: RefundMetricRequest,
  dependencies: Dependencies,
): MetricResult<RefundMetrics> {
  const parsed = requestSchema.safeParse(request);
  if (
    !parsed.success ||
    !precision(parsed.data) ||
    !["HALF_AWAY_FROM_ZERO", "TOWARD_ZERO"].includes(dependencies.rounding)
  )
    return failure("INVALID_INPUT");
  const valid = parsed.data;
  const window = validateWindows(valid, dependencies.windows);
  if (!window.ok) return failure(window.error.code, window.error.evidenceIds);
  const unique = duplicates(valid.input);
  if (!unique.ok) return failure(unique.error.code, unique.error.evidenceIds);
  const analysis = analyze(valid, dependencies.math);
  return analysis.ok ? assemble(valid, analysis.value, dependencies) : analysis;
}
/** Separates settlement occurrence from original-payment cohort observation. */
export function createRefundMetricCalculator(dependencies: Dependencies): RefundMetricCalculator {
  return Object.freeze({
    calculate: (request: RefundMetricRequest) => calculate(request, dependencies),
  });
}
