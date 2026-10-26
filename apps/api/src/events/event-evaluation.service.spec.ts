import { expect, it } from "vitest";
import {
  createEventFingerprint,
  type BaselinePort,
  type BaselineRequest,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventDetector,
  type EventEvidenceV1,
  type EventResult,
  type MetricReadPort,
  type MetricSnapshotV1,
  type RobustBaselineV1,
} from "@shopmate/contracts";
import { DEFAULT_EVENT_RULE_POLICY } from "./event-rule-policy.js";
import { EventDetectorRegistry, EventEvaluationService } from "./event-evaluation.service.js";
import { StockoutDetector } from "./detectors/stockout.detector.js";

const binding = {
  organizationId: "org-evaluation",
  workspaceId: "workspace-evaluation",
  storeId: "store-evaluation",
  connectionId: "connection-evaluation",
  externalStoreId: "external-evaluation",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const actor = {
  userId: "user-evaluation",
  merchantId: "merchant-evaluation",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "ANALYST",
  permissions: ["tenant:read"],
} as const;
const policy = DEFAULT_EVENT_RULE_POLICY;
const reference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "visible-fact",
  version: "revision-v1",
  hash: "visible-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: null,
} as const;
const common = {
  schemaVersion: 1,
  binding,
  ...period,
  observedAt: period.periodEnd,
  sourceWatermark: period.periodEnd,
  dataStatus: "VERIFIED",
  sampleSize: 24,
  coverageBasisPoints: 10000,
  issues: [],
  definitionVersion: "metrics-v1",
  baseline: null,
  baselineVersion: null,
  baselineAlignment: "MISSING",
  sourceReferences: [reference],
} as const;
const stockFacts = {
  availableUnits: 4,
  salesUnits: 24,
  salesWindow: period,
  salesWindowHours: 24,
  estimatedHoursRemaining: 4,
  supplierLeadTimeHours: 2,
  safetyBufferHours: null,
  inboundETA: null,
  inventoryObservedAt: period.periodEnd,
  inventoryAgeSeconds: 0,
  inventoryStatus: "VERIFIED",
} as const;
const financialFacts = {
  paidRevenueMinor: 20000,
  netRevenueMinor: 20000,
  grossMerchandiseMinor: 20000,
  grossProfitMinor: 2000,
  contributionMinor: 1000,
  discountMinor: 0,
  spendMinor: 0,
  costCoverageBasisPoints: 10000,
  feeCoverageBasisPoints: 10000,
  profitDeltaMinor: -3000,
  attributionVersion: "attribution-v1",
  contributions: [{ kind: "COGS", amountMinor: -3000 }],
  skuContributions: [],
  discountRate: { numerator: 0, denominator: 20000, valueBasisPoints: 0, period },
  promotionPeriod: null,
} as const;
const staleSalesQuality = {
  dataStatus: "STALE",
  sampleSize: 24,
  coverageBasisPoints: 10000,
  issues: [{ code: "STALE_SOURCE", field: "salesUnits", evidenceIds: [reference.id] }],
} as const;
function stock(): Extract<EventEvidenceV1, { eventType: "STOCKOUT_RISK" }> {
  return {
    ...common,
    eventType: "STOCKOUT_RISK",
    entity: { kind: "SKU", externalSkuId: "sku-evaluation" },
    facts: stockFacts,
  };
}
function profit(): EventEvidenceV1 {
  return {
    ...common,
    eventType: "PROFIT_MARGIN_DROP",
    entity: { kind: "STORE" },
    facts: financialFacts,
  };
}
function request(evidence: readonly EventEvidenceV1[] = [stock(), profit()]) {
  return {
    binding,
    period,
    observedAt: period.periodEnd,
    definitionVersion: "metrics-v1",
    inputRevision: "revision-v1",
    sourceWatermark: period.periodEnd,
    rulePolicyVersion: policy.version,
    jobs: evidence.map((value) => ({ evidence: value, measures: [], baselineRequest: null })),
  };
}
function candidate(value: EventDetectionRequest): EventResult<EventDetectionOutcome> {
  return {
    ok: true,
    value: {
      disposition: "CANDIDATE",
      blockedResources: [],
      quality: {
        dataStatus: value.evidence.dataStatus,
        sampleSize: value.evidence.sampleSize,
        coverageBasisPoints: value.evidence.coverageBasisPoints,
        issues: value.evidence.issues,
      },
      candidate: {
        schemaVersion: 1,
        fingerprint: createEventFingerprint(value.evidence),
        severityFloor: "HIGH",
        rulePolicyVersion: value.policy.version,
        evidence: value.evidence,
      },
    },
  };
}
function setup(
  detector: EventDetector = { detect: candidate },
  metrics?: MetricReadPort,
  baselines?: BaselinePort,
) {
  const seen: EventDetectionRequest[] = [];
  const registry = new EventDetectorRegistry(policy, [
    { eventType: "STOCKOUT_RISK", rulePolicyVersion: policy.version, detector },
    {
      eventType: "PROFIT_MARGIN_DROP",
      rulePolicyVersion: policy.version,
      detector: {
        detect: (value) => {
          seen.push(value);
          return candidate(value);
        },
      },
    },
  ]);
  const baseline: BaselinePort = baselines ?? {
    evaluate: () => {
      throw new Error("Unexpected baseline");
    },
  };
  const reads: unknown[] = [];
  const readPort: MetricReadPort = metrics ?? {
    read: async (value) => {
      reads.push(value);
      return { ok: true, value: [] };
    },
  };
  const service = new EventEvaluationService(actor, readPort, baseline, registry);
  return { service, seen, reads, registry };
}
function value<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function snapshot(patch: Partial<MetricSnapshotV1> = {}): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    definitionVersion: "metrics-v1",
    inputRevision: "revision-v1",
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    evidenceIds: [reference.id],
    sampleSize: 24,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "SKU", externalSkuId: "sku-evaluation" },
    metric: { kind: "INVENTORY_AVAILABLE", unit: "units", value: 4 },
    ...patch,
  };
}
function baselineRequest(): BaselineRequest {
  return {
    binding,
    eventType: "STOCKOUT_RISK",
    entity: stock().entity,
    period,
    observedAt: period.periodEnd,
    definitionVersion: "metrics-v1",
    baselineVersion: policy.baselineVersion,
    measure: { kind: "PAID_UNITS", unit: "units" },
    candidates: [],
    sourceReferences: [],
  };
}
function missingBaseline(): RobustBaselineV1 {
  return {
    status: "MISSING",
    alignment: "MISSING",
    measure: { kind: "PAID_UNITS", unit: "units" },
    aggregation: "EXACT_MEDIAN",
    version: policy.baselineVersion,
    period: null,
    median: null,
    mad: null,
    sampleSize: 0,
    coverageBasisPoints: 0,
    sourceReferences: [],
  };
}
function metricRequest() {
  const row = snapshot();
  const evidence = {
    ...stock(),
    sourceReferences: [
      {
        ...reference,
        kind: "METRIC_SNAPSHOT",
        measure: { kind: row.metric.kind, unit: row.metric.unit },
      },
    ],
  };
  return {
    ...request(),
    jobs: [
      {
        evidence,
        measures: [{ kind: row.metric.kind, unit: row.metric.unit }],
        baselineRequest: null,
      },
    ],
  };
}

it("evaluates low stock and profit from one frozen visible version", async () => {
  const observed: EventDetectionRequest[] = [];
  const fixture: EventDetector = {
    detect: (entry) => {
      observed.push(entry);
      return candidate(entry);
    },
  };
  const { service, seen, reads } = setup(fixture);
  const input = request();
  const original = JSON.stringify(input);
  const result = value(await service.evaluate(input));
  expect(result.candidates).toHaveLength(2);
  expect(result.evaluations).toHaveLength(2);
  expect([...observed, ...seen].map((entry) => entry.evidence.definitionVersion)).toEqual([
    "metrics-v1",
    "metrics-v1",
  ]);
  expect(reads).toHaveLength(2);
  expect(reads).toEqual(expect.arrayContaining([expect.objectContaining({ actor })]));
  expect(JSON.stringify(input)).toBe(original);
  expect(Object.isFrozen(observed[0]?.evidence.facts)).toBe(true);
});

it("sorts and deduplicates identical candidates without dropping evaluations", async () => {
  const { service } = setup();
  const first = value(await service.evaluate(request([stock(), profit(), stock()])));
  const second = value(await service.evaluate(request([profit(), stock()])));
  expect(first.candidates).toEqual(second.candidates);
  expect(first.candidates).toHaveLength(2);
  expect(first.evaluations).toHaveLength(3);
});

it("preserves missing and stale quality with resource blockers beside independent candidates", async () => {
  const quality = staleSalesQuality;
  const detector: EventDetector = {
    detect: () => ({
      ok: true,
      value: {
        disposition: "NO_CANDIDATE",
        reason: "STALE_SOURCE",
        quality,
        blockedResources: ["ORDERS"],
      },
    }),
  };
  const { service } = setup(detector);
  const missing = {
    ...stock(),
    ...quality,
    facts: {
      ...stockFacts,
      salesUnits: null,
      estimatedHoursRemaining: null,
    },
  };
  const result = value(await service.evaluate(request([missing, profit()])));
  expect(result.candidates.map((entry) => entry.evidence.eventType)).toEqual([
    "PROFIT_MARGIN_DROP",
  ]);
  expect(result.evaluations).toContainEqual(
    expect.objectContaining({
      outcome: {
        disposition: "NO_CANDIDATE",
        reason: "STALE_SOURCE",
        quality,
        blockedResources: ["ORDERS"],
      },
    }),
  );
});

it.each([
  { rulePolicyVersion: "unknown-v9" },
  { observedAt: "invalid" },
  { inputRevision: "different-revision" },
  { sourceWatermark: null },
  { definitionVersion: "different-definition" },
  { unexpected: true },
])("rejects malformed or drifting run frame %j", async (patch) => {
  expect(await setup().service.evaluate({ ...request(), ...patch })).toMatchObject({ ok: false });
});

it("rejects cross-tenant scope before any metric reads", async () => {
  const { service, reads } = setup();
  expect(
    await service.evaluate({ ...request(), binding: { ...binding, organizationId: "foreign" } }),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(reads).toHaveLength(0);
});

it.each([
  { definitionVersion: "foreign-version" },
  { inputRevision: "foreign-revision" },
  {
    sourceWatermark: "2026-10-24T23:00:00Z",
    status: "ESTIMATED",
    issues: [{ code: "STALE_SOURCE", field: "inventory", evidenceIds: [reference.id] }],
  },
  { subject: { kind: "SKU", externalSkuId: "foreign-sku" } },
  { binding: { ...binding, storeId: "foreign-store" } },
  { computedAt: "2026-10-25T00:00:01Z" },
] satisfies readonly Partial<MetricSnapshotV1>[])(
  "rejects snapshot output drift %j",
  async (patch) => {
    const metrics: MetricReadPort = { read: async () => ({ ok: true, value: [snapshot(patch)] }) };
    expect(await setup(undefined, metrics).service.evaluate(request([stock()]))).toMatchObject({
      ok: false,
    });
  },
);

it("rejects detector foreign facts even with a valid fingerprint", async () => {
  const detector: EventDetector = {
    detect: (entry) =>
      candidate({
        ...entry,
        evidence: {
          ...entry.evidence,
          binding: { ...binding, storeId: "foreign-store" },
          sourceReferences: [{ ...reference, binding: { ...binding, storeId: "foreign-store" } }],
        },
      }),
  };
  expect(await setup(detector).service.evaluate(request([stock()]))).toMatchObject({
    ok: false,
    error: { code: "SCOPE_MISMATCH" },
  });
});

it("rejects a valid detector candidate whose facts differ from the frozen evidence", async () => {
  const detector: EventDetector = {
    detect: (entry) => candidate({ ...entry, evidence: { ...entry.evidence, sampleSize: 999 } }),
  };
  expect(await setup(detector).service.evaluate(request([stock()]))).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});

it("rejects invalid fingerprints and unknown detector fields", async () => {
  const detector: EventDetector = {
    detect: (entry) => {
      const result = value(candidate(entry));
      if (result.disposition !== "CANDIDATE") throw new Error("Expected fixture candidate");
      return {
        ok: true,
        value: { ...result, candidate: { ...result.candidate, fingerprint: "bad" } },
      };
    },
  };
  expect(await setup(detector).service.evaluate(request([stock()]))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

it("returns explicit unavailable errors for thrown ports", async () => {
  const metrics: MetricReadPort = {
    read: async () => {
      throw new Error("provider detail");
    },
  };
  expect(await setup(undefined, metrics).service.evaluate(request())).toEqual({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] },
  });
});

it("rejects registry whitelist and policy-version drift", () => {
  expect(
    () =>
      new EventDetectorRegistry(policy, [
        {
          eventType: "STOCKOUT_RISK",
          rulePolicyVersion: "other-version",
          detector: { detect: candidate },
        },
      ]),
  ).toThrow();
  const registry = new EventDetectorRegistry(policy, [
    {
      eventType: "STOCKOUT_RISK",
      rulePolicyVersion: policy.version,
      detector: { detect: candidate },
    },
  ]);
  expect(registry.has("PROFIT_MARGIN_DROP")).toBe(false);
});

it("rejects unregistered jobs and unauthenticated actors", async () => {
  const registry = new EventDetectorRegistry(policy, []);
  const metrics: MetricReadPort = { read: async () => ({ ok: true, value: [] }) };
  const baseline: BaselinePort = {
    evaluate: () => {
      throw new Error("Unexpected baseline");
    },
  };
  const service = new EventEvaluationService(actor, metrics, baseline, registry);
  expect(await service.evaluate(request())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(
    () => new EventEvaluationService({ ...actor, permissions: [] }, metrics, baseline, registry),
  ).toThrow();
});

it("reads each identical pinned query once and gives detectors immutable snapshots", async () => {
  let reads = 0;
  const metrics: MetricReadPort = {
    read: async () => {
      reads++;
      return { ok: true, value: [snapshot()] };
    },
  };
  const detector: EventDetector = {
    detect: (entry) => {
      expect(Object.isFrozen(entry.snapshots[0]?.metric)).toBe(true);
      return candidate(entry);
    },
  };
  const input = metricRequest();
  const { service } = setup(detector, metrics);
  expect(
    value(await service.evaluate({ ...input, jobs: [...input.jobs, ...input.jobs] })).candidates,
  ).toHaveLength(1);
  expect(reads).toBe(1);
});

it("retains a missing baseline as an explicit detector dependency", async () => {
  const baseline: BaselinePort = {
    evaluate: (entry) => {
      expect(Object.isFrozen(entry.candidates)).toBe(true);
      return { ok: true, value: missingBaseline() };
    },
  };
  const detector: EventDetector = {
    detect: (entry) => {
      expect(entry.baseline?.status).toBe("MISSING");
      return candidate(entry);
    },
  };
  const input = request([stock()]);
  const jobs = [{ ...input.jobs[0], baselineRequest: baselineRequest() }];
  const result = value(
    await setup(detector, undefined, baseline).service.evaluate({ ...input, jobs }),
  );
  expect(result.candidates[0]?.evidence.baselineVersion).toBe(policy.baselineVersion);
});

it.each([
  { version: "foreign-version" },
  { measure: { kind: "INVENTORY_AVAILABLE", unit: "units" } },
] as const)("rejects baseline output drift %j", async (patch) => {
  const baseline: BaselinePort = {
    evaluate: () => ({
      ok: true,
      value: {
        ...missingBaseline(),
        ...patch,
      },
    }),
  };
  const input = request([stock()]);
  const jobs = [{ ...input.jobs[0], baselineRequest: baselineRequest() }];
  expect(
    await setup(undefined, undefined, baseline).service.evaluate({ ...input, jobs }),
  ).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
});

it("preserves typed port failures without leaking thrown implementation details", async () => {
  const metrics: MetricReadPort = {
    read: async () => ({ ok: false, error: { code: "FORBIDDEN", evidenceIds: [reference.id] } }),
  };
  expect(await setup(undefined, metrics).service.evaluate(request())).toEqual({
    ok: false,
    error: { code: "FORBIDDEN", evidenceIds: [reference.id] },
  });
});

it("keeps independent quality diagnostics on a no-candidate outcome", async () => {
  const issues = ["WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const;
  const evidence = {
    ...stock(),
    dataStatus: "INSUFFICIENT",
    issues: issues.map((code) => ({
      code,
      field: "supplierLeadTimeHours",
      evidenceIds: [reference.id],
    })),
  } as const;
  const detector: EventDetector = {
    detect: (entry) => ({
      ok: true,
      value: {
        disposition: "NO_CANDIDATE",
        reason: "INSUFFICIENT_EVIDENCE",
        blockedResources: ["INVENTORY"],
        quality: {
          dataStatus: "INSUFFICIENT",
          sampleSize: 24,
          coverageBasisPoints: 10000,
          issues: entry.evidence.issues,
        },
      },
    }),
  };
  const result = value(await setup(detector).service.evaluate(request([evidence, profit()])));
  expect(result.candidates).toHaveLength(1);
  expect(
    result.evaluations.find((entry) => entry.eventType === "STOCKOUT_RISK")?.outcome.quality.issues,
  ).toEqual(evidence.issues);
});

it("rejects a detector that silently erases input diagnostic reasons", async () => {
  const evidence = {
    ...stock(),
    dataStatus: "INSUFFICIENT",
    issues: [
      {
        code: "LEAD_TIME_MISSING",
        field: "supplierLeadTimeHours",
        evidenceIds: [reference.id],
      },
    ],
  } as const;
  const detector: EventDetector = {
    detect: () => ({
      ok: true,
      value: {
        disposition: "NO_CANDIDATE",
        reason: "BELOW_THRESHOLD",
        blockedResources: [],
        quality: { dataStatus: "VERIFIED", sampleSize: 24, coverageBasisPoints: 10000, issues: [] },
      },
    }),
  };
  expect(await setup(detector).service.evaluate(request([evidence]))).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});

it("cannot change frozen facts through a detector", async () => {
  const detector: EventDetector = {
    detect: (entry) => {
      Object.assign(entry.evidence.facts, { availableUnits: 999 });
      return candidate(entry);
    },
  };
  const input = request([stock()]);
  const original = JSON.stringify(input);
  expect(await setup(detector).service.evaluate(input)).toMatchObject({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE" },
  });
  expect(JSON.stringify(input)).toBe(original);
});

it("does not use test expectations as runtime observations", async () => {
  const testCase = { visible: request(), expectedEvents: ["STOCKOUT_RISK"] };
  const first = await setup().service.evaluate(testCase.visible);
  testCase.expectedEvents = ["NO_EVENTS"];
  expect(await setup().service.evaluate(testCase.visible)).toEqual(first);
});

it("rejects registry invocation with a different policy under the pinned version", () => {
  const { registry } = setup();
  const drift = {
    ...policy,
    rules: policy.rules.filter((entry) => entry.eventType === "STOCKOUT_RISK"),
  };
  expect(
    registry.detect({ evidence: stock(), snapshots: [], baseline: null, policy: drift }),
  ).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
});

it("requires store ownership authorization even for connection-only evaluations", async () => {
  const evidence = {
    ...common,
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    facts: {
      lastSuccessAt: period.periodEnd,
      lagSeconds: 0,
      typedErrorCode: "TIMEOUT",
      affectedResourceKind: "ORDERS",
    },
  } as const;
  const registry = new EventDetectorRegistry(policy, [
    {
      eventType: "SYNC_FAILURE",
      rulePolicyVersion: policy.version,
      detector: { detect: candidate },
    },
  ]);
  const metrics: MetricReadPort = {
    read: async () => ({ ok: false, error: { code: "FORBIDDEN", evidenceIds: [] } }),
  };
  const baseline: BaselinePort = { evaluate: () => ({ ok: true, value: missingBaseline() }) };
  const service = new EventEvaluationService(actor, metrics, baseline, registry);
  expect(await service.evaluate(request([evidence]))).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});

it("retains the pinned run frame when every detector has no candidate", async () => {
  const detector: EventDetector = {
    detect: (entry) => ({
      ok: true,
      value: {
        disposition: "NO_CANDIDATE",
        reason: "BELOW_THRESHOLD",
        blockedResources: [],
        quality: {
          dataStatus: "VERIFIED",
          sampleSize: entry.evidence.sampleSize,
          coverageBasisPoints: 10000,
          issues: [],
        },
      },
    }),
  };
  const result = value(await setup(detector).service.evaluate(request([stock()])));
  expect(result).toMatchObject({
    frame: {
      binding,
      period,
      inputRevision: "revision-v1",
      sourceWatermark: period.periodEnd,
      observedAt: period.periodEnd,
      definitionVersion: "metrics-v1",
      rulePolicyVersion: policy.version,
    },
    candidates: [],
  });
});

it("allows detector quality diagnostics without permitting changes to frozen facts", async () => {
  const detector: EventDetector = {
    detect: (entry) => {
      const quality = {
        dataStatus: "INSUFFICIENT",
        sampleSize: entry.evidence.sampleSize,
        coverageBasisPoints: entry.evidence.coverageBasisPoints,
        issues: [
          {
            code: "LEAD_TIME_MISSING",
            field: "supplierLeadTimeHours",
            evidenceIds: [reference.id],
          },
        ],
      } as const;
      const result = value(candidate({ ...entry, evidence: { ...entry.evidence, ...quality } }));
      return { ok: true, value: { ...result, quality } };
    },
  };
  const result = value(await setup(detector).service.evaluate(request([stock()])));
  expect(result.candidates[0]?.evidence.issues[0]?.code).toBe("LEAD_TIME_MISSING");
});

it("rejects detector outcomes that erase requested snapshot diagnostics", async () => {
  const metrics: MetricReadPort = {
    read: async () => ({
      ok: true,
      value: [
        snapshot({
          status: "STALE",
          issues: [{ code: "STALE_SOURCE", field: "inventory", evidenceIds: [reference.id] }],
        }),
      ],
    }),
  };
  expect(await setup(undefined, metrics).service.evaluate(metricRequest())).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});

it("rejects conflicting metric observations for the same immutable revision", async () => {
  const metrics: MetricReadPort = {
    read: async () => ({
      ok: true,
      value: [
        snapshot(),
        snapshot({
          metric: { kind: "INVENTORY_AVAILABLE", unit: "units", value: 999 },
        }),
      ],
    }),
  };
  expect(await setup(undefined, metrics).service.evaluate(metricRequest())).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});

it("rejects strict-unknown detector output fields", async () => {
  const detector: EventDetector = {
    detect: (entry) => ({ ok: true, value: { ...value(candidate(entry)), unexpected: true } }),
  };
  expect(await setup(detector).service.evaluate(request([stock()]))).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

it("retains fresh sold-out inventory beside blocked stale orders through the real leaf", async () => {
  const evidence = {
    ...stock(),
    dataStatus: "STALE",
    issues: [{ code: "STALE_SOURCE", field: "salesUnits", evidenceIds: [reference.id] }],
    facts: { ...stockFacts, availableUnits: 0, salesUnits: null, estimatedHoursRemaining: null },
  } as const;
  const leaf = new StockoutDetector();
  const detector: EventDetector = {
    detect: (entry) => {
      const result = leaf.detect(entry);
      return result.ok
        ? { ok: true, value: { ...result.value, blockedResources: ["ORDERS"] } }
        : result;
    },
  };
  const result = value(await setup(detector).service.evaluate(request([evidence, profit()])));
  expect(result.candidates).toHaveLength(2);
  expect(
    result.candidates.find((entry) => entry.evidence.eventType === "STOCKOUT_RISK"),
  ).toMatchObject({ severityFloor: "CRITICAL", evidence: { facts: { availableUnits: 0 } } });
  expect(
    result.evaluations.find((entry) => entry.eventType === "STOCKOUT_RISK")?.outcome,
  ).toMatchObject({
    disposition: "CANDIDATE",
    blockedResources: ["ORDERS"],
    quality: {
      dataStatus: "STALE",
      issues: expect.arrayContaining([...evidence.issues]),
    },
  });
});
