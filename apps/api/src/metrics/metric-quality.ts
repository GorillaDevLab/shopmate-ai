import type {
  DataQualityIssueV1,
  MetricQuality,
  MetricQualityDependency,
  MetricQualityReducer,
  MetricQualityRequest,
  MetricStatus,
  QualityPolicy,
} from "@shopmate/contracts";

type Rule = QualityPolicy["rules"][number];
type Evaluation = { status: MetricStatus; coverage: number; issues: DataQualityIssueV1[] };
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
function strongest(statuses: readonly MetricStatus[]): MetricStatus {
  return precedence.find((status) => statuses.includes(status)) ?? "VERIFIED";
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function copyIssue(row: DataQualityIssueV1): DataQualityIssueV1 {
  return { ...row, evidenceIds: [...row.evidenceIds] };
}
function observedEmpty(row: MetricQualityDependency, request: MetricQualityRequest, rule: Rule) {
  return (
    row.knownCount === 0 &&
    row.expectedCount === 0 &&
    row.sampleSize === 0 &&
    row.sourceWatermark !== null &&
    Date.parse(row.sourceWatermark) >= Date.parse(request.window.periodEnd) &&
    row.observedAt !== null &&
    Date.parse(row.observedAt) >= Date.parse(request.window.periodEnd) &&
    Date.parse(request.visibleAt) - Date.parse(row.observedAt) <= rule.maximumAgeHours * 3600000 &&
    row.status === "VERIFIED" &&
    row.coverageBasisPoints === 10000 &&
    row.issues.length === 0
  );
}
function evaluate(
  row: MetricQualityDependency,
  request: MetricQualityRequest,
  rule: Rule,
): Evaluation {
  const issues = row.issues.map(copyIssue),
    statuses: MetricStatus[] = [row.status];
  const add = (code: DataQualityIssueV1["code"], status: MetricStatus) => {
    issues.push({ code, field: row.field, evidenceIds: [...row.evidenceIds] });
    statuses.push(status);
  };
  if (row.sourceWatermark === null) add("NOT_SYNCHRONIZED", "UNAVAILABLE");
  if (row.observedAt === null) add("SOURCE_TIME_MISSING", "UNAVAILABLE");
  if (
    (row.sourceWatermark !== null &&
      Date.parse(row.sourceWatermark) < Date.parse(request.window.periodEnd)) ||
    (row.observedAt !== null &&
      Date.parse(request.visibleAt) - Date.parse(row.observedAt) > rule.maximumAgeHours * 3600000)
  )
    add("STALE_SOURCE", "STALE");
  const empty = observedEmpty(row, request, rule);
  if (
    !(empty && rule.allowVerifiedEmptyWindow) &&
    (row.sampleSize < rule.minimumSampleSize || (empty && !rule.allowVerifiedEmptyWindow))
  )
    add("LOW_SAMPLE", "INSUFFICIENT");
  if (issues.some(({ code }) => code === "COST_MISSING" || code === "SOURCE_INCONSISTENT"))
    statuses.push("UNAVAILABLE");
  const coverage =
    row.sourceWatermark === null || issues.some(({ code }) => code === "SOURCE_INCONSISTENT")
      ? 0
      : row.coverageBasisPoints;
  return { status: strongest(statuses), coverage, issues };
}
function reduce(request: MetricQualityRequest): MetricQuality {
  const rule = request.policy.rules.find((row) => row.kind === request.kind)!;
  const selected = request.dependencies.filter((row) => rule.requiredFields.includes(row.field));
  const results = selected.map((row) => evaluate(row, request, rule));
  return freeze({
    status: strongest(results.map((row) => row.status)),
    sampleSize: Math.min(...selected.map((row) => row.sampleSize)),
    coverageBasisPoints: Math.min(...results.map((row) => row.coverage)),
    evidenceIds: [...new Set(selected.flatMap((row) => row.evidenceIds))],
    issues: results.flatMap((row) => row.issues),
  });
}

export function createMetricQualityReducer(): MetricQualityReducer {
  return Object.freeze({ reduce });
}
