import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  createEventFingerprint,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventResult,
  type EventEvidenceV1,
  type EventRulePolicyV1,
  type MetricSnapshotV1,
} from "@shopmate/contracts";

type Resource = EventDetectionOutcome["blockedResources"][number];
type Quality = EventDetectionOutcome["quality"];
type Rule = EventRulePolicyV1["rules"][number];
type Sync = Extract<EventEvidenceV1, { eventType: "SYNC_FAILURE" }>;
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
const resources: readonly Resource[] = ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"];
const sourceFailures = new Set<DataQualityIssueV1["code"]>([
  "NOT_SYNCHRONIZED",
  "SOURCE_INCONSISTENT",
  "SOURCE_TIME_MISSING",
  "STALE_SOURCE",
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
]);
const statuses = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
const metricResources = {
  GMV: ["ORDERS"],
  PAID_REVENUE: ["ORDERS"],
  AOV: ["ORDERS"],
  REFUND_SETTLED_AMOUNT: ["REFUNDS"],
  COGS: ["PRODUCTS", "ORDERS"],
  NET_REVENUE_SETTLEMENT: ["ORDERS", "REFUNDS"],
  NET_MERCHANDISE_REVENUE: ["ORDERS", "REFUNDS"],
  GROSS_PROFIT: ["PRODUCTS", "ORDERS", "REFUNDS"],
  CONTRIBUTION: ["PRODUCTS", "ORDERS", "REFUNDS", "MARKETING"],
  ESTIMATED_NET_PROFIT: ["PRODUCTS", "ORDERS", "REFUNDS", "MARKETING"],
  PROFIT_DELTA: ["PRODUCTS", "ORDERS", "REFUNDS", "MARKETING"],
  PAID_ORDERS: ["ORDERS"],
  PAID_UNITS: ["ORDERS"],
  REFUNDED_COHORT_ORDERS: ["ORDERS", "REFUNDS"],
  INVENTORY_AVAILABLE: ["INVENTORY"],
  REFUND_COHORT_ORDER_RATE: ["ORDERS", "REFUNDS"],
  REFUND_COHORT_AMOUNT_RATE: ["ORDERS", "REFUNDS"],
  CONVERSION_RATE: ["ORDERS"],
  CART_RATE: ["ORDERS"],
  CHECKOUT_RATE: ["ORDERS"],
  ROAS: ["MARKETING"],
  INVENTORY_HOURS_REMAINING: ["ORDERS", "INVENTORY"],
  LEAD_TIME_HOURS: ["INVENTORY"],
} as const satisfies Record<MetricSnapshotV1["metric"]["kind"], readonly Resource[]>;

function invalid(): EventResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
}
function addIssue(
  evidence: EventEvidenceV1,
  issues: DataQualityIssueV1[],
  code: DataQualityIssueV1["code"],
  field: string,
): void {
  if (!issues.some((row) => row.code === code && row.field === field))
    issues.push({
      code,
      field,
      evidenceIds: [...new Set(evidence.sourceReferences.map((row) => row.id))].sort(),
    });
}
function ageMilliseconds(observed: string, previous: string): bigint {
  return BigInt(Date.parse(observed)) - BigInt(Date.parse(previous));
}
function sourceChecks(evidence: EventEvidenceV1, rule: Rule, issues: DataQualityIssueV1[]): void {
  if (evidence.sourceWatermark === null)
    addIssue(evidence, issues, "SOURCE_TIME_MISSING", "sourceWatermark");
  else if (
    ageMilliseconds(evidence.observedAt, evidence.sourceWatermark) >
    BigInt(rule.maximumAgeSeconds) * 1000n
  )
    addIssue(evidence, issues, "STALE_SOURCE", "sourceWatermark");
}
function businessChecks(
  request: EventDetectionRequest,
  rule: Rule,
  issues: DataQualityIssueV1[],
): void {
  const evidence = request.evidence;
  if (evidence.sampleSize < rule.minimumSampleSize)
    addIssue(evidence, issues, "LOW_SAMPLE", "sampleSize");
  if (evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    addIssue(evidence, issues, "PARTIAL_COVERAGE", "coverageBasisPoints");
  const baseline = request.baseline;
  if (
    rule.requireAlignedBaseline &&
    (baseline === null ||
      !["AVAILABLE", "ZERO"].includes(baseline.status) ||
      baseline.alignment !== "ALIGNED" ||
      baseline.sampleSize < rule.minimumBaselineSamples ||
      baseline.coverageBasisPoints < rule.minimumCoverageBasisPoints)
  )
    addIssue(evidence, issues, "LOW_SAMPLE", "baseline");
}
function defaultResources(evidence: EventEvidenceV1): readonly Resource[] {
  switch (evidence.eventType) {
    case "SYNC_FAILURE":
      return [evidence.facts.affectedResourceKind];
    case "ROAS_DROP":
    case "AD_SPEND_SPIKE":
      return ["MARKETING"];
    case "REFUND_SPIKE":
      return ["ORDERS", "REFUNDS"];
    case "PROFIT_MARGIN_DROP":
      return ["PRODUCTS", "ORDERS", "REFUNDS", "MARKETING"];
    case "INVENTORY_STAGNATION":
    case "PRODUCT_BREAKOUT":
      return ["PRODUCTS", "ORDERS", "INVENTORY"];
    // A global sales watermark does not invalidate independently timestamped inventory facts.
    default:
      return ["ORDERS"];
  }
}
function namedResources(field: string): readonly Resource[] {
  const found: Resource[] = [];
  if (/inventory|availableunits|leadtime|supplier|inboundeta|safetybuffer/u.test(field))
    found.push("INVENTORY");
  if (/refund|return/u.test(field)) found.push("REFUNDS");
  if (/marketing|campaign|advertis|spend|attribut|roas/u.test(field)) found.push("MARKETING");
  if (/product|listedat|cost|cogs|price|discount/u.test(field)) found.push("PRODUCTS");
  if (/order|sales|sold|paid|payment|revenue|gmv/u.test(field)) found.push("ORDERS");
  return found;
}
function issueResources(evidence: EventEvidenceV1, item: DataQualityIssueV1): readonly Resource[] {
  if (!sourceFailures.has(item.code)) return [];
  const field = item.field.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const found = namedResources(field);
  if (found.length > 0) return found;
  return /^(?:source|sourcewatermark|sourcereferences|definitionversion|evidence|facts|global)$/u.test(
    field,
  )
    ? defaultResources(evidence)
    : [];
}
function snapshotResources(row: MetricSnapshotV1, stale: boolean): readonly Resource[] {
  if (row.sourceWatermark === null || stale) return metricResources[row.metric.kind];
  const faults = row.issues.filter((item) => sourceFailures.has(item.code));
  if (faults.length === 0)
    return row.status === "UNAVAILABLE" || row.status === "STALE"
      ? metricResources[row.metric.kind]
      : [];
  return faults.flatMap((item) => {
    const named = namedResources(item.field.toLowerCase().replace(/[^a-z0-9]/gu, ""));
    return named.length > 0 ? named : metricResources[row.metric.kind];
  });
}
function snapshotChecks(
  request: EventDetectionRequest,
  rule: Rule,
  issues: DataQualityIssueV1[],
): Resource[] {
  const blocked: Resource[] = [];
  for (const row of request.snapshots) {
    const field = `snapshots.${row.metric.kind}`;
    const stale =
      row.sourceWatermark !== null &&
      ageMilliseconds(request.evidence.observedAt, row.sourceWatermark) >
        BigInt(rule.maximumAgeSeconds) * 1000n;
    if (row.status === "UNAVAILABLE") addIssue(request.evidence, issues, "NOT_SYNCHRONIZED", field);
    if (row.status === "STALE") addIssue(request.evidence, issues, "STALE_SOURCE", field);
    if (row.sourceWatermark === null)
      addIssue(request.evidence, issues, "SOURCE_TIME_MISSING", field);
    else if (stale) addIssue(request.evidence, issues, "STALE_SOURCE", field);
    if (row.sampleSize < rule.minimumSampleSize)
      addIssue(request.evidence, issues, "LOW_SAMPLE", field);
    if (row.coverageBasisPoints < rule.minimumCoverageBasisPoints)
      addIssue(request.evidence, issues, "PARTIAL_COVERAGE", field);
    blocked.push(...snapshotResources(row, stale));
  }
  return blocked;
}
function quality(request: EventDetectionRequest, issues: readonly DataQualityIssueV1[]): Quality {
  const evidence = request.evidence;
  const applicable: Quality["dataStatus"][] = [
    evidence.dataStatus,
    ...request.snapshots.map((row) => row.status),
  ];
  if (issues.length > 0) applicable.push("INSUFFICIENT");
  if (issues.some((row) => row.code === "STALE_SOURCE")) applicable.push("STALE");
  return {
    dataStatus: statuses.find((status) => applicable.includes(status)) ?? evidence.dataStatus,
    sampleSize: evidence.sampleSize,
    coverageBasisPoints: evidence.coverageBasisPoints,
    // Originals are collected first; only derived annotations can exceed the public bound.
    issues: issues.slice(0, 100),
  };
}
function reason(issues: readonly DataQualityIssueV1[]): Reason {
  if (issues.some((row) => row.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  if (issues.some((row) => row.code === "STALE_SOURCE")) return "STALE_SOURCE";
  return issues.length > 0 ? "INSUFFICIENT_EVIDENCE" : "BELOW_THRESHOLD";
}
function syncFailure(evidence: Sync, rule: Extract<Rule, { eventType: "SYNC_FAILURE" }>): boolean {
  if (evidence.facts.typedErrorCode !== "NOT_SYNCHRONIZED") return true;
  const { lastSuccessAt } = evidence.facts;
  return (
    lastSuccessAt === null ||
    evidence.sourceWatermark === null ||
    ageMilliseconds(evidence.observedAt, evidence.sourceWatermark) >
      BigInt(rule.maximumAgeSeconds) * 1000n ||
    evidence.issues.some((item) =>
      issueResources(evidence, item).includes(evidence.facts.affectedResourceKind),
    ) ||
    ageMilliseconds(evidence.observedAt, lastSuccessAt) >
      BigInt(rule.thresholds.maximumLagSeconds) * 1000n
  );
}
function candidate(
  request: EventDetectionRequest,
  evidence: Sync,
  evaluated: Quality,
  blockedResources: readonly Resource[],
): EventDetectionOutcome {
  const value = { ...evidence, ...evaluated };
  return {
    disposition: "CANDIDATE",
    quality: evaluated,
    blockedResources,
    candidate: {
      schemaVersion: 1,
      evidence: value,
      severityFloor: "HIGH",
      rulePolicyVersion: request.policy.version,
      fingerprint: createEventFingerprint(value),
    },
  };
}
function evaluate(request: EventDetectionRequest, rule: Rule): EventDetectionOutcome {
  const evidence = request.evidence;
  const issues = [...evidence.issues, ...request.snapshots.flatMap((row) => row.issues)];
  const originalCount = issues.length;
  sourceChecks(evidence, rule, issues);
  const failed =
    evidence.eventType === "SYNC_FAILURE" &&
    rule.eventType === "SYNC_FAILURE" &&
    syncFailure(evidence, rule);
  if (failed)
    addIssue(evidence, issues, "NOT_SYNCHRONIZED", `sync.${evidence.facts.affectedResourceKind}`);
  if (evidence.eventType !== "SYNC_FAILURE") businessChecks(request, rule, issues);
  const affected = new Set(
    [...evidence.issues, ...issues.slice(originalCount)].flatMap((item) =>
      issueResources(evidence, item),
    ),
  );
  if (failed && evidence.eventType === "SYNC_FAILURE")
    affected.add(evidence.facts.affectedResourceKind);
  for (const resource of snapshotChecks(request, rule, issues)) affected.add(resource);
  const evaluated = quality(request, issues);
  const blockedResources = resources.filter((resource) => affected.has(resource));
  if (failed && evidence.eventType === "SYNC_FAILURE")
    return candidate(request, evidence, evaluated, blockedResources);
  return {
    disposition: "NO_CANDIDATE",
    reason: reason(issues),
    quality: evaluated,
    blockedResources,
  };
}
function validWatermark(evidence: EventEvidenceV1): boolean {
  return (
    evidence.eventType !== "SYNC_FAILURE" ||
    evidence.sourceWatermark === null ||
    evidence.facts.lastSuccessAt === null ||
    Date.parse(evidence.sourceWatermark) <= Date.parse(evidence.facts.lastSuccessAt)
  );
}

/** Pure source-quality gate. Business candidates remain the responsibility of their detectors. */
export class SyncQualityDetector implements EventDetector {
  detect(raw: EventDetectionRequest): EventResult<EventDetectionOutcome> {
    const parsed = EventDetectionRequestSchema.safeParse(raw);
    if (!parsed.success || !validWatermark(parsed.data.evidence)) return invalid();
    const request = parsed.data;
    const rule = request.policy.rules.find((row) => row.eventType === request.evidence.eventType);
    if (!rule) return invalid();
    const originalCount =
      request.evidence.issues.length +
      request.snapshots.reduce((count, row) => count + row.issues.length, 0);
    if (originalCount > 100) return { ok: false, error: { code: "OVERFLOW", evidenceIds: [] } };
    const value = evaluate(request, rule);
    const output = EventDetectionOutcomeSchema.safeParse(value);
    return output.success ? { ok: true, value: output.data } : invalid();
  }
}
