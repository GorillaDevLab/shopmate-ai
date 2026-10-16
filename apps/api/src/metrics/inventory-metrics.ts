import { z } from "zod";
import {
  BasisPointsSchema,
  DataQualityIssueV1Schema,
  ExternalIdSchema,
  MetricComputationV1Schema,
  MetricEvidenceIdsSchema,
  MetricInputV1Schema,
  MetricSnapshotV1Schema,
  MetricStatusSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  MetricWindowSchema,
  QuantitySchema,
  SourceVersionSchema,
  type DataQualityIssueV1,
  type ExactMinorMath,
  type InventoryCoverageCalculator,
  type InventoryCoverageMetrics,
  type InventoryCoverageRequest,
  type MetricBusinessClock,
  type MetricError,
  type MetricErrorCode,
  type MetricInputV1,
  type MetricInventoryExtension,
  type MetricInventoryFact,
  type MetricMeasure,
  type MetricQuality,
  type MetricResult,
  type MetricStatus,
  type QualityPolicy,
} from "@shopmate/contracts";

type Dependencies = Readonly<{ math: ExactMinorMath; clock: MetricBusinessClock }>;
type Kind = "INVENTORY_AVAILABLE" | "INVENTORY_HOURS_REMAINING" | "LEAD_TIME_HOURS";
type Selected = Readonly<{
  stock: MetricInventoryFact | undefined;
  extension: MetricInventoryExtension | undefined;
}>;
const kinds = ["INVENTORY_AVAILABLE", "INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"] as const;
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
// Logical requiredFields vocabulary; no implicit dependency on legacy leadTimeDays/safetyStock.
const stockFields = ["available", "onHand", "reserved"];
const extensionFields = ["quarantine", "asOf", "leadTimeHours", "safetyBufferHours", "eta"];
const salesFields = ["soldUnits", "salesWindowHours"];
const supportedFields = [...stockFields, ...extensionFields, ...salesFields];
const domains = {
  INVENTORY_AVAILABLE: ["inventoryFacts"],
  INVENTORY_HOURS_REMAINING: ["inventoryFacts", "paymentFacts", "inventoryExtensions"],
  LEAD_TIME_HOURS: ["inventoryExtensions"],
} as const;
const collections = [
  "paymentFacts",
  "refundFacts",
  "inventoryFacts",
  "campaignFacts",
  "frozenCosts",
  "refundAllocations",
  "returnReceipts",
  "fees",
  "traffic",
  "inventoryExtensions",
] as const;
const qualitySchema = z.strictObject({
  status: MetricStatusSchema,
  sampleSize: QuantitySchema,
  coverageBasisPoints: BasisPointsSchema,
  evidenceIds: MetricEvidenceIdsSchema,
  issues: z.array(DataQualityIssueV1Schema),
});
const ruleSchema = z.strictObject({
  kind: z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind)),
  requiredFields: z.array(ExternalIdSchema),
  minimumSampleSize: QuantitySchema,
  maximumAgeHours: z.number().finite().nonnegative(),
  minimumCoverageBasisPoints: BasisPointsSchema,
  allowVerifiedEmptyWindow: z.boolean(),
});
const policySchema = z
  .strictObject({
    version: SourceVersionSchema,
    precedence: z.tuple(
      precedence.map((value) => z.literal(value)) as [
        z.ZodLiteral<"UNAVAILABLE">,
        z.ZodLiteral<"STALE">,
        z.ZodLiteral<"INSUFFICIENT">,
        z.ZodLiteral<"ESTIMATED">,
        z.ZodLiteral<"VERIFIED">,
      ],
    ),
    rules: z.array(ruleSchema),
  })
  .refine(
    (policy) =>
      new Set(policy.rules.map((rule) => rule.kind)).size === policy.rules.length &&
      kinds.every((kind) => policy.rules.some((rule) => rule.kind === kind)) &&
      policy.rules.every(
        (rule) =>
          !kinds.includes(rule.kind as Kind) ||
          rule.requiredFields.every((field) => supportedFields.includes(field)),
      ),
  );
const requestSchema = z.strictObject({
  input: MetricInputV1Schema,
  externalSkuId: ExternalIdSchema,
  externalLocationId: ExternalIdSchema,
  salesWindow: MetricWindowSchema,
  policy: policySchema,
  soldUnits: z.strictObject({
    metric: MetricValueSchema.refine((metric) => metric.kind === "PAID_UNITS"),
    quality: qualitySchema,
  }),
});
const clockSchema = z.strictObject({ now: MetricTimestampSchema, revision: QuantitySchema });
function ids(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
class Rejected extends Error {
  constructor(readonly detail: MetricError) {
    super(detail.code);
  }
}
function reject(code: MetricErrorCode, evidenceIds: readonly string[] = []): never {
  throw new Rejected({ code, evidenceIds: ids(evidenceIds) });
}
function checked<T>(result: MetricResult<T>): T {
  if (!result.ok) throw new Rejected(result.error);
  return result.value;
}
function context(input: MetricInputV1) {
  const {
    schemaVersion,
    definitionVersion,
    inputRevision,
    binding,
    periodStart,
    periodEnd,
    timezone,
    currency,
    visibleAt,
    sourceWatermark,
  } = input;
  return {
    schemaVersion,
    definitionVersion,
    inputRevision,
    binding,
    periodStart,
    periodEnd,
    timezone,
    currency,
    visibleAt,
    sourceWatermark,
  };
}
function evidence(input: MetricInputV1): string[] {
  return ids(
    input.evidenceIds,
    ...collections.flatMap((key) => (input[key] ?? []).map((row) => row.evidenceIds)),
  );
}
function exact(time: string | null): boolean {
  return (
    time === null ||
    (Number.isFinite(Date.parse(time)) &&
      !/[1-9]/.test((/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(time)?.[1] ?? "").slice(3)))
  );
}
function matching(
  request: InventoryCoverageRequest,
  data: { externalSkuId: string; externalLocationId: string } | null,
): boolean {
  return (
    data !== null &&
    data.externalSkuId === request.externalSkuId &&
    data.externalLocationId === request.externalLocationId
  );
}
function select(request: InventoryCoverageRequest): Selected {
  const stocks = (request.input.inventoryFacts ?? []).filter((row) => matching(request, row.data));
  const extensions = (request.input.inventoryExtensions ?? []).filter((row) =>
    matching(request, row.data),
  );
  for (const rows of [stocks, extensions])
    if (rows.length > 1) reject("CONFLICT", ids(...rows.map((row) => row.evidenceIds)));
  return { stock: stocks[0], extension: extensions[0] };
}
function precision(request: InventoryCoverageRequest, selected: Selected): boolean {
  const input = request.input;
  const times = [
    input.periodStart,
    input.periodEnd,
    input.visibleAt,
    input.sourceWatermark,
    request.salesWindow.periodStart,
    request.salesWindow.periodEnd,
  ];
  for (const proof of input.metricCoverage)
    times.push(
      proof.periodStart,
      proof.periodEnd,
      proof.visibleAt,
      proof.observedAt,
      proof.sourceWatermark,
    );
  if (selected.stock) times.push(selected.stock.observedAt, selected.stock.data.source.updatedAt);
  if (selected.extension)
    times.push(
      selected.extension.observedAt,
      selected.extension.data?.asOf ?? null,
      selected.extension.data?.eta ?? null,
    );
  return times.every(exact);
}
function validUpstream(
  request: InventoryCoverageRequest,
  sourceEvidence: ReadonlySet<string>,
): boolean {
  const { input, soldUnits } = request;
  return (
    soldUnits.quality.evidenceIds.every((id) => sourceEvidence.has(id)) &&
    MetricSnapshotV1Schema.safeParse({
      ...context(input),
      ...soldUnits.quality,
      metric: soldUnits.metric,
      subject: { kind: "SKU", externalSkuId: request.externalSkuId },
      computedAt: input.visibleAt,
    }).success
  );
}
function validate(
  request: InventoryCoverageRequest,
  selected: Selected,
  deps: Dependencies,
  sourceEvidence: ReadonlySet<string>,
): void {
  const snapshot = clockSchema.safeParse(deps.clock.snapshot());
  if (
    !snapshot.success ||
    !exact(snapshot.data.now) ||
    Date.parse(request.input.visibleAt) > Date.parse(snapshot.data.now) ||
    Date.parse(request.salesWindow.periodEnd) > Date.parse(request.input.visibleAt) ||
    !precision(request, selected) ||
    !validUpstream(request, sourceEvidence)
  )
    reject("INVALID_INPUT", request.input.evidenceIds);
}
function reconcile(selected: Selected, deps: Dependencies): void {
  const stock = selected.stock?.data,
    ext = selected.extension?.data;
  if (
    !stock ||
    !ext ||
    stock.source.updatedAt === null ||
    Date.parse(stock.source.updatedAt) !== Date.parse(ext.asOf)
  )
    return;
  const values = [stock.available, stock.reserved, ext.quarantine];
  if (stock.onHand === null || values.some((value) => value === null)) return;
  const sum = checked(deps.math.add(values as number[]));
  if (sum > stock.onHand)
    reject("CONFLICT", ids(selected.stock!.evidenceIds, selected.extension!.evidenceIds));
}
function issue(
  code: DataQualityIssueV1["code"],
  field: string,
  evidenceIds: readonly string[],
): DataQualityIssueV1 {
  return { code, field, evidenceIds: ids(evidenceIds) };
}
type Evaluation = Readonly<{ quality: MetricQuality; blocked: boolean }>;
type Frame = Readonly<{
  request: InventoryCoverageRequest;
  selected: Selected;
  sourceEvidence: ReadonlySet<string>;
  salesWindowHours: number;
}>;
type Rule = QualityPolicy["rules"][number];
function fields(frame: Frame): Readonly<Record<string, number | string | null>> {
  const stock = frame.selected.stock?.data,
    ext = frame.selected.extension?.data;
  return {
    available: stock?.available ?? null,
    onHand: stock?.onHand ?? null,
    reserved: stock?.reserved ?? null,
    quarantine: ext?.quarantine ?? null,
    asOf: ext?.asOf ?? null,
    soldUnits: observedSales(frame),
    salesWindowHours: frame.salesWindowHours,
    leadTimeHours: ext?.leadTimeHours ?? null,
    safetyBufferHours: ext?.safetyBufferHours ?? null,
    eta: ext?.eta ?? null,
  };
}
function dependencies(kind: Kind, rule: Rule) {
  return {
    stock:
      kind !== "LEAD_TIME_HOURS" ||
      rule.requiredFields.some((field) => stockFields.includes(field)),
    extension:
      kind !== "INVENTORY_AVAILABLE" ||
      rule.requiredFields.some((field) => extensionFields.includes(field)),
    sales:
      kind === "INVENTORY_HOURS_REMAINING" ||
      rule.requiredFields.some((field) => salesFields.includes(field)),
  };
}
function requiredCollections(kind: Kind, rule: Rule): readonly (typeof collections)[number][] {
  const uses = dependencies(kind, rule);
  return [
    ...new Set([
      ...domains[kind],
      ...(uses.stock ? ["inventoryFacts" as const] : []),
      ...(uses.extension ? ["inventoryExtensions" as const] : []),
      ...(uses.sales ? ["paymentFacts" as const] : []),
    ]),
  ];
}
function sourceCoverage(frame: Frame, kind: Kind, rule: Rule): number {
  const { input } = frame.request;
  const required = requiredCollections(kind, rule);
  if (required.some((key) => input[key] === null)) return 0;
  const proofs = input.metricCoverage.filter(
    (proof) =>
      proof.kind === kind &&
      proof.subject.kind === "SKU" &&
      proof.subject.externalSkuId === frame.request.externalSkuId,
  );
  const proofValues = proofs.map((proof) =>
    required.every((key) => proof.collections.includes(key)) ? proof.coverageBasisPoints : 0,
  );
  return Math.min(
    ...(proofValues.length ? proofValues : [0]),
    dependencies(kind, rule).sales ? frame.request.soldUnits.quality.coverageBasisPoints : 10000,
  );
}
function missingFields(frame: Frame, rule: Rule): DataQualityIssueV1[] {
  const values = fields(frame);
  return rule.requiredFields
    .filter((field) => values[field] === null)
    .map((field) => {
      const isLead = ["leadTimeHours", "safetyBufferHours", "eta"].includes(field);
      const path = extensionFields.includes(field)
        ? `inventoryExtensions.${field}`
        : salesFields.includes(field)
          ? field
          : `inventoryFacts.${field}`;
      return issue(isLead ? "LEAD_TIME_MISSING" : "INVENTORY_UNKNOWN", path, [
        ...frame.sourceEvidence,
      ]);
    });
}
function stockIssues(frame: Frame): DataQualityIssueV1[] {
  const row = frame.selected.stock;
  if (!row) return [issue("INVENTORY_UNKNOWN", "inventoryFacts", frame.request.input.evidenceIds)];
  return row.data.source.quality.issues.flatMap((code) => {
    if (
      ![
        "INVENTORY_UNKNOWN",
        "INVENTORY_STALE",
        "SOURCE_TIME_MISSING",
        "SOURCE_INCONSISTENT",
      ].includes(code)
    )
      return [];
    return [
      issue(
        code === "INVENTORY_STALE" ? "STALE_SOURCE" : (code as DataQualityIssueV1["code"]),
        "inventoryFacts.source",
        row.evidenceIds,
      ),
    ];
  });
}
function extensionIssues(frame: Frame, kind: Kind): DataQualityIssueV1[] {
  const { input } = frame.request;
  const result: DataQualityIssueV1[] = [];
  if (
    !frame.selected.extension?.data ||
    (input.inventoryExtensions ?? []).some((row) => row.data === null)
  )
    result.push(issue("INVENTORY_UNKNOWN", "inventoryExtensions", input.evidenceIds));
  if (kind === "LEAD_TIME_HOURS" && frame.selected.extension?.data?.leadTimeHours == null)
    result.push(issue("LEAD_TIME_MISSING", "inventoryExtensions.leadTimeHours", input.evidenceIds));
  return result;
}
function paymentIssues(frame: Frame): DataQualityIssueV1[] {
  return (frame.request.input.paymentFacts ?? []).flatMap((row) => {
    const data = row.data;
    const result: DataQualityIssueV1[] = [];
    if (
      data.paidMinor === null ||
      data.source.quality.issues.includes("PAYMENT_UNKNOWN") ||
      (data.paidAt === null &&
        (data.paidMinor !== 0 || ["PAID", "FULFILLED", "COMPLETED"].includes(data.status)))
    )
      result.push(issue("PAYMENT_UNKNOWN", "paymentFacts", row.evidenceIds));
    for (const code of ["SOURCE_INCONSISTENT", "SOURCE_TIME_MISSING"] as const)
      if (data.source.quality.issues.includes(code))
        result.push(issue(code, "paymentFacts.source", row.evidenceIds));
    return result;
  });
}
function observedSales(frame: Frame): number | null {
  const { request } = frame;
  const issues = [...paymentIssues(frame), ...request.soldUnits.quality.issues];
  const unknown = issues.some((row) =>
    ["PAYMENT_UNKNOWN", "SOURCE_INCONSISTENT", "NOT_SYNCHRONIZED"].includes(row.code),
  );
  return request.input.paymentFacts === null || unknown ? null : request.soldUnits.metric.value;
}
function freshness(frame: Frame, kind: Kind, rule: Rule): DataQualityIssueV1[] {
  const uses = dependencies(kind, rule),
    { selected, request } = frame;
  const times: [string, string | null | undefined, readonly string[]][] = [
    ["sourceWatermark", request.input.sourceWatermark, request.input.evidenceIds],
  ];
  if (uses.stock && selected.stock)
    times.push([
      "inventoryFacts.source.updatedAt",
      selected.stock.data.source.updatedAt,
      selected.stock.evidenceIds,
    ]);
  if (uses.extension && selected.extension?.data)
    times.push([
      "inventoryExtensions.asOf",
      selected.extension.data.asOf,
      selected.extension.evidenceIds,
    ]);
  return times.flatMap(([field, time, evidence]) => {
    if (time == null) return [issue("SOURCE_TIME_MISSING", field, evidence)];
    return (Date.parse(request.input.visibleAt) - Date.parse(time)) / 3600000 > rule.maximumAgeHours
      ? [issue("STALE_SOURCE", field, evidence)]
      : [];
  });
}
function sample(frame: Frame, kind: Kind, unsynced: boolean): number {
  if (unsynced) return 0;
  if (kind === "INVENTORY_HOURS_REMAINING") return frame.request.soldUnits.quality.sampleSize;
  return Number(
    kind === "INVENTORY_AVAILABLE" ? !!frame.selected.stock : !!frame.selected.extension?.data,
  );
}
function baseIssues(frame: Frame, kind: Kind, rule: Rule): DataQualityIssueV1[] {
  const uses = dependencies(kind, rule),
    input = frame.request.input;
  const issues = requiredCollections(kind, rule)
    .filter((key) => input[key] === null)
    .map((key) => issue("NOT_SYNCHRONIZED", key, input.evidenceIds));
  if (uses.stock) issues.push(...stockIssues(frame));
  if (uses.extension) issues.push(...extensionIssues(frame, kind));
  if (uses.sales) issues.push(...frame.request.soldUnits.quality.issues, ...paymentIssues(frame));
  issues.push(...missingFields(frame, rule), ...freshness(frame, kind, rule));
  if (
    input.sourceWatermark !== null &&
    Date.parse(input.sourceWatermark) < Date.parse(input.periodEnd)
  )
    issues.push(issue("PARTIAL_COVERAGE", "sourceWatermark", input.evidenceIds));
  if (kind === "INVENTORY_HOURS_REMAINING" && frame.request.soldUnits.metric.value === 0)
    issues.push(
      issue("ZERO_DENOMINATOR", "soldUnits", frame.request.soldUnits.quality.evidenceIds),
    );
  return issues;
}
function evaluatedStatus(
  frame: Frame,
  kind: Kind,
  rule: Rule,
  issues: readonly DataQualityIssueV1[],
  unavailable: boolean,
): MetricStatus {
  const statuses: MetricStatus[] = [issues.length ? "ESTIMATED" : "VERIFIED"];
  if (dependencies(kind, rule).sales) statuses.push(frame.request.soldUnits.quality.status);
  if (unavailable) statuses.push("UNAVAILABLE");
  if (issues.some((row) => row.code === "STALE_SOURCE")) statuses.push("STALE");
  if (
    issues.some((row) =>
      [
        "INVENTORY_UNKNOWN",
        "LEAD_TIME_MISSING",
        "SOURCE_INCONSISTENT",
        "PAYMENT_UNKNOWN",
        "LOW_SAMPLE",
      ].includes(row.code),
    )
  )
    statuses.push("INSUFFICIENT");
  return precedence.find((status) => statuses.includes(status))!;
}
function ownMissing(frame: Frame, kind: Kind): boolean {
  const data = fields(frame);
  if (kind === "INVENTORY_AVAILABLE") return data.available === null;
  if (kind === "LEAD_TIME_HOURS") return data.leadTimeHours === null;
  return data.available === null || data.soldUnits === null || !frame.selected.extension?.data;
}
function blockedForecast(
  frame: Frame,
  issues: readonly DataQualityIssueV1[],
  status: MetricStatus,
  low: boolean,
): boolean {
  return (
    low ||
    status === "INSUFFICIENT" ||
    frame.request.soldUnits.quality.status === "UNAVAILABLE" ||
    issues.some((row) => ["LOW_SAMPLE", "PAYMENT_UNKNOWN", "INVENTORY_UNKNOWN"].includes(row.code))
  );
}
function resultEvidence(frame: Frame, issues: readonly DataQualityIssueV1[]): string[] {
  return ids(
    [...frame.sourceEvidence],
    frame.request.soldUnits.quality.evidenceIds,
    ...issues.map((row) => row.evidenceIds),
  );
}
function evaluate(frame: Frame, kind: Kind): Evaluation {
  const rule = frame.request.policy.rules.find((row) => row.kind === kind)!;
  const issues = baseIssues(frame, kind, rule),
    coverage = sourceCoverage(frame, kind, rule);
  const unsynced = issues.some((row) => row.code === "NOT_SYNCHRONIZED");
  const sampleSize = sample(frame, kind, unsynced);
  const lowSample = sampleSize < rule.minimumSampleSize,
    lowCoverage = coverage < rule.minimumCoverageBasisPoints;
  if (lowSample) issues.push(issue("LOW_SAMPLE", kind, [...frame.sourceEvidence]));
  if (coverage < 10000)
    issues.push(issue("PARTIAL_COVERAGE", "metricCoverage", [...frame.sourceEvidence]));
  const unavailable =
    unsynced || ownMissing(frame, kind) || issues.some((row) => row.code === "ZERO_DENOMINATOR");
  const status = lowCoverage
    ? precedence.find((status) =>
        [evaluatedStatus(frame, kind, rule, issues, unavailable), "INSUFFICIENT"].includes(status),
      )!
    : evaluatedStatus(frame, kind, rule, issues, unavailable);
  const badSource = issues.some((row) => row.code === "SOURCE_INCONSISTENT");
  const blocked =
    unavailable ||
    badSource ||
    missingFields(frame, rule).length > 0 ||
    (kind === "INVENTORY_HOURS_REMAINING" &&
      blockedForecast(frame, issues, status, lowSample || lowCoverage));
  return {
    blocked,
    quality: {
      status,
      sampleSize,
      coverageBasisPoints: unsynced ? 0 : coverage,
      evidenceIds: resultEvidence(frame, issues),
      issues,
    },
  };
}
function measure<K extends Kind>(
  kind: K,
  value: number | null,
  evaluation: Evaluation,
): MetricMeasure<K> {
  return {
    metric: {
      kind,
      unit: kind === "INVENTORY_AVAILABLE" ? "units" : "hours",
      value: evaluation.blocked ? null : value,
    } as MetricMeasure<K>["metric"],
    quality: evaluation.quality,
  };
}
function durations(hours: number | null, lead: number | null, buffer: number | null) {
  return {
    daysRemaining: hours === null ? null : hours / 24,
    belowLeadTimeWithBuffer:
      hours === null || lead === null || buffer === null ? null : hours < lead + buffer,
  };
}
function compute(frame: Frame): InventoryCoverageMetrics {
  const { request, selected, salesWindowHours } = frame;
  const available = measure(
    "INVENTORY_AVAILABLE",
    selected.stock?.data.available ?? null,
    evaluate(frame, "INVENTORY_AVAILABLE"),
  );
  const ext = selected.extension?.data,
    soldUnits = observedSales(frame);
  const salesUnitsPerHour =
    soldUnits === null || request.input.paymentFacts === null ? null : soldUnits / salesWindowHours;
  const rawHours =
    selected.stock?.data.available == null || !soldUnits
      ? null
      : (selected.stock.data.available / soldUnits) * salesWindowHours;
  const hoursRemaining = measure(
    "INVENTORY_HOURS_REMAINING",
    rawHours,
    evaluate(frame, "INVENTORY_HOURS_REMAINING"),
  );
  const leadTimeHours = measure(
    "LEAD_TIME_HOURS",
    ext?.leadTimeHours ?? null,
    evaluate(frame, "LEAD_TIME_HOURS"),
  );
  const buffer = ext?.safetyBufferHours ?? null;
  return {
    available,
    soldUnits,
    salesWindowHours,
    salesUnitsPerHour,
    hoursRemaining,
    leadTimeHours,
    safetyBufferHours: buffer,
    eta: ext?.eta ?? null,
    ...durations(hoursRemaining.metric.value, leadTimeHours.metric.value, buffer),
  };
}
function validOutput(frame: Frame, result: InventoryCoverageMetrics): boolean {
  const { input, externalSkuId } = frame.request;
  return [result.available, result.hoursRemaining, result.leadTimeHours].every(
    (row) =>
      MetricComputationV1Schema.safeParse({
        input,
        snapshot: {
          ...context(input),
          ...row.quality,
          metric: row.metric,
          subject: { kind: "SKU", externalSkuId },
          computedAt: input.visibleAt,
        },
      }).success,
  );
}
function result(frame: Frame): InventoryCoverageMetrics {
  const output = compute(frame);
  if (!validOutput(frame, output)) reject("INVALID_INPUT", frame.request.input.evidenceIds);
  return output;
}
function calculate(
  raw: InventoryCoverageRequest,
  deps: Dependencies,
): MetricResult<InventoryCoverageMetrics> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success)
    return freeze({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
  const request = parsed.data as InventoryCoverageRequest;
  const sourceEvidence = new Set(evidence(request.input));
  try {
    const selected = select(request);
    validate(request, selected, deps, sourceEvidence);
    reconcile(selected, deps);
    return freeze({
      ok: true,
      value: result({
        request,
        selected,
        sourceEvidence,
        salesWindowHours:
          (Date.parse(request.salesWindow.periodEnd) -
            Date.parse(request.salesWindow.periodStart)) /
          3600000,
      }),
    });
  } catch (error) {
    if (error instanceof Rejected)
      return freeze({
        ok: false,
        error: { ...error.detail, evidenceIds: ids(error.detail.evidenceIds) },
      });
    throw error;
  }
}
/** Pure SKU/location cover. The reader binds supplied PAID_UNITS to salesWindow, SKU, cutoff and revision;
 * the public port carries no upstream provenance to authenticate that binding or its location slice. */
export function createInventoryCoverageCalculator(
  dependencies: Dependencies,
): InventoryCoverageCalculator {
  return Object.freeze({
    calculate: (request: InventoryCoverageRequest) => calculate(request, dependencies),
  });
}
