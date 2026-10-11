import { describe, expect, it, vi } from "vitest";
import { planSyncWindows } from "./planner.js";
const streams = ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"] as const;
const start = "2026-01-01T00:00:00.000Z";
const target = "2026-01-10T00:00:00.000Z";
const scope = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  sessionId: "session",
  connectionId: "connection",
  externalStoreId: "external",
  generation: 1,
};
function input() {
  return {
    binding: { grantId: "grant", provider: "MOCK", scope: { ...scope }, initialSince: start },
    bootstrap: { scope: { ...scope }, state: "READY", businessNow: target },
    publication: { scope: { ...scope }, targetTime: target, processedThrough: target },
    latestJobs: [] as ReturnType<typeof job>[],
  };
}
function job(stream: string = "PRODUCTS", status = "READY", since = start, until = target) {
  return { grantId: "grant", provider: "MOCK", scope: { ...scope }, stream, status, since, until };
}
function expectedWindows(since = start, until = target) {
  return streams.map((stream) => ({ stream, since, until }));
}
describe("common sync windows", () => {
  it("plans all five streams at the same verified target", () => {
    expect(planSyncWindows(input())).toEqual({
      status: "PLANNED",
      targetTime: target,
      frozen: false,
      windows: expectedWindows(),
      existingStreams: [],
    });
  });
  it.each(["2026-01-05T00:00:00.000Z", "2026-01-08T15:59:59.999Z"])(
    "uses actual UTC business clock %s",
    (businessNow) => {
      const value = input();
      value.bootstrap.businessNow = businessNow;
      expect(planSyncWindows(value)).toMatchObject({
        targetTime: businessNow,
        windows: expectedWindows(start, businessNow),
      });
    },
  );
  it("clamps all streams to 31 elapsed UTC days", () => {
    const value = input();
    value.bootstrap.businessNow =
      value.publication.targetTime =
      value.publication.processedThrough =
        "2026-04-01T00:00:00.000Z";
    expect(planSyncWindows(value)).toMatchObject({
      targetTime: "2026-02-01T00:00:00.000Z",
      windows: expectedWindows(start, "2026-02-01T00:00:00.000Z"),
    });
  });
  it("uses the lower publication coverage even when target is later", () => {
    const value = input();
    value.publication.processedThrough = "2026-01-04T00:00:00.000Z";
    expect(planSyncWindows(value)).toMatchObject({
      targetTime: value.publication.processedThrough,
    });
  });
  it("waits without publication", () => {
    expect(planSyncWindows({ ...input(), publication: null })).toEqual({
      status: "WAITING",
      reason: "WAITING_PUBLICATION",
      windows: [],
    });
  });
  it("waits for runtime even with publication", () => {
    const value = input();
    value.bootstrap.state = "WAITING_RUNTIME";
    expect(planSyncWindows(value)).toEqual({
      status: "WAITING",
      reason: "WAITING_RUNTIME",
      windows: [],
    });
  });
  it("waits when clock has no common forward progress", () => {
    const value = input();
    value.bootstrap.businessNow = start;
    expect(planSyncWindows(value)).toMatchObject({ status: "WAITING", windows: [] });
  });
  it("freezes a partially created batch when the clock advances", () => {
    const value = input();
    value.latestJobs = [job()];
    value.bootstrap.businessNow =
      value.publication.targetTime =
      value.publication.processedThrough =
        "2026-01-20T00:00:00.000Z";
    expect(planSyncWindows(value)).toEqual({
      status: "PLANNED",
      targetTime: target,
      frozen: true,
      windows: expectedWindows().slice(1),
      existingStreams: ["PRODUCTS"],
    });
  });
  it.each(["READY", "RUNNING", "FAILED"])("keeps %s jobs at their original target", (status) => {
    const value = input();
    value.latestJobs = streams.map((stream) => job(stream, status));
    expect(planSyncWindows(value)).toMatchObject({
      frozen: true,
      targetTime: target,
      windows: [],
      existingStreams: streams,
    });
  });
  it("skips finished streams while filling a partial batch", () => {
    const value = input();
    value.latestJobs = [job("PRODUCTS", "SUCCEEDED"), job("ORDERS")];
    expect(planSyncWindows(value)).toEqual({
      status: "PLANNED",
      targetTime: target,
      frozen: true,
      windows: expectedWindows().slice(2),
      existingStreams: ["ORDERS"],
    });
  });
  it("starts the next batch from durable received windows", () => {
    const value = input();
    value.latestJobs = streams.map((stream) => job(stream, "SUCCEEDED"));
    value.bootstrap.businessNow =
      value.publication.targetTime =
      value.publication.processedThrough =
        "2026-01-12T00:00:00.000Z";
    expect(planSyncWindows(value)).toMatchObject({
      frozen: false,
      windows: expectedWindows(target, "2026-01-12T00:00:00.000Z"),
    });
  });
  it.each(["clock", "publication"])("waits if %s no longer covers an active target", (kind) => {
    const value = input();
    value.latestJobs = [job()];
    if (kind === "clock") value.bootstrap.businessNow = start;
    else value.publication.processedThrough = start;
    expect(planSyncWindows(value)).toEqual({
      status: "WAITING",
      reason: "WAITING_COVERAGE",
      windows: [],
    });
  });
  it("clamps by the oldest needed stream when completed prefixes differ", () => {
    const value = input();
    value.latestJobs = [job("PRODUCTS", "SUCCEEDED")];
    value.bootstrap.businessNow =
      value.publication.targetTime =
      value.publication.processedThrough =
        "2026-03-01T00:00:00.000Z";
    expect(planSyncWindows(value)).toMatchObject({
      targetTime: "2026-02-01T00:00:00.000Z",
      windows: [
        { stream: "PRODUCTS", since: target, until: "2026-02-01T00:00:00.000Z" },
        ...expectedWindows(start, "2026-02-01T00:00:00.000Z").slice(1),
      ],
    });
  });
});
describe("closed normalized planner inputs", () => {
  it.each([
    "organizationId",
    "workspaceId",
    "storeId",
    "sessionId",
    "connectionId",
    "externalStoreId",
    "generation",
  ] as const)("rejects mismatching %s", (key) => {
    const value = input();
    const changed = { ...scope, [key]: key === "generation" ? 2 : "other" };
    for (const part of ["bootstrap", "publication"] as const)
      expect(() =>
        planSyncWindows({ ...value, [part]: { ...value[part], scope: changed } }),
      ).toThrow("SYNC_PLAN_CONFLICT");
    expect(() => planSyncWindows({ ...value, latestJobs: [{ ...job(), scope: changed }] })).toThrow(
      "SYNC_PLAN_CONFLICT",
    );
  });
  it.each([
    { ...job(), grantId: "other" },
    { ...job(), provider: "SHOPIFY" },
    job("UNKNOWN"),
    job("ORDERS", "DONE"),
    job("ORDERS", "READY", "2025-12-31T00:00:00.000Z"),
    job("ORDERS", "READY", target, start),
    job("ORDERS", "READY", start, "2026-02-02T00:00:00.000Z"),
  ])("rejects inconsistent latest job %#", (latest) => {
    expect(() => planSyncWindows({ ...input(), latestJobs: [latest] })).toThrow();
  });
  it("rejects disagreeing unfinished targets", () => {
    expect(() =>
      planSyncWindows({
        ...input(),
        latestJobs: [job(), job("ORDERS", "READY", start, "2026-01-11T00:00:00.000Z")],
      }),
    ).toThrow("SYNC_PLAN_CONFLICT");
  });
  it("rejects completed progress beyond the unfinished target", () => {
    expect(() =>
      planSyncWindows({
        ...input(),
        latestJobs: [job(), job("ORDERS", "SUCCEEDED", start, "2026-01-11T00:00:00.000Z")],
      }),
    ).toThrow("SYNC_PLAN_CONFLICT");
  });
  it("rejects a frozen target outside a missing stream's contiguous 31 day window", () => {
    const value = input();
    value.latestJobs = [
      job("PRODUCTS", "RUNNING", "2026-02-01T00:00:00.000Z", "2026-02-10T00:00:00.000Z"),
    ];
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_CONFLICT");
  });
  it.each([
    "2026-02-30T00:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "2026-01-01T08:00:00.000+08:00",
    "2026-01-01T00:00:00Z",
  ])("rejects noncanonical or invalid UTC %s", (businessNow) => {
    const value = input();
    value.bootstrap.businessNow = businessNow;
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
  });
  it.each([
    {},
    { ...input(), extra: true },
    { ...input(), publication: {} },
    { ...input(), latestJobs: [job(), job()] },
    { ...input(), latestJobs: Array.from({ length: 6 }, () => job()) },
    { ...input(), latestJobs: new Array(1) },
  ])("rejects malformed projection %#", (value) => {
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
  });
  it("rejects publication watermark after its target", () => {
    const value = input();
    value.publication.processedThrough = "2026-01-11T00:00:00.000Z";
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
  });
  it("rejects hostile getters without executing them", () => {
    const getter = vi.fn(() => target);
    const value = input();
    Object.defineProperty(value.bootstrap, "businessNow", { enumerable: true, get: getter });
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects nested proxies without executing traps", () => {
    const trap = vi.fn(() => []);
    const value = input();
    value.latestJobs = new Proxy([], { ownKeys: trap });
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
    expect(trap).not.toHaveBeenCalled();
  });
  it("rejects oversized identifiers and unknown fields before gating runtime", () => {
    const value = input();
    value.bootstrap.state = "WAITING_RUNTIME";
    value.binding.scope.storeId = "x".repeat(100000);
    expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
  });
  it("does not mutate input", () => {
    const value = input();
    const original = structuredClone(value);
    planSyncWindows(value);
    expect(value).toEqual(original);
  });
});
it("fills missing streams while a completed stream is already at the common target", () => {
  const value = input();
  value.latestJobs = [job("PRODUCTS", "SUCCEEDED")];
  expect(planSyncWindows(value)).toMatchObject({
    targetTime: target,
    windows: expectedWindows().slice(1),
  });
});
it("fills a lagging completed stream while others are already at the common target", () => {
  const value = input();
  value.latestJobs = streams.map((stream) =>
    job(stream, "SUCCEEDED", start, stream === "ORDERS" ? "2026-01-05T00:00:00.000Z" : target),
  );
  expect(planSyncWindows(value)).toMatchObject({
    targetTime: target,
    windows: [{ stream: "ORDERS", since: "2026-01-05T00:00:00.000Z", until: target }],
  });
});
it("rejects a top-level proxy before executing traps", () => {
  const trap = vi.fn(() => Object.prototype);
  expect(() => planSyncWindows(new Proxy(input(), { getPrototypeOf: trap }))).toThrow(
    "SYNC_PLAN_INPUT_INVALID",
  );
  expect(trap).not.toHaveBeenCalled();
});
it("rejects array accessors before executing getters", () => {
  const value = input();
  const getter = vi.fn(() => job());
  Object.defineProperty(value.latestJobs, "0", { enumerable: true, get: getter });
  expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
  expect(getter).not.toHaveBeenCalled();
});
it("rejects scope getters before executing them", () => {
  const value = input();
  const getter = vi.fn(() => "org");
  Object.defineProperty(value.binding.scope, "organizationId", { enumerable: true, get: getter });
  expect(() => planSyncWindows(value)).toThrow("SYNC_PLAN_INPUT_INVALID");
  expect(getter).not.toHaveBeenCalled();
});
it("supports a zero-event publication through its verified coverage", () => {
  const value = input();
  value.publication.targetTime = value.publication.processedThrough = start;
  expect(planSyncWindows(value)).toEqual({ status: "WAITING", reason: "CAUGHT_UP", windows: [] });
});
