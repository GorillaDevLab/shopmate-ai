import { expect, it } from "vitest";
import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  createEventFingerprint,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventEvidenceV1,
  type EventRulePolicyV1,
  type MetricSnapshotV1,
} from "@shopmate/contracts";
import { StockoutDetector } from "./stockout.detector.js";
import { SyncQualityDetector } from "./sync-quality.detector.js";

type Sync = Extract<EventEvidenceV1, { eventType: "SYNC_FAILURE" }>;
type Revenue = Extract<EventEvidenceV1, { eventType: "REVENUE_DROP" }>;
type Stockout = Extract<EventEvidenceV1, { eventType: "STOCKOUT_RISK" }>;
type Conversion = Extract<EventEvidenceV1, { eventType: "CONVERSION_DROP" }>;
const binding = {
  organizationId: "org-sync",
  workspaceId: "workspace-sync",
  storeId: "store-sync",
  connectionId: "connection-sync",
  externalStoreId: "external-sync",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const ruleQuality = {
  minimumSampleSize: 10,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 0,
} as const;
const policy = {
  schemaVersion: 1,
  version: "event-rules-v1",
  baselineVersion: "baseline-v1",
  rules: [
    { ...ruleQuality, eventType: "SYNC_FAILURE", thresholds: { maximumLagSeconds: 600 } },
    {
      ...ruleQuality,
      eventType: "REVENUE_DROP",
      thresholds: { relativeDropBasisPoints: 2000, minimumDropMinor: 1000 },
    },
    {
      ...ruleQuality,
      eventType: "STOCKOUT_RISK",
      requireAlignedBaseline: false,
      thresholds: { criticalHoursRemaining: 6, leadTimeBufferHours: 1 },
    },
    {
      ...ruleQuality,
      eventType: "CONVERSION_DROP",
      requireAlignedBaseline: false,
      thresholds: { relativeDropBasisPoints: 2000, minimumVisitors: 10 },
    },
  ],
} satisfies EventRulePolicyV1;

function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: ["observed-sync"] };
}
function common() {
  return {
    schemaVersion: 1 as const,
    binding,
    ...period,
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED" as const,
    sampleSize: 24,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: null,
    baselineVersion: null,
    baselineAlignment: "MISSING" as const,
    sourceReferences: [reference()],
  };
}
function reference() {
  return {
    kind: "NORMALIZED_AGGREGATE" as const,
    id: "observed-sync",
    version: "source-v1",
    hash: "sync-hash",
    binding,
    definitionVersion: "metrics-v1",
    period,
    observedAt: period.periodEnd,
    measure: null,
  };
}
function sync(facts: Partial<Sync["facts"]> = {}): Sync {
  return {
    ...common(),
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    facts: {
      lastSuccessAt: period.periodEnd,
      lagSeconds: 0,
      typedErrorCode: "TIMEOUT",
      affectedResourceKind: "ORDERS",
      ...facts,
    },
  };
}
function revenue(): Revenue {
  return {
    ...common(),
    eventType: "REVENUE_DROP",
    entity: { kind: "STORE" },
    facts: {
      paidRevenueMinor: null,
      netRevenueMinor: null,
      grossMerchandiseMinor: null,
      grossProfitMinor: null,
      contributionMinor: null,
      discountMinor: null,
      spendMinor: null,
      costCoverageBasisPoints: 0,
      feeCoverageBasisPoints: 0,
      profitDeltaMinor: null,
      attributionVersion: null,
      contributions: [],
      skuContributions: [],
      discountRate: { numerator: null, denominator: null, valueBasisPoints: null, period },
      promotionPeriod: null,
    },
  };
}
function stockout(): Stockout {
  return {
    ...common(),
    eventType: "STOCKOUT_RISK",
    entity: { kind: "SKU", externalSkuId: "sku-sync" },
    facts: {
      availableUnits: 0,
      salesUnits: null,
      salesWindow: period,
      salesWindowHours: 24,
      estimatedHoursRemaining: null,
      supplierLeadTimeHours: null,
      safetyBufferHours: null,
      inboundETA: null,
      inventoryObservedAt: period.periodEnd,
      inventoryAgeSeconds: 0,
      inventoryStatus: "VERIFIED",
    },
  };
}
function conversion(original: DataQualityIssueV1): Conversion {
  return {
    ...common(),
    dataStatus: "INSUFFICIENT",
    issues: [original],
    eventType: "CONVERSION_DROP",
    entity: { kind: "STORE" },
    facts: {
      visitors: 100,
      cart: 40,
      checkout: 30,
      paidOrders: 20,
      conversion: { numerator: 20, denominator: 100, valueBasisPoints: 2000, period },
      baselineConversion: null,
      priceChangeBasisPoints: null,
      priceEffectiveAt: null,
      variantAvailabilityBasisPoints: null,
      relationship: "CORRELATION_ONLY",
    },
  };
}
function request(value: EventEvidenceV1 = sync()): EventDetectionRequest {
  return EventDetectionRequestSchema.parse({
    evidence: value,
    snapshots: [],
    baseline: value.baseline,
    policy,
  });
}
function outcome(value: EventEvidenceV1 = sync()): EventDetectionOutcome {
  const result = new SyncQualityDetector().detect(request(value));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}

it("emits a typed sync failure despite missing business baseline or low sample", () => {
  const value = { ...sync(), sampleSize: 0 };
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected sync candidate");
  expect(result.candidate.evidence.facts).toEqual(value.facts);
  expect(result.candidate.evidence.eventType).toBe("SYNC_FAILURE");
  expect(result.candidate.fingerprint).toBe(createEventFingerprint(value));
  expect(result.candidate.rulePolicyVersion).toBe(policy.version);
  expect(result.blockedResources).toEqual(["ORDERS"]);
});

it.each(["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"] as const)(
  "blocks only the failed %s resource",
  (affectedResourceKind) => {
    expect(outcome(sync({ affectedResourceKind })).blockedResources).toEqual([
      affectedResourceKind,
    ]);
  },
);

it("returns INSUFFICIENT_EVIDENCE for low business sample and missing baseline without a sync claim", () => {
  const value = { ...revenue(), sampleSize: 0 };
  expect(outcome(value)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
    blockedResources: [],
    quality: {
      sampleSize: 0,
      issues: expect.arrayContaining([expect.objectContaining({ code: "LOW_SAMPLE" })]),
    },
  });
});

it("preserves every stale sales diagnostic while retaining a fresh independent sold-out fact", () => {
  const reasons = [
    issue("STALE_SOURCE", "sales"),
    issue("WINDOW_MISMATCH", "sales"),
    issue("VERSION_MISMATCH", "sales"),
  ];
  const value = { ...stockout(), dataStatus: "STALE" as const, issues: reasons };
  const gated = outcome(value);
  expect(gated.blockedResources).toEqual(["ORDERS"]);
  expect(gated.quality.issues).toEqual(expect.arrayContaining(reasons));
  const observed = new StockoutDetector().detect(request(value));
  expect(observed).toMatchObject({
    ok: true,
    value: { disposition: "CANDIDATE", candidate: { severityFloor: "CRITICAL" } },
  });
});

it("suppresses stale sales revenue claims with an ORDERS blocker", () => {
  const original = issue("STALE_SOURCE", "sales");
  expect(outcome({ ...revenue(), dataStatus: "STALE", issues: [original] })).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
    blockedResources: ["ORDERS"],
    quality: { issues: expect.arrayContaining([original]) },
  });
});

function lagged(seconds: number): Sync {
  return {
    ...sync({ typedErrorCode: "NOT_SYNCHRONIZED", lagSeconds: seconds }),
    observedAt: new Date(Date.parse(period.periodEnd) + seconds * 1000).toISOString(),
  };
}

it.each([599, 600, 601])(
  "compares %s seconds to the exact exclusive policy lag limit",
  (seconds) => {
    const result = outcome(lagged(seconds));
    expect(result.disposition).toBe(seconds > 600 ? "CANDIDATE" : "NO_CANDIDATE");
    expect(result.blockedResources).toEqual(seconds > 600 ? ["ORDERS"] : []);
  },
);

it("uses an injected lag threshold instead of a hidden default", () => {
  const input = request(lagged(601));
  const custom = {
    ...policy,
    rules: [{ ...ruleQuality, eventType: "SYNC_FAILURE", thresholds: { maximumLagSeconds: 601 } }],
  } satisfies EventRulePolicyV1;
  expect(new SyncQualityDetector().detect({ ...input, policy: custom })).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD", blockedResources: [] },
  });
});

it("uses last-success age when supplied lag is null without filling the null fact", () => {
  const value = lagged(601);
  const result = outcome({ ...value, facts: { ...value.facts, lagSeconds: null } });
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected sync candidate");
  expect(result.candidate.evidence.facts).toMatchObject({ lagSeconds: null });
});

it("never interprets missing success and watermark as healthy synchronization", () => {
  const value: Sync = {
    ...sync({ lastSuccessAt: null, lagSeconds: null, typedErrorCode: "NOT_SYNCHRONIZED" }),
    sourceWatermark: null,
    dataStatus: "UNAVAILABLE",
    sampleSize: 0,
    coverageBasisPoints: 0,
    issues: [issue("NOT_SYNCHRONIZED", "orders")],
  };
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected sync candidate");
  expect(result.candidate.evidence.sourceWatermark).toBeNull();
  expect(result.candidate.evidence.facts).toMatchObject({ lastSuccessAt: null, lagSeconds: null });
  expect(result.quality.issues).toEqual(expect.arrayContaining([...value.issues]));
});

it.each([
  "TIMEOUT",
  "RATE_LIMIT",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "TEMPORARY",
  "INVALID_RESPONSE",
] as const)(
  "emits the explicit typed failure %s even before the lag threshold",
  (typedErrorCode) => {
    expect(outcome(sync({ typedErrorCode })).disposition).toBe("CANDIDATE");
  },
);

it.each(["rawException", "exception", "token", "accessToken", "message", "error"])(
  "rejects raw secret-bearing facts field %s without echoing it",
  (field) => {
    const value = sync();
    const raw = request(value);
    const result = new SyncQualityDetector().detect({
      ...raw,
      evidence: { ...value, facts: { ...value.facts, [field]: "sensitive-fixture" } },
    });
    expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
    expect(JSON.stringify(result)).not.toContain("sensitive-fixture");
  },
);

it.each([
  { typedErrorCode: "untyped-sensitive-fixture" },
  { lastSuccessAt: "2026-10-25T00:00:01Z" },
  { lagSeconds: 1 },
  { lagSeconds: -1 },
  { lagSeconds: 0.5 },
  { lastSuccessAt: null, lagSeconds: 0 },
])("rejects invalid, future or inconsistent typed synchronization facts %j", (facts) => {
  const raw = request();
  const result = new SyncQualityDetector().detect({
    ...raw,
    evidence: { ...sync(), facts: { ...sync().facts, ...facts } },
  } as unknown as EventDetectionRequest);
  expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
});

it("rejects a watermark after the last successful synchronization", () => {
  const value = lagged(601);
  const raw = { ...request(value), evidence: { ...value, sourceWatermark: value.observedAt } };
  expect(new SyncQualityDetector().detect(raw)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it.each(["sourceWatermark", "observedAt"] as const)("rejects a future or premature %s", (field) => {
  const raw = request();
  const timestamp = field === "sourceWatermark" ? "2026-10-25T00:00:01Z" : "2026-10-24T23:59:59Z";
  expect(
    new SyncQualityDetector().detect({ ...raw, evidence: { ...raw.evidence, [field]: timestamp } }),
  ).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
});

it("retains missing baseline and every original independent quality reason", () => {
  const originals = [
    issue("LOW_SAMPLE", "sales"),
    issue("COST_MISSING", "frozenCosts"),
    issue("FEE_MISSING", "fees"),
  ];
  const value = { ...revenue(), dataStatus: "INSUFFICIENT" as const, issues: originals };
  const result = outcome(value);
  expect(result).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
    blockedResources: [],
  });
  expect(result.quality.issues).toEqual(expect.arrayContaining(originals));
  expect(value.baseline).toBeNull();
  expect(value.facts.paidRevenueMinor).toBeNull();
});

it.each(["WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "blocks only the named inventory dependency for %s",
  (code) => {
    const original = issue(code, "facts.inventoryObservedAt");
    expect(
      outcome({ ...stockout(), dataStatus: "INSUFFICIENT", issues: [original] }),
    ).toMatchObject({
      disposition: "NO_CANDIDATE",
      blockedResources: ["INVENTORY"],
      quality: { issues: expect.arrayContaining([original]) },
    });
  },
);

function snapshot(): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    definitionVersion: "metrics-v1",
    inputRevision: "source-v1",
    binding,
    ...period,
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    evidenceIds: ["observed-sync"],
    sampleSize: 24,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 100 },
  };
}
function snapshotRequest(row: MetricSnapshotV1): EventDetectionRequest {
  const value = revenue();
  return EventDetectionRequestSchema.parse({
    evidence: {
      ...value,
      sourceReferences: [
        ...value.sourceReferences,
        {
          ...reference(),
          kind: "METRIC_SNAPSHOT",
          id: "snapshot-sync",
          measure: { kind: row.metric.kind, unit: row.metric.unit },
        },
      ],
    },
    snapshots: [row],
    baseline: null,
    policy,
  });
}

it("retains snapshot-specific stale reasons when enclosing evidence appears fresh", () => {
  const original = issue("STALE_SOURCE", "sourceWatermark");
  const row = {
    ...snapshot(),
    status: "STALE" as const,
    issues: [original],
    sourceWatermark: "2026-10-24T22:59:59Z",
  };
  expect(new SyncQualityDetector().detect(snapshotRequest(row))).toMatchObject({
    ok: true,
    value: {
      disposition: "NO_CANDIDATE",
      reason: "STALE_SOURCE",
      blockedResources: ["ORDERS"],
      quality: { dataStatus: "STALE", issues: expect.arrayContaining([original]) },
    },
  });
});

it("preserves null snapshot facts and blocks an unsynchronized source", () => {
  const original = issue("NOT_SYNCHRONIZED", "paymentFacts");
  const row: MetricSnapshotV1 = {
    ...snapshot(),
    status: "UNAVAILABLE",
    sourceWatermark: null,
    metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: null },
    issues: [original],
  };
  const input = snapshotRequest(row);
  expect(new SyncQualityDetector().detect(input)).toMatchObject({
    ok: true,
    value: {
      disposition: "NO_CANDIDATE",
      blockedResources: ["ORDERS"],
      quality: { dataStatus: "UNAVAILABLE", issues: expect.arrayContaining([original]) },
    },
  });
  expect(input.snapshots[0]?.metric.value).toBeNull();
});

it("never converts a low-volume but synchronized snapshot into a source failure", () => {
  const original = issue("LOW_SAMPLE", "paidOrders");
  const row = { ...snapshot(), status: "INSUFFICIENT" as const, sampleSize: 0, issues: [original] };
  expect(new SyncQualityDetector().detect(snapshotRequest(row))).toMatchObject({
    ok: true,
    value: {
      disposition: "NO_CANDIDATE",
      reason: "INSUFFICIENT_EVIDENCE",
      blockedResources: [],
      quality: { issues: expect.arrayContaining([original]) },
    },
  });
});

it("uses snapshot dependency provenance for generic diagnostics on refund metrics", () => {
  const original = issue("VERSION_MISMATCH", "definitionVersion");
  const row: MetricSnapshotV1 = {
    ...snapshot(),
    status: "INSUFFICIENT",
    issues: [original],
    metric: { kind: "REFUND_SETTLED_AMOUNT", unit: "minorCNY", value: 0 },
  };
  expect(new SyncQualityDetector().detect(snapshotRequest(row))).toMatchObject({
    ok: true,
    value: {
      blockedResources: ["REFUNDS"],
      quality: { issues: expect.arrayContaining([original]) },
    },
  });
});

it("uses the frozen maximum source age with millisecond precision", () => {
  const value = revenue();
  const observedAt = "2026-10-25T01:00:00.001Z";
  expect(outcome({ ...value, observedAt })).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
    blockedResources: ["ORDERS"],
  });
});

it("leaves the exact source-age boundary unblocked", () => {
  expect(outcome({ ...revenue(), observedAt: "2026-10-25T01:00:00Z" }).blockedResources).toEqual(
    [],
  );
});

it("does not let mismatched optional inventory ETA block independent sales", () => {
  const original = issue("WINDOW_MISMATCH", "facts.inboundETA");
  const value = { ...stockout(), dataStatus: "INSUFFICIENT" as const, issues: [original] };
  expect(outcome(value).blockedResources).toEqual(["INVENTORY"]);
  expect(new StockoutDetector().detect(request(value))).toMatchObject({
    ok: true,
    value: { disposition: "CANDIDATE", candidate: { severityFloor: "CRITICAL" } },
  });
});

it("rejects unknown root fields without copying raw diagnostic details", () => {
  const result = new SyncQualityDetector().detect({
    ...request(),
    token: "redacted",
  } as unknown as EventDetectionRequest);
  expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
});

it("does not mutate a caller-owned immutable request while adding diagnostics", () => {
  const input = request();
  const before = JSON.stringify(input);
  new SyncQualityDetector().detect(input);
  expect(JSON.stringify(input)).toBe(before);
});

it("emits a sync candidate when source data is stale despite a recent successful job", () => {
  const original = issue("STALE_SOURCE", "orders");
  const value: Sync = {
    ...lagged(0),
    sourceWatermark: "2026-10-24T22:59:59Z",
    dataStatus: "STALE",
    issues: [original],
  };
  expect(outcome(value)).toMatchObject({
    disposition: "CANDIDATE",
    blockedResources: ["ORDERS"],
    quality: { dataStatus: "STALE", issues: expect.arrayContaining([original]) },
  });
});

it("keeps all one hundred original reasons within the public output limit", () => {
  const originals = Array.from({ length: 100 }, (_, index) =>
    issue("LOW_SAMPLE", `sample.${index}`),
  );
  const value: Sync = { ...sync(), dataStatus: "INSUFFICIENT", issues: originals };
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues).toEqual(originals);
  expect(result.blockedResources).toEqual(["ORDERS"]);
});

it("returns typed overflow rather than discarding excess snapshot reasons", () => {
  const originals = Array.from({ length: 101 }, (_, index) =>
    issue("LOW_SAMPLE", `sample.${index}`),
  );
  const row = { ...snapshot(), status: "INSUFFICIENT" as const, issues: originals };
  expect(new SyncQualityDetector().detect(snapshotRequest(row))).toEqual({
    ok: false,
    error: { code: "OVERFLOW", evidenceIds: [] },
  });
});

it.each([
  { binding: { ...binding, storeId: "another-store" } },
  { definitionVersion: "another-definition" },
  { periodStart: "2026-10-23T00:00:00Z" },
  { computedAt: "2026-10-25T00:00:00.001Z" },
])("rejects frozen snapshot scope, version, period or observation changes %j", (change) => {
  const input = snapshotRequest(snapshot());
  expect(
    new SyncQualityDetector().detect({ ...input, snapshots: [{ ...snapshot(), ...change }] }),
  ).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it("blocks the named cost source without blaming fresh order and refund dependencies", () => {
  const original = issue("SOURCE_INCONSISTENT", "frozenCosts");
  const row: MetricSnapshotV1 = {
    ...snapshot(),
    status: "INSUFFICIENT",
    issues: [original],
    metric: { kind: "GROSS_PROFIT", unit: "minorCNY", value: 0 },
  };
  expect(new SyncQualityDetector().detect(snapshotRequest(row))).toMatchObject({
    ok: true,
    value: {
      blockedResources: ["PRODUCTS"],
      quality: { issues: expect.arrayContaining([original]) },
    },
  });
});

it("keeps an independent source blocker when the original reason list is full", () => {
  const originals = Array.from({ length: 100 }, (_, index) =>
    issue("LOW_SAMPLE", `sample.${index}`),
  );
  const value: Revenue = {
    ...revenue(),
    observedAt: "2026-10-25T01:00:00.001Z",
    dataStatus: "INSUFFICIENT",
    issues: originals,
  };
  expect(outcome(value)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
    blockedResources: ["ORDERS"],
    quality: { dataStatus: "STALE", issues: originals },
  });
});

it.each([
  ["WINDOW_MISMATCH", "traffic.window"],
  ["SOURCE_INCONSISTENT", "traffic.funnel"],
  ["STALE_SOURCE", "visitors"],
  ["VERSION_MISMATCH", "cart"],
  ["SOURCE_TIME_MISSING", "checkout"],
  ["NOT_SYNCHRONIZED", "facts.visitors"],
  ["WINDOW_MISMATCH", "facts.cart"],
  ["SOURCE_INCONSISTENT", "facts.checkout"],
  ["NOT_SYNCHRONIZED", "traffic"],
] as const)("attributes %s on %s only to the funnel source", (code, field) => {
  const original = issue(code, field);
  expect(outcome(conversion(original))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason:
      code === "STALE_SOURCE"
        ? "STALE_SOURCE"
        : code === "SOURCE_INCONSISTENT"
          ? "SOURCE_CONFLICT"
          : "INSUFFICIENT_EVIDENCE",
    blockedResources: ["ORDERS"],
    quality: { issues: [original] },
  });
});

it.each([
  ["WINDOW_MISMATCH", "traffic.window"],
  ["SOURCE_INCONSISTENT", "traffic.funnel"],
] as const)("preserves independent sold-out inventory despite %s on %s", (code, field) => {
  const original = issue(code, field);
  const value = { ...stockout(), dataStatus: "INSUFFICIENT" as const, issues: [original] };
  expect(outcome(value)).toMatchObject({
    blockedResources: ["ORDERS"],
    quality: { issues: [original] },
  });
  expect(new StockoutDetector().detect(request(value))).toMatchObject({
    ok: true,
    value: { disposition: "CANDIDATE", candidate: { severityFloor: "CRITICAL" } },
  });
});

it.each([
  ["CONVERSION_RATE", "visitors"],
  ["CART_RATE", "cart"],
  ["CHECKOUT_RATE", "checkout"],
] as const)("keeps %s snapshot and %s fact blockers consistent", (kind, field) => {
  const original = issue("WINDOW_MISMATCH", "traffic.window");
  const row: MetricSnapshotV1 = {
    ...snapshot(),
    status: "INSUFFICIENT",
    issues: [original],
    metric: { kind, unit: "basisPoints", value: 2000 },
  };
  const result = new SyncQualityDetector().detect(snapshotRequest(row));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  const fact = outcome(conversion(issue(original.code, field)));
  expect(result.value.blockedResources).toEqual(["ORDERS"]);
  expect(fact.blockedResources).toEqual(result.value.blockedResources);
  expect(result.value.quality.issues).toEqual(expect.arrayContaining([original]));
});

it("does not turn missing traffic measurements into a source-failure blocker", () => {
  const original = issue("TRAFFIC_MISSING", "traffic.window");
  expect(outcome(conversion(original))).toMatchObject({
    blockedResources: [],
    quality: { issues: [original] },
  });
});

it("does not invent resource blame for an unrelated diagnostic field", () => {
  const original = issue("WINDOW_MISMATCH", "unrelated.window");
  expect(outcome(conversion(original))).toMatchObject({
    blockedResources: [],
    quality: { issues: [original] },
  });
});
