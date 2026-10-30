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

type Evidence = Extract<EventEvidenceV1, { eventType: "REVENUE_DROP" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "REVENUE_DROP" }>;
type Frame = { request: EventDetectionRequest; evidence: Evidence; rule: Rule };
type Kind = "PAID_REVENUE" | "NET_REVENUE_SETTLEMENT";
type Fraction = readonly [bigint, bigint];
type Issue = DataQualityIssueV1;
type Quality = EventDetectionOutcome["quality"];
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
type ExactMinor = Readonly<{ numerator: string; denominator: string }>;
/** API-local derivative explanation; this does not extend or persist the shared V1 evidence. */
export type RevenueDropComparison = Readonly<{
  currentMinor: number;
  baselineMinor: number;
  signedDeltaMinor: ExactMinor;
  measure: Readonly<{ kind: Kind; unit: "minorCNY" }>;
  thresholds: Readonly<Rule["thresholds"] & { toleranceBasisPoints: number }>;
  definitionVersion: string;
  baselineVersion: string;
  rulePolicyVersion: string;
  binding: Evidence["binding"];
  period: Readonly<Pick<Evidence, "periodStart" | "periodEnd" | "timezone" | "currency">>;
  sourceReferences: Evidence["sourceReferences"];
  baselineReferences: Evidence["sourceReferences"];
}>;
export type RevenueDropExplanation = Readonly<{
  outcome: EventDetectionOutcome;
  comparison: RevenueDropComparison | null;
}>;

function failure(): EventResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
}
function issue(frame: Frame, code: Issue["code"], field: string): Issue {
  return {
    code,
    field,
    evidenceIds: [...new Set(frame.evidence.sourceReferences.map((ref) => ref.id))].sort(),
  };
}
function relevant(row: Issue, kind: Kind | undefined): boolean {
  const field = row.field.toLowerCase();
  if (
    /cost|fee|profit|contribution|attribution|spend|advertising|inventory|traffic|conversion|discount|promotion/u.test(
      field,
    )
  )
    return false;
  if (kind === "PAID_REVENUE" && /refund|return|netrevenue/u.test(field)) return false;
  return true;
}
function baselineIssues(frame: Frame): Issue[] {
  const before = frame.request.baseline;
  if (!before) return [issue(frame, "LOW_SAMPLE", "baseline")];
  const issues: Issue[] = [];
  if (before.status === "STALE") issues.push(issue(frame, "STALE_SOURCE", "baseline"));
  if (before.alignment !== "ALIGNED") issues.push(issue(frame, "WINDOW_MISMATCH", "baseline"));
  if (before.median === null && before.status !== "STALE" && before.status !== "UNALIGNED")
    issues.push(issue(frame, "LOW_SAMPLE", "baseline"));
  if (
    before.measure.unit !== "minorCNY" ||
    (before.measure.kind !== "PAID_REVENUE" && before.measure.kind !== "NET_REVENUE_SETTLEMENT")
  )
    issues.push(issue(frame, "VERSION_MISMATCH", "baseline.measure"));
  if (before.sampleSize < frame.rule.minimumBaselineSamples)
    issues.push(issue(frame, "LOW_SAMPLE", "baseline.sampleSize"));
  if (before.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "baseline.coverageBasisPoints"));
  if (before.median === 0 && frame.rule.thresholds.relativeDropBasisPoints > 0)
    issues.push(issue(frame, "ZERO_DENOMINATOR", "baseline.median"));
  return issues;
}
function currentIssues(frame: Frame, compared: RevenueDropComparison | null): Issue[] {
  const issues = frame.evidence.issues.filter((row) => relevant(row, compared?.measure.kind));
  if (compared === null) issues.push(issue(frame, "NOT_SYNCHRONIZED", "revenue"));
  if (frame.evidence.sampleSize < frame.rule.minimumSampleSize)
    issues.push(issue(frame, "LOW_SAMPLE", "sampleSize"));
  if (frame.evidence.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "coverageBasisPoints"));
  issues.push(...freshness(frame, frame.evidence.sourceWatermark, "sourceWatermark"));
  const kind = compared?.measure.kind;
  if (
    kind &&
    !frame.evidence.sourceReferences.some(
      (ref) => ref.measure?.kind === kind && ref.measure.unit === "minorCNY",
    )
  )
    issues.push(issue(frame, "NOT_SYNCHRONIZED", "revenue.measure"));
  const snapshots = matchingSnapshots(frame);
  if (kind === "NET_REVENUE_SETTLEMENT" && snapshots.length === 0)
    issues.push(issue(frame, "NOT_SYNCHRONIZED", "revenue.measure"));
  for (const row of snapshots) issues.push(...snapshotIssues(frame, row, compared));
  return issues;
}
function freshness(frame: Frame, watermark: string | null, field: string): Issue[] {
  if (watermark === null) return [issue(frame, "SOURCE_TIME_MISSING", field)];
  return BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(watermark)) >
    BigInt(frame.rule.maximumAgeSeconds) * 1000n
    ? [issue(frame, "STALE_SOURCE", field)]
    : [];
}
function matchingSnapshots(frame: Frame): readonly MetricSnapshotV1[] {
  return frame.request.snapshots.filter(
    (row) => row.metric.kind === frame.request.baseline?.measure.kind,
  );
}
function snapshotIssues(
  frame: Frame,
  row: MetricSnapshotV1,
  compared: RevenueDropComparison | null,
): Issue[] {
  const field = `snapshots.${row.metric.kind}`;
  const issues = [...row.issues];
  if (row.metric.value === null) issues.push(issue(frame, "NOT_SYNCHRONIZED", field));
  else if (row.metric.value !== compared?.currentMinor)
    issues.push(issue(frame, "SOURCE_INCONSISTENT", field));
  if (row.status !== "VERIFIED")
    issues.push(issue(frame, row.status === "STALE" ? "STALE_SOURCE" : "PARTIAL_COVERAGE", field));
  if (row.sampleSize < frame.rule.minimumSampleSize) issues.push(issue(frame, "LOW_SAMPLE", field));
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", field));
  return [...issues, ...freshness(frame, row.sourceWatermark, field)];
}
function quality(frame: Frame, extra: readonly Issue[]): Quality {
  const unique = new Map<string, Issue>();
  for (const row of [...frame.evidence.issues, ...extra]) {
    const item = { ...row, evidenceIds: [...new Set(row.evidenceIds)].sort() };
    unique.set(JSON.stringify(item), item);
  }
  const issues = [...unique.values()];
  const snapshots = matchingSnapshots(frame);
  const statuses: Quality["dataStatus"][] = [
    frame.evidence.dataStatus,
    ...snapshots.map((row) => row.status),
  ];
  if (extra.length > 0) statuses.push("INSUFFICIENT");
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  return {
    dataStatus: precedence.find((status) => statuses.includes(status)) ?? "VERIFIED",
    sampleSize: Math.min(frame.evidence.sampleSize, ...snapshots.map((row) => row.sampleSize)),
    coverageBasisPoints: Math.min(
      frame.evidence.coverageBasisPoints,
      ...snapshots.map((row) => row.coverageBasisPoints),
    ),
    issues,
  };
}
function noCandidate(
  frame: Frame,
  issues: readonly Issue[],
  reason: Reason,
): RevenueDropExplanation {
  return {
    comparison: null,
    outcome: {
      disposition: "NO_CANDIDATE",
      reason,
      quality: quality(frame, issues),
      blockedResources: [],
    },
  };
}
function reason(issues: readonly Issue[]): Reason {
  if (issues.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  return issues.some((row) => row.code === "STALE_SOURCE")
    ? "STALE_SOURCE"
    : "INSUFFICIENT_EVIDENCE";
}
function fraction(value: number): Fraction {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  let numerator = (bits & ((1n << 52n) - 1n)) + (exponent === 0 ? 0n : 1n << 52n);
  const shift = (exponent === 0 ? 1 : exponent) - 1075;
  let denominator = 1n << BigInt(Math.max(-shift, 0));
  numerator <<= BigInt(Math.max(shift, 0));
  while (denominator > 1n && numerator % 2n === 0n) {
    numerator /= 2n;
    denominator /= 2n;
  }
  return [bits >> 63n === 0n ? numerator : -numerator, denominator];
}
function signedDelta(current: number, baseline: number): ExactMinor {
  const [before, denominator] = fraction(baseline);
  const numerator = BigInt(current) * denominator - before;
  return Object.freeze({ numerator: numerator.toString(), denominator: denominator.toString() });
}
function comparison(frame: Frame): RevenueDropComparison | null {
  const baseline = frame.request.baseline;
  const kind = baseline?.measure.kind;
  if (
    !baseline ||
    baseline.median === null ||
    (kind !== "PAID_REVENUE" && kind !== "NET_REVENUE_SETTLEMENT")
  )
    return null;
  const amount =
    kind === "PAID_REVENUE"
      ? frame.evidence.facts.paidRevenueMinor
      : frame.evidence.facts.netRevenueMinor;
  if (amount === null) return null;
  const { periodStart, periodEnd, timezone, currency } = frame.evidence;
  return Object.freeze({
    currentMinor: amount,
    baselineMinor: baseline.median,
    signedDeltaMinor: signedDelta(amount, baseline.median),
    measure: Object.freeze({ kind, unit: "minorCNY" }),
    thresholds: Object.freeze({
      ...frame.rule.thresholds,
      toleranceBasisPoints: frame.rule.toleranceBasisPoints,
    }),
    definitionVersion: frame.evidence.definitionVersion,
    baselineVersion: baseline.version,
    rulePolicyVersion: frame.request.policy.version,
    binding: frame.evidence.binding,
    period: Object.freeze({ periodStart, periodEnd, timezone, currency }),
    sourceReferences: frame.evidence.sourceReferences,
    baselineReferences: baseline.sourceReferences,
  });
}
function qualifies(value: RevenueDropComparison): boolean {
  const deterioration = -BigInt(value.signedDeltaMinor.numerator);
  const denominator = BigInt(value.signedDeltaMinor.denominator);
  const [before, baseDenominator] = fraction(Math.abs(value.baselineMinor));
  const { relativeDropBasisPoints, minimumDropMinor, toleranceBasisPoints } = value.thresholds;
  const relative = BigInt(relativeDropBasisPoints) * BigInt(10000 + toleranceBasisPoints);
  // Cross products keep exact minor amounts and median half steps beyond safe-number products.
  return (
    deterioration > 0n &&
    deterioration >= BigInt(minimumDropMinor) * denominator &&
    deterioration * 100000000n * baseDenominator >= before * relative * denominator
  );
}
function evaluate(frame: Frame): RevenueDropExplanation {
  const compared = comparison(frame);
  const baseline = baselineIssues(frame);
  const current = currentIssues(frame, compared);
  const issues = [...baseline, ...current];
  if (baseline.length > 0) return noCandidate(frame, issues, "BASELINE_UNAVAILABLE");
  if (current.length > 0 || compared === null) return noCandidate(frame, issues, reason(current));
  if (!qualifies(compared))
    return {
      comparison: compared,
      outcome: { ...noCandidate(frame, issues, "NORMAL_SEASONALITY").outcome },
    };
  const evaluated = quality(frame, issues);
  const evidence = { ...frame.evidence, ...evaluated };
  return {
    comparison: compared,
    outcome: {
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
    },
  };
}

export class RevenueDropDetector implements EventDetector {
  detect(request: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const result = this.explain(request);
    return result.ok ? { ok: true, value: result.value.outcome } : result;
  }
  explain(raw: EventDetectionRequest): EventResult<RevenueDropExplanation> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.evidence.eventType !== "REVENUE_DROP") return failure();
    const request = parsed.data;
    const evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "REVENUE_DROP");
    if (!rule) return failure();
    const result = evaluate({ request, evidence, rule });
    const output = EventDetectionOutcomeSchema.safeParse(result.outcome);
    return output.success
      ? { ok: true, value: Object.freeze({ ...result, outcome: output.data }) }
      : failure();
  }
}
