import { types } from "node:util";
import { ExternalIdSchema } from "@shopmate/contracts";
import type { SyncRuntimeBootstrap, SyncJob } from "@shopmate/database/sync-host";
import {
  MAX_WINDOW_MS,
  SYNC_STREAMS,
  type WindowBinding,
  type LatestWindowJob,
} from "./planner-types.js";
const bindingKeys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
  "provider",
  "generation",
] as const;
const grantKeys = [
  "id",
  "databaseRole",
  "principalUserId",
  ...bindingKeys,
  "initialSince",
  "status",
];
const jobKeys = [
  "id",
  "grantId",
  ...bindingKeys,
  "stream",
  "since",
  "until",
  "cursor",
  "successfulThrough",
  "status",
  "fence",
  "leaseOwner",
  "leaseUntil",
  "failureCode",
  "leaseBackendPid",
  "leaseBackendStart",
  "receiptCursor",
  "receivedThrough",
  "observedAt",
  "sourceWatermark",
  "pageCount",
];
export function workAssert(value: unknown): asserts value {
  if (!value) throw new Error("SYNC_WORK_INVALID");
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  workAssert(value && typeof value === "object" && !types.isProxy(value));
  workAssert(Object.getPrototypeOf(value) === Object.prototype);
  const actual = Reflect.ownKeys(value);
  workAssert(
    actual.length === keys.length &&
      actual.every((key) => typeof key === "string" && keys.includes(key)),
  );
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    workAssert(descriptor && "value" in descriptor && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  return result;
}
function id(value: unknown): string {
  workAssert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(value));
  return value;
}
function integer(value: unknown, min = 0): number {
  workAssert(
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= 2147483647,
  );
  return value;
}
export function sqlTime(value: unknown, microseconds = false): string {
  workAssert(typeof value === "string");
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)?$/u.exec(
    value,
  );
  workAssert(match && !value.startsWith("0000") && (microseconds || (match[3]?.length ?? 0) <= 3));
  const canonical = `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  workAssert(
    Number.isFinite(Date.parse(canonical)) && new Date(canonical).toISOString() === canonical,
  );
  return canonical;
}
function nullableTime(value: unknown, microseconds = false): string | null {
  return value === null ? null : sqlTime(value, microseconds);
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  workAssert(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 1024 &&
      !/[\p{Cc}\p{Cs}]/u.test(value),
  );
  return value;
}
function checkBinding(record: Record<string, unknown>, checked: SyncRuntimeBootstrap): void {
  workAssert(checked.provider === "MOCK" && record.provider === checked.provider);
  for (const key of bindingKeys) {
    const expected = key === "provider" ? checked.provider : checked.scope[key];
    workAssert(record[key] === expected);
    if (!["generation", "provider", "externalStoreId"].includes(key)) id(record[key]);
  }
  integer(record.generation);
  workAssert(
    typeof record.externalStoreId === "string" &&
      record.externalStoreId.length <= 200 &&
      ExternalIdSchema.safeParse(record.externalStoreId).success,
  );
}
function checkGrant(raw: unknown, checked: SyncRuntimeBootstrap): void {
  const grant = fields(raw, grantKeys);
  checkBinding(grant, checked);
  workAssert(
    id(grant.id) === checked.grantId && id(grant.principalUserId) === checked.principalUserId,
  );
  workAssert(
    typeof grant.databaseRole === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(grant.databaseRole),
  );
  workAssert(grant.status === "ACTIVE" && sqlTime(grant.initialSince) === checked.initialSince);
}
function checkMetadata(record: Record<string, unknown>): void {
  if (record.leaseOwner !== null) id(record.leaseOwner);
  nullableTime(record.leaseUntil);
  nullableTime(record.leaseBackendStart, true);
  if (record.leaseBackendPid !== null) integer(record.leaseBackendPid, 1);
  workAssert(
    record.failureCode === null ||
      (typeof record.failureCode === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/u.test(record.failureCode)),
  );
  cursor(record.receiptCursor);
  nullableTime(record.receivedThrough);
}
function readJob(raw: unknown, checked: SyncRuntimeBootstrap): SyncJob {
  const record = fields(raw, jobKeys);
  checkBinding(record, checked);
  checkMetadata(record);
  workAssert(
    id(record.grantId) === checked.grantId &&
      SYNC_STREAMS.includes(record.stream as SyncJob["stream"]),
  );
  workAssert(["READY", "RUNNING", "FAILED", "SUCCEEDED"].includes(String(record.status)));
  const since = sqlTime(record.since),
    until = sqlTime(record.until);
  workAssert(
    since >= checked.initialSince &&
      since < until &&
      Date.parse(until) - Date.parse(since) <= MAX_WINDOW_MS,
  );
  const result = {
    id: id(record.id),
    stream: record.stream as SyncJob["stream"],
    fence: integer(record.fence),
    since,
    until,
    cursor: cursor(record.cursor),
    status: record.status as SyncJob["status"],
    pageCount: integer(record.pageCount),
    successfulThrough: nullableTime(record.successfulThrough),
    observedAt: nullableTime(record.observedAt),
    sourceWatermark: nullableTime(record.sourceWatermark),
    organizationId: checked.scope.organizationId,
    workspaceId: checked.scope.workspaceId,
    storeId: checked.scope.storeId,
    connectionId: checked.scope.connectionId,
    externalStoreId: checked.scope.externalStoreId,
    provider: checked.provider,
    generation: checked.scope.generation,
  };
  workAssert(result.sourceWatermark === null || result.sourceWatermark <= until);
  workAssert(result.successfulThrough === null || result.successfulThrough <= until);
  return Object.freeze(result);
}
function readJobs(raw: unknown, checked: SyncRuntimeBootstrap): readonly SyncJob[] {
  workAssert(raw && typeof raw === "object" && !types.isProxy(raw) && Array.isArray(raw));
  workAssert(Object.getPrototypeOf(raw) === Array.prototype);
  const length: unknown = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  workAssert(
    typeof length === "number" && length <= 5 && Reflect.ownKeys(raw).length === length + 1,
  );
  const jobs: SyncJob[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    workAssert(descriptor && "value" in descriptor && descriptor.enumerable);
    jobs.push(readJob(descriptor.value, checked));
  }
  workAssert(new Set(jobs.map((job) => job.stream)).size === jobs.length);
  return Object.freeze(jobs);
}
export interface ProjectedSyncWork {
  readonly binding: WindowBinding;
  readonly jobs: readonly SyncJob[];
  readonly latestJobs: readonly LatestWindowJob[];
}
/** SQL supplies persisted identity; only the checked bootstrap can add a source session. */
export function projectSyncWork(raw: unknown, checked: SyncRuntimeBootstrap): ProjectedSyncWork {
  const record = fields(raw, ["grant", "jobs"]);
  checkGrant(record.grant, checked);
  const jobs = readJobs(record.jobs, checked),
    scope = Object.freeze({ ...checked.scope });
  const binding = Object.freeze({
    grantId: checked.grantId,
    provider: checked.provider,
    scope,
    initialSince: checked.initialSince,
  });
  const latestJobs = Object.freeze(
    jobs.map((job) =>
      Object.freeze({
        grantId: checked.grantId,
        provider: checked.provider,
        scope,
        stream: job.stream,
        since: job.since,
        until: job.until,
        status: job.status,
      }),
    ),
  );
  return Object.freeze({ binding, jobs, latestJobs });
}
