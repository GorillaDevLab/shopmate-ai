import { expect, it } from "vitest";
import { projectSyncWork } from "./work.js";
import { context, rawWork } from "../test/work-fixtures.js";
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
it("rejects hostile nested status without calling conversion hooks", () => {
  let calls = 0;
  const raw = rawWork();
  Object.assign(raw.jobs[0]!, {
    status: {
      toString() {
        calls++;
        return "READY";
      },
    },
  });
  expect(() => projectSyncWork(raw, context)).toThrow("SYNC_WORK_INVALID");
  expect(calls).toBe(0);
});
it("normalizes all freshness timestamps and six-digit backend starts", () => {
  const raw = rawWork();
  Object.assign(raw.jobs[0]!, {
    successfulThrough: "2026-01-02T00:00:00",
    observedAt: "2026-01-02T00:00:00+00:00",
    sourceWatermark: "2026-01-02T00:00:00.000+00:00",
    leaseBackendStart: "2026-01-01T00:00:00.123456+00:00",
  });
  const job = projectSyncWork(raw, context).jobs[0]!;
  expect([job.successfulThrough, job.observedAt, job.sourceWatermark]).toEqual(
    Array(3).fill("2026-01-02T00:00:00.000Z"),
  );
});
it("accepts exactly five unique stream slots and rejects extra slots, symbols and oversized cursors", () => {
  const raw = rawWork();
  raw.jobs = ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"].map((stream) => ({
    ...raw.jobs[0]!,
    stream,
  }));
  expect(projectSyncWork(raw, context).jobs).toHaveLength(5);
  raw.jobs.push(raw.jobs[0]!);
  expect(() => projectSyncWork(raw, context)).toThrow();
  const symbol = rawWork();
  Object.assign(symbol.grant, { [Symbol("secret")]: true });
  expect(() => projectSyncWork(symbol, context)).toThrow();
  const cursor = rawWork();
  Object.assign(cursor.jobs[0]!, { cursor: "x".repeat(1025) });
  expect(() => projectSyncWork(cursor, context)).toThrow();
});
