import {
  createEventFingerprint,
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
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

type Evidence = Extract<EventEvidenceV1, { eventType: "INVENTORY_STAGNATION" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "INVENTORY_STAGNATION" }>;
type Ratio = Readonly<{ numerator: bigint; denominator: bigint }>;
type Reason = Extract<EventDetectionOutcome, { disposition: "NO_CANDIDATE" }>["reason"];
const dayMs = 86400000n;
const core = new Set([
  "availableunits",
  "salesunits",
  "saleswindow",
  "saleswindowhours",
  "holdingdays",
  "listedat",
  "demandcoveragedays",
  "inventoryfacts",
  "paymentfacts",
  "products",
  "productfacts",
  "inventory",
  "orders",
  "paidunits",
  "inventoryavailable",
  "sourcewatermark",
  "sourcereferences",
  "evidence",
  "global",
  "samplesize",
  "coveragebasispoints",
  "definitionversion",
  "source",
  "facts",
]);
const costs = new Set([
  "inventorycostminor",
  "costcoveragebasispoints",
  "frozencosts",
  "cost",
  "cogs",
]);
const blockers = new Set([
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
  "STALE_SOURCE",
  "SOURCE_INCONSISTENT",
  "NOT_SYNCHRONIZED",
  "SOURCE_TIME_MISSING",
  "INVENTORY_UNKNOWN",
  "PAYMENT_UNKNOWN",
  "LOW_SAMPLE",
  "ZERO_DENOMINATOR",
  "IMMATURE_COHORT",
  "PARTIAL_COVERAGE",
]);

function fieldParts(field: string): readonly string[] {
  const normalized = field.toLowerCase();
  const parts = normalized.split(/[^a-z0-9]+/u);
  const scoped =
    parts.length === 1 ? parts : parts.filter((part) => part !== "facts" && part !== "evidence");
  return [normalized.replace(/[^a-z0-9]/gu, ""), ...scoped];
}
function affects(item: DataQualityIssueV1, fields: ReadonlySet<string>): boolean {
  return fieldParts(item.field).some((part) => fields.has(part));
}
function coreIssue(item: DataQualityIssueV1): boolean {
  return !affects(item, costs) && affects(item, core) && blockers.has(item.code);
}
function addIssue(
  item: Evidence,
  issues: DataQualityIssueV1[],
  code: DataQualityIssueV1["code"],
  field: string,
) {
  if (!issues.some((item) => item.code === code && item.field === field))
    issues.push({
      code,
      field,
      evidenceIds: [...new Set(item.sourceReferences.map((ref) => ref.id))],
    });
}
/** Convert policy decimals to rational integers; alarm boundaries never use a float epsilon. */
function decimal(value: number): Ratio {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction);
  return scale >= 0
    ? { numerator, denominator: 10n ** BigInt(scale) }
    : { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n };
}
function compare(left: Ratio, right: Ratio): bigint {
  return left.numerator * right.denominator - right.numerator * left.denominator;
}
function coverage(item: Evidence): Ratio | null {
  const { availableUnits, salesUnits, salesWindow } = item.facts;
  if (availableUnits === null || salesUnits === null || salesUnits === 0) return null;
  const milliseconds =
    BigInt(Date.parse(salesWindow.periodEnd)) - BigInt(Date.parse(salesWindow.periodStart));
  return {
    numerator: BigInt(availableUnits) * milliseconds,
    denominator: BigInt(salesUnits) * dayMs,
  };
}
function sourceChecks(item: Evidence, rule: Rule, issues: DataQualityIssueV1[]): void {
  const observed = BigInt(Date.parse(item.observedAt));
  const maximumAge = BigInt(rule.maximumAgeSeconds) * 1000n;
  if (item.sourceWatermark === null)
    addIssue(item, issues, "SOURCE_TIME_MISSING", "sourceWatermark");
  else if (observed - BigInt(Date.parse(item.sourceWatermark)) > maximumAge)
    addIssue(item, issues, "STALE_SOURCE", "sourceWatermark");
  for (const [kind, field] of [
    ["INVENTORY_AVAILABLE", "availableUnits"],
    ["PAID_UNITS", "salesUnits"],
    ["COGS", "inventoryCostMinor"],
  ]) {
    const refs = item.sourceReferences.filter(
      (ref) => ref.measure?.kind === kind || ref.measure === null,
    );
    if (refs.length === 0) addIssue(item, issues, "NOT_SYNCHRONIZED", field);
    if (refs.some((ref) => observed - BigInt(Date.parse(ref.observedAt)) > maximumAge))
      addIssue(item, issues, "STALE_SOURCE", field);
  }
}
function sampleChecks(item: Evidence, rule: Rule, issues: DataQualityIssueV1[]): void {
  const facts = item.facts;
  if (
    item.sampleSize < rule.minimumSampleSize ||
    facts.salesUnits === null ||
    facts.salesUnits === 0 ||
    facts.salesUnits < rule.minimumSampleSize
  )
    addIssue(
      item,
      issues,
      facts.salesUnits === 0 ? "ZERO_DENOMINATOR" : "LOW_SAMPLE",
      "salesUnits",
    );
  if (item.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    addIssue(item, issues, "PARTIAL_COVERAGE", "coverageBasisPoints");
  if (facts.availableUnits === null) addIssue(item, issues, "INVENTORY_UNKNOWN", "availableUnits");
  for (const field of ["holdingDays", "listedAt", "demandCoverageDays"] as const)
    if (facts[field] === null) addIssue(item, issues, "NOT_SYNCHRONIZED", field);
}
function listingChecks(item: Evidence, rule: Rule, issues: DataQualityIssueV1[]): void {
  const facts = item.facts;
  if (facts.listedAt !== null) {
    const age = BigInt(Date.parse(item.observedAt)) - BigInt(Date.parse(facts.listedAt));
    if (
      compare(
        { numerator: age, denominator: 3600000n },
        decimal(rule.thresholds.minimumListingAgeHours),
      ) < 0n
    )
      addIssue(item, issues, "IMMATURE_COHORT", "listedAt");
  }
}
function coverageChecks(item: Evidence, issues: DataQualityIssueV1[]): void {
  const demand = coverage(item);
  if (
    demand !== null &&
    item.facts.demandCoverageDays !== null &&
    item.facts.demandCoverageDays !==
      Number(demand.numerator / demand.denominator) +
        Number(demand.numerator % demand.denominator) / Number(demand.denominator)
  )
    addIssue(item, issues, "SOURCE_INCONSISTENT", "demandCoverageDays");
}
function snapshotQuality(
  item: Evidence,
  snapshot: MetricSnapshotV1,
  rule: Rule,
  field: string,
  issues: DataQualityIssueV1[],
): void {
  issues.push(...snapshot.issues);
  for (const diagnostic of snapshot.issues)
    if (blockers.has(diagnostic.code) && !affects(diagnostic, costs))
      addIssue(item, issues, diagnostic.code, field);
  if (snapshot.status === "UNAVAILABLE") addIssue(item, issues, "NOT_SYNCHRONIZED", field);
  if (snapshot.status === "STALE") addIssue(item, issues, "STALE_SOURCE", field);
  if (snapshot.coverageBasisPoints < rule.minimumCoverageBasisPoints)
    addIssue(item, issues, "PARTIAL_COVERAGE", field);
  if (field === "salesUnits" && snapshot.sampleSize < rule.minimumSampleSize)
    addIssue(item, issues, "LOW_SAMPLE", field);
  if (snapshot.sourceWatermark === null) addIssue(item, issues, "SOURCE_TIME_MISSING", field);
  else if (
    BigInt(Date.parse(item.observedAt)) - BigInt(Date.parse(snapshot.sourceWatermark)) >
    BigInt(rule.maximumAgeSeconds) * 1000n
  )
    addIssue(item, issues, "STALE_SOURCE", field);
}
function snapshotChecks(
  request: EventDetectionRequest,
  item: Evidence,
  rule: Rule,
  issues: DataQualityIssueV1[],
): void {
  for (const snapshot of request.snapshots) {
    const kind = snapshot.metric.kind;
    if (kind !== "INVENTORY_AVAILABLE" && kind !== "PAID_UNITS" && kind !== "COGS") continue;
    const field =
      kind === "INVENTORY_AVAILABLE"
        ? "availableUnits"
        : kind === "PAID_UNITS"
          ? "salesUnits"
          : "inventoryCostMinor";
    // COGS is a cost-quality dependency, never an inventory valuation to copy or compare.
    if (kind !== "COGS" && snapshot.metric.value !== item.facts[field])
      addIssue(item, issues, "SOURCE_INCONSISTENT", field);
    snapshotQuality(item, snapshot, rule, field, issues);
  }
}
function knownCost(item: Evidence, issues: DataQualityIssueV1[]): number | null {
  const facts = item.facts;
  if (facts.inventoryCostMinor === null || facts.costCoverageBasisPoints < 10000) {
    addIssue(item, issues, "COST_MISSING", "inventoryCostMinor");
    return null;
  }
  if (issues.some((diagnostic) => affects(diagnostic, costs))) return null;
  return facts.inventoryCostMinor;
}
function quality(item: Evidence, issues: readonly DataQualityIssueV1[]): EventQuality {
  return {
    dataStatus:
      issues.length === 0
        ? item.dataStatus
        : issues.some((entry) => entry.code === "STALE_SOURCE" && coreIssue(entry))
          ? "STALE"
          : "INSUFFICIENT",
    sampleSize: item.sampleSize,
    coverageBasisPoints: item.coverageBasisPoints,
    issues,
  };
}
function blockedReason(issues: readonly DataQualityIssueV1[]): Reason | null {
  const relevant = issues.filter(coreIssue);
  if (relevant.some((item) => item.code === "SOURCE_INCONSISTENT")) return "SOURCE_CONFLICT";
  if (relevant.some((item) => item.code === "STALE_SOURCE")) return "STALE_SOURCE";
  return relevant.length > 0 ? "INSUFFICIENT_EVIDENCE" : null;
}
function threshold(item: Evidence, rule: Rule): boolean {
  const days = coverage(item);
  return (
    days !== null &&
    item.facts.holdingDays !== null &&
    compare(days, decimal(rule.thresholds.minimumDemandCoverageDays)) > 0n &&
    compare(decimal(item.facts.holdingDays), decimal(rule.thresholds.minimumHoldingDays)) >= 0n
  );
}
function evaluate(
  request: EventDetectionRequest,
  item: Evidence,
  rule: Rule,
): EventResult<EventDetectionOutcome> {
  const issues = [...item.issues];
  sourceChecks(item, rule, issues);
  sampleChecks(item, rule, issues);
  listingChecks(item, rule, issues);
  coverageChecks(item, issues);
  snapshotChecks(request, item, rule, issues);
  const inventoryCostMinor = knownCost(item, issues);
  if (issues.length > 100) return { ok: false, error: { code: "OVERFLOW", evidenceIds: [] } };
  const resultQuality = quality(item, issues);
  const reason = blockedReason(issues) ?? (threshold(item, rule) ? null : "BELOW_THRESHOLD");
  const output =
    reason === null
      ? {
          disposition: "CANDIDATE",
          quality: resultQuality,
          blockedResources: [],
          candidate: {
            schemaVersion: 1,
            fingerprint: createEventFingerprint(item),
            severityFloor: "MEDIUM",
            rulePolicyVersion: request.policy.version,
            evidence: { ...item, ...resultQuality, facts: { ...item.facts, inventoryCostMinor } },
          },
        }
      : { disposition: "NO_CANDIDATE", reason, quality: resultQuality, blockedResources: [] };
  const parsed = EventDetectionOutcomeSchema.safeParse(output);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
}
export function createInventoryStagnationDetector(): EventDetector {
  return {
    detect(request) {
      const parsed = EventDetectionRequestSchema.safeParse(request);
      if (!parsed.success || parsed.data.evidence.eventType !== "INVENTORY_STAGNATION")
        return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
      const rule = parsed.data.policy.rules.find(
        (entry) => entry.eventType === "INVENTORY_STAGNATION",
      );
      if (!rule || rule.eventType !== "INVENTORY_STAGNATION")
        return { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
      return evaluate(parsed.data, parsed.data.evidence, rule);
    },
  };
}
