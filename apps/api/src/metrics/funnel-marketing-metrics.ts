import {
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricRatioEvidenceSchema,
  MetricSubjectSchema,
  type DataQualityIssueV1,
  type ExactMinorMath,
  type FunnelMarketingCalculator,
  type FunnelMarketingMetrics,
  type MetricError,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricMeasuredCoverage,
  type MetricResult,
  type MetricStatus,
  type MetricSubject,
  type MetricWindow,
  type MinorRounding,
  type RatioEvidence,
} from "@shopmate/contracts";

type Kind = "CONVERSION_RATE" | "CART_RATE" | "CHECKOUT_RATE" | "ROAS";
type Dependencies = Readonly<{ math: ExactMinorMath; rounding: MinorRounding }>;
type Side = Readonly<{
  numerator: number | null;
  denominator: number | null;
  coverage: MetricMeasuredCoverage | null;
  evidenceIds: readonly string[];
  issues: readonly DataQualityIssueV1[];
  coverageBasisPoints: number;
}>;
type Frame = Readonly<{ input: MetricInputV1; subject: MetricSubject; deps: Dependencies }>;
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
function ids(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
class Rejected extends Error {
  constructor(readonly detail: MetricError) {
    super(detail.code);
  }
}
function reject(code: MetricErrorCode, evidenceIds: readonly string[]): never {
  throw new Rejected({ code, evidenceIds: ids(evidenceIds) });
}
function checked<T>(result: MetricResult<T>, evidence: readonly string[]): T {
  if (!result.ok) reject(result.error.code, ids(evidence, result.error.evidenceIds));
  return result.value;
}
function issue(
  code: DataQualityIssueV1["code"],
  field: string,
  evidenceIds: readonly string[],
): DataQualityIssueV1 {
  return { code, field, evidenceIds: ids(evidenceIds) };
}
function windowOf(input: MetricWindow): MetricWindow {
  const { periodStart, periodEnd, timezone, currency } = input;
  return { periodStart, periodEnd, timezone, currency };
}
function context(input: MetricInputV1) {
  const { schemaVersion, definitionVersion, inputRevision, binding, visibleAt, sourceWatermark } =
    input;
  return {
    schemaVersion,
    definitionVersion,
    inputRevision,
    binding,
    visibleAt,
    sourceWatermark,
    ...windowOf(input),
  };
}
function missing(
  frame: Frame,
  code: "TRAFFIC_MISSING" | "ATTRIBUTION_MISSING",
  field: string,
): Side {
  return {
    numerator: null,
    denominator: null,
    coverage: null,
    coverageBasisPoints: 0,
    evidenceIds: frame.input.evidenceIds,
    issues: [issue(code, field, frame.input.evidenceIds)],
  };
}
function trafficSide(frame: Frame, field: "paidOrders" | "cart" | "checkout"): Side {
  const rows = frame.input.traffic;
  if (frame.subject.kind !== "STORE" || !rows?.length || rows.some((row) => row.data === null))
    return missing(frame, "TRAFFIC_MISSING", "traffic.subject-or-measurement");
  const row = rows[0]!,
    data = row.data!;
  const { binding, observedAt, sourceVersion, evidenceIds } = row;
  return {
    numerator: data[field],
    denominator: data.visitors,
    evidenceIds,
    issues: [],
    coverageBasisPoints: data.coverageBasisPoints,
    coverage: {
      binding,
      observedAt,
      sourceVersion,
      evidenceIds,
      ...windowOf(data),
      coverageBasisPoints: data.coverageBasisPoints,
    },
  };
}
function campaignSide(frame: Frame): Side {
  if (frame.subject.kind === "SKU")
    return missing(frame, "ATTRIBUTION_MISSING", "campaignFacts.sku-allocation");
  const rows = frame.input.campaignFacts;
  if (!rows?.length || rows.some((row) => row.measuredCoverage === null))
    return missing(frame, "ATTRIBUTION_MISSING", "campaignFacts.measuredCoverage");
  const row = rows[0]!;
  return {
    numerator: row.data.attributedRevenueMinor,
    denominator: row.data.spendMinor,
    coverage: row.measuredCoverage,
    coverageBasisPoints: row.measuredCoverage!.coverageBasisPoints,
    evidenceIds: row.evidenceIds,
    issues: [],
  };
}
function sameSubject(a: MetricSubject, b: MetricSubject): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "SKU" && b.kind === "SKU") return a.externalSkuId === b.externalSkuId;
  if (a.kind === "CAMPAIGN" && b.kind === "CAMPAIGN")
    return a.externalCampaignId === b.externalCampaignId;
  return true;
}
function proofCoverage(frame: Frame, kind: Kind): number {
  const proofs = frame.input.metricCoverage.filter(
    (row) => row.kind === kind && sameSubject(row.subject, frame.subject),
  );
  const domain = kind === "ROAS" ? "campaignFacts" : "traffic";
  return Math.min(
    ...(proofs.length
      ? proofs.map((row) => (row.collections.includes(domain) ? row.coverageBasisPoints : 0))
      : [0]),
  );
}
function quality(
  frame: Frame,
  kind: Kind,
  side: Side,
  value: number | null,
  extra: DataQualityIssueV1[],
) {
  const coverageBasisPoints = Math.min(side.coverageBasisPoints, proofCoverage(frame, kind));
  const issues = [...side.issues, ...extra];
  if (coverageBasisPoints < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", side.evidenceIds));
  if (frame.input.status !== "VERIFIED")
    issues.push(issue("PARTIAL_COVERAGE", "input.status", frame.input.evidenceIds));
  const statuses: MetricStatus[] = [frame.input.status, issues.length ? "ESTIMATED" : "VERIFIED"];
  if (value === null) statuses.push("UNAVAILABLE");
  return {
    status: precedence.find((status) => statuses.includes(status))!,
    sampleSize: side.denominator ?? 0,
    coverageBasisPoints,
    evidenceIds: ids(
      frame.input.evidenceIds,
      side.evidenceIds,
      ...issues.map((row) => row.evidenceIds),
    ),
    issues,
  };
}
function ratio<K extends Kind>(frame: Frame, kind: K, side: Side): RatioEvidence<K> {
  const extra: DataQualityIssueV1[] = [];
  let value: number | null = null;
  if (side.numerator !== null && side.denominator !== null) {
    const result = checked(
      frame.deps.math.ratio(side.numerator, side.denominator, frame.deps.rounding),
      side.evidenceIds,
    );
    value = result.value;
    if (result.reason) extra.push(issue(result.reason, kind, side.evidenceIds));
  } else if (!side.issues.length)
    extra.push(
      issue(kind === "ROAS" ? "ATTRIBUTION_MISSING" : "TRAFFIC_MISSING", kind, side.evidenceIds),
    );
  return {
    measure: {
      metric: { kind, unit: "basisPoints", value } as RatioEvidence<K>["measure"]["metric"],
      quality: quality(frame, kind, side, value, extra),
    },
    numerator: side.numerator,
    denominator: side.denominator,
    numeratorCoverage: side.coverage,
    denominatorCoverage: side.coverage,
    window: windowOf(frame.input),
    coverageBasisPoints: Math.min(side.coverageBasisPoints, proofCoverage(frame, kind)),
  };
}
function validOutput(frame: Frame, result: FunnelMarketingMetrics): boolean {
  return Object.values(result).every(
    (row) =>
      MetricRatioEvidenceSchema.safeParse(row).success &&
      MetricComputationV1Schema.safeParse({
        input: frame.input,
        snapshot: {
          ...context(frame.input),
          ...row.measure.quality,
          metric: row.measure.metric,
          subject: frame.subject,
          computedAt: frame.input.visibleAt,
        },
      }).success,
  );
}
function calculate(
  input: MetricInputV1,
  subject: MetricSubject,
  deps: Dependencies,
): MetricResult<FunnelMarketingMetrics> {
  const parsed = MetricInputV1Schema.safeParse(input),
    scope = MetricSubjectSchema.safeParse(subject);
  if (!parsed.success || !scope.success)
    return freeze({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
  const frame = { input: parsed.data, subject: scope.data, deps };
  try {
    const result = {
      conversion: ratio(frame, "CONVERSION_RATE", trafficSide(frame, "paidOrders")),
      cart: ratio(frame, "CART_RATE", trafficSide(frame, "cart")),
      checkout: ratio(frame, "CHECKOUT_RATE", trafficSide(frame, "checkout")),
      roas: ratio(frame, "ROAS", campaignSide(frame)),
    };
    if (!validOutput(frame, result)) reject("INVALID_INPUT", frame.input.evidenceIds);
    return freeze({ ok: true, value: result });
  } catch (error) {
    if (error instanceof Rejected) return freeze({ ok: false, error: error.detail });
    throw error;
  }
}
/** Pure, supplied-cutoff visitor funnel and measured attributed-revenue/spend ratios. */
export function createFunnelMarketingCalculator(
  dependencies: Dependencies,
): FunnelMarketingCalculator {
  return Object.freeze({
    calculate: (input: MetricInputV1, subject: MetricSubject) =>
      calculate(input, subject, dependencies),
  });
}
