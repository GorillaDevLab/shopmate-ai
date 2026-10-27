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

type Discount = Extract<EventEvidenceV1, { eventType: "UNUSUAL_DISCOUNT" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "UNUSUAL_DISCOUNT" }>;
type Frame = { request: EventDetectionRequest; evidence: Discount; rule: Rule };
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
function independent(field: string): boolean {
  return /cost|profit|contribution|netrevenue|fee|spend|advertis|attribution|skucontributions/u.test(
    field.toLowerCase(),
  );
}
function affectsDiscount(row: DataQualityIssueV1): boolean {
  if (independent(row.field) || /^baseline(?:[._]|$)/iu.test(row.field)) return false;
  if (
    [
      "COST_MISSING",
      "COST_ESTIMATED",
      "FEE_MISSING",
      "FEE_ESTIMATED",
      "ATTRIBUTION_MISSING",
      "RETURN_UNKNOWN",
      "REFUND_UNKNOWN",
    ].includes(row.code)
  )
    return false;
  return (
    /^(?:facts|evidence|binding|definitionVersion|period(?:Start|End)?|observedAt|currency|timezone)(?:[._]|$)/iu.test(
      row.field,
    ) ||
    /discount|grossmerchandise|promotion|paid|payment|source|coverage|sample|original/u.test(
      row.field.toLowerCase(),
    ) ||
    ["PAYMENT_UNKNOWN", "LOW_SAMPLE", "ZERO_DENOMINATOR", "NOT_SYNCHRONIZED"].includes(row.code)
  );
}
function expectedSnapshot(frame: Frame, row: MetricSnapshotV1): number | null | undefined {
  switch (row.metric.kind) {
    case "PAID_REVENUE":
      return frame.evidence.facts.paidRevenueMinor;
    case "GROSS_PROFIT":
      return frame.evidence.facts.grossProfitMinor;
    case "CONTRIBUTION":
      return frame.evidence.facts.contributionMinor;
    default:
      return undefined;
  }
}
function snapshotIssues(frame: Frame, row: MetricSnapshotV1): DataQualityIssueV1[] {
  const expected = expectedSnapshot(frame, row);
  if (expected === undefined) return [];
  const rows = [...row.issues],
    field = `snapshots.${row.metric.kind}`;
  const add = (code: DataQualityIssueV1["code"]) =>
    rows.push({ code, field, evidenceIds: [...row.evidenceIds] });
  if (row.metric.value !== expected) add("SOURCE_INCONSISTENT");
  if (row.status !== "VERIFIED") add(row.status === "STALE" ? "STALE_SOURCE" : "PARTIAL_COVERAGE");
  if (row.sampleSize < frame.rule.minimumSampleSize) add("LOW_SAMPLE");
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints) add("PARTIAL_COVERAGE");
  if (row.sourceWatermark === null) add("SOURCE_TIME_MISSING");
  else if (
    BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(row.sourceWatermark)) >
    BigInt(frame.rule.maximumAgeSeconds) * 1000n
  )
    add("STALE_SOURCE");
  return rows;
}
function snapshotAssessment(frame: Frame): {
  discount: DataQualityIssueV1[];
  financial: DataQualityIssueV1[];
} {
  const discount: DataQualityIssueV1[] = [],
    financial: DataQualityIssueV1[] = [];
  for (const row of frame.request.snapshots) {
    const target = row.metric.kind === "PAID_REVENUE" ? discount : financial;
    target.push(...snapshotIssues(frame, row));
  }
  return { discount, financial };
}
function freshness(frame: Frame): DataQualityIssueV1[] {
  const watermark = frame.evidence.sourceWatermark;
  if (watermark === null) return [issue(frame, "SOURCE_TIME_MISSING", "sourceWatermark")];
  const age = BigInt(Date.parse(frame.evidence.observedAt)) - BigInt(Date.parse(watermark));
  return age > BigInt(frame.rule.maximumAgeSeconds) * 1000n
    ? [issue(frame, "STALE_SOURCE", "sourceWatermark")]
    : [];
}
function promotion(frame: Frame): DataQualityIssueV1[] {
  const period = frame.evidence.facts.promotionPeriod;
  if (period === null) return [issue(frame, "SOURCE_TIME_MISSING", "facts.promotionPeriod")];
  return Date.parse(period.periodStart) <= Date.parse(frame.evidence.periodStart) &&
    Date.parse(period.periodEnd) >= Date.parse(frame.evidence.periodEnd)
    ? []
    : [issue(frame, "WINDOW_MISMATCH", "facts.promotionPeriod")];
}
function discountIssues(frame: Frame): DataQualityIssueV1[] {
  const { evidence, rule } = frame;
  const rows = evidence.issues.filter(affectsDiscount);
  rows.push(...freshness(frame), ...promotion(frame));
  if (!evidence.facts.grossMerchandiseMinor)
    rows.push(
      issue(
        frame,
        evidence.facts.grossMerchandiseMinor === 0 ? "ZERO_DENOMINATOR" : "PAYMENT_UNKNOWN",
        "facts.grossMerchandiseMinor",
      ),
    );
  if (evidence.facts.discountMinor === null)
    rows.push(issue(frame, "PAYMENT_UNKNOWN", "facts.discountMinor"));
  if (evidence.sampleSize < rule.minimumSampleSize)
    rows.push(issue(frame, "LOW_SAMPLE", "facts.discountRate"));
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "facts.discountRate"));
  return rows;
}
function financialIssues(frame: Frame): DataQualityIssueV1[] {
  const { facts } = frame.evidence;
  const rows: DataQualityIssueV1[] = [];
  if (facts.grossProfitMinor === null || facts.costCoverageBasisPoints === 0)
    rows.push(issue(frame, "COST_MISSING", "facts.grossProfitMinor"));
  else if (facts.costCoverageBasisPoints < 10000)
    rows.push(issue(frame, "COST_ESTIMATED", "facts.grossProfitMinor"));
  if (facts.feeCoverageBasisPoints === 0)
    rows.push(issue(frame, "FEE_MISSING", "facts.contributionMinor"));
  else if (facts.feeCoverageBasisPoints < 10000)
    rows.push(issue(frame, "FEE_ESTIMATED", "facts.contributionMinor"));
  return rows;
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
function reason(rows: readonly DataQualityIssueV1[]): Reason {
  if (rows.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  return rows.some((row) => row.code === "STALE_SOURCE") ? "STALE_SOURCE" : "INSUFFICIENT_EVIDENCE";
}
function noCandidate(
  frame: Frame,
  extra: readonly DataQualityIssueV1[],
  why: Reason,
): EventDetectionOutcome {
  return {
    disposition: "NO_CANDIDATE",
    reason: why,
    quality: quality(frame, extra),
    blockedResources: [],
  };
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
function baselineIssues(frame: Frame): DataQualityIssueV1[] {
  if (!frame.rule.requireAlignedBaseline) return [];
  const baseline = frame.request.baseline;
  const rows = frame.evidence.issues.filter((row) => /^baseline(?:[._]|$)/iu.test(row.field));
  if (
    baseline === null ||
    !["AVAILABLE", "ZERO"].includes(baseline.status) ||
    baseline.alignment !== "ALIGNED"
  )
    rows.push(
      issue(frame, baseline?.status === "STALE" ? "STALE_SOURCE" : "WINDOW_MISMATCH", "baseline"),
    );
  if (baseline !== null && baseline.sampleSize < frame.rule.minimumBaselineSamples)
    rows.push(issue(frame, "LOW_SAMPLE", "baseline"));
  if (baseline !== null && baseline.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    rows.push(issue(frame, "PARTIAL_COVERAGE", "baseline"));
  return rows;
}
function meetsThresholds(frame: Frame): boolean {
  const { discountMinor, grossMerchandiseMinor } = frame.evidence.facts;
  const { discountBasisPoints, minimumDiscountMinor } = frame.rule.thresholds;
  if (discountMinor === null || grossMerchandiseMinor === null) return false;
  // The supplied P3 accounting values stay untouched; only compare the source discount ratio.
  return (
    discountMinor >= minimumDiscountMinor &&
    BigInt(discountMinor) * 100000000n >=
      BigInt(grossMerchandiseMinor) *
        BigInt(discountBasisPoints) *
        BigInt(10000 + frame.rule.toleranceBasisPoints)
  );
}
function evaluate(frame: Frame): EventDetectionOutcome {
  const snapshots = snapshotAssessment(frame);
  const discount = [...discountIssues(frame), ...snapshots.discount];
  const extra = [...discount, ...financialIssues(frame), ...snapshots.financial];
  if (discount.length > 0) return noCandidate(frame, extra, reason(discount));
  const baseline = baselineIssues(frame);
  if (baseline.length > 0)
    return noCandidate(frame, [...extra, ...baseline], "BASELINE_UNAVAILABLE");
  return meetsThresholds(frame)
    ? candidate(frame, extra)
    : noCandidate(frame, extra, "BELOW_THRESHOLD");
}

/** Pure policy comparison over visible supplied facts; no accounting recalculation or actions. */
export class UnusualDiscountDetector implements EventDetector {
  detect(raw: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.evidence.eventType !== "UNUSUAL_DISCOUNT") return failure();
    const request = parsed.data,
      evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "UNUSUAL_DISCOUNT");
    if (!rule) return failure();
    const result = EventDetectionOutcomeSchema.safeParse(evaluate({ request, evidence, rule }));
    return result.success ? { ok: true, value: result.data } : failure();
  }
}
