import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  createEventFingerprint,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventEvidenceV1,
  type EventResult,
  type EventRulePolicyV1,
  type MetricSnapshotV1,
} from "@shopmate/contracts";

type Marketing = Extract<EventEvidenceV1, { eventType: "ROAS_DROP" | "AD_SPEND_SPIKE" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: Marketing["eventType"] }>;
type Frame = { request: EventDetectionRequest; evidence: Marketing; rule: Rule };
type Quality = EventDetectionOutcome["quality"];
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;

function failure(): EventResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
}
function issue(frame: Frame, code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return {
    code,
    field,
    evidenceIds: [...new Set(frame.evidence.sourceReferences.map((row) => row.id))].sort(),
  };
}
function dependency(field: string): "COMMON" | "ATTRIBUTION" | "BASELINE" | "CONTEXT" {
  const key = field.toLowerCase();
  if (/^baseline(?:[._]|$)/u.test(key)) return "BASELINE";
  if (/roas[._]denominator/u.test(key)) return "COMMON";
  if (/impression|click|attributedorders|cost|fee|refund|inventory|traffic/u.test(key))
    return "CONTEXT";
  if (/attribut|roas/u.test(key)) return "ATTRIBUTION";
  return /spend|campaign|marketing|source|coverage|sample|window|version|definition|binding|^facts$|^evidence|^period|^observedat$|^currency$|^timezone$/u.test(
    key,
  )
    ? "COMMON"
    : "CONTEXT";
}
function blockingDiagnostic(frame: Frame, row: DataQualityIssueV1): boolean {
  const target = dependency(row.field);
  if (row.code === "ATTRIBUTION_MISSING")
    return (
      frame.evidence.eventType === "ROAS_DROP" || (target === "COMMON" && !attributionOnly(row))
    );
  if (target === "CONTEXT" || target === "BASELINE") return false;
  if (target === "ATTRIBUTION" && frame.evidence.eventType !== "ROAS_DROP") return false;
  // Numeric policy gates decide measured sample/coverage, not the mere presence of a limitation.
  if (
    ["LOW_SAMPLE", "PARTIAL_COVERAGE"].includes(row.code) &&
    ["sampleSize", "coverageBasisPoints", "facts.attributionCoverageBasisPoints"].includes(
      row.field,
    )
  )
    return false;
  return true;
}
function attributionOnly(row: DataQualityIssueV1): boolean {
  return (
    dependency(row.field) === "ATTRIBUTION" ||
    (row.code === "ATTRIBUTION_MISSING" && /^(?:marketing|campaignFacts)$/u.test(row.field))
  );
}
function freshness(frame: Frame): DataQualityIssueV1[] {
  const watermark = frame.evidence.sourceWatermark;
  if (watermark === null) return [issue(frame, "SOURCE_TIME_MISSING", "sourceWatermark")];
  const age = BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(watermark));
  return age > BigInt(frame.rule.maximumAgeSeconds) * 1000n
    ? [issue(frame, "STALE_SOURCE", "sourceWatermark")]
    : [];
}
function provenance(frame: Frame): DataQualityIssueV1[] {
  const references = frame.evidence.sourceReferences;
  const spend = references.filter(
    (row) =>
      row.kind === "NORMALIZED_AGGREGATE" &&
      row.measure?.kind === "AD_SPEND" &&
      row.measure.unit === "minorCNY",
  );
  const rows: DataQualityIssueV1[] = [];
  if (spend.length === 0) rows.push(issue(frame, "PARTIAL_COVERAGE", "facts.spendMinor"));
  if (
    spend.some(
      (row) =>
        BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(row.observedAt)) >
        BigInt(frame.rule.maximumAgeSeconds) * 1000n,
    )
  )
    rows.push(issue(frame, "STALE_SOURCE", "sourceReferences.AD_SPEND"));
  if (frame.evidence.eventType === "ROAS_DROP" && !hasAttribution(frame))
    rows.push(issue(frame, "ATTRIBUTION_MISSING", "facts.attributedRevenueMinor"));
  return rows;
}
function hasAttribution(frame: Frame): boolean {
  return frame.evidence.sourceReferences.some(
    (row) => row.measure?.kind === "ROAS" && row.measure.unit === "basisPoints",
  );
}
function currentIssues(frame: Frame): DataQualityIssueV1[] {
  const { evidence, rule } = frame;
  const rows = [
    ...evidence.issues.filter((row) => blockingDiagnostic(frame, row)),
    ...freshness(frame),
    ...provenance(frame),
  ];
  if (evidence.facts.spendMinor === null)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "facts.spendMinor"));
  else if (evidence.facts.spendMinor === 0)
    rows.push(issue(frame, "ZERO_DENOMINATOR", "facts.spendMinor"));
  if (evidence.sampleSize < rule.minimumSampleSize)
    rows.push(issue(frame, "LOW_SAMPLE", "sampleSize"));
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "coverageBasisPoints"));
  if (evidence.dataStatus === "UNAVAILABLE" && !independentUnavailableSpend(frame))
    rows.push(issue(frame, "NOT_SYNCHRONIZED", "marketing"));
  if (rule.eventType === "ROAS_DROP") rows.push(...attributionIssues(frame, rule));
  return rows;
}
function independentUnavailableSpend(frame: Frame): boolean {
  const { evidence } = frame;
  // An explicit sibling attribution limitation cannot erase independently complete spend.
  // All provenance, source-time, sample and conflict gates still apply in currentIssues.
  return (
    evidence.eventType === "AD_SPEND_SPIKE" &&
    evidence.coverageBasisPoints === 10000 &&
    evidence.issues.length > 0 &&
    evidence.issues.every(attributionOnly)
  );
}
function attributionIssues(
  frame: Frame,
  rule: Extract<Rule, { eventType: "ROAS_DROP" }>,
): DataQualityIssueV1[] {
  const rows: DataQualityIssueV1[] = [],
    { facts } = frame.evidence;
  if (facts.attributedRevenueMinor === null || !hasAttribution(frame))
    rows.push(issue(frame, "ATTRIBUTION_MISSING", "facts.attributedRevenueMinor"));
  if (facts.attributionCoverageBasisPoints < rule.thresholds.minimumAttributionCoverageBasisPoints)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "facts.attributionCoverageBasisPoints"));
  return rows;
}
function contextIssues(frame: Frame): DataQualityIssueV1[] {
  const { facts } = frame.evidence,
    rows: DataQualityIssueV1[] = [];
  if (facts.attributedRevenueMinor === null || !hasAttribution(frame))
    rows.push(issue(frame, "ATTRIBUTION_MISSING", "facts.attributedRevenueMinor"));
  if (facts.attributionCoverageBasisPoints < 10000)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "facts.attributionCoverageBasisPoints"));
  for (const field of ["impressions", "clicks", "attributedOrders"] as const)
    if (facts[field] === null) rows.push(issue(frame, "PARTIAL_COVERAGE", `facts.${field}`));
  return rows;
}
function baselineIssues(frame: Frame): DataQualityIssueV1[] {
  const baseline = frame.request.baseline;
  const rows = frame.evidence.issues.filter((row) => dependency(row.field) === "BASELINE");
  if (baseline === null) return [...rows, issue(frame, "LOW_SAMPLE", "baseline")];
  if (!["AVAILABLE", "ZERO"].includes(baseline.status) || baseline.alignment !== "ALIGNED")
    rows.push(
      issue(
        frame,
        baseline.status === "STALE"
          ? "STALE_SOURCE"
          : baseline.alignment === "UNALIGNED"
            ? "WINDOW_MISMATCH"
            : "LOW_SAMPLE",
        "baseline",
      ),
    );
  const kind = frame.evidence.eventType === "ROAS_DROP" ? "ROAS" : "AD_SPEND";
  const unit = kind === "ROAS" ? "basisPoints" : "minorCNY";
  if (baseline.measure.kind !== kind || baseline.measure.unit !== unit)
    rows.push(issue(frame, "SOURCE_INCONSISTENT", "baseline.measure"));
  if (baseline.sampleSize < frame.rule.minimumBaselineSamples)
    rows.push(issue(frame, "LOW_SAMPLE", "baseline.sampleSize"));
  if (baseline.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "baseline.coverageBasisPoints"));
  if (baseline.median === 0) rows.push(issue(frame, "ZERO_DENOMINATOR", "baseline.median"));
  return rows;
}
function snapshotIssues(frame: Frame, row: MetricSnapshotV1): DataQualityIssueV1[] {
  const rows = [...row.issues],
    field = "snapshots.ROAS";
  if (row.metric.value === null || row.metric.value !== frame.evidence.facts.roas.valueBasisPoints)
    rows.push(issue(frame, "SOURCE_INCONSISTENT", field));
  if (row.status !== "VERIFIED")
    rows.push(issue(frame, row.status === "STALE" ? "STALE_SOURCE" : "PARTIAL_COVERAGE", field));
  if (row.sampleSize < frame.rule.minimumSampleSize) rows.push(issue(frame, "LOW_SAMPLE", field));
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    rows.push(issue(frame, "PARTIAL_COVERAGE", field));
  if (row.sourceWatermark === null) rows.push(issue(frame, "SOURCE_TIME_MISSING", field));
  else if (
    BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(row.sourceWatermark)) >
    BigInt(frame.rule.maximumAgeSeconds) * 1000n
  )
    rows.push(issue(frame, "STALE_SOURCE", field));
  return rows;
}
function snapshots(frame: Frame): {
  blocking: DataQualityIssueV1[];
  context: DataQualityIssueV1[];
} {
  const blocking: DataQualityIssueV1[] = [],
    context: DataQualityIssueV1[] = [];
  for (const row of frame.request.snapshots) {
    const relevant = row.metric.kind === "ROAS";
    const rows = relevant ? snapshotIssues(frame, row) : [...row.issues];
    (relevant && frame.evidence.eventType === "ROAS_DROP" ? blocking : context).push(...rows);
  }
  return { blocking, context };
}
function canonical(rows: readonly DataQualityIssueV1[]): DataQualityIssueV1[] {
  const unique = new Map<string, DataQualityIssueV1>();
  for (const row of rows) {
    const value = { ...row, evidenceIds: [...new Set(row.evidenceIds)].sort() };
    unique.set(JSON.stringify(value), value);
  }
  return [...unique.values()];
}
function quality(frame: Frame, extra: readonly DataQualityIssueV1[]): Quality {
  const issues = canonical([...frame.evidence.issues, ...extra]);
  const statuses: Quality["dataStatus"][] = [frame.evidence.dataStatus];
  if (issues.length > 0)
    statuses.push(
      issues.every((row) => ["COST_ESTIMATED", "FEE_ESTIMATED"].includes(row.code))
        ? "ESTIMATED"
        : "INSUFFICIENT",
    );
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  return {
    dataStatus: precedence.find((status) => statuses.includes(status)) ?? "VERIFIED",
    sampleSize: frame.evidence.sampleSize,
    coverageBasisPoints: frame.evidence.coverageBasisPoints,
    issues,
  };
}
function noCandidate(
  frame: Frame,
  extra: readonly DataQualityIssueV1[],
  reason: Reason,
): EventDetectionOutcome {
  return {
    disposition: "NO_CANDIDATE",
    reason,
    quality: quality(frame, extra),
    blockedResources: [],
  };
}
function reason(rows: readonly DataQualityIssueV1[]): Reason {
  if (rows.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  return rows.some((row) => row.code === "STALE_SOURCE") ? "STALE_SOURCE" : "INSUFFICIENT_EVIDENCE";
}
function candidate(frame: Frame, extra: readonly DataQualityIssueV1[]): EventDetectionOutcome {
  const evaluated = quality(frame, extra),
    evidence = { ...frame.evidence, ...evaluated };
  return {
    disposition: "CANDIDATE",
    quality: evaluated,
    blockedResources: [],
    candidate: {
      schemaVersion: 1,
      evidence,
      severityFloor: "MEDIUM",
      rulePolicyVersion: frame.request.policy.version,
      fingerprint: createEventFingerprint(evidence),
    },
  };
}
function fraction(value: number): readonly [bigint, bigint] {
  const [mantissa = "0", exponent = "0"] = value.toString().split("e");
  const [whole = "0", decimals = ""] = mantissa.split(".");
  const scale = decimals.length - Number(exponent);
  return [
    BigInt(whole + decimals) * 10n ** BigInt(Math.max(-scale, 0)),
    10n ** BigInt(Math.max(scale, 0)),
  ];
}
function meetsThreshold(frame: Frame): boolean {
  const { spendMinor: spend, attributedRevenueMinor: revenue } = frame.evidence.facts;
  const median = frame.request.baseline?.median,
    { rule } = frame;
  if (
    spend === null ||
    median === null ||
    median === undefined ||
    spend < rule.thresholds.minimumSpendMinor
  )
    return false;
  const [base, scale] = fraction(median),
    tolerance = BigInt(10000 + rule.toleranceBasisPoints);
  // Like compareEventThreshold ABOVE, tolerance multiplies the relative-change threshold.
  // Keep the raw ratio through the comparison: display basis points never decide an alarm.
  if (rule.eventType === "AD_SPEND_SPIKE")
    return (
      (BigInt(spend) * scale - base) * 100000000n >=
      base * BigInt(rule.thresholds.relativeIncreaseBasisPoints) * tolerance
    );
  if (revenue === null || spend === 0) return false;
  return (
    (base * BigInt(spend) - BigInt(revenue) * 10000n * scale) * 100000000n >=
    base * BigInt(spend) * BigInt(rule.thresholds.relativeDropBasisPoints) * tolerance
  );
}
function evaluate(frame: Frame): EventDetectionOutcome {
  const supplied = snapshots(frame),
    current = [...currentIssues(frame), ...supplied.blocking];
  const historical = baselineIssues(frame),
    extra = [...current, ...historical, ...contextIssues(frame), ...supplied.context];
  if (current.length > 0) return noCandidate(frame, extra, reason(current));
  if (historical.length > 0) return noCandidate(frame, extra, "BASELINE_UNAVAILABLE");
  return meetsThreshold(frame)
    ? candidate(frame, extra)
    : noCandidate(frame, extra, "BELOW_THRESHOLD");
}

/** Pure campaign observations only: no accounting mutations or advertising actions. */
export class MarketingDetector implements EventDetector {
  detect(raw: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success) return failure();
    const request = parsed.data,
      evidence = request.evidence;
    if (evidence.eventType !== "ROAS_DROP" && evidence.eventType !== "AD_SPEND_SPIKE")
      return failure();
    const rule = request.policy.rules.find(
      (row): row is Rule => row.eventType === evidence.eventType,
    );
    if (!rule) return failure();
    const result = EventDetectionOutcomeSchema.safeParse(evaluate({ request, evidence, rule }));
    return result.success ? { ok: true, value: result.data } : failure();
  }
}
