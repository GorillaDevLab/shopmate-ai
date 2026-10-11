import { describe, expect, it } from "vitest";
import type { SyncRuntimeBootstrap } from "@shopmate/database/sync-host";
import { projectSyncWork } from "./work.js";
export const context = {
  grantId: "grant-a",
  principalUserId: "user-a",
  provider: "MOCK",
  scope: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "ext-a",
    sessionId: "session-a",
    generation: 1,
  },
  initialSince: "2026-01-01T00:00:00.000Z",
} as SyncRuntimeBootstrap;
export function rawWork() {
  const binding = {
    organizationId: context.scope.organizationId,
    workspaceId: context.scope.workspaceId,
    storeId: context.scope.storeId,
    connectionId: context.scope.connectionId,
    externalStoreId: context.scope.externalStoreId,
    generation: context.scope.generation,
  };
  const grant = {
    ...binding,
    provider: "MOCK",
    id: context.grantId,
    principalUserId: context.principalUserId,
    databaseRole: "worker_role",
    status: "ACTIVE",
    initialSince: "2026-01-01T00:00:00",
  };
  const job = {
    ...binding,
    provider: "MOCK",
    id: "job-a",
    grantId: grant.id,
    stream: "PRODUCTS",
    since: grant.initialSince,
    until: "2026-01-02T00:00:00.000Z",
    status: "READY",
    cursor: null,
    successfulThrough: null,
    fence: 0,
    leaseOwner: null,
    leaseUntil: null,
    failureCode: null,
    leaseBackendPid: null,
    leaseBackendStart: null,
    receiptCursor: null,
    receivedThrough: null,
    observedAt: null,
    sourceWatermark: null,
    pageCount: 0,
  };
  return { grant, jobs: [job] };
}
describe("strict SQL work projection", () => {
  it("canonicalizes SQL timestamps and attaches only the checked session", () => {
    const work = projectSyncWork(rawWork(), context);
    expect(work.jobs[0]?.since).toBe(context.initialSince);
    expect(work.latestJobs[0]?.scope.sessionId).toBe("session-a");
    expect(Object.isFrozen(work.jobs[0])).toBe(true);
  });
  it.each([
    "organizationId",
    "workspaceId",
    "storeId",
    "connectionId",
    "externalStoreId",
    "provider",
    "generation",
  ])("rejects foreign %s", (key) => {
    const raw = rawWork();
    Object.assign(raw.jobs[0]!, { [key]: "foreign" });
    expect(() => projectSyncWork(raw, context)).toThrow("SYNC_WORK_INVALID");
  });
  it("rejects grant principal and initialSince mismatches", () => {
    const raw = rawWork();
    raw.grant.principalUserId = "other";
    expect(() => projectSyncWork(raw, context)).toThrow();
    raw.grant.principalUserId = context.principalUserId;
    raw.grant.initialSince = "2026-01-01T01:00:00";
    expect(() => projectSyncWork(raw, context)).toThrow();
  });
  it("rejects proxies and accessors without evaluating them", () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          return [];
        },
      },
    );
    expect(() => projectSyncWork(proxy, context)).toThrow();
    const raw = rawWork();
    Object.defineProperty(raw.jobs[0], "cursor", {
      get() {
        calls++;
        return null;
      },
      enumerable: true,
    });
    expect(() => projectSyncWork(raw, context)).toThrow();
    expect(calls).toBe(0);
  });
  it("rejects extra metadata, duplicate streams, malformed freshness and sparse arrays", () => {
    const raw = rawWork();
    Object.assign(raw.grant, { sessionId: "forged" });
    expect(() => projectSyncWork(raw, context)).toThrow();
    const duplicate = rawWork();
    duplicate.jobs.push(duplicate.jobs[0]!);
    expect(() => projectSyncWork(duplicate, context)).toThrow();
    const bad = rawWork();
    Object.assign(bad.jobs[0]!, { observedAt: "2026-02-30T00:00:00Z" });
    expect(() => projectSyncWork(bad, context)).toThrow();
    expect(() => projectSyncWork({ ...rawWork(), jobs: Array(2) }, context)).toThrow();
  });
});
