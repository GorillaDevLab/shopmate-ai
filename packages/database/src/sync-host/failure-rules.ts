import { types } from "node:util";
import { MockReadFailureRulesSchema, type MockReadFailureRule } from "@shopmate/contracts";
import { readRuntimeBootstrap, type SyncRuntimeBootstrap } from "./bootstrap.js";

export interface SyncRuntimeFailureRules {
  readonly context: SyncRuntimeBootstrap;
  readonly rules: readonly MockReadFailureRule[];
}

function ruleJson(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 200;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 40) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      Boolean(descriptor && "value" in descriptor && ruleJson(descriptor.value, depth + 1))
    );
  });
}

export function readRuntimeFailureRules(value: unknown): SyncRuntimeFailureRules | null {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("SYNC_RESULT_INVALID");
  const contextField = Object.getOwnPropertyDescriptor(value, "context");
  const rulesField = Object.getOwnPropertyDescriptor(value, "rules");
  if (
    Reflect.ownKeys(value).length !== 2 ||
    !contextField ||
    !("value" in contextField) ||
    !rulesField ||
    !("value" in rulesField) ||
    !ruleJson(rulesField.value)
  )
    throw new Error("SYNC_RESULT_INVALID");
  const context = readRuntimeBootstrap(contextField.value);
  const rules = MockReadFailureRulesSchema.safeParse(rulesField.value);
  if (!context || !rules.success) throw new Error("SYNC_RESULT_INVALID");
  return Object.freeze({ context, rules: rules.data });
}
