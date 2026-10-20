import { expect, it, vi } from "vitest";
import {
  MetricComputationV1Schema,
  type ConnectorBinding,
  type MetricCalculationRequest,
  type MetricComputationV1,
  type MetricInputV1,
  type MetricResult,
  type MetricSnapshotRepository,
  type MetricSnapshotV1,
  type MetricSourceQuery,
  type MetricSourceReader,
  type TenantContext,
} from "@shopmate/contracts";
import {
  createMetricDefinitionRegistry,
  type MetricDefinitionRegistry,
} from "./metric-definition-registry.js";
import {
  createMetricComputationService,
  type MetricComputationServiceOptions,
} from "./metric-computation.service.js";

const binding: ConnectorBinding = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  storeId: "store-1",
  connectionId: "connection-1",
  externalStoreId: "external-1",
};
const actor: TenantContext = {
  userId: "user-1",
  merchantId: "merchant-1",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  role: "ANALYST",
  permissions: ["tenant:read", "products:read", "orders:read", "inventory:read"],
};
const window = {
  periodStart: "2026-10-01T00:00:00Z",
  periodEnd: "2026-10-02T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const computedAt = "2026-10-03T01:00:00Z";
function query(patch: Partial<MetricSourceQuery> = {}): MetricSourceQuery {
  return {
    binding,
    window,
    visibleAt: "2026-10-03T00:00:00Z",
    definitionVersion: "v1",
    inputRevision: null,
    coverageRequests: [
      { kind: "GMV", subject: { kind: "STORE" } },
      { kind: "PAID_REVENUE", subject: { kind: "STORE" } },
    ],
    ...patch,
  };
}
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  const context = {
    schemaVersion: 1 as const,
    ...window,
    binding,
    visibleAt: query().visibleAt,
    definitionVersion: "v1",
    inputRevision: "revision-1",
    sourceWatermark: window.periodEnd,
    evidenceIds: ["source-a"],
  };
  return {
    ...context,
    status: "VERIFIED",
    paymentFacts: [],
    refundFacts: [],
    inventoryFacts: [],
    campaignFacts: [],
    frozenCosts: [],
    refundAllocations: [],
    returnReceipts: [],
    fees: [],
    traffic: [],
    inventoryExtensions: [],
    metricCoverage: query().coverageRequests.map((request) => ({
      ...context,
      ...request,
      observedAt: query().visibleAt,
      sourceVersion: "source-v1",
      coverageBasisPoints: 10000,
      collections: ["paymentFacts"],
    })),
    ...patch,
  };
}
function success<T>(value: T): MetricResult<T> {
  return { ok: true, value };
}
function failed(code: "SOURCE_UNAVAILABLE" | "CONFLICT" = "SOURCE_UNAVAILABLE") {
  return { ok: false, error: { code, evidenceIds: ["private-evidence"] } } as const;
}
function calculation(request: MetricCalculationRequest): MetricComputationV1 {
  const { input: facts, kind, subject, computedAt: time } = request;
  const { metricCoverage: coverage, status, ...context } = facts;
  void coverage;
  void status;
  const snapshot = {
    schemaVersion: context.schemaVersion,
    ...window,
    binding: facts.binding,
    definitionVersion: facts.definitionVersion,
    inputRevision: facts.inputRevision,
    visibleAt: facts.visibleAt,
    sourceWatermark: facts.sourceWatermark,
    evidenceIds: facts.evidenceIds,
    computedAt: time,
    subject,
    metric: { kind, unit: "minorCNY", value: 0 },
    status: "VERIFIED",
    issues: [],
    sampleSize: 0,
    coverageBasisPoints: 10000,
  };
  return MetricComputationV1Schema.parse({ input: facts, snapshot });
}
function fixture() {
  const source = input({ binding: { ...binding } });
  const read = vi.fn(async () => success(source));
  const calculate = vi.fn((request: MetricCalculationRequest) => success(calculation(request)));
  const append = vi.fn(async (result: MetricComputationV1) => success(result.snapshot));
  const authorizeBinding = vi.fn(async () => success(binding));
  const registry = createMetricDefinitionRegistry([
    { definitionVersion: "v1", calculator: { calculate } },
  ]);
  const repository: MetricSnapshotRepository = { append, read: async () => success([]) };
  const service = createMetricComputationService({
    actor,
    source: { read },
    registry,
    repository,
    authorizeBinding,
  });
  return { source, read, calculate, append, authorizeBinding, service, registry, repository };
}
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected successful result");
  return result.value;
}

it("reads once and shares one deeply frozen independent input across requested calculations", async () => {
  const f = fixture();
  const result = value(await f.service.compute({ query: query(), computedAt }));
  expect(result).toHaveLength(2);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.authorizeBinding).toHaveBeenCalledBefore(f.read);
  const first = f.calculate.mock.calls[0]![0];
  const second = f.calculate.mock.calls[1]![0];
  expect(first.input).toBe(second.input);
  expect(first.input).not.toBe(f.source);
  expect(first.computedAt).toBe(second.computedAt);
  expect(first.input.inputRevision).toBe("revision-1");
  expect(Object.isFrozen(first.input.metricCoverage[0]!.binding)).toBe(true);
  expect(Object.isFrozen(first.input.paymentFacts)).toBe(true);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(f.source)).toBe(false);
  expect(f.append).toHaveBeenCalledTimes(2);
});

it("accepts the repository's normalized timestamps and idempotent prior computation time", async () => {
  const f = fixture();
  f.append.mockImplementation(async ({ snapshot }) =>
    success({
      ...snapshot,
      computedAt: query().visibleAt,
      periodStart: new Date(snapshot.periodStart).toISOString(),
      periodEnd: new Date(snapshot.periodEnd).toISOString(),
      visibleAt: new Date(snapshot.visibleAt).toISOString(),
      sourceWatermark: new Date(snapshot.sourceWatermark!).toISOString(),
    }),
  );
  const result = value(await f.service.compute({ query: query(), computedAt }));
  expect(result[0]!.computedAt).toBe(query().visibleAt);
});

it.each([
  { extra: true },
  { query: { ...query(), scenario: "answer" } },
  { query: query({ coverageRequests: [] }) },
  {
    query: query({
      coverageRequests: [query().coverageRequests[0]!, query().coverageRequests[0]!],
    }),
  },
  { computedAt: "2026-09-30T00:00:00Z" },
  { query: query({ visibleAt: "2026-10-01T12:00:00Z" }) },
  { query: query({ window: { ...window, periodEnd: window.periodStart } }) },
])("rejects malformed compute request before source use %#", async (patch) => {
  const f = fixture();
  expect(await f.service.compute({ query: query(), computedAt, ...patch } as never)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});

it.each(["organizationId", "workspaceId"] as const)(
  "rejects foreign actor %s before authorization",
  async (key) => {
    const f = fixture();
    const request = query({ binding: { ...binding, [key]: "foreign" } });
    expect(await f.service.compute({ query: request, computedAt })).toMatchObject({
      ok: false,
      error: { code: "SCOPE_MISMATCH" },
    });
    expect(f.authorizeBinding).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  },
);

it("requires all read permissions even when the server authorizer would grant access", async () => {
  const f = fixture();
  const service = createMetricComputationService({
    actor: { ...actor, permissions: ["tenant:read"] },
    source: { read: f.read },
    registry: f.registry,
    repository: f.repository,
    authorizeBinding: f.authorizeBinding,
  });
  expect(await service.compute({ query: query(), computedAt })).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(f.authorizeBinding).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it.each(["storeId", "connectionId", "externalStoreId"] as const)(
  "requires authorization of exact %s",
  async (key) => {
    const f = fixture();
    f.authorizeBinding.mockResolvedValue(success({ ...binding, [key]: "foreign" }));
    expect(await f.service.compute({ query: query(), computedAt })).toMatchObject({
      ok: false,
      error: { code: "SCOPE_MISMATCH" },
    });
    expect(f.read).not.toHaveBeenCalled();
  },
);

it("uses a historical registered definition and rejects an unknown one before reading", async () => {
  const f = fixture();
  expect(
    await f.service.compute({ query: query({ definitionVersion: "v2" }), computedAt }),
  ).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
  expect(f.read).not.toHaveBeenCalled();
});

it.each([
  { definitionVersion: "v2" },
  { inputRevision: "wrong-revision" },
  { visibleAt: "2026-10-04T00:00:00Z" },
  { binding: { ...binding, storeId: "foreign" } },
  { periodStart: "2026-10-01T01:00:00Z" },
])("rejects source query mismatch %#", async (patch) => {
  const f = fixture();
  f.read.mockResolvedValue(success(input({ ...patch, metricCoverage: [] })));
  expect(
    await f.service.compute({ query: query({ inputRevision: "revision-1" }), computedAt }),
  ).toMatchObject({ ok: false });
  expect(f.calculate).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});

it.each(["unknown", "missing", "nested"])(
  "strictly rejects %s source fields without writing zero",
  async (mode) => {
    const f = fixture();
    const source =
      mode === "unknown"
        ? { ...f.source, oracle: 0 }
        : mode === "missing"
          ? { ...f.source, paymentFacts: undefined }
          : { ...f.source, binding: { ...binding, token: "private" } };
    f.read.mockResolvedValue(success(source as MetricInputV1));
    expect(await f.service.compute({ query: query(), computedAt })).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: [] },
    });
    expect(f.calculate).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  },
);

it("does not append any computation when a later calculator fails", async () => {
  const f = fixture();
  f.calculate
    .mockImplementationOnce((request) => success(calculation(request)))
    .mockImplementationOnce(() => failed("CONFLICT"));
  expect(await f.service.compute({ query: query(), computedAt })).toEqual({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: [] },
  });
  expect(f.append).not.toHaveBeenCalled();
});

it.each(["kind", "subject", "computedAt", "input", "evidence", "quality", "unknown"])(
  "rejects invalid calculator %s before any append",
  async (mode) => {
    const f = fixture();
    f.calculate.mockImplementation((request) => success(tampered(request, mode)));
    expect(await f.service.compute({ query: query(), computedAt })).toMatchObject({ ok: false });
    expect(f.append).not.toHaveBeenCalled();
  },
);

function tampered(request: MetricCalculationRequest, mode: string): MetricComputationV1 {
  const computed = calculation(request);
  if (mode === "input") return { ...computed, input: { ...request.input, inventoryFacts: null } };
  const patch =
    mode === "kind"
      ? { metric: { kind: "AOV", unit: "minorCNY", value: 0 } }
      : mode === "subject"
        ? { subject: { kind: "SKU", externalSkuId: "foreign" } }
        : mode === "computedAt"
          ? { computedAt: "2026-10-04T00:00:00Z" }
          : mode === "evidence"
            ? { evidenceIds: ["foreign"] }
            : mode === "quality"
              ? { coverageBasisPoints: 100 }
              : { extra: true };
  return { ...computed, snapshot: { ...computed.snapshot, ...patch } } as MetricComputationV1;
}

it("does not accept a VERIFIED zero without source completeness evidence", async () => {
  const f = fixture();
  f.read.mockResolvedValue(success(input({ metricCoverage: [] })));
  f.calculate.mockImplementation((request) => {
    const baseline = calculation({ ...request, input: input() });
    return success({ input: request.input, snapshot: baseline.snapshot });
  });
  expect(await f.service.compute({ query: query(), computedAt })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(f.append).not.toHaveBeenCalled();
});

it("allows unavailable sources to produce an explicit null with preserved quality reason", async () => {
  const f = fixture();
  const unavailable = input({
    status: "UNAVAILABLE",
    sourceWatermark: null,
    metricCoverage: [],
    paymentFacts: null,
    refundFacts: null,
    inventoryFacts: null,
    campaignFacts: null,
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    traffic: null,
    inventoryExtensions: null,
  });
  f.read.mockResolvedValue(success(unavailable));
  f.calculate.mockImplementation((request) => {
    const original = calculation({ ...request, input: input() });
    return success({
      input: request.input,
      snapshot: {
        ...original.snapshot,
        sourceWatermark: null,
        status: "UNAVAILABLE",
        coverageBasisPoints: 0,
        metric: { ...original.snapshot.metric, value: null },
        issues: [{ code: "NOT_SYNCHRONIZED", field: "paymentFacts", evidenceIds: ["source-a"] }],
      },
    });
  });
  const result = value(await f.service.compute({ query: query(), computedAt }));
  expect(result[0]).toMatchObject({
    status: "UNAVAILABLE",
    metric: { value: null },
    issues: [{ code: "NOT_SYNCHRONIZED" }],
  });
});

it("returns the same stored snapshot for repeated immutable input and never reads repository first", async () => {
  const f = fixture();
  const stored = new Map<string, MetricSnapshotV1>();
  f.append.mockImplementation(async ({ snapshot }) => {
    const key = `${snapshot.inputRevision}:${snapshot.metric.kind}`;
    const existing = stored.get(key) ?? snapshot;
    stored.set(key, existing);
    return success(existing);
  });
  const first = value(await f.service.compute({ query: query(), computedAt }));
  const second = value(
    await f.service.compute({ query: query(), computedAt: "2026-10-04T00:00:00Z" }),
  );
  expect(second).toEqual(first);
  expect(stored.size).toBe(2);
  expect(f.authorizeBinding).toHaveBeenCalledTimes(2);
});

it.each(["source", "calculator", "repository", "authorization"])(
  "converts thrown %s failures without leaking details",
  async (boundary) => {
    const f = fixture();
    const throwPrivate = () => {
      throw new Error("private token and database details");
    };
    if (boundary === "source") f.read.mockImplementation(throwPrivate);
    if (boundary === "calculator") f.calculate.mockImplementation(throwPrivate);
    if (boundary === "repository") f.append.mockImplementation(throwPrivate);
    if (boundary === "authorization") f.authorizeBinding.mockImplementation(throwPrivate);
    expect(await f.service.compute({ query: query(), computedAt })).toEqual({
      ok: false,
      error: {
        code: boundary === "calculator" ? "INVALID_INPUT" : "SOURCE_UNAVAILABLE",
        evidenceIds: [],
      },
    });
  },
);

it.each(["source", "repository", "authorization"])(
  "preserves typed %s errors while removing untrusted evidence",
  async (boundary) => {
    const f = fixture();
    if (boundary === "source") f.read.mockResolvedValue(failed());
    if (boundary === "repository") f.append.mockResolvedValue(failed("CONFLICT"));
    if (boundary === "authorization") f.authorizeBinding.mockResolvedValue(failed("CONFLICT"));
    const result = await f.service.compute({ query: query(), computedAt });
    expect(result).toEqual({
      ok: false,
      error: {
        code: boundary === "source" ? "SOURCE_UNAVAILABLE" : "CONFLICT",
        evidenceIds: [],
      },
    });
    if (boundary !== "repository") expect(f.append).not.toHaveBeenCalled();
  },
);

it.each(["source", "calculator", "repository", "authorization"])(
  "rejects malformed %s result envelopes",
  async (boundary) => {
    const f = fixture();
    const malformed = { ok: false, error: { code: "RAW_DATABASE_ERROR", message: "private" } };
    if (boundary === "source") f.read.mockResolvedValue(malformed as never);
    if (boundary === "calculator") f.calculate.mockReturnValue(malformed as never);
    if (boundary === "repository") f.append.mockResolvedValue(malformed as never);
    if (boundary === "authorization") f.authorizeBinding.mockResolvedValue(malformed as never);
    expect(await f.service.compute({ query: query(), computedAt })).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: [] },
    });
  },
);

it("rejects a repository that changes the validated metric value", async () => {
  const f = fixture();
  f.append.mockImplementation(async ({ snapshot }) =>
    success({
      ...snapshot,
      metric: { ...snapshot.metric, value: 99 },
    }),
  );
  expect(await f.service.compute({ query: query(), computedAt })).toEqual({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: [] },
  });
});

it("captures actor configuration and request before an awaited authorization", async () => {
  const f = fixture();
  const actorCopy = { ...actor, permissions: [...actor.permissions] };
  const request = { query: { ...query(), binding: { ...binding } }, computedAt };
  const service = createMetricComputationService({
    actor: actorCopy,
    source: { read: f.read },
    registry: f.registry,
    repository: f.repository,
    authorizeBinding: f.authorizeBinding,
  });
  const pending = service.compute(request);
  actorCopy.organizationId = "foreign";
  actorCopy.permissions.length = 0;
  request.query.binding.storeId = "foreign";
  request.query.inputRevision = "changed";
  const result = value(await pending);
  expect(result[0]!.binding.storeId).toBe(binding.storeId);
  expect(f.authorizeBinding.mock.calls[0]).toEqual([actor, binding]);
  expect(Object.isFrozen(actorCopy)).toBe(false);
  expect(Object.isFrozen(request.query.binding)).toBe(false);
});

it("prevents a calculator mutating the shared source without freezing the source reader's object", async () => {
  const f = fixture();
  f.calculate.mockImplementation((request) => {
    expect(() => Object.assign(request.input.binding, { storeId: "foreign" })).toThrow(TypeError);
    Object.assign(f.source.binding, { storeId: "mutated-upstream" });
    return success(calculation(request));
  });
  const result = value(await f.service.compute({ query: query(), computedAt }));
  expect(result.every((snapshot) => snapshot.binding.storeId === "store-1")).toBe(true);
  Object.assign(f.source.binding, { storeId: "store-1" });
});

it("rejects unsupported timestamp precision rather than returning a rounded replay cutoff", async () => {
  const f = fixture();
  const result = await f.service.compute({
    query: query(),
    computedAt: "2026-10-03T01:00:00.0001Z",
  });
  expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
  expect(f.read).not.toHaveBeenCalled();
});

it("returns typed failure for unavailable definition registry without source use", async () => {
  const f = fixture();
  const service = createMetricComputationService({
    actor,
    source: { read: f.read },
    repository: f.repository,
    authorizeBinding: f.authorizeBinding,
    registry: {
      resolve: () => {
        throw new Error("private registry failure");
      },
    },
  });
  expect(await service.compute({ query: query(), computedAt })).toEqual({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] },
  });
  expect(f.read).not.toHaveBeenCalled();
});

it("keeps a resolved old definition when a newer server definition is registered", async () => {
  const f = fixture();
  const newer = vi.fn(() => failed("CONFLICT"));
  const registry = createMetricDefinitionRegistry([
    { definitionVersion: "v1", calculator: { calculate: f.calculate } },
    { definitionVersion: "v2", calculator: { calculate: newer } },
  ]);
  const service = createMetricComputationService({
    actor,
    source: { read: f.read },
    registry,
    repository: f.repository,
    authorizeBinding: f.authorizeBinding,
  });
  expect(value(await service.compute({ query: query(), computedAt }))[0]!.definitionVersion).toBe(
    "v1",
  );
  expect(newer).not.toHaveBeenCalled();
});

it("permits idempotent retry after storage fails partway through a validated batch", async () => {
  const f = fixture();
  const stored = new Map<string, MetricSnapshotV1>();
  let failedOnce = false;
  f.append.mockImplementation(async ({ snapshot }) => {
    if (snapshot.metric.kind === "PAID_REVENUE" && !failedOnce) {
      failedOnce = true;
      return failed();
    }
    const existing = stored.get(snapshot.metric.kind) ?? snapshot;
    stored.set(snapshot.metric.kind, existing);
    return success(existing);
  });
  expect(await f.service.compute({ query: query(), computedAt })).toMatchObject({ ok: false });
  expect(stored.size).toBe(1);
  const retry = value(
    await f.service.compute({ query: query(), computedAt: "2026-10-04T00:00:00Z" }),
  );
  expect(retry).toHaveLength(2);
  expect(stored.size).toBe(2);
  expect(retry[0]!.computedAt).toBe(computedAt);
});

it("accepts the same source cutoff represented with normalized UTC timestamps", async () => {
  const f = fixture();
  const timestamps = {
    periodStart: new Date(window.periodStart).toISOString(),
    periodEnd: new Date(window.periodEnd).toISOString(),
    visibleAt: new Date(query().visibleAt).toISOString(),
    sourceWatermark: new Date(window.periodEnd).toISOString(),
  };
  f.read.mockResolvedValue(
    success(
      input({
        ...timestamps,
        metricCoverage: f.source.metricCoverage.map((coverage) => ({ ...coverage, ...timestamps })),
      }),
    ),
  );
  f.calculate.mockImplementation((request) => {
    const computed = calculation({ ...request, input: input() });
    return success({ input: request.input, snapshot: { ...computed.snapshot, ...timestamps } });
  });
  const result = value(await f.service.compute({ query: query(), computedAt }));
  expect(result[0]!.visibleAt).toBe(timestamps.visibleAt);
  expect(f.read).toHaveBeenCalledTimes(1);
});

class ReceiverSource implements MetricSourceReader {
  #input = input();
  async read(): Promise<MetricResult<MetricInputV1>> {
    return success(this.#input);
  }
}
class ReceiverRepository implements MetricSnapshotRepository {
  #snapshots: MetricSnapshotV1[] = [];
  async append(computation: MetricComputationV1): Promise<MetricResult<MetricSnapshotV1>> {
    this.#snapshots.push(computation.snapshot);
    return success(this.#snapshots.at(-1)!);
  }
  async read(): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
    return success(this.#snapshots);
  }
}
class ReceiverRegistry implements MetricDefinitionRegistry {
  #registry = createMetricDefinitionRegistry([
    {
      definitionVersion: "v1",
      calculator: { calculate: (request) => success(calculation(request)) },
    },
  ]);
  resolve(version: string) {
    return this.#registry.resolve(version);
  }
}
class ReceiverOptions implements MetricComputationServiceOptions {
  #binding = binding;
  readonly actor = actor;
  readonly source = new ReceiverSource();
  readonly repository = new ReceiverRepository();
  readonly registry = new ReceiverRegistry();
  async authorizeBinding(): Promise<MetricResult<ConnectorBinding>> {
    return success(this.#binding);
  }
}

it.each(["source", "repository", "registry", "authorization"])(
  "preserves the original class %s method receiver without freezing the adapter",
  async (boundary) => {
    const f = fixture();
    const options =
      boundary === "authorization"
        ? new ReceiverOptions()
        : {
            actor,
            source: boundary === "source" ? new ReceiverSource() : { read: f.read },
            repository: boundary === "repository" ? new ReceiverRepository() : f.repository,
            registry: boundary === "registry" ? new ReceiverRegistry() : f.registry,
            authorizeBinding: f.authorizeBinding,
          };
    const adapters = [options, options.source, options.repository, options.registry];
    const frozen = adapters.map(Object.isFrozen);
    const service = createMetricComputationService(options);
    expect(value(await service.compute({ query: query(), computedAt }))).toHaveLength(2);
    expect(adapters.map(Object.isFrozen)).toEqual(frozen);
  },
);

function normalizedCalculation(request: MetricCalculationRequest): MetricComputationV1 {
  const computed = calculation(request);
  const timestamps = {
    periodStart: new Date(request.input.periodStart).toISOString(),
    periodEnd: new Date(request.input.periodEnd).toISOString(),
    visibleAt: new Date(request.input.visibleAt).toISOString(),
    sourceWatermark: new Date(request.input.sourceWatermark!).toISOString(),
  };
  return MetricComputationV1Schema.parse({
    input: {
      ...computed.input,
      ...timestamps,
      metricCoverage: computed.input.metricCoverage.map((coverage) => ({
        ...coverage,
        ...timestamps,
      })),
    },
    snapshot: { ...computed.snapshot, ...timestamps },
  });
}

it("revalidates normalized calculator output against the original frozen input before append", async () => {
  const f = fixture();
  f.calculate.mockImplementation((request) => success(normalizedCalculation(request)));
  const result = value(await f.service.compute({ query: query(), computedAt }));
  expect(f.append).toHaveBeenCalledTimes(2);
  for (const [computation] of f.append.mock.calls) {
    expect(MetricComputationV1Schema.safeParse(computation).success).toBe(true);
    expect(computation.input).toBe(f.calculate.mock.calls[0]![0].input);
    expect(computation.snapshot.visibleAt).toBe(computation.input.visibleAt);
    expect(computation.snapshot.metric.value).toBe(0);
  }
  expect(result.every((snapshot) => snapshot.visibleAt === query().visibleAt)).toBe(true);
});
