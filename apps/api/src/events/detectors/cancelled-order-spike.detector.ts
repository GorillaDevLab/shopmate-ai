import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  MetricValueSchema,
  createEventFingerprint,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventEvidenceV1,
  type EventQuality,
  type EventResult,
  type EventRulePolicyV1,
} from "@shopmate/contracts";
import { EVENT_THRESHOLD_BOUNDARIES } from "../event-rule-policy.js";

type Evidence = Extract<EventEvidenceV1, { eventType: "CANCELLED_ORDER_SPIKE" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "CANCELLED_ORDER_SPIKE" }>;
type Frame = { request: EventDetectionRequest; evidence: Evidence; rule: Rule };
type Issue = DataQualityIssueV1;
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
const rateKind = "CANCELLED_ORDER_RATE";
const independentMetrics = new Set<string>(
  MetricValueSchema.options.flatMap((option) => option.unwrap().shape.kind.options),
);
const independentFields = new Set([
  "reasonCounts",
  "baselineRate",
  "refundFacts",
  "refundAllocations",
  "returnReceipts",
  "frozenCosts",
  "fees",
  "traffic",
  "campaignFacts",
  "inventoryFacts",
  "inventoryExtensions",
]);
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
// Dyadic scaling retains the exact finite statistical median without rounding alarm boundaries.
const scale = 1n << 1074n;
function scaled(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  return exponent === 0 ? fraction : (fraction + (1n << 52n)) << BigInt(exponent - 1);
}
function issue(frame: Frame, code: Issue["code"], field: string): Issue {
  return {
    code,
    field,
    evidenceIds: [...new Set(frame.evidence.sourceReferences.map((ref) => ref.id))],
  };
}
function relevant(row: Issue): boolean {
  const root = row.field.replace(/^(?:(?:evidence|facts|snapshots)\.)+/u, "").split(/[.[]/u)[0];
  return !independentMetrics.has(root) && !independentFields.has(root);
}
function sampleIssues(frame: Frame): Issue[] {
  const { evidence, rule } = frame;
  const { cohortOrders, paidCancelledOrders, pendingCancelledOrders } = evidence.facts;
  const issues: Issue[] = [];
  if (evidence.dataStatus === "UNAVAILABLE")
    issues.push(issue(frame, "NOT_SYNCHRONIZED", "cancellationFacts"));
  if (cohortOrders === null || paidCancelledOrders === null || pendingCancelledOrders === null)
    issues.push(issue(frame, "NOT_SYNCHRONIZED", "cancellationFacts"));
  if (cohortOrders === 0) issues.push(issue(frame, "ZERO_DENOMINATOR", "facts.cohortOrders"));
  if (cohortOrders !== null && evidence.sampleSize !== cohortOrders)
    issues.push(issue(frame, "SOURCE_INCONSISTENT", "sampleSize"));
  if (
    evidence.sampleSize < rule.minimumSampleSize ||
    (cohortOrders !== null && cohortOrders < rule.minimumSampleSize)
  )
    issues.push(issue(frame, "LOW_SAMPLE", "facts.cohortOrders"));
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "coverageBasisPoints"));
  return issues;
}
function ageIssue(frame: Frame, time: string | null, field: string): Issue[] {
  if (time === null) return [issue(frame, "SOURCE_TIME_MISSING", field)];
  const age = BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(time));
  return age > BigInt(frame.rule.maximumAgeSeconds) * 1000n
    ? [issue(frame, "STALE_SOURCE", field)]
    : [];
}
function sourceIssues(frame: Frame): Issue[] {
  const refs = frame.evidence.sourceReferences.filter(
    (ref) => ref.kind === "NORMALIZED_AGGREGATE" && ref.measure?.kind === rateKind,
  );
  const issues = ageIssue(frame, frame.evidence.sourceWatermark, "sourceWatermark");
  const watermark = frame.evidence.sourceWatermark;
  if (watermark !== null && Date.parse(watermark) < Date.parse(frame.evidence.periodEnd))
    issues.push(issue(frame, "WINDOW_MISMATCH", "sourceWatermark"));
  if (refs.length === 0) issues.push(issue(frame, "NOT_SYNCHRONIZED", "cancellationFacts.source"));
  for (const ref of refs)
    issues.push(...ageIssue(frame, ref.observedAt, "cancellationFacts.source"));
  return issues;
}
function baselineIssues(frame: Frame): Issue[] {
  const baseline = frame.evidence.baseline;
  if (baseline === null) return [issue(frame, "NOT_SYNCHRONIZED", "baseline")];
  const issues: Issue[] = [];
  if (baseline.measure.kind !== rateKind || baseline.measure.unit !== "basisPoints")
    issues.push(issue(frame, "VERSION_MISMATCH", "baseline.measure"));
  if (baseline.status === "STALE") issues.push(issue(frame, "STALE_SOURCE", "baseline"));
  if (baseline.alignment !== "ALIGNED") issues.push(issue(frame, "WINDOW_MISMATCH", "baseline"));
  if (baseline.median === null) issues.push(issue(frame, "NOT_SYNCHRONIZED", "baseline"));
  if (baseline.sampleSize < frame.rule.minimumBaselineSamples)
    issues.push(issue(frame, "LOW_SAMPLE", "baseline.sampleSize"));
  if (baseline.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "baseline.coverageBasisPoints"));
  return issues;
}
function unique(issues: readonly Issue[]): Issue[] {
  return [...new Map(issues.map((row) => [JSON.stringify(row), row])).values()];
}
function quality(frame: Frame, issues: readonly Issue[]): EventQuality {
  const statuses: EventQuality["dataStatus"][] = [frame.evidence.dataStatus];
  if (issues.length > 0) statuses.push("INSUFFICIENT");
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  return {
    dataStatus: precedence.find((status) => statuses.includes(status)) ?? "VERIFIED",
    sampleSize: frame.evidence.sampleSize,
    coverageBasisPoints: frame.evidence.coverageBasisPoints,
    issues,
  };
}
function blockedReason(current: readonly Issue[], historical: readonly Issue[]): Reason | null {
  if (current.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  if (current.some((row) => row.code === "STALE_SOURCE")) return "STALE_SOURCE";
  if (current.length > 0) return "INSUFFICIENT_EVIDENCE";
  return historical.length > 0 ? "BASELINE_UNAVAILABLE" : null;
}
function meetsThreshold(frame: Frame): boolean {
  const {
    cohortOrders: denominator,
    paidCancelledOrders: paid,
    pendingCancelledOrders: pending,
  } = frame.evidence.facts;
  const baseline = frame.evidence.baseline;
  if (!denominator || paid === null || pending === null || !baseline || baseline.median === null)
    return false;
  const cancelled = BigInt(paid) + BigInt(pending);
  if (cancelled === 0n || cancelled < BigInt(frame.rule.thresholds.minimumCancelledOrders))
    return false;
  // A zero history has no relative increase. Only the policy's absolute count branch applies.
  if (baseline.status === "ZERO") return true;
  const widened =
    BigInt(frame.rule.thresholds.relativeIncreaseBasisPoints) *
    BigInt(10000 + frame.rule.toleranceBasisPoints);
  const left = cancelled * 10000n * scale * 100000000n;
  const right = BigInt(denominator) * scaled(baseline.median) * (100000000n + widened);
  return (
    left > right ||
    (left === right && EVENT_THRESHOLD_BOUNDARIES.CANCELLED_ORDER_SPIKE === "INCLUSIVE")
  );
}
function outcome(
  frame: Frame,
  issues: readonly Issue[],
  reason: Reason | null,
): EventDetectionOutcome {
  const resultQuality = quality(frame, issues);
  const common = { quality: resultQuality, blockedResources: [] };
  if (reason !== null) return { ...common, disposition: "NO_CANDIDATE", reason };
  const evidence = { ...frame.evidence, ...resultQuality };
  return {
    ...common,
    disposition: "CANDIDATE",
    candidate: {
      schemaVersion: 1,
      fingerprint: createEventFingerprint(evidence),
      severityFloor: "MEDIUM",
      rulePolicyVersion: frame.request.policy.version,
      evidence,
    },
  };
}
function evaluate(frame: Frame): EventDetectionOutcome {
  // No metric snapshot represents this all-order cancellation cohort; its metric values are independent.
  // Explicit cancellation/cohort diagnostics still retain authority wherever they were reported.
  const supplied = [
    ...frame.evidence.issues,
    ...frame.request.snapshots.flatMap((row) => row.issues),
  ];
  const derived = [...sampleIssues(frame), ...sourceIssues(frame)];
  const historical = baselineIssues(frame);
  const current = [...supplied.filter(relevant), ...derived];
  const issues = unique([...supplied, ...derived, ...historical]);
  const reason =
    blockedReason(current, historical) ?? (meetsThreshold(frame) ? null : "BELOW_THRESHOLD");
  return outcome(frame, issues, reason);
}
/** Pure comparable-cohort observation; pending cancellation never changes paid refunds or revenue. */
export class CancelledOrderSpikeDetector implements EventDetector {
  detect(input: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.evidence.eventType !== "CANCELLED_ORDER_SPIKE")
      return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
    const request = parsed.data;
    const evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "CANCELLED_ORDER_SPIKE");
    if (!rule) return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
    const result = EventDetectionOutcomeSchema.safeParse(evaluate({ request, evidence, rule }));
    return result.success
      ? { ok: true, value: result.data }
      : {
          ok: false,
          error: { code: "OVERFLOW", evidenceIds: evidence.sourceReferences.map((ref) => ref.id) },
        };
  }
}
export function createCancelledOrderSpikeDetector(): EventDetector {
  return Object.freeze(new CancelledOrderSpikeDetector());
}
