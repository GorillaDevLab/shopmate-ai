import {
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
  if (!issues.length && coverage < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", input.evidenceIds));
  if (
    input.sourceWatermark !== null &&
    Date.parse(input.sourceWatermark) < Date.parse(input.visibleAt)
  )
    issues.push(issue("STALE_SOURCE", "sourceWatermark", input.evidenceIds));
  return { coverage, issues };
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
    gross === null || shipping === null || resultQuality.status === "UNAVAILABLE"
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
function calculate(
  request: ContributionRequest,
  deps: Dependencies,
): MetricResult<EstimatedNetProfit> {
  try {
    const fees = categories(request.input, deps);
    return freeze({
      ok: true,
      value: {
        contribution: measure(request, "CONTRIBUTION", fees.slice(0, 4), deps),
        estimatedNetProfit: measure(request, "ESTIMATED_NET_PROFIT", fees, deps),
        excludedFeeKinds: fees.filter((row) => row.coverage < 10000).map((row) => row.kind),
        feeCoverage: fees.map((row) => ({ kind: row.kind, coverageBasisPoints: row.coverage })),
      },
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
