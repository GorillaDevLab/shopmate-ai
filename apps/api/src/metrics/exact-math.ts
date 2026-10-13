import type { BasisPointRatio, MetricResult, MinorRounding } from "@shopmate/contracts";

/** Policy v1: safe integer inputs, checked prefixes, explicit signed exact rounding. */
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
