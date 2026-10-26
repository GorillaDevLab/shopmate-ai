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

type Conversion = Extract<EventEvidenceV1, { eventType: "CONVERSION_DROP" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "CONVERSION_DROP" }>;
type Frame = { request: EventDetectionRequest; evidence: Conversion; rule: Rule };
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
function affectsConversion(row: DataQualityIssueV1): boolean {
  const field = row.field.toLowerCase();
  if (/cart|checkout|price|variant|baselineconversion|cost|fee|refund|attribution/u.test(field))
    return false;
  if (["PAYMENT_UNKNOWN", "TRAFFIC_MISSING", "ZERO_DENOMINATOR", "LOW_SAMPLE"].includes(row.code))
    return true;
  return /visitor|traffic|paid|payment|conversion|baseline|source|sample|coverage|window|definition|version|^period|^facts$/u.test(
    field,
  );
}
function freshness(frame: Frame): DataQualityIssueV1[] {
  const watermark = frame.evidence.sourceWatermark;
  if (watermark === null) return [issue(frame, "SOURCE_TIME_MISSING", "sourceWatermark")];
  if (
    (Date.parse(frame.evidence.observedAt) - Date.parse(watermark)) / 1000 >
    frame.rule.maximumAgeSeconds
  )
    return [issue(frame, "STALE_SOURCE", "sourceWatermark")];
  return [];
}
function currentIssues(frame: Frame): DataQualityIssueV1[] {
  const issues = [...frame.evidence.issues.filter(affectsConversion), ...freshness(frame)];
  const { visitors, paidOrders } = frame.evidence.facts;
  if (visitors === null) issues.push(issue(frame, "TRAFFIC_MISSING", "facts.visitors"));
  else if (visitors === 0) issues.push(issue(frame, "ZERO_DENOMINATOR", "facts.visitors"));
  else if (visitors < frame.rule.thresholds.minimumVisitors)
    issues.push(issue(frame, "LOW_SAMPLE", "facts.visitors"));
  if (paidOrders === null) issues.push(issue(frame, "PAYMENT_UNKNOWN", "facts.paidOrders"));
  if (frame.evidence.sampleSize < frame.rule.minimumSampleSize)
    issues.push(issue(frame, "LOW_SAMPLE", "sampleSize"));
  if (frame.evidence.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "coverageBasisPoints"));
  return issues;
}
function baselineIssues(frame: Frame): DataQualityIssueV1[] {
  const baseline = frame.request.baseline;
  if (baseline === null) return [issue(frame, "LOW_SAMPLE", "baseline")];
  if (baseline.status === "STALE") return [issue(frame, "STALE_SOURCE", "baseline")];
  if (baseline.median === 0) return [issue(frame, "ZERO_DENOMINATOR", "baseline.median")];
  if (baseline.status !== "AVAILABLE" || baseline.alignment !== "ALIGNED")
    return [issue(frame, "LOW_SAMPLE", "baseline")];
  const issues: DataQualityIssueV1[] = [];
  if (baseline.measure.kind !== "CONVERSION_RATE" || baseline.measure.unit !== "basisPoints")
    issues.push(issue(frame, "SOURCE_INCONSISTENT", "baseline.measure"));
  if (baseline.sampleSize < frame.rule.minimumBaselineSamples)
    issues.push(issue(frame, "LOW_SAMPLE", "baseline.sampleSize"));
  if (baseline.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "baseline.coverageBasisPoints"));
  return issues;
}
function contextIssues(frame: Frame): DataQualityIssueV1[] {
  const issues: DataQualityIssueV1[] = [];
  const facts = frame.evidence.facts;
  for (const field of ["cart", "checkout", "priceChangeBasisPoints", "priceEffectiveAt"] as const) {
    if (facts[field] === null)
      issues.push(
        issue(
          frame,
          field === "cart" || field === "checkout" ? "TRAFFIC_MISSING" : "PARTIAL_COVERAGE",
          `facts.${field}`,
        ),
      );
  }
  if (facts.variantAvailabilityBasisPoints === null)
    issues.push(issue(frame, "INVENTORY_UNKNOWN", "facts.variantAvailabilityBasisPoints"));
  // Known unsellable variants limit price association without making availability unknown.
  else if (facts.variantAvailabilityBasisPoints < 10000)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "facts.variantAvailabilityBasisPoints"));
  // A mixed or pre-change window cannot establish even a full post-change association.
  if (
    facts.priceEffectiveAt !== null &&
    Date.parse(facts.priceEffectiveAt) > Date.parse(frame.evidence.periodStart)
  )
    issues.push(issue(frame, "WINDOW_MISMATCH", "facts.priceEffectiveAt"));
  return issues;
}
function canonical(issues: readonly DataQualityIssueV1[]): DataQualityIssueV1[] {
  const unique = new Map<string, DataQualityIssueV1>();
  for (const row of issues) {
    const value = { ...row, evidenceIds: [...new Set(row.evidenceIds)].sort() };
    unique.set(JSON.stringify(value), value);
  }
  return [...unique.values()];
}
function quality(frame: Frame, extra: readonly DataQualityIssueV1[]): Quality {
  const issues = canonical([...frame.evidence.issues, ...extra]);
  const statuses: Quality["dataStatus"][] = [
    frame.evidence.dataStatus,
    ...frame.request.snapshots.map((row) => row.status),
  ];
  if (issues.length > 0) statuses.push("INSUFFICIENT");
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  return {
    dataStatus: precedence.find((value) => statuses.includes(value)) ?? "VERIFIED",
    sampleSize: frame.evidence.sampleSize,
    coverageBasisPoints: frame.evidence.coverageBasisPoints,
    issues,
  };
}
function reason(issues: readonly DataQualityIssueV1[]): Reason {
  if (issues.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  return issues.some((row) => row.code === "STALE_SOURCE")
    ? "STALE_SOURCE"
    : "INSUFFICIENT_EVIDENCE";
}
function noCandidate(
  frame: Frame,
  issues: readonly DataQualityIssueV1[],
  why: Reason,
): EventDetectionOutcome {
  return {
    disposition: "NO_CANDIDATE",
    reason: why,
    quality: quality(frame, issues),
    blockedResources: [],
  };
}
function candidate(frame: Frame, issues: readonly DataQualityIssueV1[]): EventDetectionOutcome {
  const evaluated = quality(frame, issues);
  const evidence = { ...frame.evidence, ...evaluated };
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
function meetsDrop(frame: Frame): boolean {
  const { visitors, paidOrders } = frame.evidence.facts;
  const median = frame.request.baseline?.median;
  if (!visitors || paidOrders === null || median === null || median === undefined) return false;
  const [numerator, denominator] = fraction(median);
  // Compare raw counts against the exact median: rounded display rates must not decide alarms.
  return (
    BigInt(paidOrders) * 100000000n * denominator <=
    BigInt(visitors) * numerator * BigInt(10000 - frame.rule.thresholds.relativeDropBasisPoints)
  );
}
function expectedSnapshot(frame: Frame, kind: string): number | null {
  const facts = frame.evidence.facts;
  if (kind === "PAID_ORDERS") return facts.paidOrders;
  if (kind === "CONVERSION_RATE") return facts.conversion.valueBasisPoints;
  const count = kind === "CART_RATE" ? facts.cart : facts.checkout;
  if (count === null || !facts.visitors) return null;
  const scaled = BigInt(count) * 10000n,
    denominator = BigInt(facts.visitors);
  return Number(scaled / denominator + ((scaled % denominator) * 2n >= denominator ? 1n : 0n));
}
function snapshotIssues(frame: Frame, row: MetricSnapshotV1): DataQualityIssueV1[] {
  const issues = [...row.issues];
  const field = `snapshots.${row.metric.kind}`;
  const expected = expectedSnapshot(frame, row.metric.kind);
  if (expected !== null && row.metric.value !== null && row.metric.value !== expected)
    issues.push(issue(frame, "SOURCE_INCONSISTENT", field));
  if (row.status !== "VERIFIED")
    issues.push(issue(frame, row.status === "STALE" ? "STALE_SOURCE" : "PARTIAL_COVERAGE", field));
  if (row.sampleSize < frame.rule.minimumSampleSize) issues.push(issue(frame, "LOW_SAMPLE", field));
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", field));
  if (row.sourceWatermark === null) issues.push(issue(frame, "SOURCE_TIME_MISSING", field));
  else if (
    (Date.parse(frame.evidence.observedAt) - Date.parse(row.sourceWatermark)) / 1000 >
    frame.rule.maximumAgeSeconds
  )
    issues.push(issue(frame, "STALE_SOURCE", field));
  return issues;
}
function snapshots(frame: Frame): {
  blocking: DataQualityIssueV1[];
  context: DataQualityIssueV1[];
} {
  const blocking: DataQualityIssueV1[] = [],
    context: DataQualityIssueV1[] = [];
  for (const row of frame.request.snapshots) {
    if (["CONVERSION_RATE", "PAID_ORDERS"].includes(row.metric.kind))
      blocking.push(...snapshotIssues(frame, row));
    else if (["CART_RATE", "CHECKOUT_RATE"].includes(row.metric.kind))
      context.push(...snapshotIssues(frame, row));
    else context.push(...row.issues);
  }
  return { blocking, context };
}
function evaluate(frame: Frame): EventDetectionOutcome {
  const supplied = snapshots(frame);
  const current = [...currentIssues(frame), ...supplied.blocking],
    historical = baselineIssues(frame);
  const issues = [...current, ...historical, ...contextIssues(frame), ...supplied.context];
  if (current.length > 0) return noCandidate(frame, issues, reason(current));
  if (historical.length > 0) return noCandidate(frame, issues, "BASELINE_UNAVAILABLE");
  return meetsDrop(frame)
    ? candidate(frame, issues)
    : noCandidate(frame, issues, "BELOW_THRESHOLD");
}

/** Pure observation-only detector. Price context never establishes causality or action authority. */
export class ConversionDropDetector implements EventDetector {
  detect(raw: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.evidence.eventType !== "CONVERSION_DROP") return failure();
    const request = parsed.data;
    const evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "CONVERSION_DROP");
    if (!rule) return failure();
    const result = EventDetectionOutcomeSchema.safeParse(evaluate({ request, evidence, rule }));
    return result.success ? { ok: true, value: result.data } : failure();
  }
}
