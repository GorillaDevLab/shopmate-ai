import { types } from "node:util";
import type { SyncJob } from "@shopmate/database/sync-host";
import { sqlTime } from "./work.js";
const fields = [
  "id",
  "stream",
  "fence",
  "since",
  "until",
  "cursor",
  "status",
  "pageCount",
  "successfulThrough",
  "observedAt",
  "sourceWatermark",
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
  "provider",
  "generation",
] as const;
const metadata = [
  "grantId",
  "leaseOwner",
  "leaseUntil",
  "failureCode",
  "leaseBackendPid",
  "leaseBackendStart",
  "receiptCursor",
  "receivedThrough",
];
const identity = [
  "id",
  "stream",
  "since",
  "until",
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
  "provider",
  "generation",
] as const;
function invalid(condition: unknown): asserts condition {
  if (!condition) throw new Error("SYNC_RUN_RESULT_INVALID");
}
type LeaseAction = "CLAIM" | "RENEW" | "COMMIT" | "INPUT";
function jobFields(value: SyncJob): SyncJob {
  invalid(
    value &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
  const keys = Reflect.ownKeys(value),
    record: Record<string, unknown> = {};
  invalid(keys.length === fields.length || keys.length === fields.length + metadata.length);
  for (const key of keys) {
    invalid(typeof key === "string" && [...fields, ...metadata].includes(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invalid(descriptor && "value" in descriptor && descriptor.enumerable);
    record[key] = descriptor.value;
  }
  for (const key of fields) invalid(Object.hasOwn(record, key));
  return Object.fromEntries(fields.map((key) => [key, record[key]])) as unknown as SyncJob;
}
function progress(job: SyncJob): void {
  invalid(Number.isInteger(job.fence) && job.fence >= 0 && job.fence <= 2147483647);
  invalid(Number.isInteger(job.pageCount) && job.pageCount >= 0 && job.pageCount <= 2147483647);
  invalid(
    job.cursor === null ||
      (typeof job.cursor === "string" &&
        job.cursor.length > 0 &&
        Buffer.byteLength(job.cursor) <= 1024 &&
        !/[\p{Cc}\p{Cs}]/u.test(job.cursor)),
  );
  invalid(
    typeof job.status === "string" &&
      ["READY", "RUNNING", "FAILED", "SUCCEEDED"].includes(job.status),
  );
  invalid(job.sourceWatermark === null || job.sourceWatermark <= job.until);
  invalid(job.successfulThrough === null || job.successfulThrough <= job.until);
}
function transition(job: SyncJob, expected: SyncJob, action: LeaseAction): void {
  if (action !== "INPUT") invalid(job.fence === expected.fence + (action === "CLAIM" ? 1 : 0));
  if (action === "CLAIM" || action === "RENEW")
    invalid(
      job.status === "RUNNING" &&
        job.cursor === expected.cursor &&
        job.pageCount === expected.pageCount,
    );
  if (action === "COMMIT")
    invalid(
      ["RUNNING", "SUCCEEDED"].includes(job.status) && job.pageCount === expected.pageCount + 1,
    );
}
export function checkedJob(value: SyncJob, expected: SyncJob, action: LeaseAction): SyncJob {
  const result = jobFields(value);
  const normalized = {
    ...result,
    since: sqlTime(result.since),
    until: sqlTime(result.until),
    successfulThrough: time(result.successfulThrough),
    observedAt: time(result.observedAt),
    sourceWatermark: time(result.sourceWatermark),
  };
  invalid(identity.every((key) => normalized[key] === expected[key]));
  progress(normalized);
  transition(normalized, expected, action);
  return Object.freeze(normalized);
}
function time(value: unknown): string | null {
  return value === null ? null : sqlTime(value);
}
