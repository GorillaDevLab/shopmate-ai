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
} from "@shopmate/contracts";

type Dependencies = Readonly<{ math: ExactMinorMath; clock: MetricBusinessClock }>;
type Kind = "INVENTORY_AVAILABLE" | "INVENTORY_HOURS_REMAINING" | "LEAD_TIME_HOURS";
type Selected = Readonly<{
  stock: MetricInventoryFact | undefined;
  extension: MetricInventoryExtension | undefined;
}>;
const kinds = ["INVENTORY_AVAILABLE", "INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"] as const;
const precedence = ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] as const;
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
      kinds.every((kind) => policy.rules.some((rule) => rule.kind === kind)),
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
function quality(
  request: InventoryCoverageRequest,
  selected: Selected,
  kind: Kind,
  missing = false,
): MetricQuality {
  const input = request.input;
  const rule = request.policy.rules.find((row) => row.kind === kind)!;
  const updatedAt =
    kind === "LEAD_TIME_HOURS"
      ? selected.extension?.data?.asOf
      : selected.stock?.data.source.updatedAt;
  const stale =
    updatedAt != null &&
    Date.parse(input.visibleAt) - Date.parse(updatedAt) > rule.maximumAgeHours * 3600000;
  const issues: DataQualityIssueV1[] = [];
  if (missing)
    issues.push({
      code: kind === "LEAD_TIME_HOURS" ? "LEAD_TIME_MISSING" : "ZERO_DENOMINATOR",
      field: kind,
      evidenceIds: [...input.evidenceIds],
    });
  if (stale)
    issues.push({
      code: "STALE_SOURCE",
      field: "inventoryFacts.source.updatedAt",
      evidenceIds: [...input.evidenceIds],
    });
  const status: MetricStatus = missing ? "UNAVAILABLE" : stale ? "STALE" : "VERIFIED";
  return {
    status,
    issues,
    evidenceIds: evidence(input),
    sampleSize: kind === "INVENTORY_HOURS_REMAINING" ? request.soldUnits.quality.sampleSize : 1,
    coverageBasisPoints: 10000,
  };
}
function measure<K extends Kind>(
  request: InventoryCoverageRequest,
  selected: Selected,
  kind: K,
  value: number | null,
): MetricMeasure<K> {
  return {
    metric: {
      kind,
      unit: kind === "INVENTORY_AVAILABLE" ? "units" : "hours",
      value,
    } as MetricMeasure<K>["metric"],
    quality: quality(request, selected, kind, value === null),
  };
}
function compute(request: InventoryCoverageRequest, selected: Selected): InventoryCoverageMetrics {
  const available = selected.stock?.data.available ?? null;
  const ext = selected.extension?.data;
  const soldUnits = request.soldUnits.metric.value;
  const salesWindowHours =
    (Date.parse(request.salesWindow.periodEnd) - Date.parse(request.salesWindow.periodStart)) /
    3600000;
  const salesUnitsPerHour = soldUnits === null ? null : soldUnits / salesWindowHours;
  const hours =
    available === null || !soldUnits || !ext ? null : (available / soldUnits) * salesWindowHours;
  const lead = ext?.leadTimeHours ?? null,
    buffer = ext?.safetyBufferHours ?? null;
  return {
    available: measure(request, selected, "INVENTORY_AVAILABLE", available),
    soldUnits,
    salesWindowHours,
    salesUnitsPerHour,
    hoursRemaining: measure(request, selected, "INVENTORY_HOURS_REMAINING", hours),
    daysRemaining: hours === null ? null : hours / 24,
    leadTimeHours: measure(request, selected, "LEAD_TIME_HOURS", lead),
    safetyBufferHours: buffer,
    eta: ext?.eta ?? null,
    belowLeadTimeWithBuffer:
      hours === null || lead === null || buffer === null ? null : hours < lead + buffer,
  };
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
    return freeze({ ok: true, value: compute(request, selected) });
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
