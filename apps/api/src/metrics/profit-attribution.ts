import type {
  ExactMinorMath,
  MetricErrorCode,
  MetricQuality,
  MetricResult,
  MinorRounding,
  ProfitDeltaAttributionV1,
  ProfitDeltaComponent,
  ProfitDeltaMetrics,
  ProfitDeltaRequest,
  ProfitPeriodAggregate,
  ProfitSkuAggregate,
} from "@shopmate/contracts";

export const PROFIT_DELTA_METHOD_VERSION = "profit-delta-sequential-v1";
const order = ["VOLUME", "PRICE_DISCOUNT", "SKU_MIX", "COGS", "ADVERTISING"] as const;
type Dependencies = Readonly<{ math: ExactMinorMath }>;
type Fraction = Readonly<{ n: bigint; d: bigint }>;
type Revenue = Readonly<{ quantity: bigint; revenue: bigint }>;
const maximum = BigInt(Number.MAX_SAFE_INTEGER);

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
  return Object.freeze({ calculate: (input: ProfitDeltaRequest) => calculate(input, deps) });
}
