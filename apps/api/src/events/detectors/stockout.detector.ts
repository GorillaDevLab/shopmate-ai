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
  type EventSeverity,
  type MetricSnapshotV1,
} from "@shopmate/contracts";

type Stockout = Extract<EventEvidenceV1, { eventType: "STOCKOUT_RISK" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "STOCKOUT_RISK" }>;
type Quality = EventDetectionOutcome["quality"];
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
type Dependency = "inventory" | "sales" | "leadTime";
type OptionalField = "inboundETA" | "safetyBufferHours";
type Assessment = { issues: DataQualityIssueV1[]; blocked: boolean };
type Frame = { request: EventDetectionRequest; evidence: Stockout; rule: Rule };
type Fraction = readonly [numerator: bigint, denominator: bigint];
const kinds = {
  inventory: "INVENTORY_AVAILABLE",
  sales: "PAID_UNITS",
  leadTime: "LEAD_TIME_HOURS",
} as const;
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;

function failure(
  code: "INVALID_INPUT" | "OVERFLOW",
  evidenceIds: readonly string[] = [],
): EventResult<never> {
  return { ok: false, error: { code, evidenceIds } };
}
function ids(frame: Frame): string[] {
  return [...new Set(frame.evidence.sourceReferences.map((row) => row.id))].sort();
}
function issue(frame: Frame, code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: ids(frame) };
}
function expected(frame: Frame, dependency: Dependency): number | null {
  const facts = frame.evidence.facts;
  if (dependency === "inventory") return facts.availableUnits;
  return dependency === "sales" ? facts.salesUnits : facts.supplierLeadTimeHours;
}
function optionalField(field: string): OptionalField | null {
  const value = field.toLowerCase();
  if (/(?:^|[._])(?:inboundeta|eta)(?:[._]|$)/u.test(value)) return "inboundETA";
  return /(?:^|[._])safetybufferhours(?:[._]|$)/u.test(value) ? "safetyBufferHours" : null;
}
function usableOptional(frame: Frame, field: OptionalField): boolean {
  return !frame.evidence.issues.some((row) => optionalField(row.field) === field);
}
function affects(row: DataQualityIssueV1, dependency: Dependency): boolean {
  if (optionalField(row.field) !== null) return false;
  const field = row.field.toLowerCase();
  if (/cost|fee|profit|marketing|traffic/u.test(field)) return false;
  if (dependency === "inventory" && /hour|extension|lead|supplier|estimated/u.test(field))
    return false;
  if (dependency === "inventory" && row.code === "INVENTORY_UNKNOWN") return true;
  if (
    dependency === "sales" &&
    ["PAYMENT_UNKNOWN", "ZERO_DENOMINATOR", "LOW_SAMPLE"].includes(row.code)
  )
    return true;
  if (dependency === "leadTime" && row.code === "LEAD_TIME_MISSING") return true;
  if (
    [
      "SOURCE_INCONSISTENT",
      "STALE_SOURCE",
      "NOT_SYNCHRONIZED",
      "PARTIAL_COVERAGE",
      "SOURCE_TIME_MISSING",
      "WINDOW_MISMATCH",
      "VERSION_MISMATCH",
    ].includes(row.code)
  ) {
    if (/sourcewatermark|^source$/u.test(field)) return true;
    if (dependency === "inventory") return /inventory|available|stock/u.test(field);
    if (dependency === "sales") return /sales|sold|paid|payment|order/u.test(field);
    return /lead|supplier|extension/u.test(field);
  }
  return false;
}
function snapshotIssues(
  frame: Frame,
  row: MetricSnapshotV1,
  dependency: Dependency,
): DataQualityIssueV1[] {
  const field = `snapshots.${row.metric.kind}`;
  const issues: DataQualityIssueV1[] = [...row.issues];
  if (row.metric.value !== expected(frame, dependency))
    issues.push(issue(frame, "SOURCE_INCONSISTENT", field));
  if (row.status !== "VERIFIED")
    issues.push(issue(frame, row.status === "STALE" ? "STALE_SOURCE" : "PARTIAL_COVERAGE", field));
  if (row.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", field));
  if (dependency === "sales" && row.sampleSize < frame.rule.minimumSampleSize)
    issues.push(issue(frame, "LOW_SAMPLE", field));
  const watermark = row.sourceWatermark;
  if (watermark === null) issues.push(issue(frame, "SOURCE_TIME_MISSING", field));
  else if (
    (Date.parse(frame.evidence.observedAt) - Date.parse(watermark)) / 1000 >
    frame.rule.maximumAgeSeconds
  )
    issues.push(issue(frame, "STALE_SOURCE", field));
  return issues;
}
function assess(frame: Frame, dependency: Dependency): Assessment {
  const issues = frame.evidence.issues.filter((row) => affects(row, dependency));
  const rows = frame.request.snapshots.filter((row) => row.metric.kind === kinds[dependency]);
  for (const row of rows) issues.push(...snapshotIssues(frame, row, dependency));
  return { issues, blocked: issues.length > 0 };
}
function inventory(frame: Frame): Assessment {
  const result = assess(frame, "inventory");
  const facts = frame.evidence.facts;
  if (facts.availableUnits === null || facts.inventoryStatus !== "VERIFIED")
    result.issues.push(
      issue(
        frame,
        facts.inventoryStatus === "STALE" ? "STALE_SOURCE" : "INVENTORY_UNKNOWN",
        "facts.availableUnits",
      ),
    );
  if (facts.inventoryObservedAt === null)
    result.issues.push(issue(frame, "SOURCE_TIME_MISSING", "facts.inventoryObservedAt"));
  else if (
    (Date.parse(frame.evidence.observedAt) - Date.parse(facts.inventoryObservedAt)) / 1000 >
    frame.rule.maximumAgeSeconds
  )
    result.issues.push(issue(frame, "STALE_SOURCE", "facts.inventoryObservedAt"));
  result.blocked = result.issues.length > 0;
  return result;
}
function forecast(frame: Frame): Assessment {
  const sales = assess(frame, "sales"),
    lead = assess(frame, "leadTime");
  const issues = [...sales.issues, ...lead.issues];
  const { facts } = frame.evidence;
  if (!facts.salesUnits)
    issues.push(
      issue(
        frame,
        facts.salesUnits === 0 ? "ZERO_DENOMINATOR" : "PAYMENT_UNKNOWN",
        "facts.salesUnits",
      ),
    );
  if (facts.supplierLeadTimeHours === null)
    issues.push(issue(frame, "LEAD_TIME_MISSING", "facts.supplierLeadTimeHours"));
  if (facts.estimatedHoursRemaining === null)
    issues.push(issue(frame, "INVENTORY_UNKNOWN", "facts.estimatedHoursRemaining"));
  if (frame.evidence.sampleSize < frame.rule.minimumSampleSize)
    issues.push(issue(frame, "LOW_SAMPLE", "facts.salesUnits"));
  if (frame.evidence.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints)
    issues.push(issue(frame, "PARTIAL_COVERAGE", "facts.salesUnits"));
  const watermark = frame.evidence.sourceWatermark;
  if (watermark === null) issues.push(issue(frame, "SOURCE_TIME_MISSING", "sourceWatermark"));
  else if (
    (Date.parse(frame.evidence.observedAt) - Date.parse(watermark)) / 1000 >
    frame.rule.maximumAgeSeconds
  )
    issues.push(issue(frame, "STALE_SOURCE", "sourceWatermark"));
  return { issues, blocked: issues.length > 0 };
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
  const statuses: Quality["dataStatus"][] = [frame.evidence.dataStatus];
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
function candidate(
  frame: Frame,
  issues: readonly DataQualityIssueV1[],
  severityFloor: EventSeverity,
): EventDetectionOutcome {
  const evaluated = quality(frame, issues);
  const evidence = { ...frame.evidence, ...evaluated };
  return {
    disposition: "CANDIDATE",
    quality: evaluated,
    blockedResources: [],
    candidate: {
      schemaVersion: 1,
      evidence,
      severityFloor,
      rulePolicyVersion: frame.request.policy.version,
      fingerprint: createEventFingerprint(evidence),
    },
  };
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
function compare(left: Fraction, right: Fraction): bigint {
  return left[0] * right[1] - right[0] * left[1];
}
function leadThreshold(frame: Frame): Fraction {
  const { supplierLeadTimeHours, safetyBufferHours } = frame.evidence.facts;
  const lead = fraction(supplierLeadTimeHours ?? 0);
  // An unusable observation cannot replace the independently configured policy buffer.
  const observed = usableOptional(frame, "safetyBufferHours") ? safetyBufferHours : null;
  const buffer = fraction(observed ?? frame.rule.thresholds.leadTimeBufferHours);
  return [lead[0] * buffer[1] + buffer[0] * lead[1], lead[1] * buffer[1]];
}
function coverage(frame: Frame): Fraction | null {
  const { availableUnits, salesUnits, salesWindow } = frame.evidence.facts;
  if (availableUnits === null || !salesUnits) return null;
  const elapsedMs = Date.parse(salesWindow.periodEnd) - Date.parse(salesWindow.periodStart);
  return [BigInt(availableUnits) * BigInt(elapsedMs), BigInt(salesUnits) * 3600000n];
}
function conflicts(frame: Frame, hours: number): boolean {
  const supplied = frame.evidence.facts.estimatedHoursRemaining;
  return supplied !== null && Math.abs(supplied - hours) > Number.EPSILON * Math.max(1, hours) * 4;
}
function severity(frame: Frame, hours: Fraction): EventSeverity | null {
  const { supplierLeadTimeHours, inboundETA } = frame.evidence.facts;
  if (compare(hours, fraction(frame.rule.thresholds.criticalHoursRemaining)) < 0n) return "HIGH";
  if (supplierLeadTimeHours !== null && compare(hours, leadThreshold(frame)) < 0n) return "MEDIUM";
  if (inboundETA === null || !usableOptional(frame, "inboundETA")) return null;
  const etaMs = Date.parse(inboundETA) - Date.parse(frame.evidence.observedAt);
  return compare(hours, [BigInt(etaMs), 3600000n]) < 0n ? "MEDIUM" : null;
}
function baselineMissing(frame: Frame): boolean {
  if (!frame.rule.requireAlignedBaseline) return false;
  const baseline = frame.request.baseline;
  return (
    baseline === null ||
    !["AVAILABLE", "ZERO"].includes(baseline.status) ||
    baseline.alignment !== "ALIGNED" ||
    baseline.sampleSize < frame.rule.minimumBaselineSamples ||
    baseline.coverageBasisPoints < frame.rule.minimumCoverageBasisPoints
  );
}
function evaluateForecast(
  frame: Frame,
  issues: DataQualityIssueV1[],
): EventResult<EventDetectionOutcome> {
  if (baselineMissing(frame)) {
    issues.push(issue(frame, "LOW_SAMPLE", "baseline"));
    return { ok: true, value: noCandidate(frame, issues, "BASELINE_UNAVAILABLE") };
  }
  if (compare(leadThreshold(frame), fraction(Number.MAX_SAFE_INTEGER)) > 0n)
    return failure("OVERFLOW", ids(frame));
  const hours = coverage(frame);
  if (hours === null)
    return { ok: true, value: noCandidate(frame, issues, "INSUFFICIENT_EVIDENCE") };
  if (compare(hours, fraction(Number.MAX_SAFE_INTEGER)) > 0n)
    return failure("OVERFLOW", ids(frame));
  // Floating tolerance is limited to checking a supplied diagnostic, never threshold decisions.
  if (conflicts(frame, Number(hours[0]) / Number(hours[1]))) {
    issues.push(issue(frame, "SOURCE_INCONSISTENT", "facts.estimatedHoursRemaining"));
    return { ok: true, value: noCandidate(frame, issues, "SOURCE_CONFLICT") };
  }
  const floor = severity(frame, hours);
  return {
    ok: true,
    value:
      floor === null
        ? noCandidate(frame, issues, "BELOW_THRESHOLD")
        : candidate(frame, issues, floor),
  };
}
function evaluate(frame: Frame): EventResult<EventDetectionOutcome> {
  const stock = inventory(frame),
    projected = forecast(frame);
  const issues = [...stock.issues, ...projected.issues];
  // Sales/lead-time limitations do not erase an independently fresh observed sold-out fact.
  if (!stock.blocked && frame.evidence.facts.availableUnits === 0)
    return { ok: true, value: candidate(frame, issues, "CRITICAL") };
  if (stock.blocked) return { ok: true, value: noCandidate(frame, issues, reason(stock.issues)) };
  if (projected.blocked)
    return { ok: true, value: noCandidate(frame, issues, reason(projected.issues)) };
  return evaluateForecast(frame, issues);
}

/** Pure observation-only detector. Supplied policy is server-owned; no action or stock authority. */
export class StockoutDetector implements EventDetector {
  detect(raw: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.evidence.eventType !== "STOCKOUT_RISK")
      return failure("INVALID_INPUT");
    const request = parsed.data;
    const evidence = parsed.data.evidence;
    const rule = request.policy.rules.find((row) => row.eventType === "STOCKOUT_RISK");
    if (!rule) return failure("INVALID_INPUT");
    const result = evaluate({ request, evidence, rule });
    if (!result.ok) return result;
    const output = EventDetectionOutcomeSchema.safeParse(result.value);
    return output.success ? { ok: true, value: output.data } : failure("INVALID_INPUT");
  }
}
