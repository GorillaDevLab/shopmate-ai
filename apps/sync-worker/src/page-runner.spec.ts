import { expect, it, vi } from "vitest";
import type { SyncJob } from "@shopmate/database/sync-host";
import type { CommerceConnector, ConnectorResult, ConnectorPage } from "@shopmate/contracts";
import { projectSyncWork } from "./work.js";
import { context, rawWork } from "../test/work-fixtures.js";
import { SyncPageRunner } from "./page-runner.js";
import type { PageRunControls } from "./page-controls.js";

it.each(["fake signal", "accessor", "proxy", "custom prototype", "unknown field"])(
  "rejects %s controls without evaluating caller code or mutating leases",
  async (kind) => {
    const f = fixture();
    const evaluated = vi.fn(() => 1);
    const inputs: Record<string, unknown> = {
      "fake signal": { signal: { aborted: false } },
      accessor: Object.defineProperty({}, "maxPages", { get: evaluated, enumerable: true }),
      proxy: new Proxy(
        {},
        {
          get: evaluated,
          getPrototypeOf: () => {
            evaluated();
            return Object.prototype;
          },
          getOwnPropertyDescriptor: () => {
            evaluated();
            return undefined;
          },
          ownKeys: () => {
            evaluated();
            return [];
          },
        },
      ),
      "custom prototype": Object.create({ maxPages: 1 }),
      "unknown field": { extra: true },
    };
    await expect(f.runner.run(f.initial, inputs[kind] as PageRunControls)).rejects.toThrow(
      "SYNC_RUN_INPUT_INVALID",
    );
    expect(evaluated).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    for (const operation of Object.values(f.host)) expect(operation).not.toHaveBeenCalled();
  },
);

it.each(["controller", "timeout", "any"])("accepts native %s signals", async (kind) => {
  const f = fixture();
  const controller = new AbortController();
  const signal =
    kind === "controller"
      ? controller.signal
      : kind === "timeout"
        ? AbortSignal.timeout(10000)
        : AbortSignal.any([controller.signal]);
  signal.onabort = () => undefined;
  signal.addEventListener("abort", { handleEvent() {} });
  expect((await f.runner.run(f.initial, { signal })).reason).toBe("SUCCEEDED");
});
function fixture() {
  const initial = projectSyncWork(rawWork(), context).jobs[0]!;
  const page = {
    items: [],
    nextCursor: null,
    observedAt: "2026-01-02T00:00:00.000Z",
    sourceWatermark: null,
  };
  const events: string[] = [];
  const fetch = vi.fn(
    async (_query: unknown, _options: unknown): Promise<ConnectorResult<ConnectorPage<never>>> => {
      void _query;
      void _options;
      events.push("fetch");
      return { ok: true, data: page };
    },
  );
  const connector = connectorFixture(fetch);
  const host = hostFixture(events);
  return {
    connector,
    initial,
    page,
    events,
    fetch,
    host,
    runner: new SyncPageRunner(host, connector, context.initialSince),
  };
}
function connectorFixture(
  fetch: ReturnType<
    typeof vi.fn<
      (query: unknown, options: unknown) => Promise<ConnectorResult<ConnectorPage<never>>>
    >
  >,
): CommerceConnector {
  return {
    listProducts: fetch,
    listOrders: fetch,
    listRefunds: fetch,
    getInventory: fetch,
    getMarketingMetrics: fetch,
    binding: {
      organizationId: context.scope.organizationId,
      workspaceId: context.scope.workspaceId,
      storeId: context.scope.storeId,
      connectionId: context.scope.connectionId,
      externalStoreId: context.scope.externalStoreId,
    },
  } as unknown as CommerceConnector;
}

function hostFixture(events: string[]) {
  return {
    claim: vi.fn(async (job: SyncJob) => {
      events.push("claim");
      return { ...job, status: "RUNNING" as const, fence: job.fence + 1 };
    }),
    renew: vi.fn(async (job: SyncJob) => {
      events.push("renew");
      return job;
    }),
    fail: vi.fn(async (job: SyncJob) => {
      events.push("fail");
      return job;
    }),
    commitPage: vi.fn(
      async (
        job: SyncJob,
        _id: string,
        _cursor: string | null,
        _page: unknown,
      ): Promise<SyncJob> => {
        void _id;
        void _cursor;
        void _page;
        events.push("commit");
        return { ...job, status: "SUCCEEDED" as const, cursor: null, pageCount: job.pageCount + 1 };
      },
    ),
  };
}
it.each(["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"] as const)(
  "fetches %s with full snapshot bounds",
  async (stream) => {
    const f = fixture();
    const job = {
      ...f.initial,
      stream,
      status: "RUNNING" as const,
      cursor: "original",
      pageCount: 3,
    };
    const result = await f.runner.run(job);
    expect(result.reason).toBe("SUCCEEDED");
    expect(f.events).toEqual(["claim", "renew", "fetch", "renew", "commit"]);
    expect(f.fetch.mock.calls[0]?.[0]).toEqual({
      until: job.until,
      cursor: "original",
      limit: stream === "ORDERS" ? 10 : 200,
      ...(stream === "MARKETING" ? { since: context.initialSince } : {}),
    });
    expect(f.host.commitPage.mock.calls[0]?.slice(1, 3)).toEqual(["page-4", "original"]);
  },
);
it("preserves committed progress at page limit and retains explicit same-runner ownership", async () => {
  const f = fixture();
  f.host.commitPage.mockImplementation(async (job) => ({
    ...job,
    cursor: "next",
    pageCount: job.pageCount + 1,
  }));
  const first = await f.runner.run(f.initial, { maxPages: 1 });
  expect(first.reason).toBe("PAGE_LIMIT");
  await f.runner.run(first.job, { maxPages: 1 });
  expect(f.host.claim).toHaveBeenCalledTimes(1);
  expect(f.host.fail).not.toHaveBeenCalled();
});
it("honors the coordinator original deadline without extending a relative job budget", async () => {
  const f = fixture();
  expect(await f.runner.run(f.initial, { budgetMs: 1000 }, Date.now() - 1)).toMatchObject({
    reason: "BUDGET",
    job: f.initial,
  });
  expect(f.host.claim).not.toHaveBeenCalled();
});
it("never fails or refetches a foreign lease or uncertain commit", async () => {
  const f = fixture();
  f.host.claim.mockRejectedValueOnce(new Error("LEASE_BUSY"));
  await expect(f.runner.run(f.initial)).rejects.toThrow("LEASE_BUSY");
  expect(f.fetch).not.toHaveBeenCalled();
  f.host.commitPage.mockRejectedValueOnce(new Error("ACK_LOST"));
  await expect(f.runner.run(f.initial)).rejects.toThrow("ACK_LOST");
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.host.fail).not.toHaveBeenCalled();
});
it("stops after successful fetch and before commit without failing", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.fetch.mockImplementation(async () => {
    controller.abort();
    return { ok: true, data: f.page };
  });
  expect((await f.runner.run(f.initial, { signal: controller.signal })).reason).toBe("STOPPED");
  expect(f.host.commitPage).not.toHaveBeenCalled();
  expect(f.host.fail).not.toHaveBeenCalled();
});
it("checks cancellation after post-fetch renewal", async () => {
  const f = fixture(),
    controller = new AbortController();
  let count = 0;
  f.host.renew.mockImplementation(async (job) => {
    if (++count === 2) controller.abort();
    return job;
  });
  expect((await f.runner.run(f.initial, { signal: controller.signal })).reason).toBe("STOPPED");
  expect(f.host.commitPage).not.toHaveBeenCalled();
});
it.each(["TEMPORARY", "TIMEOUT", "RATE_LIMIT"] as const)(
  "retries only actual %s failures three times then fails",
  async (code) => {
    const f = fixture();
    f.fetch.mockResolvedValue({ ok: false, error: { code, retryAfterMs: null } });
    await expect(f.runner.run(f.initial)).rejects.toThrow("SYNC_CONNECTOR_FAILED");
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.host.fail).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "PERMISSION_DENIED",
  "AUTH_EXPIRED",
  "INVALID_RESPONSE",
  "INVALID_INPUT",
  "ABORTED",
] as const)("does not retry %s", async (code) => {
  const f = fixture();
  f.fetch.mockResolvedValue({ ok: false, error: { code, retryAfterMs: null } });
  await expect(f.runner.run(f.initial)).rejects.toThrow(`SYNC_CONNECTOR_${code}`);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.host.fail).not.toHaveBeenCalled();
});
it("does not classify thrown infrastructure errors as connector failures", async () => {
  const f = fixture();
  f.fetch.mockRejectedValue(new Error("unexpected"));
  await expect(f.runner.run(f.initial)).rejects.toThrow("unexpected");
  expect(f.host.fail).not.toHaveBeenCalled();
});

it("rejects a preselected foreign connector before claiming", async () => {
  const f = fixture();
  const foreign = { ...f.connector, binding: { ...f.connector.binding, storeId: "foreign" } };
  const runner = new SyncPageRunner(f.host, foreign, context.initialSince);
  await expect(runner.run(f.initial)).rejects.toThrow("SYNC_RUN_BINDING_INVALID");
  expect(f.host.claim).not.toHaveBeenCalled();
});
it("rejects malformed source success without a commit", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue({
    ok: true,
    data: { ...f.page, sourceWatermark: "2027-01-01T00:00:00.000Z" },
  });
  await expect(f.runner.run(f.initial)).rejects.toThrow("SYNC_CONNECTOR_INVALID_RESPONSE");
  expect(f.host.commitPage).not.toHaveBeenCalled();
  expect(f.host.fail).not.toHaveBeenCalled();
});
it("rejects malformed renewed identity without fetching", async () => {
  const f = fixture();
  f.host.renew.mockImplementation(async (job) => ({ ...job, storeId: "foreign" }));
  await expect(f.runner.run(f.initial)).rejects.toThrow("SYNC_RUN_RESULT_INVALID");
  expect(f.fetch).not.toHaveBeenCalled();
});
it("bounds ignored source deadlines and caller abort", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetch.mockImplementation(() => new Promise(() => undefined));
  try {
    const running = f.runner.run(f.initial, { budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await running).reason).toBe("BUDGET");
    expect(f.host.commitPage).not.toHaveBeenCalled();
    expect(f.host.fail).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("uses one capped25s deadline across retry attempts", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetch.mockResolvedValueOnce({
    ok: false,
    error: { code: "RATE_LIMIT", retryAfterMs: 1000 },
  });
  try {
    const running = f.runner.run(f.initial, { budgetMs: 60000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await running).reason).toBe("SUCCEEDED");
    const first = f.fetch.mock.calls[0]?.[1] as { deadlineAt: string },
      second = f.fetch.mock.calls[1]?.[1] as { deadlineAt: string };
    expect(first.deadlineAt).toBe(second.deadlineAt);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry before a rate-limit delay beyond the shared page budget", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetch.mockResolvedValueOnce({
    ok: false,
    error: { code: "RATE_LIMIT", retryAfterMs: 86400000 },
  });
  try {
    const running = f.runner.run(f.initial);
    await vi.advanceTimersByTimeAsync(25000);
    expect((await running).reason).toBe("BUDGET");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.host.fail).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("rejects invalid limits and stops an already aborted pass without a claim", async () => {
  const f = fixture();
  await expect(f.runner.run(f.initial, { maxPages: 1001 })).rejects.toThrow(
    "SYNC_RUN_INPUT_INVALID",
  );
  const controller = new AbortController();
  controller.abort();
  expect((await f.runner.run(f.initial, { signal: controller.signal })).reason).toBe("STOPPED");
  expect(f.host.claim).not.toHaveBeenCalled();
});
it("keeps the original durable cursor when lease snapshots are malformed", async () => {
  const f = fixture();
  f.host.renew.mockImplementation(async (job) => ({ ...job, cursor: "refreshed" }));
  await expect(f.runner.run({ ...f.initial, cursor: "original" })).rejects.toThrow(
    "SYNC_RUN_RESULT_INVALID",
  );
  expect(f.fetch).not.toHaveBeenCalled();
});
it("claims again when explicit same-backend retained ownership has expired", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.host.commitPage.mockImplementation(async (job) => ({
    ...job,
    cursor: `cursor-${job.pageCount + 1}`,
    pageCount: job.pageCount + 1,
  }));
  try {
    const first = await f.runner.run(f.initial, { maxPages: 1 });
    vi.setSystemTime(Date.now() + 120001);
    await f.runner.run(first.job, { maxPages: 1 });
    expect(f.host.claim).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
it.each(["getter", "proxy"])(
  "rejects hostile %s jobs before binding reads or claims",
  async (kind) => {
    const f = fixture();
    let calls = 0;
    const job = { ...f.initial };
    const hostile =
      kind === "proxy"
        ? new Proxy(job, {
            get(target, key, receiver) {
              calls++;
              return Reflect.get(target, key, receiver);
            },
          })
        : Object.defineProperty(job, "organizationId", {
            enumerable: true,
            get() {
              calls++;
              return f.initial.organizationId;
            },
          });
    await expect(f.runner.run(hostile)).rejects.toThrow("SYNC_RUN_RESULT_INVALID");
    expect(calls).toBe(0);
    expect(f.host.claim).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  },
);
it.each(["2026-01-02T13:00:00+13:00", "2026-01-01T19:00:00-05:00"])(
  "normalizes committed SQL freshness %s after one durable commit",
  async (timestamp) => {
    const f = fixture();
    f.host.commitPage.mockImplementation(async (job) => ({
      ...job,
      status: "SUCCEEDED",
      pageCount: job.pageCount + 1,
      observedAt: timestamp,
      sourceWatermark: timestamp,
      successfulThrough: timestamp,
    }));
    const result = await f.runner.run(f.initial);
    expect(result.reason).toBe("SUCCEEDED");
    expect([
      result.job.observedAt,
      result.job.sourceWatermark,
      result.job.successfulThrough,
    ]).toEqual(Array(3).fill("2026-01-02T00:00:00.000Z"));
    expect(f.host.commitPage).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  },
);
