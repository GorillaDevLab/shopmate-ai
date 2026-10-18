import { z } from "zod";
import {
  BasisPointsSchema,
  DataQualityIssueV1Schema,
  ExternalIdSchema,
  MetricEvidenceIdsSchema,
  MetricStatusSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  MetricWindowSchema,
  QuantitySchema,
  SourceVersionSchema,
  type DataQualityIssueV1,
  type MetricQuality,
  type MetricQualityDependency,
  type MetricQualityReducer,
  type MetricQualityRequest,
  type MetricStatus,
  type QualityPolicy,
} from "@shopmate/contracts";

type Rule = QualityPolicy["rules"][number];
type Evaluation = { status: MetricStatus; coverage: number; issues: DataQualityIssueV1[] };
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
const kindSchema = z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind));
function exactTimestamp(value: string): boolean {
  const tail = /\.(\d+)Z$/.exec(value)?.[1] ?? "";
  return Number.isFinite(Date.parse(value)) && !/[1-9]/.test(tail.slice(3));
}
const timestampSchema = MetricTimestampSchema.refine(exactTimestamp);
const ruleSchema = z.strictObject({
  kind: kindSchema,
  requiredFields: z
    .array(ExternalIdSchema)
    .refine((fields) => new Set(fields).size === fields.length),
  minimumSampleSize: QuantitySchema,
  maximumAgeHours: z.number().finite().nonnegative(),
  minimumCoverageBasisPoints: BasisPointsSchema,
  allowVerifiedEmptyWindow: z.boolean(),
});
const policySchema = z
  .strictObject({
    version: SourceVersionSchema,
    precedence: z.tuple([
      z.literal("UNAVAILABLE"),
      z.literal("STALE"),
      z.literal("INSUFFICIENT"),
      z.literal("ESTIMATED"),
      z.literal("VERIFIED"),
    ]),
    rules: z.array(ruleSchema),
  })
  .refine((policy) => new Set(policy.rules.map((rule) => rule.kind)).size === policy.rules.length);
const dependencySchema = z
  .strictObject({
    field: ExternalIdSchema,
    status: MetricStatusSchema,
    sourceWatermark: timestampSchema.nullable(),
    observedAt: timestampSchema.nullable(),
    sampleSize: QuantitySchema,
    knownCount: QuantitySchema,
    expectedCount: QuantitySchema,
    coverageBasisPoints: BasisPointsSchema,
    evidenceIds: MetricEvidenceIdsSchema,
    issues: z.array(DataQualityIssueV1Schema),
  })
  .refine(
    (row) =>
      row.knownCount <= row.expectedCount &&
      row.issues.every((issue) => issue.evidenceIds.every((id) => row.evidenceIds.includes(id))),
  );
const requestSchema = z
  .strictObject({
    kind: kindSchema,
    window: MetricWindowSchema.refine(
      (window) => exactTimestamp(window.periodStart) && exactTimestamp(window.periodEnd),
    ),
    visibleAt: timestampSchema,
    dependencies: z.array(dependencySchema),
    policy: policySchema,
  })
  .refine(validRequest);
function validRequest(request: MetricQualityRequest): boolean {
  const rule = request.policy.rules.find((row) => row.kind === request.kind);
  const cutoff = Date.parse(request.visibleAt);
  return (
    !!rule?.requiredFields.length &&
    Date.parse(request.window.periodEnd) <= cutoff &&
    request.dependencies.every((row) =>
      [row.observedAt, row.sourceWatermark].every(
        (time) => time === null || Date.parse(time) <= cutoff,
      ),
    )
  );
}
function parse(raw: MetricQualityRequest): MetricQualityRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new TypeError("Invalid metric quality request or policy");
  return parsed.data;
}
function strongest(statuses: readonly MetricStatus[]): MetricStatus {
  return precedence.find((status) => statuses.includes(status)) ?? "VERIFIED";
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function copyIssue(row: DataQualityIssueV1): DataQualityIssueV1 {
  return { ...row, evidenceIds: canonicalIds(row.evidenceIds) };
}
function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
function canonicalIssues(issues: readonly DataQualityIssueV1[]): DataQualityIssueV1[] {
  const keyed = new Map<string, DataQualityIssueV1>();
  for (const row of issues) {
    const copy = copyIssue(row);
    keyed.set(JSON.stringify([copy.code, copy.field, copy.evidenceIds]), copy);
  }
  return [...keyed.keys()].sort().map((key) => keyed.get(key)!);
}
function missingCode(field: string): DataQualityIssueV1["code"] {
  const aliases: Readonly<Record<string, DataQualityIssueV1["code"]>> = {
    frozenCosts: "COST_MISSING",
    paymentFacts: "PAYMENT_UNKNOWN",
    refundFacts: "REFUND_UNKNOWN",
    fees: "FEE_MISSING",
    traffic: "TRAFFIC_MISSING",
    campaignFacts: "ATTRIBUTION_MISSING",
    inventoryFacts: "INVENTORY_UNKNOWN",
    leadTimeHours: "LEAD_TIME_MISSING",
    returnReceipts: "RETURN_UNKNOWN",
  };
  return Object.hasOwn(aliases, field) ? aliases[field]! : "NOT_SYNCHRONIZED";
}
// Missing/integrity/scope/denominator facts block use; stale outranks confidence defects.
// A source-time issue can be inherited nonfatally when the wrapper independently supplies observedAt.
const issueFloors: Readonly<Record<DataQualityIssueV1["code"], MetricStatus>> = {
  NOT_SYNCHRONIZED: "UNAVAILABLE",
  SOURCE_INCONSISTENT: "UNAVAILABLE",
  PAYMENT_UNKNOWN: "UNAVAILABLE",
  REFUND_UNKNOWN: "UNAVAILABLE",
  COST_MISSING: "UNAVAILABLE",
  RETURN_UNKNOWN: "UNAVAILABLE",
  FEE_MISSING: "UNAVAILABLE",
  TRAFFIC_MISSING: "UNAVAILABLE",
  ATTRIBUTION_MISSING: "UNAVAILABLE",
  INVENTORY_UNKNOWN: "UNAVAILABLE",
  LEAD_TIME_MISSING: "UNAVAILABLE",
  ZERO_DENOMINATOR: "UNAVAILABLE",
  WINDOW_MISMATCH: "UNAVAILABLE",
  VERSION_MISMATCH: "UNAVAILABLE",
  STALE_SOURCE: "STALE",
  LOW_SAMPLE: "INSUFFICIENT",
  IMMATURE_COHORT: "INSUFFICIENT",
  COST_ESTIMATED: "ESTIMATED",
  FEE_ESTIMATED: "ESTIMATED",
  PARTIAL_COVERAGE: "ESTIMATED",
  SOURCE_TIME_MISSING: "ESTIMATED",
};
function issueStatus(code: DataQualityIssueV1["code"]): MetricStatus {
  return issueFloors[code];
}
function observedEmpty(row: MetricQualityDependency, request: MetricQualityRequest, rule: Rule) {
  return (
    row.knownCount === 0 &&
    row.expectedCount === 0 &&
    row.sampleSize === 0 &&
    row.sourceWatermark !== null &&
    Date.parse(row.sourceWatermark) >= Date.parse(request.window.periodEnd) &&
    row.observedAt !== null &&
    Date.parse(row.observedAt) >= Date.parse(request.window.periodEnd) &&
    Date.parse(request.visibleAt) - Date.parse(row.observedAt) <= rule.maximumAgeHours * 3600000 &&
    row.status === "VERIFIED" &&
    row.coverageBasisPoints === 10000 &&
    row.issues.length === 0
  );
}
function evaluate(
  row: MetricQualityDependency,
  request: MetricQualityRequest,
  rule: Rule,
  bypassEmpty: boolean,
): Evaluation {
  const issues = [...row.issues.map(copyIssue), ...timingIssues(row, request, rule)],
    statuses: MetricStatus[] = [row.status, row.observedAt === null ? "UNAVAILABLE" : "VERIFIED"];
  const add = (code: DataQualityIssueV1["code"], status: MetricStatus) => {
    issues.push({ code, field: row.field, evidenceIds: [...row.evidenceIds] });
    statuses.push(status);
  };
  const empty = observedEmpty(row, request, rule);
  if (
    !bypassEmpty &&
    (row.sampleSize < rule.minimumSampleSize || (empty && !rule.allowVerifiedEmptyWindow))
  )
    add("LOW_SAMPLE", "INSUFFICIENT");
  const coverage = effectiveCoverage(row, empty);
  if (coverage < 10000)
    add(
      "PARTIAL_COVERAGE",
      coverage < rule.minimumCoverageBasisPoints ? "INSUFFICIENT" : "ESTIMATED",
    );
  if (row.knownCount === 0 && row.expectedCount > 0) add(missingCode(row.field), "UNAVAILABLE");
  statuses.push(...issues.map(({ code }) => issueStatus(code)));
  // No public issue code means "unspecified source status". Require real reasons instead of
  // inventing a low sample, partial observation or synchronization failure to explain that flag.
  if (row.status !== "VERIFIED" && issues.length === 0)
    throw new TypeError("Nonverified source status requires supplied or derived quality evidence");
  return { status: strongest(statuses), coverage, issues };
}
function timingIssues(row: MetricQualityDependency, request: MetricQualityRequest, rule: Rule) {
  const codes: DataQualityIssueV1["code"][] = [];
  if (row.sourceWatermark === null) codes.push("NOT_SYNCHRONIZED");
  if (row.observedAt === null) codes.push("SOURCE_TIME_MISSING");
  if (
    (row.sourceWatermark !== null &&
      Date.parse(row.sourceWatermark) < Date.parse(request.window.periodEnd)) ||
    (row.observedAt !== null &&
      Date.parse(request.visibleAt) - Date.parse(row.observedAt) > rule.maximumAgeHours * 3600000)
  )
    codes.push("STALE_SOURCE");
  return codes.map((code) => ({ code, field: row.field, evidenceIds: [...row.evidenceIds] }));
}
function effectiveCoverage(row: MetricQualityDependency, empty: boolean): number {
  if (
    row.sourceWatermark === null ||
    row.observedAt === null ||
    row.issues.some(({ code }) => code === "SOURCE_INCONSISTENT")
  )
    return 0;
  const countCoverage =
    row.expectedCount === 0
      ? empty
        ? 10000
        : 0
      : Number((BigInt(row.knownCount) * 10000n) / BigInt(row.expectedCount));
  return Math.min(row.coverageBasisPoints, countCoverage);
}
function reduce(raw: MetricQualityRequest): MetricQuality {
  const request = parse(raw);
  const rule = request.policy.rules.find((row) => row.kind === request.kind)!;
  const selected = request.dependencies.filter((row) => rule.requiredFields.includes(row.field));
  // The port has no request-level provenance: a caller must supply real relevant sync observations,
  // even for empty business collections. Inventing an ID here would forge public issue evidence.
  if (selected.length === 0)
    throw new TypeError("Metric quality requires relevant source evidence");
  const missing = rule.requiredFields.filter(
    (field) => !selected.some((row) => row.field === field),
  );
  const bypassEmpty =
    rule.allowVerifiedEmptyWindow &&
    missing.length === 0 &&
    selected.every((row) => observedEmpty(row, request, rule));
  const results = selected.map((row) => evaluate(row, request, rule, bypassEmpty));
  const evidenceIds = canonicalIds(selected.flatMap((row) => row.evidenceIds));
  const missingIssues = missing.map((field) => ({
    code: missingCode(field),
    field,
    evidenceIds: [...evidenceIds],
  }));
  return freeze({
    status: missing.length ? "UNAVAILABLE" : strongest(results.map((row) => row.status)),
    sampleSize: missing.length ? 0 : Math.min(...selected.map((row) => row.sampleSize)),
    coverageBasisPoints: missing.length ? 0 : Math.min(...results.map((row) => row.coverage)),
    evidenceIds,
    issues: canonicalIssues([...results.flatMap((row) => row.issues), ...missingIssues]),
  });
}

export function createMetricQualityReducer(): MetricQualityReducer {
  return Object.freeze({ reduce });
}
