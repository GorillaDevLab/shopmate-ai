import { SourceStorageError } from "./errors.js";
import type { SourceReadActor, SourceScope, SourceWorkerActor } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
export const bindingKeys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
] as const;
export const scopeKeys = [...bindingKeys, "sessionId", "generation"] as const;
export function object(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
export function externalId(value: unknown): value is string {
  /* eslint-disable no-control-regex -- Matches the Connector namespace's hidden-character exclusions. */
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
  /* eslint-enable no-control-regex */
}
export function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
export function validateScope(value: unknown): asserts value is SourceScope {
  if (
    !exact(value, scopeKeys) ||
    !scopeKeys
      .filter((key) => !["externalStoreId", "generation"].includes(key))
      .every((key) => safeId(value[key])) ||
    !externalId(value.externalStoreId) ||
    !integer(value.generation, 0, 2147483647)
  )
    throw new SourceStorageError("SOURCE_INPUT");
}
export function validateReadActor(value: unknown): asserts value is SourceReadActor {
  if (!exact(value, ["userId", "merchantId"]) || !safeId(value.userId) || !safeId(value.merchantId))
    throw new SourceStorageError("SOURCE_INPUT");
}
export function validateWorkerActor(value: unknown): asserts value is SourceWorkerActor {
  if (!exact(value, ["grantId"]) || !safeId(value.grantId))
    throw new SourceStorageError("SOURCE_INPUT");
}
