import { z } from "zod";
import {
  BasisPointsSchema,
  DataQualityIssueV1Schema,
  ExternalIdSchema,
  MetricComputationV1Schema,
  MetricEvidenceIdsSchema,
  MetricInputV1Schema,
  MetricSnapshotV1Schema,
  MetricStatusSchema,
  MetricValueSchema,
  MinorAmountSchema,
  SourceVersionSchema,
  type ContributionCalculator,
  type ContributionRequest,
  type DataQualityIssueV1,
  type EstimatedNetProfit,
  type ExactMinorMath,
  type MetricError,
  type MetricErrorCode,
  type MetricFee,
  type MetricFeeKind,
  type MetricInputV1,
  type MetricMeasure,
  type MetricQuality,
  type MetricResult,
  type MetricStatus,
  type MinorRounding,
} from "@shopmate/contracts";

type Dependencies = Readonly<{ math: ExactMinorMath; rounding: MinorRounding }>;
type Kind = "CONTRIBUTION" | "ESTIMATED_NET_PROFIT";
type Category = Readonly<{
  kind: MetricFeeKind;
  amount: number;
  coverage: number;
  issues: readonly DataQualityIssueV1[];
}>;
const feeKinds = [
  "FULFILLMENT",
  "PLATFORM",
  "PAYMENT",
  "ADVERTISING_PROMOTION",
  "OTHER_OPERATING",
] as const;
const precedence: readonly MetricStatus[] = [
  "UNAVAILABLE",
  "STALE",
  "INSUFFICIENT",
  "ESTIMATED",
  "VERIFIED",
];
const sources = [
  "paymentFacts",
  "refundFacts",
  "frozenCosts",
  "refundAllocations",
  "returnReceipts",
  "fees",
] as const;
const qualitySchema = z.strictObject({
  status: MetricStatusSchema,
  sampleSize: MinorAmountSchema,
  coverageBasisPoints: BasisPointsSchema,
  evidenceIds: MetricEvidenceIdsSchema,
  issues: z.array(DataQualityIssueV1Schema),
});
function measureSchema(kind: string) {
  return z.strictObject({
    metric: MetricValueSchema.refine((metric) => metric.kind === kind),
    quality: qualitySchema,
  });
}
const reversalSchema = z.strictObject({
  externalOrderId: ExternalIdSchema,
  externalLineId: ExternalIdSchema,
  externalReceiptId: ExternalIdSchema,
  skuCostVersion: SourceVersionSchema,
  reversedQuantity: MinorAmountSchema,
  reversedMinor: MinorAmountSchema,
  evidenceIds: MetricEvidenceIdsSchema,
});
const requestSchema = z.strictObject({
  input: MetricInputV1Schema,
  frozenCosts: z.strictObject({
    netMerchandiseRevenue: measureSchema("NET_MERCHANDISE_REVENUE"),
    cogs: measureSchema("COGS"),
    grossProfit: measureSchema("GROSS_PROFIT"),
    policyVersion: SourceVersionSchema,
    reversals: z.array(reversalSchema),
  }),
  netBuyerShipping: z.strictObject({
    amountMinor: MinorAmountSchema.nullable(),
    quality: qualitySchema,
  }),
});
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
  };
}
function evidence(input: MetricInputV1): string[] {
  return ids(
    input.evidenceIds,
    ...sources.flatMap((key) => (input[key] ?? []).map((row) => row.evidenceIds)),
  );
}
function validMeasure(
  input: MetricInputV1,
  metric:
    | MetricMeasure<"GROSS_PROFIT">["metric"]
    | MetricMeasure<"COGS">["metric"]
    | MetricMeasure<"NET_MERCHANDISE_REVENUE">["metric"],
  quality: MetricQuality,
): boolean {
  return (
    quality.evidenceIds.every((id) => evidence(input).includes(id)) &&
    MetricSnapshotV1Schema.safeParse({
      ...context(input),
      ...quality,
      metric,
      subject: { kind: "STORE" },
      computedAt: input.visibleAt,
    }).success
  );
}
function exact(time: string | null): boolean {
  if (time === null) return true;
  return (
    !/[1-9]/.test((/\.(\d+)Z$/.exec(time)?.[1] ?? "").slice(3)) && Number.isFinite(Date.parse(time))
  );
}
function precision(input: MetricInputV1): boolean {
  const times = [input.periodStart, input.periodEnd, input.visibleAt, input.sourceWatermark];
  for (const proof of input.metricCoverage)
    times.push(
      proof.periodStart,
      proof.periodEnd,
      proof.visibleAt,
      proof.observedAt,
      proof.sourceWatermark,
    );
  for (const row of input.fees ?? [])
    times.push(row.observedAt, row.data?.periodStart ?? null, row.data?.periodEnd ?? null);
  for (const row of input.paymentFacts ?? []) times.push(row.observedAt, row.data.paidAt);
  return times.every(exact);
}
function validRequest(request: ContributionRequest): boolean {
  const { input, frozenCosts, netBuyerShipping } = request;
  const measures = [frozenCosts.netMerchandiseRevenue, frozenCosts.cogs, frozenCosts.grossProfit];
  const shippingMetric = {
    kind: "NET_MERCHANDISE_REVENUE",
    unit: "minorCNY",
    value: netBuyerShipping.amountMinor,
  } as const;
  return (
    precision(input) &&
    measures.every((row) => validMeasure(input, row.metric, row.quality)) &&
    validMeasure(input, shippingMetric, netBuyerShipping.quality) &&
    frozenCosts.reversals.every((row) =>
      row.evidenceIds.every((id) => evidence(input).includes(id)),
    )
  );
}
function validOutput(input: MetricInputV1, result: EstimatedNetProfit): boolean {
  return [result.contribution, result.estimatedNetProfit].every(
    (row) =>
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
class Rejected extends Error {
  constructor(readonly detail: MetricError) {
    super(detail.code);
  }
}
function checked<T>(result: MetricResult<T>): T {
  if (!result.ok) throw new Rejected(result.error);
  return result.value;
}
function issue(code: DataQualityIssueV1["code"], field: string, evidenceIds: readonly string[]) {
  return { code, field, evidenceIds: ids(evidenceIds) };
}
function reject(code: MetricErrorCode, evidenceIds: readonly string[]): never {
  throw new Rejected({ code, evidenceIds });
}
function cohort(input: MetricInputV1): Set<string> {
  return new Set(
    (input.paymentFacts ?? [])
      .filter(
        ({ data }) =>
          data.paidAt !== null &&
          data.paidMinor !== null &&
          Date.parse(data.paidAt) >= Date.parse(input.periodStart) &&
          Date.parse(data.paidAt) < Date.parse(input.periodEnd),
      )
      .map(({ data }) => data.externalOrderId),
  );
}
function relevantFees(input: MetricInputV1): MetricFee[] {
  const orders = cohort(input);
  return (input.fees ?? []).filter((row) => {
    const data = row.data;
    if (!data) return true;
    if (data.externalOrderId !== null && !orders.has(data.externalOrderId)) return false;
    const start = Date.parse(data.periodStart),
      end = Date.parse(data.periodEnd);
    if (end <= Date.parse(input.periodStart) || start >= Date.parse(input.periodEnd)) return false;
    if (start !== Date.parse(input.periodStart) || end !== Date.parse(input.periodEnd))
      reject("WINDOW_MISMATCH", row.evidenceIds);
    return true;
  });
}
function uniqueFees(rows: readonly MetricFee[]): void {
  const seen: MetricFee[] = [];
  for (const row of rows) {
    if (!row.data) continue;
    const prior = seen.find(
      ({ data }) =>
        data?.kind === row.data!.kind &&
        (data.externalOrderId === row.data!.externalOrderId ||
          data.externalOrderId === null ||
          row.data!.externalOrderId === null),
    );
    if (prior) reject("CONFLICT", ids(prior.evidenceIds, row.evidenceIds));
    seen.push(row);
  }
}
function category(
  input: MetricInputV1,
  rows: readonly MetricFee[],
  kind: MetricFeeKind,
  deps: Dependencies,
): Category {
  const known = rows.filter((row) => row.data?.kind === kind);
  const ambiguous = rows.filter((row) => row.data === null);
  const evidence = ids(...[...known, ...ambiguous].map((row) => row.evidenceIds));
  const coverage =
    known.length && !ambiguous.length
      ? Math.min(
          ...known.map((row) =>
            row.data!.amountMinor === null ? 0 : row.data!.coverageBasisPoints,
          ),
        )
      : 0;
  const issues: DataQualityIssueV1[] = [];
  if (coverage < 10000)
    issues.push(
      issue("FEE_MISSING", `fees.${kind}`, evidence.length ? evidence : input.evidenceIds),
    );
  if (known.some((row) => row.data!.basis === "ESTIMATED"))
    issues.push(issue("FEE_ESTIMATED", `fees.${kind}`, evidence));
  if (known.some((row) => row.data!.coverageBasisPoints < 10000))
    issues.push(issue("PARTIAL_COVERAGE", `fees.${kind}`, evidence));
  return {
    kind,
    amount: checked(deps.math.add(known.map((row) => row.data!.amountMinor ?? 0))),
    coverage,
    issues,
  };
}
function categories(input: MetricInputV1, deps: Dependencies): Category[] {
  const rows = relevantFees(input);
  uniqueFees(rows);
  return feeKinds.map((kind) => category(input, rows, kind, deps));
}
function sourceQuality(input: MetricInputV1, kind: Kind) {
  const proofs = input.metricCoverage.filter(
    (row) =>
      row.kind === kind &&
      row.subject.kind === "STORE" &&
      sources.every((key) => row.collections.includes(key)),
  );
  const coverage = proofs.length ? Math.min(...proofs.map((row) => row.coverageBasisPoints)) : 0;
  const issues = sources
    .filter((key) => input[key] === null)
    .map((key) => issue("NOT_SYNCHRONIZED", key, input.evidenceIds));
  issues.push(...paymentUncertainty(input));
  if (!issues.length && coverage < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", input.evidenceIds));
  if (
    input.sourceWatermark !== null &&
    Date.parse(input.sourceWatermark) < Date.parse(input.visibleAt)
  )
    issues.push(issue("STALE_SOURCE", "sourceWatermark", input.evidenceIds));
  return { coverage, issues };
}
function paymentUncertainty(input: MetricInputV1): DataQualityIssueV1[] {
  return (input.paymentFacts ?? []).flatMap((row) => {
    const unknown =
      row.data.paidMinor === null ||
      row.data.source.quality.issues.includes("PAYMENT_UNKNOWN") ||
      (row.data.paidAt === null &&
        (row.data.paidMinor !== 0 || ["PAID", "FULFILLED", "COMPLETED"].includes(row.data.status)));
    return unknown ? [issue("PAYMENT_UNKNOWN", "paymentFacts", row.evidenceIds)] : [];
  });
}
function uncertain(issues: readonly DataQualityIssueV1[]): boolean {
  return issues.some((row) =>
    ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN", "RETURN_UNKNOWN", "SOURCE_INCONSISTENT"].includes(
      row.code,
    ),
  );
}
function overallStatus(
  upstream: readonly MetricQuality[],
  issues: readonly DataQualityIssueV1[],
): MetricStatus {
  const statuses: MetricStatus[] = [
    ...upstream.map((row) => row.status),
    issues.length ? "ESTIMATED" : "VERIFIED",
  ];
  if (issues.some((row) => row.code === "NOT_SYNCHRONIZED")) statuses.push("UNAVAILABLE");
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  if (uncertain(issues)) statuses.push("INSUFFICIENT");
  return precedence.find((candidate) => statuses.includes(candidate))!;
}
function categoryCoverage(selected: readonly Category[], deps: Dependencies): number {
  return checked(
    deps.math.ratio(
      checked(deps.math.add(selected.map((row) => row.coverage))),
      selected.length * 10000,
      deps.rounding,
    ),
  ).value!;
}
function quality(
  request: ContributionRequest,
  kind: Kind,
  selected: readonly Category[],
  deps: Dependencies,
): MetricQuality {
  const { input, frozenCosts, netBuyerShipping } = request;
  const upstream = [frozenCosts.grossProfit.quality, netBuyerShipping.quality];
  const source = sourceQuality(input, kind);
  const issues = [
    ...upstream.flatMap((row) => row.issues),
    ...selected.flatMap((row) => row.issues),
    ...source.issues,
  ];
  const unavailable =
    issues.some((row) => row.code === "NOT_SYNCHRONIZED") ||
    upstream.some((row) => row.status === "UNAVAILABLE");
  const coverage = categoryCoverage(selected, deps);
  return {
    status: overallStatus(upstream, issues),
    sampleSize: unavailable ? 0 : Math.min(...upstream.map((row) => row.sampleSize)),
    coverageBasisPoints: unavailable
      ? 0
      : Math.min(coverage, source.coverage, ...upstream.map((row) => row.coverageBasisPoints)),
    evidenceIds: ids(
      input.evidenceIds,
      ...upstream.map((row) => row.evidenceIds),
      ...sources.flatMap((key) => (input[key] ?? []).map((row) => row.evidenceIds)),
      ...issues.map((row) => row.evidenceIds),
    ),
    issues,
  };
}
function measure<K extends Kind>(
  request: ContributionRequest,
  kind: K,
  selected: readonly Category[],
  deps: Dependencies,
): MetricMeasure<K> {
  const gross = request.frozenCosts.grossProfit.metric.value;
  const shipping = request.netBuyerShipping.amountMinor;
  const resultQuality = quality(request, kind, selected, deps);
  const amount =
    gross === null ||
    shipping === null ||
    resultQuality.status === "UNAVAILABLE" ||
    uncertain(resultQuality.issues)
      ? null
      : checked(
          deps.math.subtract(
            checked(deps.math.add([gross, shipping])),
            checked(deps.math.add(selected.map((row) => row.amount))),
          ),
        );
  return {
    metric: { kind, unit: "minorCNY", value: amount } as MetricMeasure<K>["metric"],
    quality: resultQuality,
  };
}
function netMeasure(
  request: ContributionRequest,
  fees: readonly Category[],
  contribution: MetricMeasure<"CONTRIBUTION">,
  deps: Dependencies,
): MetricMeasure<"ESTIMATED_NET_PROFIT"> {
  const resultQuality = quality(request, "ESTIMATED_NET_PROFIT", fees, deps);
  const amount =
    contribution.metric.value === null ||
    resultQuality.status === "UNAVAILABLE" ||
    uncertain(resultQuality.issues)
      ? null
      : checked(deps.math.subtract(contribution.metric.value, fees[4]!.amount));
  return {
    metric: { kind: "ESTIMATED_NET_PROFIT", unit: "minorCNY", value: amount },
    quality: resultQuality,
  };
}
function calculate(
  request: ContributionRequest,
  deps: Dependencies,
): MetricResult<EstimatedNetProfit> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || !["HALF_AWAY_FROM_ZERO", "TOWARD_ZERO"].includes(deps.rounding))
    return freeze({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
  // The port omits upstream revision/window provenance; readers and hosts must bind it before calling.
  const validated = parsed.data as ContributionRequest;
  if (!validRequest(validated))
    return freeze({
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: ids(validated.input.evidenceIds) },
    });
  try {
    const fees = categories(validated.input, deps);
    const contribution = measure(validated, "CONTRIBUTION", fees.slice(0, 4), deps);
    const result = {
      contribution,
      estimatedNetProfit: netMeasure(validated, fees, contribution, deps),
      excludedFeeKinds: fees.filter((row) => row.coverage < 10000).map((row) => row.kind),
      feeCoverage: fees.map((row) => ({ kind: row.kind, coverageBasisPoints: row.coverage })),
    };
    return validOutput(validated.input, result)
      ? freeze({ ok: true, value: result })
      : freeze({
          ok: false,
          error: { code: "INVALID_INPUT", evidenceIds: ids(validated.input.evidenceIds) },
        });
  } catch (error) {
    if (error instanceof Rejected)
      return freeze({
        ok: false,
        error: { ...error.detail, evidenceIds: ids(error.detail.evidenceIds) },
      });
    throw error;
  }
}
/** Pure estimated operating profit over supplied historical gross profit and allocated fees. */
export function createContributionCalculator(dependencies: Dependencies): ContributionCalculator {
  return Object.freeze({
    calculate: (request: ContributionRequest) => calculate(request, dependencies),
  });
}
