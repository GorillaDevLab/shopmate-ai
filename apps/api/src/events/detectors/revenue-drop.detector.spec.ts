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
  type RobustBaselineV1,
} from "@shopmate/contracts";
import { RevenueDropDetector } from "./revenue-drop.detector.js";
import { createRobustBaseline } from "../robust-baseline.js";

type Evidence = Extract<EventEvidenceV1, { eventType: "REVENUE_DROP" }>;
type Kind = "PAID_REVENUE" | "NET_REVENUE_SETTLEMENT";
const binding = {
  organizationId: "org-revenue",
  workspaceId: "workspace-revenue",
  storeId: "store-revenue",
  connectionId: "connection-revenue",
  externalStoreId: "external-revenue",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-24T04:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const previous = {
  ...period,
  periodStart: "2026-10-17T00:00:00Z",
  periodEnd: "2026-10-17T04:00:00Z",
};
const policy = {
  schemaVersion: 1,
  version: "revenue-rules-v1",
  baselineVersion: "baseline-v1",
  rules: [
    {
      eventType: "REVENUE_DROP",
      minimumSampleSize: 10,
      minimumCoverageBasisPoints: 9000,
      maximumAgeSeconds: 3600,
      minimumBaselineSamples: 4,
      requireAlignedBaseline: true,
      toleranceBasisPoints: 0,
      thresholds: { relativeDropBasisPoints: 2000, minimumDropMinor: 1000 },
    },
  ],
} satisfies EventRulePolicyV1;
const reference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "computed-revenue",
  version: "source-v1",
  hash: "revenue-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
} as const;
function baseline(median = 10000, kind: Kind = "PAID_REVENUE"): RobustBaselineV1 {
  return {
    status: median === 0 ? "ZERO" : "AVAILABLE",
    alignment: "ALIGNED",
    measure: { kind, unit: "minorCNY" },
    aggregation: "EXACT_MEDIAN",
    version: "baseline-v1",
    period: previous,
    median,
    mad: 100,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [
      {
        ...reference,
        id: "historical-revenue",
        period: previous,
        observedAt: previous.periodEnd,
        measure: { kind, unit: "minorCNY" },
      },
    ],
  } as RobustBaselineV1;
}
function facts(overrides: Partial<Evidence["facts"]> = {}): Evidence["facts"] {
  return {
    paidRevenueMinor: 7000,
    netRevenueMinor: 3000,
    grossMerchandiseMinor: 10000,
    grossProfitMinor: null,
    contributionMinor: null,
    discountMinor: 0,
    spendMinor: null,
    costCoverageBasisPoints: 0,
    feeCoverageBasisPoints: 0,
    profitDeltaMinor: null,
    attributionVersion: null,
    contributions: [],
    skuContributions: [],
    discountRate: { numerator: 0, denominator: 10000, valueBasisPoints: 0, period },
    promotionPeriod: null,
    ...overrides,
  };
}
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  const before = baseline();
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "REVENUE_DROP",
    entity: { kind: "STORE" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 30,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: before,
    baselineVersion: before.version,
    baselineAlignment: before.alignment,
    sourceReferences: [reference],
    facts: facts(),
    ...overrides,
  };
}
function request(
  value = evidence(),
  configuration: EventRulePolicyV1 = policy,
): EventDetectionRequest {
  return EventDetectionRequestSchema.parse({
    evidence: value,
    baseline: value.baseline,
    snapshots: [],
    policy: configuration,
  });
}
function detect(input = request()): EventDetectionOutcome {
  const result = new RevenueDropDetector().detect(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function changed(current: number, median = 10000): EventDetectionRequest {
  return request(
    evidence({ baseline: baseline(median), facts: facts({ paidRevenueMinor: current }) }),
  );
}

it("emits a real aligned four-hour decline with immutable evidence and policy version", () => {
  const input = request();
  const before = JSON.stringify(input);
  const result = detect(input);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected revenue candidate");
  expect(result.candidate.evidence).toEqual(input.evidence);
  expect(result.candidate.fingerprint).toBe(createEventFingerprint(input.evidence));
  expect(result.candidate.rulePolicyVersion).toBe(policy.version);
  expect(result.quality.dataStatus).toBe("VERIFIED");
  expect(JSON.stringify(input)).toBe(before);
});
it("does not mistake a lower seasonal four-hour total for a decline against yesterday", () => {
  const yesterdayWholeDayMinor = 40000;
  const input = changed(10000);
  expect(evidence().facts.paidRevenueMinor).toBeLessThan(yesterdayWholeDayMinor);
  expect(detect(input)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "NORMAL_SEASONALITY",
  });
});
it.each([
  [8000, "CANDIDATE"],
  [8001, "NO_CANDIDATE"],
  [11000, "NO_CANDIDATE"],
] as const)("compares the inclusive relative threshold at %i minor CNY", (current, disposition) => {
  expect(detect(changed(current)).disposition).toBe(disposition);
});
it.each([
  [7900, "CANDIDATE"],
  [7901, "NO_CANDIDATE"],
] as const)(
  "applies the explicit policy tolerance inclusively at %i minor CNY",
  (current, disposition) => {
    const configuration = { ...policy, rules: [{ ...policy.rules[0], toleranceBasisPoints: 500 }] };
    expect(
      detect(request(evidence({ facts: facts({ paidRevenueMinor: current }) }), configuration))
        .disposition,
    ).toBe(disposition);
  },
);
it.each([
  [9001, "NO_CANDIDATE"],
  [9000, "CANDIDATE"],
] as const)("requires the inclusive absolute minimum at %i minor CNY", (current, disposition) => {
  const thresholds = { relativeDropBasisPoints: 0, minimumDropMinor: 1000 };
  const configuration = { ...policy, rules: [{ ...policy.rules[0], thresholds }] };
  expect(
    detect(request(evidence({ facts: facts({ paidRevenueMinor: current }) }), configuration))
      .disposition,
  ).toBe(disposition);
});
it("uses the authoritative fractional median without rounding to a representative sample", () => {
  expect(detect(changed(8000, 10000.5)).disposition).toBe("CANDIDATE");
  expect(detect(changed(8001, 10000.5)).disposition).toBe("NO_CANDIDATE");
});
it("compares oversized threshold products without unsafe number intermediates", () => {
  const median = Number.MAX_SAFE_INTEGER;
  expect(detect(changed(7205759403792792, median)).disposition).toBe("CANDIDATE");
  expect(detect(changed(7205759403792793, median)).disposition).toBe("NO_CANDIDATE");
});
it("exposes an exact signed revenue comparison without changing shared evidence", () => {
  const input = changed(7000, 10000.5);
  const result = new RevenueDropDetector().explain(input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      outcome: { disposition: "CANDIDATE" },
      comparison: {
        currentMinor: 7000,
        baselineMinor: 10000.5,
        signedDeltaMinor: { numerator: "-6001", denominator: "2" },
        measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
        thresholds: {
          relativeDropBasisPoints: 2000,
          minimumDropMinor: 1000,
          toleranceBasisPoints: 0,
        },
        definitionVersion: "metrics-v1",
        baselineVersion: "baseline-v1",
        rulePolicyVersion: policy.version,
        binding,
        period,
        sourceReferences: input.evidence.sourceReferences,
        baselineReferences: input.baseline?.sourceReferences,
      },
    },
  });
});

function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: [reference.id] };
}
function historical(before: RobustBaselineV1 | null): Evidence {
  return evidence({
    baseline: before,
    baselineVersion: before?.version ?? null,
    baselineAlignment: before?.alignment ?? "MISSING",
  });
}
it.each(["MISSING", "UNALIGNED", "INSUFFICIENT", "STALE"] as const)(
  "withholds a %s baseline with its quality reason",
  (status) => {
    const unavailable = status === "MISSING" || status === "UNALIGNED";
    const before: RobustBaselineV1 = {
      ...baseline(),
      status,
      median: null,
      mad: null,
      alignment: unavailable ? status : "ALIGNED",
      period: unavailable ? null : previous,
      sourceReferences: status === "MISSING" ? [] : baseline().sourceReferences,
    };
    const code =
      status === "STALE"
        ? "STALE_SOURCE"
        : status === "UNALIGNED"
          ? "WINDOW_MISMATCH"
          : "LOW_SAMPLE";
    expect(detect(request(historical(before)))).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "BASELINE_UNAVAILABLE",
      quality: {
        issues: expect.arrayContaining([expect.objectContaining({ code, field: "baseline" })]),
      },
    });
    expect(new RevenueDropDetector().explain(request(historical(before)))).toMatchObject({
      ok: true,
      value: { comparison: null },
    });
  },
);
it("withholds a missing baseline instead of treating absence as zero", () => {
  expect(detect(request(historical(null)))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
    quality: { issues: expect.arrayContaining([expect.objectContaining({ field: "baseline" })]) },
  });
});
it.each([
  [{ sampleSize: 3 }, "LOW_SAMPLE"],
  [{ coverageBasisPoints: 8999 }, "PARTIAL_COVERAGE"],
] as const)("suppresses insufficient historical quality %j", (patch, code) => {
  expect(detect(request(historical({ ...baseline(), ...patch })))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
    quality: { issues: expect.arrayContaining([expect.objectContaining({ code })]) },
  });
});
it("requires a supported revenue basis instead of interpreting profit as revenue", () => {
  const before: RobustBaselineV1 = {
    ...baseline(),
    measure: { kind: "GROSS_PROFIT", unit: "minorCNY" },
    sourceReferences: baseline().sourceReferences.map((ref) => ({
      ...ref,
      measure: { kind: "GROSS_PROFIT", unit: "minorCNY" },
    })),
  };
  expect(detect(request(historical(before)))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
    quality: {
      issues: expect.arrayContaining([expect.objectContaining({ code: "VERSION_MISMATCH" })]),
    },
  });
});
it.each([
  [{ sampleSize: 9 }, "LOW_SAMPLE"],
  [
    {
      sourceWatermark: "2026-10-24T02:59:59Z",
      dataStatus: "ESTIMATED",
      issues: [issue("STALE_SOURCE", "sourceWatermark")],
    },
    "STALE_SOURCE",
  ],
  [
    {
      coverageBasisPoints: 8999,
      dataStatus: "INSUFFICIENT",
      issues: [issue("PARTIAL_COVERAGE", "coverageBasisPoints")],
    },
    "PARTIAL_COVERAGE",
  ],
] satisfies readonly (readonly [Partial<Evidence>, string])[])(
  "suppresses insufficient current quality %j",
  (patch, code) => {
    expect(detect(request(evidence(patch)))).toMatchObject({
      disposition: "NO_CANDIDATE",
      quality: { issues: expect.arrayContaining([expect.objectContaining({ code })]) },
    });
  },
);
it("preserves payment uncertainty while suppressing a deterministic decline", () => {
  const limitation = issue("PAYMENT_UNKNOWN", "paymentFacts");
  const value = evidence({ dataStatus: "INSUFFICIENT", issues: [limitation] });
  expect(detect(request(value))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
    quality: { dataStatus: "INSUFFICIENT", issues: expect.arrayContaining([limitation]) },
  });
});
it("retains unrelated cost quality without hiding an observed paid revenue decline", () => {
  const limitation = issue("COST_MISSING", "costCoverageBasisPoints");
  const value = evidence({ dataStatus: "INSUFFICIENT", issues: [limitation] });
  expect(detect(request(value))).toMatchObject({
    disposition: "CANDIDATE",
    quality: { dataStatus: "INSUFFICIENT", issues: [limitation] },
  });
});

function snapshot(overrides: Partial<MetricSnapshotV1> = {}): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    definitionVersion: "metrics-v1",
    inputRevision: reference.version,
    binding,
    ...period,
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    evidenceIds: [reference.id],
    sampleSize: 30,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 7000 },
    ...overrides,
  };
}
function observed(row: MetricSnapshotV1, value = evidence()): EventDetectionRequest {
  const ref = { ...reference, measure: { kind: row.metric.kind, unit: row.metric.unit } };
  return EventDetectionRequestSchema.parse({
    ...request(value),
    snapshots: [row],
    evidence: { ...value, sourceReferences: [ref] },
  });
}
it("withholds contradictory revenue snapshots with a source conflict", () => {
  const row = snapshot({ metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 7001 } });
  expect(detect(observed(row))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
    quality: {
      issues: expect.arrayContaining([expect.objectContaining({ code: "SOURCE_INCONSISTENT" })]),
    },
  });
});
it.each([
  [{ sampleSize: 9 }, "LOW_SAMPLE"],
  [
    {
      sourceWatermark: "2026-10-24T02:59:59Z",
      status: "STALE",
      issues: [issue("STALE_SOURCE", "sourceWatermark")],
    },
    "STALE_SOURCE",
  ],
  [
    {
      coverageBasisPoints: 8999,
      status: "INSUFFICIENT",
      issues: [issue("PARTIAL_COVERAGE", "paymentFacts")],
    },
    "PARTIAL_COVERAGE",
  ],
  [
    {
      status: "UNAVAILABLE",
      metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: null },
      issues: [issue("NOT_SYNCHRONIZED", "paymentFacts")],
    },
    "NOT_SYNCHRONIZED",
  ],
] satisfies readonly (readonly [Partial<MetricSnapshotV1>, string])[])(
  "withholds a limited matching snapshot %j",
  (patch, code) => {
    expect(detect(observed(snapshot(patch)))).toMatchObject({
      disposition: "NO_CANDIDATE",
      quality: { issues: expect.arrayContaining([expect.objectContaining({ code })]) },
    });
  },
);
function net(current: number, median = 10000): Evidence {
  const measure = { kind: "NET_REVENUE_SETTLEMENT", unit: "minorCNY" } as const;
  return {
    ...historical(baseline(median, "NET_REVENUE_SETTLEMENT")),
    sourceReferences: [{ ...reference, measure }],
    facts: facts({ netRevenueMinor: current, paidRevenueMinor: 10000 }),
  };
}
function netObserved(current: number, median = 10000): EventDetectionRequest {
  const metric = { kind: "NET_REVENUE_SETTLEMENT", unit: "minorCNY", value: current } as const;
  return observed(snapshot({ metric }), net(current, median));
}
it("requires an explicit matching snapshot before interpreting ambiguous netRevenueMinor", () => {
  expect(detect(request(net(7000)))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
    quality: {
      issues: expect.arrayContaining([expect.objectContaining({ code: "NOT_SYNCHRONIZED" })]),
    },
  });
});
it("detects net settlement deterioration only against its matching typed basis", () => {
  expect(detect(netObserved(7000)).disposition).toBe("CANDIDATE");
  expect(detect(netObserved(10000)).disposition).toBe("NO_CANDIDATE");
  expect(detect(changed(10000)).disposition).toBe("NO_CANDIDATE");
});
it("preserves refund uncertainty for net while paid revenue uses its own raw amount", () => {
  const limitation = issue("REFUND_UNKNOWN", "refundFacts");
  const value = { ...net(7000), dataStatus: "INSUFFICIENT" as const, issues: [limitation] };
  const row = snapshot({
    metric: { kind: "NET_REVENUE_SETTLEMENT", unit: "minorCNY", value: 7000 },
  });
  expect(detect(observed(row, value))).toMatchObject({
    disposition: "NO_CANDIDATE",
    quality: { issues: expect.arrayContaining([limitation]) },
  });
  expect(
    detect(request(evidence({ dataStatus: "INSUFFICIENT", issues: [limitation] }))).disposition,
  ).toBe("CANDIDATE");
});
it("keeps exact signed net delta when subtraction exceeds the safe integer range", () => {
  const input = netObserved(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  expect(new RevenueDropDetector().explain(input)).toMatchObject({
    ok: true,
    value: {
      outcome: { disposition: "CANDIDATE" },
      comparison: {
        signedDeltaMinor: { numerator: "-18014398509481982", denominator: "1" },
      },
    },
  });
});
it("does not turn an unrelated cost snapshot limitation into revenue authority", () => {
  const row = snapshot({
    metric: { kind: "GROSS_PROFIT", unit: "minorCNY", value: null },
    status: "UNAVAILABLE",
    issues: [issue("COST_MISSING", "frozenCosts")],
  });
  const value = evidence({
    sourceReferences: [
      reference,
      { ...reference, id: "cost-reference", measure: { kind: "GROSS_PROFIT", unit: "minorCNY" } },
    ],
  });
  expect(
    detect(EventDetectionRequestSchema.parse({ ...request(value), snapshots: [row] })).disposition,
  ).toBe("CANDIDATE");
});

it("withholds a fresh but incomplete current window even when another field caused estimation", () => {
  const value = evidence({
    sourceWatermark: "2026-10-24T03:59:59Z",
    dataStatus: "ESTIMATED",
    issues: [issue("COST_MISSING", "costCoverageBasisPoints")],
  });
  expect(detect(request(value))).toMatchObject({
    disposition: "NO_CANDIDATE",
    quality: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "PARTIAL_COVERAGE", field: "sourceWatermark" }),
      ]),
    },
  });
});
it.each(["paidRevenueMinor", "netRevenueMinor"] as const)(
  "withholds null %s instead of guessing zero",
  (field) => {
    const value = field === "paidRevenueMinor" ? evidence() : net(7000);
    expect(detect(request({ ...value, facts: { ...value.facts, [field]: null } }))).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "INSUFFICIENT_EVIDENCE",
      quality: {
        issues: expect.arrayContaining([expect.objectContaining({ code: "NOT_SYNCHRONIZED" })]),
      },
    });
  },
);
it("requires a typed current revenue reference even for paid revenue", () => {
  const value = evidence({ sourceReferences: [{ ...reference, measure: null }] });
  expect(detect(request(value))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each([
  [-12000, "CANDIDATE"],
  [-11999, "NO_CANDIDATE"],
  [-9000, "NO_CANDIDATE"],
] as const)(
  "uses signed deterioration against a negative net baseline at %i",
  (current, disposition) => {
    expect(detect(netObserved(current, -10000)).disposition).toBe(disposition);
  },
);
it("requires absolute-only policy before using a zero baseline", () => {
  expect(detect(netObserved(-1000, 0))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
    quality: {
      issues: expect.arrayContaining([expect.objectContaining({ code: "ZERO_DENOMINATOR" })]),
    },
  });
  const input = netObserved(-1000, 0);
  const thresholds = { relativeDropBasisPoints: 0, minimumDropMinor: 1000 };
  expect(
    detect({ ...input, policy: { ...policy, rules: [{ ...policy.rules[0], thresholds }] } })
      .disposition,
  ).toBe("CANDIDATE");
});
it("keeps the exact represented median rather than its shortened decimal rendering", () => {
  const input = changed(0, 1e-7);
  const result = new RevenueDropDetector().explain(input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      comparison: {
        signedDeltaMinor: { numerator: "-944473296573929", denominator: "9444732965739290427392" },
      },
    },
  });
});
const elapsedPeriod = {
  ...period,
  periodStart: "2026-10-23T16:00:00Z",
  periodEnd: "2026-10-23T20:00:00Z",
};
function historicalRow(value: number, index: number): MetricSnapshotV1 {
  const shift = (index + 1) * 7 * 86400000;
  const periodStart = new Date(Date.parse(elapsedPeriod.periodStart) - shift).toISOString();
  const periodEnd = new Date(Date.parse(elapsedPeriod.periodEnd) - shift).toISOString();
  return snapshot({
    periodStart,
    periodEnd,
    sourceWatermark: periodEnd,
    visibleAt: periodEnd,
    computedAt: periodEnd,
    inputRevision: `historical-${index}`,
    metric: { kind: "PAID_REVENUE", unit: "minorCNY", value },
  });
}
function realBaseline(): RobustBaselineV1 {
  const candidates = [9000, 10000, 10001, 20000].map(historicalRow);
  const sourceReferences = candidates.map((row, index) => ({
    ...reference,
    kind: "METRIC_SNAPSHOT" as const,
    id: `historical-${index}`,
    version: row.inputRevision,
    period: { ...previous, periodStart: row.periodStart, periodEnd: row.periodEnd },
    observedAt: row.periodEnd,
  }));
  const port = createRobustBaseline({
    version: "baseline-v1",
    minimumSamples: 4,
    lookbackWeeks: 4,
    maximumAgeSeconds: 35 * 86400,
  });
  const result = port.evaluate({
    binding,
    eventType: "REVENUE_DROP",
    entity: { kind: "STORE" },
    period: elapsedPeriod,
    observedAt: elapsedPeriod.periodEnd,
    definitionVersion: "metrics-v1",
    baselineVersion: "baseline-v1",
    measure: reference.measure,
    candidates,
    sourceReferences,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function elapsedEvidence(before: RobustBaselineV1, current: number): Evidence {
  return {
    ...historical(before),
    ...elapsedPeriod,
    observedAt: elapsedPeriod.periodEnd,
    sourceWatermark: elapsedPeriod.periodEnd,
    sourceReferences: [
      { ...reference, period: elapsedPeriod, observedAt: elapsedPeriod.periodEnd },
    ],
    facts: facts({
      paidRevenueMinor: current,
      discountRate: {
        numerator: 0,
        denominator: 10000,
        valueBasisPoints: 0,
        period: elapsedPeriod,
      },
    }),
  };
}
it("consumes the actual baseline port median for positive and seasonal negative controls", () => {
  const before = realBaseline();
  expect(before).toMatchObject({ status: "AVAILABLE", median: 10000.5, sampleSize: 4 });
  expect(detect(request(elapsedEvidence(before, 8000))).disposition).toBe("CANDIDATE");
  expect(detect(request(elapsedEvidence(before, 10000))).disposition).toBe("NO_CANDIDATE");
});
function rejects(input: unknown): void {
  const detector = new RevenueDropDetector();
  const expected = { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
  expect(detector.detect(input as EventDetectionRequest)).toEqual(expected);
  expect(detector.explain(input as EventDetectionRequest)).toEqual(expected);
}
it.each(["wrong-definition", "future", "different-hour", "different-duration"] as const)(
  "rejects %s historical context at the shared contract boundary",
  (change) => {
    const before = baseline();
    const sourceReferences = before.sourceReferences.map((ref) => ({
      ...ref,
      ...(change === "wrong-definition" ? { definitionVersion: "metrics-old" } : {}),
      ...(change === "future" ? { observedAt: "2026-10-24T04:00:01Z" } : {}),
    }));
    const shifted = change === "different-hour" || change === "different-duration";
    const oldPeriod = {
      ...previous,
      periodStart: "2026-10-17T01:00:00Z",
      periodEnd: change === "different-hour" ? "2026-10-17T05:00:00Z" : previous.periodEnd,
    };
    const value = historical({
      ...before,
      sourceReferences,
      ...(shifted ? { period: oldPeriod } : {}),
    });
    rejects({ evidence: value, snapshots: [], baseline: value.baseline, policy });
  },
);
it.each(["binding", "version", "future", "extra", "unsafe-integer"] as const)(
  "rejects %s request boundary mismatches",
  (change) => {
    const input = request();
    if (change === "binding")
      rejects({
        ...input,
        evidence: { ...input.evidence, binding: { ...binding, storeId: "other-store" } },
      });
    if (change === "version")
      rejects({ ...input, policy: { ...policy, baselineVersion: "baseline-old" } });
    if (change === "future")
      rejects({
        ...input,
        evidence: { ...input.evidence, sourceWatermark: "2026-10-24T04:00:01Z" },
      });
    if (change === "extra") rejects({ ...input, rawVendorPayload: {} });
    if (change === "unsafe-integer")
      rejects({
        ...input,
        evidence: {
          ...evidence(),
          facts: facts({ paidRevenueMinor: Number.MAX_SAFE_INTEGER + 1 }),
        },
      });
  },
);
it("rejects a missing policy rule or wrong event type", () => {
  rejects({ ...request(), policy: { ...policy, rules: [] } });
  rejects({ ...request(), evidence: { ...evidence(), eventType: "UNUSUAL_DISCOUNT" } });
});
