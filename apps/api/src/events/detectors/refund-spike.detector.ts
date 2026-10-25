import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  MetricValueSchema,
  createEventFingerprint,
  sameEventPeriod,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventEvidenceV1,
  type EventQuality,
  type EventResult,
  type EventRulePolicyV1,
  type MetricSnapshotV1,
} from "@shopmate/contracts";

type Evidence = Extract<EventEvidenceV1, { eventType: "REFUND_SPIKE" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "REFUND_SPIKE" }>;
type Issue = DataQualityIssueV1;
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
const rateKind = "REFUND_COHORT_ORDER_RATE";
const countKinds = new Set(["PAID_ORDERS", "REFUNDED_COHORT_ORDERS"]);
const independentMetricKinds = new Set<string>(
  MetricValueSchema.options
    .flatMap((option) => option.unwrap().shape.kind.options)
    .filter((kind) => kind !== rateKind && !countKinds.has(kind)),
);
const diagnosticFields = new Set([
  "reasonCounts",
  "skuConcentration",
  "affectedSkuShare",
  "baselineRate",
  "inventoryFacts",
  "inventoryExtensions",
  "frozenCosts",
  "fees",
  "traffic",
  "campaignFacts",
  "refundAllocations",
  "returnReceipts",
  "costCoverageBasisPoints",
  "feeCoverageBasisPoints",
]);
// All finite nonnegative IEEE-754 values are exact integer multiples of this scale.
const scale = 1n << 1074n;
function scaled(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction + (1n << 52n);
  return significand << BigInt(exponent === 0 ? 0 : exponent - 1);
}
function issue(evidence: Evidence, code: Issue["code"], field: string): Issue {
  return { code, field, evidenceIds: [...new Set(evidence.sourceReferences.map((ref) => ref.id))] };
}
function unique(issues: readonly Issue[]): Issue[] {
  return [...new Map(issues.map((item) => [JSON.stringify(item), item])).values()];
}
function relevant(item: Issue, zero: boolean): boolean {
  const root = item.field.replace(/^(?:evidence\.)?(?:facts\.)?/u, "").split(/[.[]/u)[0];
  if (diagnosticFields.has(root)) return false;
  if (independentMetricKinds.has(root)) return false;
  return !zero || (root !== "currentRate" && root !== rateKind);
}
function currentSampleIssues(evidence: Evidence, rule: Rule): Issue[] {
  const { paidCohortOrders: paid, refundedOrders: refunded } = evidence.facts;
  const issues: Issue[] = [];
  if (paid === null || refunded === null)
    issues.push(issue(evidence, "NOT_SYNCHRONIZED", "refundFacts"));
  if (paid === 0) issues.push(issue(evidence, "ZERO_DENOMINATOR", "paidCohortOrders"));
  if (
    paid !== null &&
    (paid < rule.minimumSampleSize || evidence.sampleSize < rule.minimumSampleSize)
  )
    issues.push(issue(evidence, "LOW_SAMPLE", "paidCohortOrders"));
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    issues.push(issue(evidence, "PARTIAL_COVERAGE", "refundFacts"));
  return issues;
}
function referenceIssues(evidence: Evidence): Issue[] {
  const supported = evidence.sourceReferences.some(
    (ref) =>
      ref.measure?.kind === rateKind ||
      ref.measure?.kind === "REFUNDED_COHORT_ORDERS" ||
      (ref.kind === "NORMALIZED_AGGREGATE" && ref.measure === null),
  );
  return supported ? [] : [issue(evidence, "NOT_SYNCHRONIZED", "refundFacts")];
}
function maturityIssues(evidence: Evidence, rule: Rule): Issue[] {
  const facts = evidence.facts;
  const elapsed =
    BigInt(Date.parse(facts.observedThrough)) - BigInt(Date.parse(facts.paymentCohort.periodEnd));
  const required = Math.max(facts.maturityHours, rule.thresholds.maturityHours);
  return elapsed * scale < scaled(required) * 3600000n
    ? [issue(evidence, "IMMATURE_COHORT", "paymentCohort")]
    : [];
}
function freshnessIssues(evidence: Evidence, rule: Rule): Issue[] {
  const issues: Issue[] = [];
  for (const [field, time] of [
    ["sourceWatermark", evidence.sourceWatermark],
    ["observedThrough", evidence.facts.observedThrough],
  ] as const) {
    if (time === null) issues.push(issue(evidence, "NOT_SYNCHRONIZED", field));
    else if (
      BigInt(Date.parse(evidence.observedAt)) - BigInt(Date.parse(time)) >
      BigInt(rule.maximumAgeSeconds) * 1000n
    )
      issues.push(issue(evidence, "STALE_SOURCE", field));
  }
  return issues;
}
function baselineIssues(evidence: Evidence, rule: Rule): Issue[] {
  const baseline = evidence.baseline;
  if (baseline === null) return [issue(evidence, "NOT_SYNCHRONIZED", "baseline")];
  const issues: Issue[] = [];
  if (baseline.measure.kind !== rateKind || baseline.measure.unit !== "basisPoints")
    issues.push(issue(evidence, "VERSION_MISMATCH", "baseline"));
  if (baseline.status === "STALE") issues.push(issue(evidence, "STALE_SOURCE", "baseline"));
  if (baseline.alignment !== "ALIGNED") issues.push(issue(evidence, "WINDOW_MISMATCH", "baseline"));
  if (baseline.median === null) issues.push(issue(evidence, "NOT_SYNCHRONIZED", "baseline"));
  if (baseline.sampleSize < rule.minimumBaselineSamples)
    issues.push(issue(evidence, "LOW_SAMPLE", "baseline"));
  if (baseline.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    issues.push(issue(evidence, "PARTIAL_COVERAGE", "baseline"));
  return issues;
}
function expectedValue(evidence: Evidence, kind: string): number | null {
  if (kind === "PAID_ORDERS") return evidence.facts.paidCohortOrders;
  if (kind === "REFUNDED_COHORT_ORDERS") return evidence.facts.refundedOrders;
  return evidence.facts.currentRate.valueBasisPoints;
}
function snapshotIssues(evidence: Evidence, item: MetricSnapshotV1, rule: Rule): Issue[] {
  const field = item.metric.kind;
  const issues = [...item.issues];
  if (item.metric.value !== null && item.metric.value !== expectedValue(evidence, field))
    issues.push(issue(evidence, "SOURCE_INCONSISTENT", field));
  if (item.metric.value === null) issues.push(issue(evidence, "NOT_SYNCHRONIZED", field));
  if (item.sampleSize < rule.minimumSampleSize) issues.push(issue(evidence, "LOW_SAMPLE", field));
  if (item.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    issues.push(issue(evidence, "PARTIAL_COVERAGE", field));
  if (Date.parse(item.visibleAt) !== Date.parse(evidence.facts.observedThrough))
    issues.push(issue(evidence, "WINDOW_MISMATCH", field));
  if (item.sourceWatermark === null) issues.push(issue(evidence, "NOT_SYNCHRONIZED", field));
  else if (
    BigInt(Date.parse(evidence.observedAt)) - BigInt(Date.parse(item.sourceWatermark)) >
    BigInt(rule.maximumAgeSeconds) * 1000n
  )
    issues.push(issue(evidence, "STALE_SOURCE", field));
  if (
    !evidence.sourceReferences.some(
      (ref) =>
        ref.kind === "METRIC_SNAPSHOT" &&
        ref.version === item.inputRevision &&
        ref.measure?.kind === field &&
        sameEventPeriod(ref.period, item) &&
        Date.parse(ref.observedAt) >= Date.parse(item.computedAt),
    )
  )
    issues.push(issue(evidence, "SOURCE_INCONSISTENT", field));
  return issues;
}
function collectSnapshots(request: EventDetectionRequest, evidence: Evidence, rule: Rule) {
  const all: Issue[] = request.snapshots.flatMap((item) => item.issues);
  const blocking: Issue[] = [];
  const zero = evidence.baseline?.status === "ZERO";
  for (const item of request.snapshots) {
    if (!countKinds.has(item.metric.kind) && item.metric.kind !== rateKind) continue;
    const issues = snapshotIssues(evidence, item, rule);
    all.push(...issues);
    // Count/source faults retain authority regardless of the snapshot carrying them.
    const dependent =
      zero && item.metric.kind === rateKind
        ? issues.filter((diagnostic) => relevant(diagnostic, true))
        : issues;
    blocking.push(...dependent);
  }
  return { all, blocking };
}
function quality(evidence: Evidence, issues: readonly Issue[]): EventQuality {
  const dataStatus =
    evidence.dataStatus === "VERIFIED" && issues.length > 0
      ? issues.some((item) => item.code === "STALE_SOURCE")
        ? "STALE"
        : "INSUFFICIENT"
      : evidence.dataStatus;
  return {
    dataStatus,
    sampleSize: evidence.sampleSize,
    coverageBasisPoints: evidence.coverageBasisPoints,
    issues,
  };
}
function blockedReason(blocking: readonly Issue[], historical: readonly Issue[]): Reason | null {
  if (blocking.some((item) => item.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  if (blocking.some((item) => item.code === "STALE_SOURCE")) return "STALE_SOURCE";
  if (historical.length > 0) return "BASELINE_UNAVAILABLE";
  return blocking.length > 0 ? "INSUFFICIENT_EVIDENCE" : null;
}
function exceeds(evidence: Evidence, rule: Rule): boolean {
  const { refundedOrders: refunded, paidCohortOrders: paid } = evidence.facts;
  const baseline = evidence.baseline;
  if (refunded === null || paid === null || paid === 0 || baseline?.median === null || !baseline)
    return false;
  if (refunded === 0 || refunded < rule.thresholds.minimumRefundedOrders) return false;
  if (baseline.status === "ZERO") return true;
  // Compare the unrounded cohort ratio with the exact statistical median in basis points.
  const left = BigInt(refunded) * 10000n * 10000n * scale;
  const right =
    BigInt(paid) *
    scaled(baseline.median) *
    (10000n + BigInt(rule.thresholds.relativeIncreaseBasisPoints));
  return left >= right;
}
function outcome(
  evidence: Evidence,
  resultQuality: EventQuality,
  policyVersion: string,
  reason: Reason | null,
): EventResult<EventDetectionOutcome> {
  const common = { quality: resultQuality, blockedResources: [] };
  const value =
    reason === null
      ? {
          ...common,
          disposition: "CANDIDATE",
          candidate: {
            schemaVersion: 1,
            fingerprint: createEventFingerprint(evidence),
            severityFloor: "MEDIUM",
            rulePolicyVersion: policyVersion,
            evidence: { ...evidence, ...resultQuality },
          },
        }
      : { ...common, disposition: "NO_CANDIDATE", reason };
  const parsed = EventDetectionOutcomeSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: { code: "OVERFLOW", evidenceIds: evidence.sourceReferences.map((ref) => ref.id) },
      };
}
function evaluate(
  request: EventDetectionRequest,
  evidence: Evidence,
  rule: Rule,
): EventResult<EventDetectionOutcome> {
  const snapshots = collectSnapshots(request, evidence, rule);
  const derived = [
    ...referenceIssues(evidence),
    ...currentSampleIssues(evidence, rule),
    ...maturityIssues(evidence, rule),
    ...freshnessIssues(evidence, rule),
  ];
  const historical = baselineIssues(evidence, rule);
  const source = evidence.issues.filter((item) =>
    relevant(item, evidence.baseline?.status === "ZERO"),
  );
  const blocking = [...source, ...snapshots.blocking, ...derived];
  const issues = unique([...evidence.issues, ...snapshots.all, ...derived, ...historical]);
  const reason =
    blockedReason(blocking, historical) ?? (exceeds(evidence, rule) ? null : "BELOW_THRESHOLD");
  return outcome(evidence, quality(evidence, issues), request.policy.version, reason);
}
/** Pure observed paid-cohort detection; SKU/reason details are evidence, never batch causality. */
export class RefundSpikeDetector implements EventDetector {
  detect(input: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
    const request = parsed.data;
    const rule = request.policy.rules.find(
      (entry): entry is Rule => entry.eventType === "REFUND_SPIKE",
    );
    if (request.evidence.eventType !== "REFUND_SPIKE" || !rule)
      return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
    return evaluate(request, request.evidence, rule);
  }
}

export function createRefundSpikeDetector(): EventDetector {
  return Object.freeze(new RefundSpikeDetector());
}
