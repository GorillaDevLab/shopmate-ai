import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
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
import {
  CancelledOrderSpikeDetector,
  createCancelledOrderSpikeDetector,
} from "./cancelled-order-spike.detector.js";

type Evidence = Extract<EventEvidenceV1, { eventType: "CANCELLED_ORDER_SPIKE" }>;
type Facts = Evidence["facts"];
type Request = EventDetectionRequest & { readonly evidence: Evidence };
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "CANCELLED_ORDER_SPIKE" }>;
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
const observed = "2026-10-21T01:00:00.000Z";
const measure = { kind: "CANCELLED_ORDER_RATE", unit: "basisPoints" } as const;
const rule: Rule = {
  eventType: "CANCELLED_ORDER_SPIKE",
  minimumSampleSize: 100,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 0,
  thresholds: { relativeIncreaseBasisPoints: 10000, minimumCancelledOrders: 10 },
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
  const scaled = n === null ? null : BigInt(n) * 10000n;
  const divisor = d === null ? null : BigInt(d);
  const value =
    scaled === null || divisor === null || divisor === 0n
      ? null
      : Number(scaled / divisor + ((scaled % divisor) * 2n >= divisor ? 1n : 0n));
  return { numerator: n, denominator: d, valueBasisPoints: value, period: window };
}
function counts(paid: number | null, pending: number | null, total = 100): Facts {
  const cancelled = paid === null || pending === null ? null : paid + pending;
  return {
    cohort: period,
    cohortOrders: total,
    paidCancelledOrders: paid,
    pendingCancelledOrders: pending,
    currentRate: rate(cancelled, total),
    baselineRate: rate(10, 100, historicalPeriod()),
    reasonCounts: [],
  };
}
function request(facts: Facts = counts(5, 15), patch: Partial<Evidence> = {}): Request {
  const evidence: Evidence = {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "CANCELLED_ORDER_SPIKE",
    entity: { kind: "STORE" },
    observedAt: observed,
    sourceWatermark: observed,
    dataStatus: "VERIFIED",
    sampleSize: facts.cohortOrders ?? 0,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: "baseline-v1",
    baselineAlignment: "ALIGNED",
    baseline: baseline(),
    sourceReferences: [reference()],
    facts,
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
function withRule(input: Request, patch: Partial<Rule>): Request {
  return { ...input, policy: { ...input.policy, rules: [{ ...rule, ...patch }] } };
}
function withBaseline(input: Request, history: RobustBaselineV1 | null): Request {
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
  return { code, field, evidenceIds: ["visible-fact"] };
}
function withIssues(input: Request, issues: readonly DataQualityIssueV1[]): Request {
  return { ...input, evidence: { ...input.evidence, dataStatus: "INSUFFICIENT", issues } };
}
function detect(input: Request = request()): EventDetectionOutcome {
  expect(EventDetectionRequestSchema.safeParse(input).success).toBe(true);
  const result = createCancelledOrderSpikeDetector().detect(input);
  if (!result.ok) throw new Error(`Unexpected detector error: ${result.error.code}`);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function noCandidate(input: Request, reason: string): EventDetectionOutcome {
  const result = detect(input);
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason, blockedResources: [] });
  return result;
}
it("detects inclusive doubling with distinct paid and pending cancellation evidence", () => {
  const input = request();
  expect(detect(input)).toMatchObject({
    disposition: "CANDIDATE",
    candidate: {
      severityFloor: "MEDIUM",
      rulePolicyVersion: "policy-v1",
      evidence: input.evidence,
      fingerprint: createEventFingerprint(input.evidence),
    },
  });
  expect(new CancelledOrderSpikeDetector().detect(input)).toEqual(
    createCancelledOrderSpikeDetector().detect(input),
  );
});
it("counts pending cancellations without producing payment, refund or revenue facts", () => {
  const input = request(counts(0, 20));
  const before = JSON.stringify(input);
  const result = detect(input);
  expect(result).toMatchObject({ candidate: { evidence: { facts: counts(0, 20) } } });
  expect(JSON.stringify(result)).not.toMatch(/refundedOrders|revenue|refundMinor|paidOrders/u);
  expect(JSON.stringify(input)).toBe(before);
});
it("uses raw integer ratios instead of rounded current display basis points", () => {
  const input = request(counts(0, 19999, 100000));
  expect(input.evidence.facts.currentRate.valueBasisPoints).toBe(2000);
  noCandidate(input, "BELOW_THRESHOLD");
});
it("uses the fractional statistical median without requiring representative ratio equality", () => {
  expect(detect(withBaseline(request(), baseline(999.5))).disposition).toBe("CANDIDATE");
  noCandidate(withBaseline(request(), baseline(1000.5)), "BELOW_THRESHOLD");
  expect(detect(request({ ...counts(5, 15), baselineRate: null })).disposition).toBe("CANDIDATE");
});
it("compares a nontrivial exact relative boundary without floating point drift", () => {
  const input = withRule(withBaseline(request(counts(0, 49, 125)), baseline(3500)), {
    thresholds: { ...rule.thresholds, relativeIncreaseBasisPoints: 1200 },
  });
  expect(detect(input).disposition).toBe("CANDIDATE");
  noCandidate(
    withRule(input, { thresholds: { ...rule.thresholds, relativeIncreaseBasisPoints: 1201 } }),
    "BELOW_THRESHOLD",
  );
});
it("widens the relative increase threshold with frozen policy tolerance", () => {
  const configured = (pending: number) =>
    withRule(request(counts(0, pending, 1000)), { toleranceBasisPoints: 100 });
  noCandidate(configured(200), "BELOW_THRESHOLD");
  expect(detect(configured(201)).disposition).toBe("CANDIDATE");
});
it("keeps large safe integer counts exact", () => {
  noCandidate(request(counts(0, 1801439850948198, Number.MAX_SAFE_INTEGER)), "BELOW_THRESHOLD");
});
it("uses the configured count minimum and immutable policy version", () => {
  noCandidate(
    withRule(request(), { thresholds: { ...rule.thresholds, minimumCancelledOrders: 21 } }),
    "BELOW_THRESHOLD",
  );
  const input = { ...request(), policy: { ...request().policy, version: "policy-v2" } };
  expect(detect(input)).toMatchObject({ candidate: { rulePolicyVersion: "policy-v2" } });
});
it("uses an explicit positive absolute count branch for a zero baseline", () => {
  const input = withBaseline(request(counts(0, 10)), baseline(0));
  const result = detect(input);
  expect(result.disposition).toBe("CANDIDATE");
  expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN|multiplier/u);
  noCandidate(withBaseline(request(counts(0, 9)), baseline(0)), "BELOW_THRESHOLD");
  noCandidate(
    withRule(withBaseline(request(counts(0, 0)), baseline(0)), {
      thresholds: { ...rule.thresholds, minimumCancelledOrders: 0 },
    }),
    "BELOW_THRESHOLD",
  );
});
it("never alarms on a zero or missing cohort denominator", () => {
  noCandidate(request(counts(0, 0, 0)), "INSUFFICIENT_EVIDENCE");
  const facts: Facts = { ...counts(null, null), cohortOrders: null, currentRate: rate(null, null) };
  noCandidate(request(facts), "INSUFFICIENT_EVIDENCE");
});
it.each(["paidCancelledOrders", "pendingCancelledOrders"] as const)(
  "requires known %s",
  (field) => {
    const facts = { ...counts(5, 15), [field]: null, currentRate: rate(null, 100) };
    noCandidate(request(facts), "INSUFFICIENT_EVIDENCE");
  },
);
it("requires current cohort sample, matching sample size and coverage", () => {
  noCandidate(request(counts(5, 15, 99)), "INSUFFICIENT_EVIDENCE");
  noCandidate(request(undefined, { sampleSize: 99 }), "SOURCE_CONFLICT");
  const input = withIssues(request(undefined, { coverageBasisPoints: 8999 }), [
    issue("PARTIAL_COVERAGE", "cohort"),
  ]);
  noCandidate(input, "INSUFFICIENT_EVIDENCE");
});
it.each([
  "SOURCE_TIME_MISSING",
  "SOURCE_INCONSISTENT",
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
  "STALE_SOURCE",
  "PAYMENT_UNKNOWN",
] as const)("suppresses a conclusion dependent on cancellation %s", (code) => {
  const original = issue(code, "facts.pendingCancelledOrders");
  const expected =
    code === "SOURCE_INCONSISTENT"
      ? "SOURCE_CONFLICT"
      : code === "STALE_SOURCE"
        ? "STALE_SOURCE"
        : "INSUFFICIENT_EVIDENCE";
  expect(noCandidate(withIssues(request(), [original]), expected).quality.issues).toContainEqual(
    original,
  );
});
it("does not infer cancellation time from order, payment, update or observation timestamps", () => {
  const original = issue("SOURCE_TIME_MISSING", "cancellationFacts.cancelledAt");
  noCandidate(withIssues(request(), [original]), "INSUFFICIENT_EVIDENCE");
});
it.each([
  "reasonCounts",
  "baselineRate",
  "NET_REVENUE_SETTLEMENT",
  "REFUND_COHORT_ORDER_RATE",
  "fees",
  "inventoryFacts",
])("preserves independent cancellation evidence with unavailable %s", (field) => {
  const original = issue("STALE_SOURCE", field);
  expect(detect(withIssues(request(), [original]))).toMatchObject({
    disposition: "CANDIDATE",
    quality: { issues: [original] },
  });
});
it("preserves unknown and absent cancellation reasons without inventing a cause", () => {
  const facts = { ...counts(5, 15), reasonCounts: [{ reason: "UNKNOWN" as const, count: 20 }] };
  expect(detect(request(facts))).toMatchObject({ candidate: { evidence: { facts } } });
  expect(detect()).toMatchObject({ candidate: { evidence: { facts: { reasonCounts: [] } } } });
});
it("keeps every independent original diagnostic while suppressing the affected branch", () => {
  const originals = [
    issue("SOURCE_TIME_MISSING", "cancelledAt"),
    issue("STALE_SOURCE", "reasonCounts"),
    issue("VERSION_MISMATCH", "cohort"),
  ];
  expect(
    noCandidate(withIssues(request(), originals), "INSUFFICIENT_EVIDENCE").quality.issues,
  ).toEqual(expect.arrayContaining(originals));
});
it("requires typed normalized current cancellation provenance", () => {
  const input = request(undefined, { sourceReferences: [{ ...reference(), measure: null }] });
  noCandidate(input, "INSUFFICIENT_EVIDENCE");
});
it("checks exact freshness boundaries for current sources", () => {
  expect(detect(request(undefined, { sourceWatermark: period.periodEnd })).disposition).toBe(
    "CANDIDATE",
  );
  const stale = request(undefined, { sourceWatermark: "2026-10-20T23:59:59.999Z" });
  const degraded = withIssues(stale, [issue("STALE_SOURCE", "sourceWatermark")]);
  noCandidate(degraded, "STALE_SOURCE");
});
it("does not let a fresh watermark repair a stale cancellation aggregate reference", () => {
  const late = "2026-10-21T02:00:00.001Z";
  noCandidate(request(undefined, { observedAt: late, sourceWatermark: late }), "STALE_SOURCE");
});
it("retains missing current source time explicitly", () => {
  const input = request(undefined, {
    sourceWatermark: null,
    dataStatus: "INSUFFICIENT",
    issues: [issue("SOURCE_TIME_MISSING", "sourceWatermark")],
  });
  noCandidate(input, "INSUFFICIENT_EVIDENCE");
});
it("requires baseline sample and coverage independent of the current cohort", () => {
  noCandidate(withRule(request(), { minimumBaselineSamples: 5 }), "BASELINE_UNAVAILABLE");
  noCandidate(
    withBaseline(request(), { ...baseline(), coverageBasisPoints: 8999 }),
    "BASELINE_UNAVAILABLE",
  );
  noCandidate(
    withBaseline(request({ ...counts(5, 15), baselineRate: null }), null),
    "BASELINE_UNAVAILABLE",
  );
});
it("rejects a refund/conversion/revenue proxy baseline as unavailable", () => {
  const proxy = { kind: "REFUND_COHORT_ORDER_RATE", unit: "basisPoints" } as const;
  const history = {
    ...baseline(),
    measure: proxy,
    sourceReferences: baseline().sourceReferences.map((ref) => ({ ...ref, measure: proxy })),
  };
  noCandidate(withBaseline(request(), history), "BASELINE_UNAVAILABLE");
});
it.each(["MISSING", "UNALIGNED", "INSUFFICIENT", "STALE"] as const)(
  "retains %s baseline unavailability",
  (status) => {
    const history: RobustBaselineV1 = {
      ...baseline(),
      status,
      median: null,
      mad: null,
      sourceReferences: [],
      alignment:
        status === "MISSING" ? "MISSING" : status === "UNALIGNED" ? "UNALIGNED" : "ALIGNED",
      period: status === "MISSING" ? null : historicalPeriod(),
    };
    noCandidate(
      withBaseline(request({ ...counts(5, 15), baselineRate: null }), history),
      "BASELINE_UNAVAILABLE",
    );
  },
);
it("keeps stable fingerprints and immutable caller evidence", () => {
  const input = request();
  const before = JSON.stringify(input);
  const first = detect(input);
  expect(detect(input)).toEqual(first);
  expect(JSON.stringify(input)).toBe(before);
});
it("strictly rejects invalid facts, cutoffs, scopes and unsupported fields", () => {
  const original = request();
  const inputs = [
    { ...original, evidence: { ...original.evidence, unknown: true } },
    { ...original, evidence: { ...original.evidence, observedAt: period.periodStart } },
    {
      ...original,
      evidence: {
        ...original.evidence,
        facts: { ...original.evidence.facts, pendingCancelledOrders: -1 },
      },
    },
    {
      ...original,
      evidence: {
        ...original.evidence,
        sourceReferences: [{ ...reference(), binding: { ...binding, storeId: "other" } }],
      },
    },
  ];
  for (const input of inputs)
    expect(createCancelledOrderSpikeDetector().detect(input)).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: [] },
    });
});
it("does not use globally unavailable evidence even when diagnostic fields are independent", () => {
  const input = request(undefined, {
    dataStatus: "UNAVAILABLE",
    issues: [issue("NOT_SYNCHRONIZED", "reasonCounts")],
  });
  noCandidate(input, "INSUFFICIENT_EVIDENCE");
});
it("requires source coverage through the end of the comparable cohort", () => {
  const input = withIssues(
    request(undefined, {
      observedAt: "2026-10-21T00:01:00.000Z",
      sourceWatermark: "2026-10-20T23:59:00.000Z",
      sourceReferences: [{ ...reference(), observedAt: "2026-10-21T00:00:00.000Z" }],
      baseline: { ...baseline(), sourceReferences: [] },
    }),
    [issue("NOT_SYNCHRONIZED", "reasonCounts")],
  );
  const valid = withBaseline(input, {
    ...baseline(),
    sourceReferences: [1, 2, 3, 4].map((weeks) => ({
      ...reference(weeks),
      observedAt: "2026-10-21T00:00:00.000Z",
    })),
  });
  noCandidate(valid, "INSUFFICIENT_EVIDENCE");
});

function withSnapshotDiagnostic(input: Request, diagnostic: DataQualityIssueV1): Request {
  const metric = { kind: "PAID_ORDERS", unit: "units", value: 100 } as const;
  const snapshot: MetricSnapshotV1 = {
    schemaVersion: 1,
    binding,
    ...period,
    definitionVersion: "metrics-v1",
    inputRevision: "paid-revision-v1",
    visibleAt: observed,
    sourceWatermark: observed,
    computedAt: observed,
    evidenceIds: ["visible-fact"],
    sampleSize: 100,
    coverageBasisPoints: 10000,
    status: "INSUFFICIENT",
    issues: [diagnostic],
    subject: { kind: "STORE" },
    metric,
  };
  const ref: EventSourceReference = {
    ...reference(),
    kind: "METRIC_SNAPSHOT",
    id: "paid-snapshot",
    version: "paid-revision-v1",
    measure: { kind: "PAID_ORDERS", unit: "units" },
  };
  return {
    ...input,
    snapshots: [snapshot],
    evidence: {
      ...input.evidence,
      sourceReferences: [...input.evidence.sourceReferences, ref],
    },
  };
}
it.each([
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
  "STALE_SOURCE",
  "SOURCE_INCONSISTENT",
  "SOURCE_TIME_MISSING",
] as const)(
  "retains and gates relevant %s diagnostics reported by independent snapshots",
  (code) => {
    const original = issue(code, "facts.paidCancelledOrders");
    const reason =
      code === "SOURCE_INCONSISTENT"
        ? "SOURCE_CONFLICT"
        : code === "STALE_SOURCE"
          ? "STALE_SOURCE"
          : "INSUFFICIENT_EVIDENCE";
    const result = noCandidate(withSnapshotDiagnostic(request(), original), reason);
    expect(result.quality.issues).toContainEqual(original);
  },
);
it("does not require a paid-order metric snapshot for the distinct all-order cohort", () => {
  const original = issue("STALE_SOURCE", "PAID_ORDERS");
  const input = withSnapshotDiagnostic(request(), original);
  expect(detect(input)).toMatchObject({
    disposition: "CANDIDATE",
    quality: { issues: [original] },
  });
});
it("rejects rate/count contradictions without repairing the observed numerator", () => {
  const input = request();
  const invalid = {
    ...input,
    evidence: {
      ...input.evidence,
      facts: {
        ...input.evidence.facts,
        currentRate: rate(10, 100),
      },
    },
  };
  expect(createCancelledOrderSpikeDetector().detect(invalid)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});
