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
  return { ...row, evidenceIds: [...row.evidenceIds] };
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
): Evaluation {
  const issues = row.issues.map(copyIssue),
    statuses: MetricStatus[] = [row.status];
  const add = (code: DataQualityIssueV1["code"], status: MetricStatus) => {
    issues.push({ code, field: row.field, evidenceIds: [...row.evidenceIds] });
    statuses.push(status);
  };
  if (row.sourceWatermark === null) add("NOT_SYNCHRONIZED", "UNAVAILABLE");
  if (row.observedAt === null) add("SOURCE_TIME_MISSING", "UNAVAILABLE");
  if (
    (row.sourceWatermark !== null &&
      Date.parse(row.sourceWatermark) < Date.parse(request.window.periodEnd)) ||
    (row.observedAt !== null &&
      Date.parse(request.visibleAt) - Date.parse(row.observedAt) > rule.maximumAgeHours * 3600000)
  )
    add("STALE_SOURCE", "STALE");
  const empty = observedEmpty(row, request, rule);
  if (
    !(empty && rule.allowVerifiedEmptyWindow) &&
    (row.sampleSize < rule.minimumSampleSize || (empty && !rule.allowVerifiedEmptyWindow))
  )
    add("LOW_SAMPLE", "INSUFFICIENT");
  if (issues.some(({ code }) => code === "COST_MISSING" || code === "SOURCE_INCONSISTENT"))
    statuses.push("UNAVAILABLE");
  const coverage =
    row.sourceWatermark === null || issues.some(({ code }) => code === "SOURCE_INCONSISTENT")
      ? 0
      : row.coverageBasisPoints;
  return { status: strongest(statuses), coverage, issues };
}
function reduce(raw: MetricQualityRequest): MetricQuality {
  const request = parse(raw);
  const rule = request.policy.rules.find((row) => row.kind === request.kind)!;
  const selected = request.dependencies.filter((row) => rule.requiredFields.includes(row.field));
  // The port has no request-level provenance: a caller must supply real relevant sync observations,
  // even for empty business collections. Inventing an ID here would forge public issue evidence.
  if (selected.length === 0)
    throw new TypeError("Metric quality requires relevant source evidence");
  const results = selected.map((row) => evaluate(row, request, rule));
  return freeze({
    status: strongest(results.map((row) => row.status)),
    sampleSize: Math.min(...selected.map((row) => row.sampleSize)),
    coverageBasisPoints: Math.min(...results.map((row) => row.coverage)),
    evidenceIds: [...new Set(selected.flatMap((row) => row.evidenceIds))],
    issues: results.flatMap((row) => row.issues),
  });
}

export function createMetricQualityReducer(): MetricQualityReducer {
  return Object.freeze({ reduce });
}
