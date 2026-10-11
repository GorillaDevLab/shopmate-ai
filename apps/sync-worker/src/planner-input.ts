import { types } from "node:util";
import { ExternalIdSchema } from "@shopmate/contracts";
import type { SourceScope } from "@shopmate/database/mock-platform";
import { MAX_WINDOW_MS, SYNC_STREAMS } from "./planner-types.js";
import type {
  LatestWindowJob,
  WindowBinding,
  WindowBootstrap,
  WindowPlannerInput,
  VerifiedWindowPublication,
} from "./planner-types.js";

function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new Error("SYNC_PLAN_INPUT_INVALID");
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !types.isProxy(value));
  requireInput(Object.getPrototypeOf(value) === Object.prototype);
  const actual = Reflect.ownKeys(value);
  requireInput(
    actual.length === keys.length &&
      actual.every((key) => typeof key === "string" && keys.includes(key)),
  );
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireInput(descriptor && "value" in descriptor && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  return result;
}
function id(value: unknown): string {
  requireInput(
    typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(value),
  );
  return value;
}
function utc(value: unknown): string {
  requireInput(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      !value.startsWith("0000"),
  );
  requireInput(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  requireInput(typeof value === "string" && allowed.includes(value as T));
  return value as T;
}
const scopeKeys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "sessionId",
  "connectionId",
  "externalStoreId",
  "generation",
] as const;
function scope(value: unknown): SourceScope {
  const record = fields(value, scopeKeys);
  requireInput(
    typeof record.generation === "number" &&
      Number.isInteger(record.generation) &&
      record.generation >= 0 &&
      record.generation <= 2147483647,
  );
  requireInput(
    typeof record.externalStoreId === "string" &&
      record.externalStoreId.length <= 200 &&
      ExternalIdSchema.safeParse(record.externalStoreId).success,
  );
  return {
    organizationId: id(record.organizationId),
    workspaceId: id(record.workspaceId),
    storeId: id(record.storeId),
    sessionId: id(record.sessionId),
    connectionId: id(record.connectionId),
    externalStoreId: record.externalStoreId,
    generation: record.generation,
  };
}
function binding(value: unknown): WindowBinding {
  const record = fields(value, ["grantId", "provider", "scope", "initialSince"]);
  return {
    grantId: id(record.grantId),
    provider: oneOf(record.provider, ["MOCK"]),
    scope: scope(record.scope),
    initialSince: utc(record.initialSince),
  };
}
function bootstrap(value: unknown): WindowBootstrap {
  const record = fields(value, ["scope", "businessNow", "state"]);
  return {
    scope: scope(record.scope),
    businessNow: utc(record.businessNow),
    state: oneOf(record.state, ["WAITING_RUNTIME", "READY"]),
  };
}
function publication(value: unknown): VerifiedWindowPublication | null {
  if (value === null) return null;
  const record = fields(value, ["scope", "targetTime", "processedThrough"]);
  const result = {
    scope: scope(record.scope),
    targetTime: utc(record.targetTime),
    processedThrough: utc(record.processedThrough),
  };
  requireInput(result.processedThrough <= result.targetTime);
  return result;
}
function job(value: unknown): LatestWindowJob {
  const record = fields(value, [
    "grantId",
    "provider",
    "scope",
    "stream",
    "since",
    "until",
    "status",
  ]);
  const result = {
    grantId: id(record.grantId),
    provider: oneOf(record.provider, ["MOCK"]),
    scope: scope(record.scope),
    stream: oneOf(record.stream, SYNC_STREAMS),
    since: utc(record.since),
    until: utc(record.until),
    status: oneOf(record.status, ["READY", "RUNNING", "FAILED", "SUCCEEDED"]),
  };
  requireInput(
    result.since < result.until &&
      Date.parse(result.until) - Date.parse(result.since) <= MAX_WINDOW_MS,
  );
  return result;
}
function jobs(value: unknown): LatestWindowJob[] {
  requireInput(
    typeof value === "object" && value !== null && !types.isProxy(value) && Array.isArray(value),
  );
  requireInput(Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  requireInput(
    typeof length === "number" &&
      length >= 0 &&
      length <= 5 &&
      Reflect.ownKeys(value).length === length + 1,
  );
  const result: LatestWindowJob[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireInput(descriptor && "value" in descriptor && descriptor.enumerable);
    result.push(job(descriptor.value));
  }
  requireInput(new Set(result.map((item) => item.stream)).size === result.length);
  return result;
}
export function sameScope(left: SourceScope, right: SourceScope): boolean {
  return scopeKeys.every((key) => left[key] === right[key]);
}
export function readWindowPlannerInput(value: unknown): WindowPlannerInput {
  const record = fields(value, ["binding", "bootstrap", "publication", "latestJobs"]);
  return {
    binding: binding(record.binding),
    bootstrap: bootstrap(record.bootstrap),
    publication: publication(record.publication),
    latestJobs: jobs(record.latestJobs),
  };
}
