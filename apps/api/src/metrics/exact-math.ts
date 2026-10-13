import type {
  BasisPointRatio,
  ExactMinorMath,
  MetricResult,
  MinorAllocation,
  MinorAllocationWeight,
  MinorRounding,
} from "@shopmate/contracts";

/** Policy v1: safe inputs, checked prefixes, signed exact rounding and error-ranked allocation. */
export const EXACT_MINOR_MATH_VERSION = 1;

const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function failure<T>(code: "INVALID_INPUT" | "OVERFLOW"): MetricResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}

function success<T>(value: T): MetricResult<T> {
  return { ok: true, value };
}

function safeRange(value: bigint): boolean {
  return value >= -MAX_MINOR && value <= MAX_MINOR;
}

function checkedNumber(value: bigint): MetricResult<number> {
  return safeRange(value) ? success(Number(value)) : failure("OVERFLOW");
}

function validIntegers(values: readonly number[]): boolean {
  if (!Array.isArray(values)) return false;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return false;
  }
  return true;
}

function validRounding(rounding: MinorRounding): boolean {
  return rounding === "HALF_AWAY_FROM_ZERO" || rounding === "TOWARD_ZERO";
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function roundQuotient(numerator: bigint, denominator: bigint, rounding: MinorRounding): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (rounding === "TOWARD_ZERO" || absolute(remainder) * 2n < absolute(denominator)) {
    return quotient;
  }
  return quotient + (numerator < 0n !== denominator < 0n ? -1n : 1n);
}

export function add(values: readonly number[]): MetricResult<number> {
  if (!validIntegers(values)) return failure("INVALID_INPUT");
  let total = 0n;
  for (const value of values) {
    total += BigInt(value);
    if (!safeRange(total)) return failure("OVERFLOW");
  }
  return success(Number(total));
}

export function subtract(leftMinor: number, rightMinor: number): MetricResult<number> {
  if (!validIntegers([leftMinor, rightMinor])) return failure("INVALID_INPUT");
  return checkedNumber(BigInt(leftMinor) - BigInt(rightMinor));
}

export function multiply(amountMinor: number, quantity: number): MetricResult<number> {
  if (!validIntegers([amountMinor, quantity]) || quantity < 0) return failure("INVALID_INPUT");
  return checkedNumber(BigInt(amountMinor) * BigInt(quantity));
}

export function ratio(
  numerator: number,
  denominator: number,
  rounding: MinorRounding,
): MetricResult<BasisPointRatio> {
  if (!validIntegers([numerator, denominator]) || !validRounding(rounding)) {
    return failure("INVALID_INPUT");
  }
  if (denominator === 0) return success({ value: null, reason: "ZERO_DENOMINATOR" });
  const result = checkedNumber(
    roundQuotient(BigInt(numerator) * 10000n, BigInt(denominator), rounding),
  );
  return result.ok ? success({ value: result.value, reason: null }) : result;
}

interface ExactShare {
  readonly key: string;
  readonly weight: bigint;
  readonly error: bigint;
  amount: bigint;
}

function validWeights(weights: readonly MinorAllocationWeight[]): boolean {
  if (!Array.isArray(weights) || weights.length === 0) return false;
  const keys = new Set<string>();
  let hasPositiveWeight = false;
  for (const item of weights) {
    if (typeof item !== "object" || item === null) return false;
    if (typeof item.key !== "string" || item.key.trim().length === 0 || keys.has(item.key)) {
      return false;
    }
    if (!Number.isSafeInteger(item.weight) || item.weight < 0) return false;
    keys.add(item.key);
    hasPositiveWeight ||= item.weight > 0;
  }
  return hasPositiveWeight;
}

function weightedShare(
  amount: bigint,
  item: MinorAllocationWeight,
  totalWeight: bigint,
  rounding: MinorRounding,
): ExactShare {
  const weight = BigInt(item.weight);
  const numerator = amount * weight;
  const rounded = roundQuotient(numerator, totalWeight, rounding);
  return { key: item.key, weight, amount: rounded, error: numerator - rounded * totalWeight };
}

function compareShares(left: ExactShare, right: ExactShare, direction: bigint): number {
  if (left.error !== right.error)
    return left.error > right.error ? -Number(direction) : Number(direction);
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * Round exact quotas first, then correct the signed residual by rounding error:
 * positive residual favors underallocated shares; negative favors overallocated.
 * Errors share one exact denominator; ties use ascending UTF-16 key order.
 * Each positive-weight share needs at most one unit; zero weights are excluded.
 */
function reconcileShares(shares: readonly ExactShare[], amount: bigint): void {
  let residual = amount - shares.reduce((total, share) => total + share.amount, 0n);
  const direction = residual < 0n ? -1n : 1n;
  const candidates = shares.filter((share) => share.weight > 0n);
  candidates.sort((left, right) => compareShares(left, right, direction));
  for (const share of candidates) {
    if (residual === 0n) break;
    share.amount += direction;
    residual -= direction;
  }
}

export function allocate(
  amountMinor: number,
  weights: readonly MinorAllocationWeight[],
  rounding: MinorRounding,
): MetricResult<readonly MinorAllocation[]> {
  if (!Number.isSafeInteger(amountMinor) || !validWeights(weights) || !validRounding(rounding)) {
    return failure("INVALID_INPUT");
  }
  const amount = BigInt(amountMinor);
  const totalWeight = weights.reduce((total, item) => total + BigInt(item.weight), 0n);
  const shares = weights.map((item) => weightedShare(amount, item, totalWeight, rounding));
  reconcileShares(shares, amount);
  if (shares.some((share) => !safeRange(share.amount))) return failure("OVERFLOW");
  return success(shares.map((share) => ({ key: share.key, amountMinor: Number(share.amount) })));
}

/** Pure policy-v1 currency arithmetic; no clocks, sources or runtime dependencies. */
export const exactMinorMath: ExactMinorMath = { add, subtract, multiply, ratio, allocate };
