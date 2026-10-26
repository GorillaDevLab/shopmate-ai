import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  createEventFingerprint,
  sameEventPeriod,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventEvidenceV1,
  type EventResult,
  type EventRulePolicyV1,
  type MetricSnapshotV1,
} from "@shopmate/contracts";

type Breakout = Extract<EventEvidenceV1, { eventType: "PRODUCT_BREAKOUT" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "PRODUCT_BREAKOUT" }>;
type Frame = { request: EventDetectionRequest; evidence: Breakout; rule: Rule };
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
type Quality = EventDetectionOutcome["quality"];
const requiredKinds = new Set(["PAID_UNITS", "PAID_ORDERS", "CONVERSION_RATE"]);

function invalid(): EventResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
}
function issue(frame: Frame, code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: frame.evidence.sourceReferences.map((row) => row.id) };
}
function optionalMargin(row: DataQualityIssueV1): boolean {
  return /cost|profit|margin|revenue|fee/iu.test(row.field);
}
function stale(frame: Frame, watermark: string | null): boolean {
  return (
    watermark !== null &&
    Date.parse(frame.evidence.observedAt) - Date.parse(watermark) >
      frame.rule.maximumAgeSeconds * 1000
  );
}
function expected(frame: Frame, row: MetricSnapshotV1): number | null {
  const { facts } = frame.evidence;
  if (row.metric.kind === "PAID_UNITS") return facts.salesUnits;
  if (row.metric.kind === "PAID_ORDERS") return facts.conversion.numerator;
  return facts.conversion.valueBasisPoints;
}
function snapshotIssues(frame: Frame, row: MetricSnapshotV1): DataQualityIssueV1[] {
  const field = `snapshots.${row.metric.kind}`;
  const issues = [...row.issues];
  if (row.metric.value !== expected(frame, row))
    issues.push(issue(frame, "SOURCE_INCONSISTENT", field));
  if (row.status !== "VERIFIED")
    issues.push(issue(frame, row.status === "STALE" ? "STALE_SOURCE" : "PARTIAL_COVERAGE", field));
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", field));
  if (row.sampleSize < frame.rule.minimumSampleSize) issues.push(issue(frame, "LOW_SAMPLE", field));
  if (row.sourceWatermark === null) issues.push(issue(frame, "SOURCE_TIME_MISSING", field));
  else if (stale(frame, row.sourceWatermark)) issues.push(issue(frame, "STALE_SOURCE", field));
  return issues;
}
function coreIssues(frame: Frame): DataQualityIssueV1[] {
  const { evidence, rule } = frame;
  const { facts } = evidence;
  const issues = evidence.issues.filter((row) => !optionalMargin(row));
  if (
    evidence.sampleSize < rule.minimumSampleSize ||
    (facts.conversion.numerator !== null && facts.conversion.numerator < rule.minimumSampleSize)
  )
    issues.push(issue(frame, "LOW_SAMPLE", "facts.conversion.numerator"));
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "sales"));
  if (facts.salesUnits === null || facts.salesUnitsPerHour === null)
    issues.push(issue(frame, "PAYMENT_UNKNOWN", "facts.salesUnits"));
  if (facts.conversion.numerator === null || facts.conversion.denominator === null)
    issues.push(issue(frame, "TRAFFIC_MISSING", "facts.conversion"));
  else if (facts.conversion.denominator === 0)
    issues.push(issue(frame, "ZERO_DENOMINATOR", "facts.conversion"));
  if (facts.listedAt === null) issues.push(issue(frame, "SOURCE_TIME_MISSING", "facts.listedAt"));
  if (evidence.sourceWatermark === null)
    issues.push(issue(frame, "SOURCE_TIME_MISSING", "sourceWatermark"));
  else if (stale(frame, evidence.sourceWatermark))
    issues.push(issue(frame, "STALE_SOURCE", "sourceWatermark"));
  for (const row of frame.request.snapshots)
    if (requiredKinds.has(row.metric.kind)) issues.push(...snapshotIssues(frame, row));
  return issues;
}
function marginIssues(frame: Frame): DataQualityIssueV1[] {
  const issues: DataQualityIssueV1[] = [];
  const { facts } = frame.evidence;
  if (facts.grossProfitMinor === null || facts.costCoverageBasisPoints === 0)
    issues.push(issue(frame, "COST_MISSING", "facts.grossProfitMinor"));
  if (facts.costCoverageBasisPoints > 0 && facts.costCoverageBasisPoints < 10000)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "facts.costCoverageBasisPoints"));
  if (facts.netRevenueMinor === null)
    issues.push(issue(frame, "SOURCE_INCONSISTENT", "facts.netRevenueMinor"));
  for (const row of frame.request.snapshots)
    if (!requiredKinds.has(row.metric.kind)) issues.push(...row.issues);
  return issues;
}
function baselineAvailable(frame: Frame): boolean {
  const baseline = frame.request.baseline;
  if (
    baseline === null ||
    baseline.status !== "AVAILABLE" ||
    baseline.median <= 0 ||
    baseline.alignment !== "ALIGNED" ||
    baseline.measure.kind !== "PAID_UNITS" ||
    baseline.measure.unit !== "units" ||
    baseline.sampleSize < frame.rule.minimumBaselineSamples ||
    baseline.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints
  )
    return false;
  if (!Number.isSafeInteger(baseline.median) && !Number.isSafeInteger(baseline.median * 2))
    return false;
  const periods = new Set(
    baseline.sourceReferences.map((row) => Date.parse(row.period.periodStart)),
  );
  return (
    periods.size >= frame.rule.minimumBaselineSamples &&
    periods.size === baseline.sampleSize &&
    periods.size === baseline.sourceReferences.length &&
    baseline.sourceReferences.some((row) => sameEventPeriod(row.period, baseline.period))
  );
}
function listingConflict(frame: Frame): boolean {
  const listedAt = frame.evidence.facts.listedAt;
  if (listedAt === null) return false;
  const start = Date.parse(listedAt);
  const history = frame.request.baseline?.sourceReferences.map((row) => row.period) ?? [];
  return [frame.evidence.facts.salesWindow, ...history].some(
    (row) => Date.parse(row.periodStart) < start,
  );
}
function quality(frame: Frame, added: readonly DataQualityIssueV1[]): Quality {
  const all = [...frame.evidence.issues, ...added];
  const issues = [...new Map(all.map((row) => [JSON.stringify(row), row])).values()];
  let dataStatus = frame.evidence.dataStatus;
  if (dataStatus === "VERIFIED" && issues.length > 0)
    dataStatus = issues.every(optionalMargin) ? "ESTIMATED" : "INSUFFICIENT";
  if (dataStatus !== "UNAVAILABLE" && issues.some((row) => row.code === "STALE_SOURCE"))
    dataStatus = "STALE";
  return {
    dataStatus,
    sampleSize: frame.evidence.sampleSize,
    coverageBasisPoints: frame.evidence.coverageBasisPoints,
    issues,
  };
}
function noCandidate(
  frame: Frame,
  issues: readonly DataQualityIssueV1[],
  reason: Reason,
): EventDetectionOutcome {
  return {
    disposition: "NO_CANDIDATE",
    reason,
    quality: quality(frame, issues),
    blockedResources: [],
  };
}
function reason(issues: readonly DataQualityIssueV1[]): Reason {
  if (issues.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  return issues.some((row) => row.code === "STALE_SOURCE")
    ? "STALE_SOURCE"
    : "INSUFFICIENT_EVIDENCE";
}
function reachesThreshold(frame: Frame): boolean {
  const baseline = frame.request.baseline;
  const { facts } = frame.evidence;
  if (
    baseline?.median === null ||
    baseline === null ||
    facts.salesUnits === null ||
    facts.conversion.numerator === null ||
    !facts.conversion.denominator
  )
    return false;
  const medianTwice = Number.isSafeInteger(baseline.median)
    ? BigInt(baseline.median) * 2n
    : BigInt(baseline.median * 2);
  const thresholds = frame.rule.thresholds;
  // Equal elapsed windows make unit counts comparable; BigInt avoids rounded growth/conversion alarms.
  return (
    facts.salesUnits >= thresholds.minimumSalesUnits &&
    BigInt(facts.salesUnits) * 20000n >=
      medianTwice * (10000n + BigInt(thresholds.relativeGrowthBasisPoints)) &&
    BigInt(facts.conversion.numerator) * 10000n >=
      BigInt(facts.conversion.denominator) * BigInt(thresholds.minimumConversionBasisPoints)
  );
}
function evaluate(frame: Frame): EventDetectionOutcome {
  const core = coreIssues(frame);
  const issues = [...core, ...marginIssues(frame)];
  if (listingConflict(frame)) {
    issues.push(issue(frame, "SOURCE_INCONSISTENT", "facts.listedAt"));
    return noCandidate(frame, issues, "SOURCE_CONFLICT");
  }
  if (core.length > 0) return noCandidate(frame, issues, reason(core));
  if (!baselineAvailable(frame)) {
    issues.push(issue(frame, "LOW_SAMPLE", "baseline"));
    return noCandidate(frame, issues, "BASELINE_UNAVAILABLE");
  }
  if (!reachesThreshold(frame)) return noCandidate(frame, issues, "BELOW_THRESHOLD");
  const evaluated = quality(frame, issues);
  const evidence = { ...frame.evidence, ...evaluated };
  return {
    disposition: "CANDIDATE",
    quality: evaluated,
    blockedResources: [],
    candidate: {
      schemaVersion: 1,
      severityFloor: "LOW",
      rulePolicyVersion: frame.request.policy.version,
      fingerprint: createEventFingerprint(evidence),
      evidence,
    },
  };
}

/** Pure opportunity assessment; the frozen policy has no listing-age cutoff or action authority. */
export class ProductBreakoutDetector implements EventDetector {
  detect(raw: unknown): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.evidence.eventType !== "PRODUCT_BREAKOUT") return invalid();
    const request = parsed.data;
    const evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "PRODUCT_BREAKOUT");
    if (!rule) return invalid();
    const result = EventDetectionOutcomeSchema.safeParse(evaluate({ request, evidence, rule }));
    return result.success ? { ok: true, value: result.data } : invalid();
  }
}
