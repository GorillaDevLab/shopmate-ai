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
import { PROFIT_DELTA_METHOD_VERSION } from "../../metrics/profit-attribution.js";

type Evidence = Extract<EventEvidenceV1, { eventType: "PROFIT_MARGIN_DROP" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "PROFIT_MARGIN_DROP" }>;
type Frame = { request: EventDetectionRequest; evidence: Evidence; rule: Rule };
type Quality = EventDetectionOutcome["quality"];
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
type Measure = "GROSS_PROFIT" | "CONTRIBUTION";
type Fraction = readonly [bigint, bigint];
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
const blockers = new Set([
  "SOURCE_INCONSISTENT",
  "STALE_SOURCE",
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
  "NOT_SYNCHRONIZED",
  "SOURCE_TIME_MISSING",
  "PAYMENT_UNKNOWN",
  "REFUND_UNKNOWN",
  "RETURN_UNKNOWN",
  "LOW_SAMPLE",
]);

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
function measure(frame: Frame): Measure | null {
  const selected = frame.request.baseline?.measure;
  return selected?.unit === "minorCNY" &&
    (selected.kind === "GROSS_PROFIT" || selected.kind === "CONTRIBUTION")
    ? selected.kind
    : null;
}
function current(frame: Frame, kind: Measure): number | null {
  return kind === "GROSS_PROFIT"
    ? frame.evidence.facts.grossProfitMinor
    : frame.evidence.facts.contributionMinor;
}
function attributionField(field: string): boolean {
  return /attribution|contributions|profitdelta|skucontribution/iu.test(field);
}
function relevant(row: DataQualityIssueV1, kind: Measure): boolean {
  if (attributionField(row.field)) return false;
  const field = row.field.toLowerCase();
  if (/inventory|traffic|conversion|leadtime|listedat|promotion/u.test(field)) return false;
  if (kind === "GROSS_PROFIT" && /contribution|fee|spend|advertising/u.test(field)) return false;
  return true;
}
function timestampIssues(
  frame: Frame,
  watermark: string | null,
  field: string,
): DataQualityIssueV1[] {
  if (watermark === null) return [issue(frame, "SOURCE_TIME_MISSING", field)];
  return Date.parse(frame.evidence.observedAt) - Date.parse(watermark) >
    frame.rule.maximumAgeSeconds * 1000
    ? [issue(frame, "STALE_SOURCE", field)]
    : [];
}
function snapshotIssues(frame: Frame, row: MetricSnapshotV1, kind: Measure): DataQualityIssueV1[] {
  const field = `snapshots.${kind}`;
  const result = [...row.issues];
  if (row.metric.value !== current(frame, kind))
    result.push(issue(frame, "SOURCE_INCONSISTENT", field));
  if (row.status === "STALE") result.push(issue(frame, "STALE_SOURCE", field));
  if (row.status === "UNAVAILABLE" || row.status === "INSUFFICIENT")
    result.push(issue(frame, "PARTIAL_COVERAGE", field));
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    result.push(issue(frame, "PARTIAL_COVERAGE", field));
  if (row.sampleSize < frame.rule.minimumSampleSize) result.push(issue(frame, "LOW_SAMPLE", field));
  return [...result, ...timestampIssues(frame, row.sourceWatermark, field)];
}
function coreIssues(frame: Frame, kind: Measure): DataQualityIssueV1[] {
  const { evidence, rule } = frame;
  const result = evidence.issues.filter((row) => relevant(row, kind));
  if (current(frame, kind) === null) result.push(issue(frame, "PARTIAL_COVERAGE", `facts.${kind}`));
  if (evidence.sampleSize < rule.minimumSampleSize)
    result.push(issue(frame, "LOW_SAMPLE", "profit"));
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    result.push(issue(frame, "PARTIAL_COVERAGE", "profit"));
  result.push(...financialCoverageIssues(frame, kind));
  result.push(...timestampIssues(frame, evidence.sourceWatermark, "sourceWatermark"));
  for (const row of frame.request.snapshots.filter((row) => row.metric.kind === kind))
    result.push(...snapshotIssues(frame, row, kind));
  return result;
}
function financialCoverageIssues(frame: Frame, kind: Measure): DataQualityIssueV1[] {
  const fields = kind === "CONTRIBUTION" ? (["cost", "fee"] as const) : (["cost"] as const);
  const result: DataQualityIssueV1[] = [];
  for (const field of fields) {
    const coverage = frame.evidence.facts[`${field}CoverageBasisPoints`];
    if (coverage === 10000) continue;
    const missing = coverage === 0 || coverage < frame.rule.minimumCoverageBasisPoints;
    const code =
      field === "cost"
        ? missing
          ? "COST_MISSING"
          : "COST_ESTIMATED"
        : missing
          ? "FEE_MISSING"
          : "FEE_ESTIMATED";
    result.push(issue(frame, code, `facts.${field}CoverageBasisPoints`));
  }
  return result;
}
function blocks(row: DataQualityIssueV1): boolean {
  return (
    blockers.has(row.code) ||
    row.code === "PARTIAL_COVERAGE" ||
    ((row.code === "COST_MISSING" || row.code === "FEE_MISSING") &&
      /costCoverageBasisPoints|feeCoverageBasisPoints/u.test(row.field))
  );
}
function baselineIssues(frame: Frame, kind: Measure | null): DataQualityIssueV1[] {
  const before = frame.request.baseline;
  if (before?.status === "STALE") return [issue(frame, "STALE_SOURCE", "baseline")];
  if (
    before === null ||
    kind === null ||
    !["AVAILABLE", "ZERO"].includes(before.status) ||
    before.alignment !== "ALIGNED"
  )
    return [issue(frame, "PARTIAL_COVERAGE", "baseline")];
  const result: DataQualityIssueV1[] = [];
  if (before.sampleSize < frame.rule.minimumBaselineSamples)
    result.push(issue(frame, "LOW_SAMPLE", "baseline"));
  if (before.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    result.push(issue(frame, "PARTIAL_COVERAGE", "baseline"));
  if (before.median === 0 && frame.rule.thresholds.relativeDropBasisPoints > 0)
    result.push(issue(frame, "ZERO_DENOMINATOR", "baseline"));
  return result;
}
function fraction(value: number): Fraction {
  const [mantissa = "0", exponent = "0"] = value.toString().split("e");
  const [whole = "0", decimals = ""] = mantissa.split(".");
  const scale = decimals.length - Number(exponent);
  return [
    BigInt(whole + decimals) * 10n ** BigInt(Math.max(-scale, 0)),
    10n ** BigInt(Math.max(scale, 0)),
  ];
}
function drop(frame: Frame, kind: Measure): Fraction | null {
  const median = frame.request.baseline?.median;
  const amount = current(frame, kind);
  if (median === undefined || median === null || amount === null) return null;
  const [numerator, denominator] = fraction(median);
  return [numerator - BigInt(amount) * denominator, denominator];
}
function qualifies(frame: Frame, kind: Measure): boolean {
  const delta = drop(frame, kind);
  const median = frame.request.baseline?.median;
  if (delta === null || median === undefined || median === null || delta[0] <= 0n) return false;
  const [base, denominator] = fraction(Math.abs(median));
  const { minimumDropMinor, relativeDropBasisPoints } = frame.rule.thresholds;
  // Signed deterioration uses baseline magnitude; zero has an explicit absolute-only policy.
  const relative =
    BigInt(relativeDropBasisPoints) * BigInt(10000 + frame.rule.toleranceBasisPoints);
  return (
    delta[0] >= BigInt(minimumDropMinor) * delta[1] &&
    delta[0] * 100000000n * denominator >= base * relative * delta[1]
  );
}
function explanationIssues(frame: Frame, kind: Measure): DataQualityIssueV1[] {
  const facts = frame.evidence.facts;
  const result: DataQualityIssueV1[] = [];
  if (facts.attributionVersion !== PROFIT_DELTA_METHOD_VERSION)
    result.push(
      issue(
        frame,
        facts.attributionVersion === null ? "ATTRIBUTION_MISSING" : "VERSION_MISMATCH",
        "attributionVersion",
      ),
    );
  if (
    facts.contributions.length === 0 ||
    facts.contributions.some((row) => row.amountMinor === null) ||
    !facts.contributions.some((row) => row.kind === "RESIDUAL")
  )
    result.push(issue(frame, "ATTRIBUTION_MISSING", "contributions"));
  const delta = drop(frame, kind);
  // Attribution has no typed profit-basis field. Gross profit cannot inherit an advertising explanation.
  if (
    kind !== "CONTRIBUTION" ||
    facts.profitDeltaMinor === null ||
    delta === null ||
    BigInt(facts.profitDeltaMinor) * delta[1] !== -delta[0]
  )
    result.push(issue(frame, "ATTRIBUTION_MISSING", "profitDeltaMinor.basis"));
  return result;
}
function quality(frame: Frame, extra: readonly DataQualityIssueV1[]): Quality {
  const unique = new Map<string, DataQualityIssueV1>();
  const snapshots = frame.request.snapshots.filter((row) => row.metric.kind === measure(frame));
  for (const row of [...frame.evidence.issues, ...extra]) {
    const value = { ...row, evidenceIds: [...new Set(row.evidenceIds)].sort() };
    unique.set(JSON.stringify(value), value);
  }
  const issues = [...unique.values()];
  const statuses: Quality["dataStatus"][] = [
    frame.evidence.dataStatus,
    ...snapshots.map((row) => row.status),
  ];
  if (issues.length > 0) statuses.push("ESTIMATED");
  if (extra.some(blocks)) statuses.push("INSUFFICIENT");
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  return {
    dataStatus: precedence.find((status) => statuses.includes(status)) ?? "VERIFIED",
    sampleSize: Math.min(frame.evidence.sampleSize, ...snapshots.map((row) => row.sampleSize)),
    coverageBasisPoints: Math.min(
      frame.evidence.coverageBasisPoints,
      frame.evidence.facts.costCoverageBasisPoints,
      measure(frame) === "CONTRIBUTION" ? frame.evidence.facts.feeCoverageBasisPoints : 10000,
      ...snapshots.map((row) => row.coverageBasisPoints),
    ),
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
function evaluate(frame: Frame): EventDetectionOutcome {
  const kind = measure(frame);
  const baseline = baselineIssues(frame, kind);
  if (baseline.length > 0 || kind === null)
    return noCandidate(frame, baseline, "BASELINE_UNAVAILABLE");
  const core = coreIssues(frame, kind);
  const blocking = core.filter(blocks);
  if (blocking.length > 0) return noCandidate(frame, core, reason(blocking));
  const issues = [...core, ...explanationIssues(frame, kind)];
  if (!qualifies(frame, kind)) return noCandidate(frame, issues, "BELOW_THRESHOLD");
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

/** Pure monetary-profit deterioration; no margin ratio, revenue growth, or new causal inference. */
export class ProfitMarginDropDetector implements EventDetector {
  detect(raw: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.evidence.eventType !== "PROFIT_MARGIN_DROP")
      return failure();
    const request = parsed.data;
    const evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "PROFIT_MARGIN_DROP");
    if (!rule) return failure();
    const output = EventDetectionOutcomeSchema.safeParse(evaluate({ request, evidence, rule }));
    return output.success ? { ok: true, value: output.data } : failure();
  }
}
