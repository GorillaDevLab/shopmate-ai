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
    method.order.join(",") !== order.join(",")
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
      quantity: sum.quantity + BigInt(row.units ?? 0),
      revenue: sum.revenue + BigInt(row.grossMinor ?? 0) - BigInt(row.discountMinor ?? 0),
    }),
    { quantity: 0n, revenue: 0n },
  );
}
function weightedCurrent(input: ProfitDeltaRequest): Fraction {
  const current = new Map(input.current.skus.map((row) => [row.externalSkuId, row]));
  return input.baseline.skus.reduce((sum, before) => {
    if (before.units === 0) return sum;
    const after = current.get(before.externalSkuId);
    if (!after || !after.units) return sum;
    return plus(
      sum,
      fraction(
        BigInt(before.units ?? 0) *
          (BigInt(after.grossMinor ?? 0) - BigInt(after.discountMinor ?? 0)),
        BigInt(after.units),
      ),
    );
  }, fraction(0n));
}
function revenueEffects(input: ProfitDeltaRequest, deps: Dependencies): MetricResult<number[]> {
  const before = revenue(input.baseline.skus),
    after = revenue(input.current.skus);
  if (before.quantity === 0n) return failure("INVALID_INPUT");
  const weighted = weightedCurrent(input);
  const counterfactual = fraction(after.quantity * weighted.n, before.quantity * weighted.d);
  const volume = fraction((after.quantity - before.quantity) * before.revenue, before.quantity);
  const price = plus(counterfactual, fraction(-after.quantity * before.revenue, before.quantity));
  const mix = plus(fraction(after.revenue), fraction(-counterfactual.n, counterfactual.d));
  const result: number[] = [];
  for (const effect of [volume, price, mix]) {
    const value = rounded(effect, input.method.rounding, deps);
    if (!value.ok) return value;
    result.push(value.value);
  }
  return success(result);
}
function total(period: ProfitPeriodAggregate, field: "cogsMinor" | "advertisingMinor") {
  return period.skus.reduce((sum, row) => sum + BigInt(row[field] ?? 0), 0n);
}
function calculate(
  input: ProfitDeltaRequest,
  deps: Dependencies,
): MetricResult<ProfitDeltaMetrics> {
  const effects = revenueEffects(input, deps);
  if (!effects.ok) return effects;
  const values = [...effects.value];
  for (const field of ["cogsMinor", "advertisingMinor"] as const) {
    const value = checked(total(input.baseline, field) - total(input.current, field), deps);
    if (!value.ok) return value;
    values.push(value.value);
  }
  const delta = deps.math.subtract(input.current.profitMinor ?? 0, input.baseline.profitMinor ?? 0);
  if (!delta.ok) return delta;
  const residual = checked(
    BigInt(delta.value) - values.reduce((sum, value) => sum + BigInt(value), 0n),
    deps,
  );
  if (!residual.ok) return residual;
  return success({
    methodVersion: input.method.version,
    delta: {
      metric: { kind: "PROFIT_DELTA", unit: "minorCNY", value: delta.value },
      quality: copyQuality(input.current.quality),
    },
    components: order.map((kind: ProfitDeltaComponent, index) => ({
      kind,
      amountMinor: values[index]!,
      quality: copyQuality(input.current.quality),
    })),
    residualMinor: residual.value,
  });
}
function copyQuality(quality: MetricQuality): MetricQuality {
  return structuredClone(quality);
}
export function createProfitDeltaAttribution(deps: Dependencies): ProfitDeltaAttributionV1 {
  return Object.freeze({
    calculate: (input: ProfitDeltaRequest) => {
      const validated = validation(input);
      return validated.ok ? calculate(validated.value, deps) : validated;
    },
  });
}
