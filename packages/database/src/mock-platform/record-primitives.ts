import { SourceStorageError } from "./errors.js";
import { exact, externalId } from "./validation.js";

export function requireInput(valid: unknown): asserts valid {
  if (!valid) throw new SourceStorageError("SOURCE_INPUT");
}
export function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireInput(exact(value, keys));
  return value;
}
export function validateUInt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
export function positiveUInt(value: unknown): value is string {
  return validateUInt(value) && value !== "0";
}
export function incrementUInt(value: string): string {
  if (!validateUInt(value) || value === "9223372036854775807")
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return String(BigInt(value) + 1n);
}
export function validateDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function validateUtc(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value)
  )
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
export function representable(value: string): boolean {
  return !/[\ud800-\udfff]/u.test(value) && !value.includes("\u0000");
}
export function id(value: unknown): value is string {
  return externalId(value) && representable(value) && Buffer.byteLength(value, "utf8") <= 200;
}
export function text(value: unknown, max = 5000): value is string {
  /* eslint-disable no-control-regex -- Text excludes hidden controls but permits tab and LF. */
  return (
    typeof value === "string" &&
    value.length > 0 &&
    representable(value) &&
    value.trim() === value &&
    value.normalize("NFC") === value &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
  /* eslint-enable no-control-regex */
}
export function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function nullable(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === null || guard(value);
}
export function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
export function list(value: unknown, min = 0, max = 500): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max;
}
export function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}
