import {
  type ContributionCalculator,
  type ContributionRequest,
  type DataQualityIssueV1,
  type EstimatedNetProfit,
  type ExactMinorMath,
  type MetricError,
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
function categories(input: MetricInputV1, deps: Dependencies): Category[] {
  return feeKinds.map((kind) => {
    const rows = (input.fees ?? []).filter((row) => row.data?.kind === kind);
    const evidence = ids(input.evidenceIds, ...rows.map((row) => row.evidenceIds));
    const coverage = rows.length
      ? Math.min(
          ...rows.map((row) =>
            row.data!.amountMinor === null ? 0 : row.data!.coverageBasisPoints,
          ),
        )
      : 0;
    const issues: DataQualityIssueV1[] = [];
    if (coverage < 10000) issues.push(issue("FEE_MISSING", `fees.${kind}`, evidence));
    if (rows.some((row) => row.data!.basis === "ESTIMATED"))
      issues.push(issue("FEE_ESTIMATED", `fees.${kind}`, evidence));
    return {
      kind,
      amount: checked(deps.math.add(rows.map((row) => row.data!.amountMinor ?? 0))),
      coverage,
      issues,
    };
  });
}
function quality(
  request: ContributionRequest,
  selected: readonly Category[],
  deps: Dependencies,
): MetricQuality {
  const { input, frozenCosts, netBuyerShipping } = request;
  const upstream = [frozenCosts.grossProfit.quality, netBuyerShipping.quality];
  const issues = [
    ...upstream.flatMap((row) => row.issues),
    ...selected.flatMap((row) => row.issues),
  ];
  const statuses = [...upstream.map((row) => row.status), issues.length ? "ESTIMATED" : "VERIFIED"];
  const coverage = checked(
    deps.math.ratio(
      checked(deps.math.add(selected.map((row) => row.coverage))),
      selected.length * 10000,
      deps.rounding,
    ),
  ).value!;
  return {
    status: precedence.find((candidate) => statuses.includes(candidate))!,
    sampleSize: Math.min(...upstream.map((row) => row.sampleSize)),
    coverageBasisPoints: Math.min(coverage, ...upstream.map((row) => row.coverageBasisPoints)),
    evidenceIds: ids(
      input.evidenceIds,
      ...upstream.map((row) => row.evidenceIds),
      ...(input.fees ?? []).map((row) => row.evidenceIds),
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
  const amount =
    gross === null || shipping === null
      ? null
      : checked(
          deps.math.subtract(
            checked(deps.math.add([gross, shipping])),
            checked(deps.math.add(selected.map((row) => row.amount))),
          ),
        );
  return {
    metric: { kind, unit: "minorCNY", value: amount } as MetricMeasure<K>["metric"],
    quality: quality(request, selected, deps),
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
