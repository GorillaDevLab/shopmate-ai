import { z } from "zod";
import {
  BasisPointsSchema,
  ConnectorBindingSchema,
  DataQualityIssueV1Schema,
  ExternalIdSchema,
  MetricEvidenceIdsSchema,
  MetricStatusSchema,
  MetricTimestampSchema,
  MetricWindowSchema,
  MinorAmountSchema,
  SignedMinorSchema,
  SourceVersionSchema,
  type MetricWindow,
  type DataQualityIssueV1,
  type MetricStatus,
  type ExactMinorMath,
  type MetricErrorCode,
  type MetricQuality,
  type MetricResult,
  type MinorRounding,
  type ProfitDeltaAttributionV1,
  type ProfitDeltaComponent,
  type ProfitDeltaMetrics,
  type ProfitDeltaRequest,
  type ProfitPeriodAggregate,
  type ProfitSkuAggregate,
} from "@shopmate/contracts";

export const PROFIT_DELTA_METHOD_VERSION = "profit-delta-sequential-v1";
const order = ["VOLUME", "PRICE_DISCOUNT", "SKU_MIX", "COGS", "ADVERTISING"] as const;
type Dependencies = Readonly<{ math: ExactMinorMath }>;
type Fraction = Readonly<{ n: bigint; d: bigint }>;
type Revenue = Readonly<{ quantity: bigint; revenue: bigint }>;
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const timestampSchema = MetricTimestampSchema.refine(
  (value) =>
    Number.isFinite(Date.parse(value)) &&
    !/[1-9]/.test((/\.(\d+)Z$/.exec(value)?.[1] ?? "").slice(3)),
);
const windowSchema = MetricWindowSchema.refine(
  (window) =>
    timestampSchema.safeParse(window.periodStart).success &&
    timestampSchema.safeParse(window.periodEnd).success,
);
const qualitySchema = z
  .strictObject({
    status: MetricStatusSchema,
    sampleSize: MinorAmountSchema,
    coverageBasisPoints: BasisPointsSchema,
    evidenceIds: MetricEvidenceIdsSchema,
    issues: z.array(DataQualityIssueV1Schema),
  })
  .refine((quality) =>
    quality.issues.every((issue) =>
      issue.evidenceIds.every((id) => quality.evidenceIds.includes(id)),
    ),
  )
  .refine((quality) =>
    quality.status === "VERIFIED"
      ? quality.coverageBasisPoints === 10000 && quality.issues.length === 0
      : quality.issues.length > 0,
  );
const skuSchema = z.strictObject({
  externalSkuId: ExternalIdSchema,
  units: MinorAmountSchema.nullable(),
  grossMinor: MinorAmountSchema.nullable(),
  discountMinor: MinorAmountSchema.nullable(),
  netRevenueMinor: SignedMinorSchema.nullable(),
  cogsMinor: SignedMinorSchema.nullable(),
  advertisingMinor: MinorAmountSchema.nullable(),
  frozenCostVersions: z
    .array(SourceVersionSchema)
    .refine((values) => new Set(values).size === values.length),
  evidenceIds: MetricEvidenceIdsSchema,
});
const periodSchema = z.strictObject({
  binding: ConnectorBindingSchema,
  window: windowSchema,
  definitionVersion: SourceVersionSchema,
  costPolicyVersion: SourceVersionSchema,
  inputRevision: SourceVersionSchema,
  visibleAt: timestampSchema,
  skus: z.array(skuSchema),
  profitMinor: SignedMinorSchema.nullable(),
  quality: qualitySchema,
});
const requestSchema = z.strictObject({
  baseline: periodSchema,
  current: periodSchema,
  comparison: z.strictObject({
    current: windowSchema,
    baseline: windowSchema,
    elapsedHours: z.number().finite().nonnegative(),
    aligned: z.boolean(),
    reason: z.enum(["WEEKDAY_MISMATCH", "CUTOFF_MISMATCH"]).nullable(),
  }),
  method: z.strictObject({
    schemaVersion: MinorAmountSchema,
    version: SourceVersionSchema,
    order: z.array(ExternalIdSchema),
    rounding: z.enum(["HALF_AWAY_FROM_ZERO", "TOWARD_ZERO"]),
    residualPolicy: ExternalIdSchema,
  }),
});
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

function local(time: string) {
  const parts = formatter.formatToParts(new Date(time));
  const read = (key: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === key)?.value;
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    weekday: read("weekday"),
    cutoff: `${read("hour")}:${read("minute")}:${read("second")}:${read("fractionalSecond")}`,
  };
}
function sameWindow(left: MetricWindow, right: MetricWindow): boolean {
  return (
    left.currency === right.currency &&
    left.timezone === right.timezone &&
    Date.parse(left.periodStart) === Date.parse(right.periodStart) &&
    Date.parse(left.periodEnd) === Date.parse(right.periodEnd)
  );
}
function aligned(input: ProfitDeltaRequest): boolean {
  const { current, baseline, comparison } = input;
  const before = baseline.window,
    after = current.window;
  const duration = Date.parse(after.periodEnd) - Date.parse(after.periodStart);
  const baselineDuration = Date.parse(before.periodEnd) - Date.parse(before.periodStart);
  const start0 = local(before.periodStart),
    start1 = local(after.periodStart);
  return (
    comparison.aligned &&
    comparison.reason === null &&
    sameWindow(before, comparison.baseline) &&
    sameWindow(after, comparison.current) &&
    duration === baselineDuration &&
    comparison.elapsedHours === duration / 3600000 &&
    Date.parse(before.periodEnd) <= Date.parse(after.periodStart) &&
    Date.parse(before.periodEnd) <= Date.parse(baseline.visibleAt) &&
    Date.parse(after.periodEnd) <= Date.parse(current.visibleAt) &&
    start0.weekday === start1.weekday &&
    start0.cutoff === "00:00:00:000" &&
    start1.cutoff === "00:00:00:000" &&
    local(before.periodEnd).cutoff === local(after.periodEnd).cutoff &&
    local(new Date(Date.parse(before.periodEnd) - 1).toISOString()).date === start0.date &&
    local(new Date(Date.parse(after.periodEnd) - 1).toISOString()).date === start1.date
  );
}
function validation(input: unknown): MetricResult<ProfitDeltaRequest> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT");
  const value = parsed.data as ProfitDeltaRequest;
  const { method, baseline, current } = value;
  if (
    method.schemaVersion !== 1 ||
    method.version !== PROFIT_DELTA_METHOD_VERSION ||
    method.residualPolicy !== "EXPLICIT_RESIDUAL" ||
    method.order.length !== order.length ||
    method.order.some((step, index) => step !== order[index])
  )
    return failure("VERSION_MISMATCH");
  if (
    Object.keys(baseline.binding).some(
      (key) =>
        baseline.binding[key as keyof typeof baseline.binding] !==
        current.binding[key as keyof typeof current.binding],
    )
  )
    return failure("SCOPE_MISMATCH");
  if (
    baseline.definitionVersion !== current.definitionVersion ||
    baseline.costPolicyVersion !== current.costPolicyVersion
  )
    return failure("VERSION_MISMATCH");
  if (!aligned(value)) return failure("WINDOW_MISMATCH");
  if (
    [baseline, current].some(
      (period) => new Set(period.skus.map((row) => row.externalSkuId)).size !== period.skus.length,
    )
  )
    return failure("CONFLICT");
  return success(value);
}

function success<T>(value: T): MetricResult<T> {
  return { ok: true, value };
}
function failure<T>(code: MetricErrorCode): MetricResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return absolute(left);
}
function fraction(n: bigint, d = 1n): Fraction {
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
function plus(left: Fraction, right: Fraction): Fraction {
  return fraction(left.n * right.d + right.n * left.d, left.d * right.d);
}
function checked(value: bigint, deps: Dependencies): MetricResult<number> {
  if (value > maximum || value < -maximum) return failure("OVERFLOW");
  return deps.math.add([Number(value)]);
}
function rounded(value: Fraction, mode: MinorRounding, deps: Dependencies): MetricResult<number> {
  let quotient = value.n / value.d;
  if (mode === "HALF_AWAY_FROM_ZERO" && absolute(value.n % value.d) * 2n >= value.d)
    quotient += value.n < 0n ? -1n : 1n;
  return checked(quotient, deps);
}
function revenue(rows: readonly ProfitSkuAggregate[]): Revenue {
  return rows.reduce(
    (sum, row) => ({
      quantity: sum.quantity + BigInt(row.units!),
      revenue: sum.revenue + BigInt(row.grossMinor!) - BigInt(row.discountMinor!),
    }),
    { quantity: 0n, revenue: 0n },
  );
}
function weightedCurrent(input: ProfitDeltaRequest): Fraction {
  const current = new Map(input.current.skus.map((row) => [row.externalSkuId, row]));
  return input.baseline.skus.reduce((sum, before) => {
    if (before.units === 0) return sum;
    const after = current.get(before.externalSkuId);
    if (!after || !after.units) throw new TypeError("Unvalidated current SKU price");
    return plus(
      sum,
      fraction(
        BigInt(before.units!) * (BigInt(after.grossMinor!) - BigInt(after.discountMinor!)),
        BigInt(after.units),
      ),
    );
  }, fraction(0n));
}
function revenueEffect(input: ProfitDeltaRequest, kind: ProfitDeltaComponent): Fraction {
  const quantity0 = input.baseline.skus.reduce((sum, row) => sum + BigInt(row.units!), 0n);
  const quantity1 = input.current.skus.reduce((sum, row) => sum + BigInt(row.units!), 0n);
  if (kind === "VOLUME")
    return fraction((quantity1 - quantity0) * revenue(input.baseline.skus).revenue, quantity0);
  const weighted = weightedCurrent(input);
  const counterfactual = fraction(quantity1 * weighted.n, quantity0 * weighted.d);
  if (kind === "PRICE_DISCOUNT")
    return plus(
      counterfactual,
      fraction(-quantity1 * revenue(input.baseline.skus).revenue, quantity0),
    );
  return plus(
    fraction(revenue(input.current.skus).revenue),
    fraction(-counterfactual.n, counterfactual.d),
  );
}
function total(period: ProfitPeriodAggregate, field: "cogsMinor" | "advertisingMinor") {
  return period.skus.reduce((sum, row) => sum + BigInt(row[field]!), 0n);
}
function periods(input: ProfitDeltaRequest): readonly ProfitPeriodAggregate[] {
  return [input.baseline, input.current];
}
function issue(
  code: DataQualityIssueV1["code"],
  field: string,
  evidenceIds: readonly string[],
): DataQualityIssueV1 {
  return { code, field, evidenceIds: [...evidenceIds] };
}
function universeIssues(input: ProfitDeltaRequest): DataQualityIssueV1[] {
  const before = new Set(input.baseline.skus.map((row) => row.externalSkuId));
  const matched =
    before.size === input.current.skus.length &&
    input.current.skus.every((row) => before.has(row.externalSkuId));
  return periods(input).flatMap((period) =>
    !matched || period.quality.coverageBasisPoints < 10000
      ? [issue("PARTIAL_COVERAGE", "skus", period.quality.evidenceIds)]
      : [],
  );
}
function missing(
  row: ProfitSkuAggregate,
  fields: readonly (keyof ProfitSkuAggregate)[],
): DataQualityIssueV1[] {
  return fields
    .filter((field) => row[field] === null)
    .map((field) =>
      issue(
        field === "cogsMinor"
          ? "COST_MISSING"
          : field === "advertisingMinor"
            ? "FEE_MISSING"
            : "PARTIAL_COVERAGE",
        field,
        row.evidenceIds,
      ),
    );
}
function revenueIssues(
  input: ProfitDeltaRequest,
  kind: ProfitDeltaComponent,
): DataQualityIssueV1[] {
  const result = universeIssues(input);
  for (const period of periods(input))
    for (const row of period.skus) {
      result.push(...missing(row, ["units"]));
      const zeroBaselineWeight =
        kind === "PRICE_DISCOUNT" &&
        period === input.current &&
        input.baseline.skus.find((before) => before.externalSkuId === row.externalSkuId)?.units ===
          0;
      if (
        !zeroBaselineWeight &&
        ((period === input.baseline && kind !== "SKU_MIX") ||
          (period === input.current && kind !== "VOLUME"))
      )
        result.push(...missing(row, ["grossMinor", "discountMinor"]));
      if (row.units === 0 && ((row.grossMinor ?? 0) > 0 || (row.discountMinor ?? 0) > 0))
        result.push(issue("SOURCE_INCONSISTENT", "units", row.evidenceIds));
    }
  if (
    input.baseline.skus.every((row) => row.units !== null) &&
    input.baseline.skus.reduce((sum, row) => sum + BigInt(row.units!), 0n) === 0n
  )
    result.push(issue("ZERO_DENOMINATOR", "baseline.units", input.baseline.quality.evidenceIds));
  if (kind !== "VOLUME")
    for (const row of input.baseline.skus) {
      const after = input.current.skus.find(
        (candidate) => candidate.externalSkuId === row.externalSkuId,
      );
      if (row.units !== null && row.units > 0 && after?.units === 0)
        result.push(issue("ZERO_DENOMINATOR", "current.units", after.evidenceIds));
    }
  return result;
}
function componentIssues(
  input: ProfitDeltaRequest,
  kind: ProfitDeltaComponent,
): DataQualityIssueV1[] {
  if (kind !== "COGS" && kind !== "ADVERTISING") return revenueIssues(input, kind);
  const field = kind === "COGS" ? "cogsMinor" : "advertisingMinor";
  return periods(input).flatMap((period) =>
    period.skus.flatMap((row) => {
      const result = missing(row, [field]);
      if (
        field === "cogsMinor" &&
        row.cogsMinor !== null &&
        row.cogsMinor !== 0 &&
        row.frozenCostVersions.length === 0
      )
        result.push(issue("COST_MISSING", field, row.evidenceIds));
      return result;
    }),
  );
}
const precedence: readonly MetricStatus[] = [
  "UNAVAILABLE",
  "STALE",
  "INSUFFICIENT",
  "ESTIMATED",
  "VERIFIED",
];
function qualityFor(
  input: ProfitDeltaRequest,
  extra: readonly DataQualityIssueV1[],
): MetricQuality {
  const sources = periods(input).map((period) => period.quality);
  const status =
    extra.length > 0
      ? "UNAVAILABLE"
      : precedence.find((candidate) => sources.some((source) => source.status === candidate))!;
  const issues = [...sources.flatMap((source) => source.issues), ...extra];
  const evidenceIds = [
    ...new Set([
      ...sources.flatMap((source) => source.evidenceIds),
      ...periods(input).flatMap((period) => period.skus.flatMap((row) => row.evidenceIds)),
    ]),
  ].sort();
  return {
    status,
    sampleSize: Math.min(...sources.map((source) => source.sampleSize)),
    coverageBasisPoints: Math.min(...sources.map((source) => source.coverageBasisPoints)),
    evidenceIds,
    issues: structuredClone(issues),
  };
}
type Component = ProfitDeltaMetrics["components"][number];
function component(
  input: ProfitDeltaRequest,
  kind: ProfitDeltaComponent,
  deps: Dependencies,
): MetricResult<Component> {
  const quality = qualityFor(input, componentIssues(input, kind));
  if (quality.status === "UNAVAILABLE") return success({ kind, amountMinor: null, quality });
  const field = kind === "COGS" ? "cogsMinor" : "advertisingMinor";
  const amount =
    kind === "COGS" || kind === "ADVERTISING"
      ? checked(total(input.baseline, field) - total(input.current, field), deps)
      : rounded(revenueEffect(input, kind), input.method.rounding, deps);
  return amount.ok ? success({ kind, amountMinor: amount.value, quality }) : amount;
}
function profitDelta(
  input: ProfitDeltaRequest,
  deps: Dependencies,
): MetricResult<ProfitDeltaMetrics["delta"]> {
  const extra = periods(input)
    .filter((period) => period.profitMinor === null)
    .map((period) => issue("PARTIAL_COVERAGE", "profitMinor", period.quality.evidenceIds));
  const quality = qualityFor(input, extra);
  if (quality.status === "UNAVAILABLE")
    return success({ metric: { kind: "PROFIT_DELTA", unit: "minorCNY", value: null }, quality });
  const amount = deps.math.subtract(input.current.profitMinor!, input.baseline.profitMinor!);
  return amount.ok
    ? success({ metric: { kind: "PROFIT_DELTA", unit: "minorCNY", value: amount.value }, quality })
    : amount;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function aggregateLimits(input: ProfitDeltaRequest, deps: Dependencies): MetricResult<null> {
  const fields = [
    "units",
    "grossMinor",
    "discountMinor",
    "netRevenueMinor",
    "cogsMinor",
    "advertisingMinor",
  ] as const;
  for (const period of periods(input))
    for (const field of fields) {
      if (period.skus.some((row) => row[field] === null)) continue;
      const sum = period.skus.reduce((amount, row) => amount + BigInt(row[field]!), 0n);
      const result = checked(sum, deps);
      if (!result.ok) return result;
    }
  return success(null);
}
function calculate(
  input: ProfitDeltaRequest,
  deps: Dependencies,
): MetricResult<ProfitDeltaMetrics> {
  const limits = aggregateLimits(input, deps);
  if (!limits.ok) return limits;
  const components: Component[] = [];
  for (const kind of order) {
    const result = component(input, kind, deps);
    if (!result.ok) return result;
    components.push(result.value);
  }
  const delta = profitDelta(input, deps);
  if (!delta.ok) return delta;
  let residual: MetricResult<number | null> = success(null);
  if (delta.value.metric.value !== null && components.every((part) => part.amountMinor !== null))
    residual = checked(
      BigInt(delta.value.metric.value) -
        components.reduce((sum, part) => sum + BigInt(part.amountMinor!), 0n),
      deps,
    );
  if (!residual.ok) return residual;
  return success(
    freeze({
      methodVersion: input.method.version,
      delta: delta.value,
      components,
      residualMinor: residual.value,
    }),
  );
}
export function createProfitDeltaAttribution(deps: Dependencies): ProfitDeltaAttributionV1 {
  return Object.freeze({
    calculate: (input: ProfitDeltaRequest) => {
      const validated = validation(input);
      return validated.ok ? calculate(validated.value, deps) : validated;
    },
  });
}
