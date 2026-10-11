import { afterEach, expect, it, vi } from "vitest";
import type { SyncJob, SyncRuntimeBootstrap } from "@shopmate/database/sync-host";
import type { SourceReadPorts } from "@shopmate/database/mock-platform-read";
import type { CommerceConnector } from "@shopmate/contracts";
import { context, rawWork } from "../test/work-fixtures.js";
import { projectSyncWork } from "./work.js";
import { SyncCoordinator } from "./coordinator.js";
import { SYNC_STREAMS } from "./planner-types.js";
const current: SyncRuntimeBootstrap = {
  ...context,
  merchantId: "merchant-a",
  config: {},
  configHash: "hash-a",
  generatorVersion: "mock-source-v1",
  state: "READY",
  runtimeOpening: context.initialSince,
  businessNow: "2026-01-02T00:00:00.000Z",
  clockRevision: 1,
  sessionRevision: 1,
};
function fixture() {
  const raw: { grant: ReturnType<typeof rawWork>["grant"]; jobs: Record<string, unknown>[] } =
    rawWork();
  raw.jobs = [];
  const base = projectSyncWork(rawWork(), current).jobs[0]!;
  const fetch = vi.fn(async () => ({
    ok: true as const,
    data: { items: [], nextCursor: null, observedAt: current.businessNow, sourceWatermark: null },
  }));
  const { sessionId: _session, generation: _generation, ...binding } = current.scope;
  void _session;
  void _generation;
  const connector = {
    binding,
    listProducts: fetch,
    listOrders: fetch,
    listRefunds: fetch,
    getInventory: fetch,
    getMarketingMetrics: fetch,
  } as unknown as CommerceConnector;
  const publication = vi.fn(
    async (): Promise<{
      scope: typeof current.scope;
      generatorVersion: string;
      targetTime: string;
      processedThrough: string;
    } | null> => ({
      scope: current.scope,
      generatorVersion: current.generatorVersion,
      targetTime: current.businessNow,
      processedThrough: current.businessNow,
    }),
  );
  const sources = {
    bind: vi.fn(() => ({ findPublication: publication })),
    close: vi.fn(),
  } as unknown as SourceReadPorts;
  const host = {
    runtimeBootstrap: vi.fn(async (): Promise<SyncRuntimeBootstrap | null> => current),
    listWork: vi.fn(async () => raw),
    runtimeFailureRules: vi.fn(async () => ({ context: current, rules: [] })),
    createWindow: vi.fn(async (stream: SyncJob["stream"], until: string) => ({
      ...base,
      id: `job-${stream}`,
      stream,
      until,
    })),
    claim: vi.fn(async (job: SyncJob) => ({
      ...job,
      status: "RUNNING" as const,
      fence: job.fence + 1,
    })),
    renew: vi.fn(async (job: SyncJob) => job),
    fail: vi.fn(async (job: SyncJob) => job),
    commitPage: vi.fn(
      async (job: SyncJob): Promise<SyncJob> => ({
        ...job,
        status: "SUCCEEDED" as const,
        pageCount: job.pageCount + 1,
      }),
    ),
  };
  const open = vi.fn(async () => ({ ok: true as const, data: { bootstrap: current, connector } }));
  return {
    host,
    sources,
    publication,
    open,
    raw,
    base,
    fetch,
    coordinator: new SyncCoordinator(host, sources, { open }),
  };
}
afterEach(() => vi.useRealTimers());
it("applies a verified common target to all five streams", async () => {
  const f = fixture();
  const result = await f.coordinator.pass();
  expect(result.status).toBe("PROGRESSED");
  expect(result.created).toHaveLength(5);
  expect(result.outcomes).toHaveLength(5);
  expect(f.host.createWindow.mock.calls).toEqual(
    SYNC_STREAMS.map((stream) => [stream, current.businessNow]),
  );
});
it("waits for runtime without source or work reads", async () => {
  const f = fixture();
  f.host.runtimeBootstrap.mockResolvedValue(null);
  expect(await f.coordinator.pass()).toMatchObject({
    status: "WAITING",
    reason: "WAITING_RUNTIME",
    created: [],
    outcomes: [],
  });
  expect(f.sources.bind).not.toHaveBeenCalled();
  expect(f.host.createWindow).not.toHaveBeenCalled();
});
it("denies authority drift after publication before mutations", async () => {
  const f = fixture();
  f.host.runtimeBootstrap
    .mockResolvedValueOnce(current)
    .mockResolvedValue({ ...current, configHash: "changed" });
  await expect(f.coordinator.pass()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(f.host.createWindow).not.toHaveBeenCalled();
});
it("keeps a created receipt when stop occurs during mutation", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.host.createWindow.mockImplementation(async (stream, until) => {
    controller.abort();
    return { ...f.base, id: `job-${stream}`, stream, until };
  });
  expect(await f.coordinator.pass({ signal: controller.signal })).toMatchObject({
    status: "STOPPED",
    created: [{ stream: "PRODUCTS" }],
    outcomes: [],
  });
  expect(f.host.createWindow).toHaveBeenCalledTimes(1);
  expect(f.host.claim).not.toHaveBeenCalled();
});
it("rechecks the latest backwards clock before applying a target", async () => {
  const f = fixture();
  f.host.runtimeBootstrap
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(current)
    .mockResolvedValue({ ...current, businessNow: current.initialSince, clockRevision: 2 });
  expect(await f.coordinator.pass()).toMatchObject({
    status: "WAITING",
    reason: "WAITING_COVERAGE",
    created: [],
  });
  expect(f.host.createWindow).not.toHaveBeenCalled();
});
it("waits for missing publication and insufficient coverage", async () => {
  const f = fixture();
  f.publication.mockResolvedValue(null);
  expect(await f.coordinator.pass()).toMatchObject({
    status: "WAITING",
    reason: "WAITING_PUBLICATION",
  });
  f.raw.jobs = rawWork().jobs;
  f.publication.mockResolvedValue({
    scope: current.scope,
    generatorVersion: current.generatorVersion,
    targetTime: current.initialSince,
    processedThrough: current.initialSince,
  });
  expect(await f.coordinator.pass()).toMatchObject({
    status: "WAITING",
    reason: "WAITING_COVERAGE",
  });
  expect(f.host.createWindow).not.toHaveBeenCalled();
});
it("keeps the frozen target after partial creation failure", async () => {
  const f = fixture();
  f.host.createWindow.mockImplementation(async (stream, until) => {
    if (stream === "ORDERS") throw new Error("SQL_FAILED");
    const job = { ...f.base, id: `job-${stream}`, stream, until };
    f.raw.jobs.push({ ...rawWork().jobs[0]!, ...job } as (typeof f.raw.jobs)[number]);
    return job;
  });
  await expect(f.coordinator.pass()).rejects.toThrow("SQL_FAILED");
  f.host.runtimeBootstrap.mockResolvedValue({
    ...current,
    businessNow: "2026-01-03T00:00:00.000Z",
    clockRevision: 2,
  });
  f.host.createWindow.mockImplementation(async (stream, until) => ({
    ...f.base,
    id: `job-${stream}`,
    stream,
    until,
  }));
  const result = await f.coordinator.pass();
  expect(result.created).toHaveLength(4);
  expect(result.created.every((job) => job.until === current.businessNow)).toBe(true);
  expect(result.outcomes).toHaveLength(5);
});
it("retains all five runner leases and refreshes connectors across passes", async () => {
  const f = fixture();
  f.fetch.mockImplementation(async () => ({
    ok: true,
    data: {
      items: [],
      nextCursor: null,
      observedAt: current.businessNow,
      sourceWatermark: null,
    },
  }));
  f.host.commitPage.mockImplementation(async (job) => {
    const result = {
      ...job,
      status: "RUNNING" as const,
      cursor: "next-a",
      pageCount: job.pageCount + 1,
    };
    const entry = { ...rawWork().jobs[0]!, ...result } as (typeof f.raw.jobs)[number];
    const index = f.raw.jobs.findIndex((item) => item.id === result.id);
    if (index < 0) f.raw.jobs.push(entry);
    else f.raw.jobs[index] = entry;
    return result;
  });
  expect((await f.coordinator.pass({ maxPages: 1 })).outcomes).toHaveLength(5);
  const refreshedFetch = vi.fn(f.fetch.getMockImplementation()!);
  const selected = await f.open();
  f.open.mockResolvedValue({
    ...selected,
    data: {
      ...selected.data,
      connector: {
        ...selected.data.connector,
        listProducts: refreshedFetch,
        listOrders: refreshedFetch,
        listRefunds: refreshedFetch,
        getInventory: refreshedFetch,
        getMarketingMetrics: refreshedFetch,
      } as unknown as CommerceConnector,
    },
  });
  f.open.mockClear();
  expect((await f.coordinator.pass({ maxPages: 1 })).outcomes).toHaveLength(5);
  expect(f.host.claim).toHaveBeenCalledTimes(5);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(refreshedFetch).toHaveBeenCalledTimes(5);
  expect(f.host.createWindow).toHaveBeenCalledTimes(5);
});
it("validates hostile and out of range controls before reads", async () => {
  const f = fixture();
  const getter = vi.fn(() => 1);
  await expect(
    f.coordinator.pass({
      get maxPages() {
        return getter();
      },
    }),
  ).rejects.toThrow("SYNC_RUN_INPUT_INVALID");
  await expect(f.coordinator.pass({ budgetMs: 0 })).rejects.toThrow("SYNC_RUN_INPUT_INVALID");
  await expect(f.coordinator.pass({ signal: {} as AbortSignal })).rejects.toThrow(
    "SYNC_RUN_INPUT_INVALID",
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.host.runtimeBootstrap).not.toHaveBeenCalled();
});
it("preserves creation receipts when the total pass budget expires", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.host.createWindow.mockImplementation(async (stream, until) => {
    vi.advanceTimersByTime(100);
    return { ...f.base, id: `job-${stream}`, stream, until };
  });
  expect(await f.coordinator.pass({ budgetMs: 50 })).toMatchObject({
    status: "BUDGET",
    created: [{ stream: "PRODUCTS" }],
    outcomes: [],
  });
});
it("rejects a created window outside the planned identity", async () => {
  const f = fixture();
  f.host.createWindow.mockImplementation(async (stream, until) => ({
    ...f.base,
    stream,
    until,
    generation: 2,
  }));
  await expect(f.coordinator.pass()).rejects.toThrow("SYNC_RUN_RESULT_INVALID");
  expect(f.open).not.toHaveBeenCalled();
});
it("returns stop when a cancelled source read rejects", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.publication.mockImplementation(async () => {
    controller.abort();
    throw new Error("SOURCE_ABORTED");
  });
  expect(await f.coordinator.pass({ signal: controller.signal })).toMatchObject({
    status: "STOPPED",
    created: [],
    outcomes: [],
  });
});
