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
  type MetricTraffic,
  type MetricCampaignFact,
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
  const selected = rows.filter((row) => overlaps(row.data!, frame.input));
  if (!selected.length) return missing(frame, "TRAFFIC_MISSING", "traffic.window");
  if (selected.some((row) => !inside(row.data!, frame.input)))
    return windowMissing(
      frame,
      selected.flatMap((row) => row.evidenceIds),
      "traffic.window",
    );
  const sides = selected.map((row) => trafficRow(row, field));
  return combine(frame, sides);
}
function trafficRow(row: MetricTraffic, field: "paidOrders" | "cart" | "checkout"): Side {
  const data = row.data!;
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
function overlaps(a: MetricWindow, b: MetricWindow): boolean {
  return (
    Date.parse(a.periodStart) < Date.parse(b.periodEnd) &&
    Date.parse(b.periodStart) < Date.parse(a.periodEnd)
  );
}
function inside(a: MetricWindow, b: MetricWindow): boolean {
  return (
    Date.parse(a.periodStart) >= Date.parse(b.periodStart) &&
    Date.parse(a.periodEnd) <= Date.parse(b.periodEnd)
  );
}
function windowMissing(frame: Frame, evidence: readonly string[], field: string): Side {
  return {
    ...missing(frame, "ATTRIBUTION_MISSING", field),
    evidenceIds: evidence,
    issues: [issue("WINDOW_MISMATCH", field, evidence)],
  };
}
function sum(
  frame: Frame,
  values: readonly (number | null)[],
  evidence: readonly string[],
): number | null {
  return values.some((n) => n === null)
    ? null
    : checked(frame.deps.math.add(values as number[]), evidence);
}
function intervalCoverage(frame: Frame, sides: readonly Side[]): number {
  const intervals = sides
    .map((row) => row.coverage!)
    .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart));
  const spans: { start: number; end: number }[] = [];
  for (const row of intervals) {
    const start = Date.parse(row.periodStart),
      end = Date.parse(row.periodEnd),
      last = spans.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  const duration = checked(
    frame.deps.math.add(spans.map((row) => row.end - row.start)),
    sides.flatMap((row) => row.evidenceIds),
  );
  const total = Date.parse(frame.input.periodEnd) - Date.parse(frame.input.periodStart);
  return checked(frame.deps.math.ratio(duration, total, "TOWARD_ZERO"), frame.input.evidenceIds)
    .value!;
}
function combinedProvenance(
  sides: readonly Side[],
  measured: number,
): MetricMeasuredCoverage | null {
  const coverage = sides.map((row) => row.coverage!),
    first = coverage[0]!;
  const ordered = [...coverage].sort(
    (a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart),
  );
  const contiguous = ordered.every(
    (row, i) => i === 0 || Date.parse(row.periodStart) <= Date.parse(ordered[i - 1]!.periodEnd),
  );
  if (
    !contiguous ||
    coverage.some(
      (row) => row.sourceVersion !== first.sourceVersion || row.observedAt !== first.observedAt,
    )
  )
    return null;
  if (coverage.length === 1) return first;
  return {
    ...first,
    periodStart: ordered[0]!.periodStart,
    periodEnd: ordered.reduce(
      (end, row) => (Date.parse(row.periodEnd) > Date.parse(end) ? row.periodEnd : end),
      first.periodEnd,
    ),
    evidenceIds: ids(...coverage.map((row) => row.evidenceIds)),
    coverageBasisPoints: measured,
  };
}
function combine(frame: Frame, sides: readonly Side[]): Side {
  const evidenceIds = ids(...sides.map((row) => row.evidenceIds));
  const measured = Math.min(...sides.map((row) => row.coverageBasisPoints));
  const coverageBasisPoints = Math.min(measured, intervalCoverage(frame, sides));
  const coverage = combinedProvenance(sides, measured);
  const issues = sides.flatMap((row) => row.issues);
  if (
    !coverage ||
    coverage.periodStart !== frame.input.periodStart ||
    coverage.periodEnd !== frame.input.periodEnd
  )
    issues.push(issue("PARTIAL_COVERAGE", "measurement.provenance-or-window", evidenceIds));
  return {
    numerator: sum(
      frame,
      sides.map((row) => row.numerator),
      evidenceIds,
    ),
    denominator: sum(
      frame,
      sides.map((row) => row.denominator),
      evidenceIds,
    ),
    coverage,
    coverageBasisPoints,
    evidenceIds,
    issues,
  };
}
function campaignSide(frame: Frame): Side {
  if (frame.subject.kind === "SKU")
    return missing(frame, "ATTRIBUTION_MISSING", "campaignFacts.sku-allocation");
  const subject = frame.subject;
  const rows = frame.input.campaignFacts?.filter(
    (row) =>
      subject.kind !== "CAMPAIGN" || row.data.externalCampaignId === subject.externalCampaignId,
  );
  if (!rows?.length || rows.some((row) => row.measuredCoverage === null))
    return missing(frame, "ATTRIBUTION_MISSING", "campaignFacts.measuredCoverage");
  if (!matchingCohorts(rows))
    return windowMissing(
      frame,
      rows.flatMap((row) => row.evidenceIds),
      "campaignFacts.cohort",
    );
  return combine(frame, rows.map(campaignRow));
}
function campaignRow(row: MetricCampaignFact): Side {
  return {
    numerator: row.data.attributedRevenueMinor,
    denominator: row.data.spendMinor,
    coverage: row.measuredCoverage,
    coverageBasisPoints: row.measuredCoverage!.coverageBasisPoints,
    evidenceIds: row.evidenceIds,
    issues: [],
  };
}
function matchingCohorts(rows: readonly MetricCampaignFact[]): boolean {
  const byDate = new Map<string, MetricMeasuredCoverage>();
  for (const row of rows) {
    const coverage = row.measuredCoverage!,
      previous = byDate.get(row.data.date);
    if (
      previous &&
      (Date.parse(previous.periodStart) !== Date.parse(coverage.periodStart) ||
        Date.parse(previous.periodEnd) !== Date.parse(coverage.periodEnd))
    )
      return false;
    byDate.set(row.data.date, coverage);
  }
  return true;
}
function conflicts(frame: Frame): void {
  const traffic = (frame.input.traffic ?? []).filter(
    (row) => row.data !== null && overlaps(row.data, frame.input),
  );
  for (let i = 0; i < traffic.length; i++) {
    for (const other of traffic.slice(i + 1))
      if (overlaps(traffic[i]!.data!, other.data!))
        reject("CONFLICT", ids(traffic[i]!.evidenceIds, other.evidenceIds));
  }
  const campaigns = new Map<string, MetricCampaignFact>();
  for (const row of frame.input.campaignFacts ?? []) {
    const key = JSON.stringify([row.data.externalCampaignId, row.data.date]),
      previous = campaigns.get(key);
    if (previous) reject("CONFLICT", ids(previous.evidenceIds, row.evidenceIds));
    campaigns.set(key, row);
  }
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
      ...(kind === "ROAS" ? (frame.input.campaignFacts ?? []).map((row) => row.evidenceIds) : []),
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
    conflicts(frame);
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
