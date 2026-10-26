import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  EventMeasureSchema,
  createEventFingerprint,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventEvidenceV1,
  type EventPeriod,
  type EventRate,
  type EventRulePolicyV1,
  type EventSourceReference,
  type MetricSnapshotV1,
  type RobustBaselineV1,
} from "@shopmate/contracts";
import { expect, it } from "vitest";
import { RefundSpikeDetector, createRefundSpikeDetector } from "./refund-spike.detector.js";

type RefundEvidence = Extract<EventEvidenceV1, { eventType: "REFUND_SPIKE" }>;
type Facts = RefundEvidence["facts"];
type RefundRequest = EventDetectionRequest & { readonly evidence: RefundEvidence };
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "REFUND_SPIKE" }>;
const binding = {
  organizationId: "organization-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const period = {
  periodStart: "2026-10-20T00:00:00.000Z",
  periodEnd: "2026-10-21T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const observed = "2026-10-23T00:00:00.000Z";
const measure = { kind: "REFUND_COHORT_ORDER_RATE", unit: "basisPoints" } as const;
const rule: Rule = {
  eventType: "REFUND_SPIKE",
  minimumSampleSize: 100,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 0,
  thresholds: { relativeIncreaseBasisPoints: 20000, minimumRefundedOrders: 10, maturityHours: 48 },
};
function historicalPeriod(weeks = 1): EventPeriod {
  const delta = weeks * 7 * 86400000;
  return {
    ...period,
    periodStart: new Date(Date.parse(period.periodStart) - delta).toISOString(),
    periodEnd: new Date(Date.parse(period.periodEnd) - delta).toISOString(),
  };
}
function reference(weeks = 0): EventSourceReference {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: `aggregate-${weeks}`,
    version: "revision-v1",
    hash: `hash-${weeks}`,
    binding,
    definitionVersion: "metrics-v1",
    period: weeks === 0 ? period : historicalPeriod(weeks),
    observedAt: observed,
    measure,
  };
}
function baseline(median = 1000): RobustBaselineV1 {
  const common = {
    alignment: "ALIGNED" as const,
    measure,
    aggregation: "EXACT_MEDIAN" as const,
    version: "baseline-v1",
    period: historicalPeriod(),
    mad: 0,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [1, 2, 3, 4].map(reference),
  };
  return median === 0
    ? { ...common, status: "ZERO", median: 0 }
    : { ...common, status: "AVAILABLE", median };
}
function rate(n: number | null, d: number | null, window: EventPeriod = period): EventRate {
  const numerator = n === null ? null : BigInt(n) * 10000n;
  const denominator = d === null ? null : BigInt(d);
  const value =
    numerator === null || denominator === null || denominator === 0n
      ? null
      : Number(numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n));
  return { numerator: n, denominator: d, valueBasisPoints: value, period: window };
}
function facts(patch: Partial<Facts> = {}): Facts {
  return {
    paymentCohort: period,
    observedThrough: observed,
    maturityHours: 48,
    paidCohortOrders: 100,
    refundedOrders: 30,
    currentRate: rate(30, 100),
    baselineRate: rate(10, 100, historicalPeriod()),
    affectedSkuShare: rate(27, 30),
    reasonCounts: [{ reason: "QUALITY", count: 30 }],
    skuConcentration: [
      { externalSkuId: "sku-a", refundedOrders: 27 },
      { externalSkuId: "sku-b", refundedOrders: 3 },
    ],
    ...patch,
  };
}
function request(
  factsPatch: Partial<Facts> = {},
  patch: Partial<RefundEvidence> = {},
): RefundRequest {
  const history = baseline();
  const evidence: RefundEvidence = {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "REFUND_SPIKE",
    entity: { kind: "STORE" },
    observedAt: observed,
    sourceWatermark: observed,
    dataStatus: "VERIFIED",
    sampleSize: 100,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: "baseline-v1",
    baselineAlignment: "ALIGNED",
    baseline: history,
    sourceReferences: [reference()],
    facts: facts(factsPatch),
    ...patch,
  };
  return {
    evidence,
    snapshots: [],
    baseline: evidence.baseline,
    policy: {
      schemaVersion: 1,
      version: "policy-v1",
      baselineVersion: "baseline-v1",
      rules: [rule],
    },
  };
}
function counts(n: number | null, d: number | null): Partial<Facts> {
  return {
    paidCohortOrders: d,
    refundedOrders: n,
    currentRate: rate(n, d),
    affectedSkuShare: rate(n, n),
    reasonCounts: [],
    skuConcentration: [],
  };
}
function withRule(input: RefundRequest, patch: Partial<Rule>): RefundRequest {
  return { ...input, policy: { ...input.policy, rules: [{ ...rule, ...patch }] } };
}
function withBaseline(input: RefundRequest, history: RobustBaselineV1 | null): RefundRequest {
  return {
    ...input,
    baseline: history,
    evidence: {
      ...input.evidence,
      baseline: history,
      baselineVersion: history?.version ?? null,
      baselineAlignment: history?.alignment ?? "MISSING",
    },
  };
}
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: ["source-fact"] };
}
function withIssue(input: RefundRequest, diagnostic: DataQualityIssueV1): RefundRequest {
  return {
    ...input,
    evidence: { ...input.evidence, dataStatus: "INSUFFICIENT", issues: [diagnostic] },
  };
}
function snapshot(input: RefundRequest, metric: MetricSnapshotV1["metric"]): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    definitionVersion: "metrics-v1",
    inputRevision: "revision-v1",
    visibleAt: input.evidence.observedAt,
    sourceWatermark: input.evidence.observedAt,
    computedAt: input.evidence.observedAt,
    evidenceIds: ["source-fact"],
    sampleSize: 100,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric,
  };
}
function withSnapshot(input: RefundRequest, item: MetricSnapshotV1): RefundRequest {
  const ref: EventSourceReference = {
    ...reference(),
    kind: "METRIC_SNAPSHOT",
    id: `snapshot-${item.metric.kind}`,
    measure: EventMeasureSchema.parse({ kind: item.metric.kind, unit: item.metric.unit }),
    version: item.inputRevision,
    observedAt: item.computedAt,
  };
  return {
    ...input,
    snapshots: [...input.snapshots, item],
    evidence: {
      ...input.evidence,
      sourceReferences: [...input.evidence.sourceReferences, ref],
    },
  };
}
function detect(input: EventDetectionRequest = request()): EventDetectionOutcome {
  expect(EventDetectionRequestSchema.safeParse(input).success).toBe(true);
  const result = createRefundSpikeDetector().detect(input);
  if (!result.ok) throw new Error(`Unexpected failure: ${result.error.code}`);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function noCandidate(input: EventDetectionRequest, reason: string): EventDetectionOutcome {
  const result = detect(input);
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason, blockedResources: [] });
  return result;
}
it("detects a mature adequate paid cohort at exactly three times the baseline", () => {
  const input = request();
  const result = detect(input);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    blockedResources: [],
    candidate: {
      severityFloor: "MEDIUM",
      rulePolicyVersion: "policy-v1",
      evidence: input.evidence,
      fingerprint: createEventFingerprint(input.evidence),
    },
  });
  expect(new RefundSpikeDetector().detect(input)).toEqual(
    createRefundSpikeDetector().detect(input),
  );
});
it("compares exact counts rather than the rounded current bp value", () => {
  const input = request(counts(29999, 100000), { sampleSize: 100000 });
  expect(input.evidence.facts.currentRate.valueBasisPoints).toBe(3000);
  noCandidate(input, "BELOW_THRESHOLD");
});
it("uses a fractional multiwindow median and preserves an optional differing period ratio", () => {
  const input = withBaseline(request(), baseline(999.5));
  expect(detect(input).disposition).toBe("CANDIDATE");
  noCandidate(withBaseline(request(), baseline(1000.5)), "BELOW_THRESHOLD");
});
it("does not turn equality into an increase with a floating division artifact", () => {
  const input = withBaseline(request(counts(49, 125), { sampleSize: 125 }), baseline(3500));
  const configured = withRule(input, {
    thresholds: { ...rule.thresholds, relativeIncreaseBasisPoints: 1200 },
  });
  expect(detect(configured).disposition).toBe("CANDIDATE");
  noCandidate(
    withRule(configured, { thresholds: { ...rule.thresholds, relativeIncreaseBasisPoints: 1201 } }),
    "BELOW_THRESHOLD",
  );
});
it("keeps large safe integer count comparisons exact", () => {
  const input = request(counts(2702159776422297, 9007199254740991), {
    sampleSize: 9007199254740991,
  });
  noCandidate(input, "BELOW_THRESHOLD");
});
it("uses server policy thresholds and version without an implicit default", () => {
  const input = withRule(request(), {
    thresholds: { ...rule.thresholds, relativeIncreaseBasisPoints: 20001 },
  });
  noCandidate(input, "BELOW_THRESHOLD");
  const configured = { ...request(), policy: { ...request().policy, version: "policy-v2" } };
  expect(detect(configured)).toMatchObject({ candidate: { rulePolicyVersion: "policy-v2" } });
});
it("keeps Day3 below threshold and only detects the later Day5 observation", () => {
  noCandidate(request(counts(10, 100)), "BELOW_THRESHOLD");
  const day5 = "2026-10-25T00:00:00.000Z";
  expect(
    detect(request({ observedThrough: day5 }, { observedAt: day5, sourceWatermark: day5 }))
      .disposition,
  ).toBe("CANDIDATE");
});
it("preserves distinct concentrated SKU evidence without naming a hidden batch cause", () => {
  const concentrated = detect(request());
  const spread = facts({
    affectedSkuShare: rate(3, 30),
    skuConcentration: Array.from({ length: 10 }, (_, index) => ({
      externalSkuId: `sku-${index}`,
      refundedOrders: 3,
    })),
  });
  const storewide = detect(request(spread));
  expect(concentrated).toMatchObject({
    candidate: { evidence: { facts: { skuConcentration: facts().skuConcentration } } },
  });
  expect(storewide).toMatchObject({
    candidate: { evidence: { facts: { skuConcentration: spread.skuConcentration } } },
  });
  expect(JSON.stringify(concentrated)).not.toMatch(/batch|causality|rootCause/i);
});
it("preserves missing reasons and concentration as missing observed details", () => {
  expect(
    detect(request({ reasonCounts: [], skuConcentration: [], affectedSkuShare: rate(null, 30) })),
  ).toMatchObject({
    candidate: {
      evidence: {
        facts: {
          reasonCounts: [],
          skuConcentration: [],
          affectedSkuShare: { numerator: null, valueBasisPoints: null },
        },
      },
    },
  });
});
it("keeps deterministic references, fingerprints and caller objects intact", () => {
  const input = request();
  const before = JSON.stringify(input);
  const left = detect(input);
  expect(detect(input)).toEqual(left);
  expect(JSON.stringify(input)).toBe(before);
  expect(left).toMatchObject({
    candidate: { evidence: { sourceReferences: input.evidence.sourceReferences } },
  });
});
it("uses positive absolute quantity for an observed zero baseline without a multiplier", () => {
  const input = withBaseline(
    request({ baselineRate: rate(0, 100, historicalPeriod()) }),
    baseline(0),
  );
  const result = detect(input);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    candidate: {
      evidence: { baseline: { status: "ZERO", median: 0 }, facts: { refundedOrders: 30 } },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN|multiplier|relativeIncrease/);
});
it.each([0, 9])("does not turn zero baseline and %i refunds into an absolute spike", (quantity) => {
  noCandidate(
    withBaseline(request({ ...counts(quantity, 100), baselineRate: null }), baseline(0)),
    "BELOW_THRESHOLD",
  );
});
it("allows the zero quantity branch to retain an unrelated rate diagnostic", () => {
  const input = withIssue(
    withBaseline(request(), baseline(0)),
    issue("STALE_SOURCE", "currentRate"),
  );
  expect(detect(input)).toMatchObject({
    disposition: "CANDIDATE",
    quality: { issues: input.evidence.issues },
  });
});
it.each(["refundedOrders", "paidCohortOrders", "refundFacts.source"])(
  "blocks zero-baseline count/source conflicts on %s inside a rate snapshot",
  (field) => {
    const input = withBaseline(request(), baseline(0));
    const diagnostic = issue("SOURCE_INCONSISTENT", field);
    const item = {
      ...snapshot(input, { ...measure, value: 3000 }),
      status: "INSUFFICIENT" as const,
      issues: [diagnostic],
    };
    const result = noCandidate(withSnapshot(input, item), "SOURCE_CONFLICT");
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it.each([
  { code: "SOURCE_INCONSISTENT", field: "currentRate" },
  { code: "STALE_SOURCE", field: "REFUND_COHORT_ORDER_RATE" },
  { code: "ZERO_DENOMINATOR", field: "currentRate" },
] as const)(
  "keeps zero-baseline quantity independent from rate-only $code in a snapshot",
  ({ code, field }) => {
    const input = withBaseline(request(), baseline(0));
    const diagnostic = issue(code, field);
    const item = {
      ...snapshot(input, { ...measure, value: 3000 }),
      status: "INSUFFICIENT" as const,
      issues: [diagnostic],
    };
    const result = detect(withSnapshot(input, item));
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it.each(["paidCohortOrders", "refundedOrders"])(
  "blocks the zero quantity branch for stale %s",
  (field) => {
    const input = withIssue(withBaseline(request(), baseline(0)), issue("STALE_SOURCE", field));
    noCandidate(input, "STALE_SOURCE");
  },
);
it("retains low paid cohort and quality sample reasons", () => {
  const result = noCandidate(request(counts(27, 90), { sampleSize: 90 }), "INSUFFICIENT_EVIDENCE");
  expect(result.quality.issues).toContainEqual(expect.objectContaining({ code: "LOW_SAMPLE" }));
});
it("requires adequate policy sample and coverage even with a high observed rate", () => {
  noCandidate(withRule(request(), { minimumSampleSize: 101 }), "INSUFFICIENT_EVIDENCE");
  const input = request(
    {},
    {
      dataStatus: "INSUFFICIENT",
      coverageBasisPoints: 8000,
      issues: [issue("PARTIAL_COVERAGE", "refundFacts")],
    },
  );
  expect(noCandidate(input, "INSUFFICIENT_EVIDENCE").quality.issues).toContainEqual(
    input.evidence.issues[0],
  );
});
it("checks actual cohort age even when the supplied maturity number claims maturity", () => {
  const through = "2026-10-22T23:59:59.999Z";
  const input = request({ observedThrough: through });
  expect(noCandidate(input, "INSUFFICIENT_EVIDENCE").quality.issues).toContainEqual(
    expect.objectContaining({ code: "IMMATURE_COHORT" }),
  );
});
it("does not use observedAt to mature an earlier facts cutoff", () => {
  const input = request({ observedThrough: "2026-10-22T00:00:00.000Z" });
  noCandidate(withRule(input, { maximumAgeSeconds: 200000 }), "INSUFFICIENT_EVIDENCE");
});
it("honors stricter declared maturity and exact fractional policy maturity", () => {
  noCandidate(request({ maturityHours: 49 }), "INSUFFICIENT_EVIDENCE");
  noCandidate(
    withRule(request(), { thresholds: { ...rule.thresholds, maturityHours: 48.00000000000001 } }),
    "INSUFFICIENT_EVIDENCE",
  );
});
it("keeps missing counts and a zero cohort as explicit insufficient evidence", () => {
  const unknown = request(counts(null, null), {
    dataStatus: "UNAVAILABLE",
    sourceWatermark: null,
    sampleSize: 0,
    coverageBasisPoints: 0,
    issues: [issue("NOT_SYNCHRONIZED", "refundFacts")],
  });
  noCandidate(unknown, "INSUFFICIENT_EVIDENCE");
  noCandidate(request(counts(0, 0), { sampleSize: 0 }), "INSUFFICIENT_EVIDENCE");
});
it.each(["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH", "STALE_SOURCE"] as const)(
  "gates a relevant %s diagnostic while retaining its reason",
  (code) => {
    const input = withIssue(request(), issue(code, "REFUND_COHORT_ORDER_RATE"));
    const reason =
      code === "SOURCE_INCONSISTENT"
        ? "SOURCE_CONFLICT"
        : code === "STALE_SOURCE"
          ? "STALE_SOURCE"
          : "INSUFFICIENT_EVIDENCE";
    expect(noCandidate(input, reason).quality.issues).toContainEqual(input.evidence.issues[0]);
  },
);
it.each(["reasonCounts", "skuConcentration", "baselineRate", "COGS", "inventoryFacts"])(
  "retains independent rate evidence when %s is unavailable",
  (field) => {
    const input = withIssue(request(), issue("STALE_SOURCE", field));
    expect(detect(input)).toMatchObject({
      disposition: "CANDIDATE",
      quality: { issues: input.evidence.issues },
    });
  },
);
it("checks source and observation age with an inclusive exact age limit", () => {
  const atLimit = "2026-10-22T23:00:00.000Z";
  expect(detect(request({}, { sourceWatermark: atLimit })).disposition).toBe("CANDIDATE");
  noCandidate(request({}, { sourceWatermark: "2026-10-22T22:59:59.999Z" }), "STALE_SOURCE");
  noCandidate(request({ observedThrough: atLimit }), "INSUFFICIENT_EVIDENCE");
});
it("keeps a stale observation cutoff distinct from an up to date watermark", () => {
  noCandidate(request({ observedThrough: "2026-10-22T22:59:59.999Z" }), "STALE_SOURCE");
});
it("uses the robust baseline sample and coverage policy", () => {
  noCandidate(withRule(request(), { minimumBaselineSamples: 5 }), "BASELINE_UNAVAILABLE");
  noCandidate(
    withBaseline(request(), { ...baseline(), coverageBasisPoints: 8000 }),
    "BASELINE_UNAVAILABLE",
  );
});
it("keeps a missing baseline unavailable rather than treating it as zero", () => {
  noCandidate(withBaseline(request({ baselineRate: null }), null), "BASELINE_UNAVAILABLE");
});
it.each(["MISSING", "UNALIGNED", "INSUFFICIENT", "STALE"] as const)(
  "retains %s historical availability",
  (status) => {
    const history: RobustBaselineV1 = {
      ...baseline(),
      status,
      median: null,
      mad: null,
      alignment:
        status === "MISSING" ? "MISSING" : status === "UNALIGNED" ? "UNALIGNED" : "ALIGNED",
      period: status === "MISSING" ? null : historicalPeriod(),
      sourceReferences: [],
    };
    noCandidate(withBaseline(request({ baselineRate: null }), history), "BASELINE_UNAVAILABLE");
  },
);
it("rejects a different historical measure without comparing different units", () => {
  const history = baseline();
  const wrong = {
    ...history,
    measure: { kind: "REFUND_COHORT_AMOUNT_RATE", unit: "basisPoints" } as const,
    sourceReferences: history.sourceReferences.map((ref) => ({
      ...ref,
      measure: { kind: "REFUND_COHORT_AMOUNT_RATE", unit: "basisPoints" } as const,
    })),
  };
  const result = noCandidate(withBaseline(request(), wrong), "BASELINE_UNAVAILABLE");
  expect(result.quality.issues).toContainEqual(
    expect.objectContaining({ code: "VERSION_MISMATCH" }),
  );
});
it("checks provided rate and absolute count snapshot agreement", () => {
  const input = request();
  const matched = withSnapshot(input, snapshot(input, { ...measure, value: 3000 }));
  expect(detect(matched).disposition).toBe("CANDIDATE");
  noCandidate(withSnapshot(input, snapshot(input, { ...measure, value: 3001 })), "SOURCE_CONFLICT");
  noCandidate(
    withSnapshot(
      input,
      snapshot(input, { kind: "REFUNDED_COHORT_ORDERS", unit: "units", value: 31 }),
    ),
    "SOURCE_CONFLICT",
  );
  noCandidate(
    withSnapshot(input, snapshot(input, { kind: "PAID_ORDERS", unit: "units", value: 101 })),
    "SOURCE_CONFLICT",
  );
});
it.each(["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH", "STALE_SOURCE"] as const)(
  "gates a supplied rate snapshot's %s quality",
  (code) => {
    const input = request();
    const item = {
      ...snapshot(input, { ...measure, value: 3000 }),
      status: "INSUFFICIENT" as const,
      issues: [issue(code, "refundFacts")],
    };
    const reason =
      code === "SOURCE_INCONSISTENT"
        ? "SOURCE_CONFLICT"
        : code === "STALE_SOURCE"
          ? "STALE_SOURCE"
          : "INSUFFICIENT_EVIDENCE";
    expect(noCandidate(withSnapshot(input, item), reason).quality.issues).toContainEqual(
      item.issues[0],
    );
  },
);
it("does not silently compare a rate snapshot with a different observation cutoff", () => {
  const input = request();
  const item = {
    ...snapshot(input, { ...measure, value: 3000 }),
    visibleAt: "2026-10-22T23:00:00.000Z",
    sourceWatermark: "2026-10-22T23:00:00.000Z",
  };
  noCandidate(withSnapshot(input, item), "INSUFFICIENT_EVIDENCE");
});
it("retains an unrelated snapshot diagnostic without suppressing refunds", () => {
  const input = request();
  const item = {
    ...snapshot(input, { kind: "INVENTORY_AVAILABLE", unit: "units", value: null }),
    status: "UNAVAILABLE" as const,
    sourceWatermark: null,
    issues: [issue("INVENTORY_UNKNOWN", "inventoryFacts")],
  };
  expect(detect(withSnapshot(input, item)).disposition).toBe("CANDIDATE");
});
it("suppresses an unavailable supplied dependent snapshot", () => {
  const input = request();
  const item = {
    ...snapshot(input, { ...measure, value: null }),
    status: "UNAVAILABLE" as const,
    sourceWatermark: null,
    issues: [issue("NOT_SYNCHRONIZED", "refundFacts")],
  };
  noCandidate(withSnapshot(input, item), "INSUFFICIENT_EVIDENCE");
});
it("does not replace the original source conflict with a low sample reason", () => {
  const input = withIssue(
    request(counts(9, 10), { sampleSize: 10 }),
    issue("SOURCE_INCONSISTENT", "refundFacts"),
  );
  expect(noCandidate(input, "SOURCE_CONFLICT").quality.issues).toContainEqual(
    input.evidence.issues[0],
  );
});
it("retains SKU scope and stable baseline version in the fingerprint", () => {
  const input = request({}, { entity: { kind: "SKU", externalSkuId: "sku-a" } });
  expect(detect(input)).toMatchObject({
    candidate: { fingerprint: createEventFingerprint(input.evidence) },
  });
});
it.each(["REFUNDS", "ORDERS"])("does not discard source quality on the %s resource", (field) => {
  noCandidate(withIssue(request(), issue("SOURCE_INCONSISTENT", field)), "SOURCE_CONFLICT");
});
it("deduplicates diagnostic evidence ids across separate immutable reference versions", () => {
  const input = request(counts(9, 10), {
    sampleSize: 10,
    sourceReferences: [reference(), { ...reference(), version: "revision-v2", hash: "hash-v2" }],
  });
  const result = noCandidate(input, "INSUFFICIENT_EVIDENCE");
  expect(result.quality.issues).toContainEqual({
    code: "LOW_SAMPLE",
    field: "paidCohortOrders",
    evidenceIds: ["aggregate-0"],
  });
});
it("does not use an unrelated typed current reference to support refund facts", () => {
  const source: EventSourceReference = {
    ...reference(),
    measure: { kind: "INVENTORY_AVAILABLE", unit: "units" },
  };
  noCandidate(request({}, { sourceReferences: [source] }), "INSUFFICIENT_EVIDENCE");
});
it("accepts an untyped normalized aggregate without inventing a snapshot requirement", () => {
  const source: EventSourceReference = { ...reference(), measure: null };
  expect(detect(request({}, { sourceReferences: [source] })).disposition).toBe("CANDIDATE");
});
it.each([
  { label: "unknown field", build: () => ({ ...request(), untrusted: true }) },
  { label: "future facts", build: () => request({ observedThrough: "2026-10-25T00:00:00.000Z" }) },
  {
    label: "policy version",
    build: () => ({
      ...request(),
      policy: { ...request().policy, baselineVersion: "different-v2" },
    }),
  },
  { label: "different baseline object", build: () => ({ ...request(), baseline: baseline(500) }) },
  {
    label: "reason count above observed refunds",
    build: () => request({ reasonCounts: [{ reason: "UNKNOWN", count: 31 }] }),
  },
])("strictly rejects $label at the immutable boundary", ({ build }) => {
  expect(createRefundSpikeDetector().detect(build())).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
