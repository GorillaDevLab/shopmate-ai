import type { DemoActor, DemoSourceInput } from "./demo-commerce.types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
export const MAX_COUNTER = 2_147_483_647;
const MIN_CLOCK = Date.parse("0001-01-01T00:00:00.000Z");
const MAX_CLOCK = Date.parse("9999-12-31T23:59:59.999Z");

export function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function validActor(actor: DemoActor, storeId: unknown): boolean {
  return Boolean(actor && validId(actor.userId) && validId(actor.merchantId) && validId(storeId));
}

export function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_COUNTER;
}

export function validClock(value: unknown): value is Date {
  return value instanceof Date && value.getTime() >= MIN_CLOCK && value.getTime() <= MAX_CLOCK;
}

function strictJsonValue(_key: string, value: unknown): unknown {
  if (
    ["undefined", "function", "symbol", "bigint"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("Source config contains a non-JSON value");
  }
  return value;
}

export function sourceJson(input: DemoSourceInput): string | null {
  if (!input || !validClock(input.clockNow) || !validId(input.generatorVersion)) return null;
  if (typeof input.configHash !== "string" || !/^[0-9a-f]{64}$/u.test(input.configHash))
    return null;
  try {
    const json = JSON.stringify(input.config, strictJsonValue);
    return json && json.length <= 1_000_000 && json.startsWith("{") ? json : null;
  } catch {
    // Cyclic objects and unsupported JSON values are rejected before a database transaction.
    return null;
  }
}

export function matchesBinding(
  json: string,
  scope: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly storeId: string;
    readonly connectionId: string;
    readonly externalStoreId: string;
  },
): boolean {
  const config: unknown = JSON.parse(json);
  if (!config || typeof config !== "object" || !("binding" in config)) return false;
  const binding = config.binding;
  if (!binding || typeof binding !== "object") return false;
  return Object.entries(scope).every(
    ([key, value]) =>
      Object.hasOwn(binding, key) && (binding as Record<string, unknown>)[key] === value,
  );
}

export function isConstraintConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "P2002") return true;
  if (error.code !== "P2010" || !("meta" in error) || !error.meta || typeof error.meta !== "object")
    return false;
  if ("code" in error.meta) return ["23505", "23514", "23503"].includes(String(error.meta.code));
  if (!("driverAdapterError" in error.meta)) return false;
  const driver = error.meta.driverAdapterError;
  if (!driver || typeof driver !== "object" || !("cause" in driver)) return false;
  const cause = driver.cause;
  return Boolean(
    cause &&
      typeof cause === "object" &&
      "originalCode" in cause &&
      ["23505", "23514", "23503"].includes(String(cause.originalCode)),
  );
}
