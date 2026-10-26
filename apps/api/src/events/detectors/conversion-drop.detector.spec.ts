import { expect, it } from "vitest";
import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  EventMeasureSchema,
  createEventFingerprint,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventEvidenceV1,
  type EventRulePolicyV1,
  type EventPeriod,
  type MetricSnapshotV1,
  type RobustBaselineV1,
} from "@shopmate/contracts";
import { ConversionDropDetector } from "./conversion-drop.detector.js";

type Conversion = Extract<EventEvidenceV1, { eventType: "CONVERSION_DROP" }>;
type Rule = Extract<EventRulePolicyV1["rules"][number], { eventType: "CONVERSION_DROP" }>;
const binding = {
  organizationId: "org-conversion",
  workspaceId: "workspace-conversion",
  storeId: "store-conversion",
  connectionId: "connection-conversion",
  externalStoreId: "external-conversion",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const historicalPeriod = {
  ...period,
  periodStart: "2026-10-17T00:00:00Z",
  periodEnd: "2026-10-18T00:00:00Z",
};
const rule: Rule = {
  eventType: "CONVERSION_DROP",
  minimumSampleSize: 10,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 0,
  thresholds: { relativeDropBasisPoints: 3500, minimumVisitors: 100 },
};
const policy: EventRulePolicyV1 = {
  schemaVersion: 1,
  version: "event-rules-v1",
  baselineVersion: "baseline-v1",
  rules: [rule],
};
const reference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "observed-conversion",
  version: "source-v1",
  hash: "conversion-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: null,
} as const;
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: [reference.id] };
}
function baseline(median = 1000): Extract<RobustBaselineV1, { status: "AVAILABLE" }> {
  return {
    status: "AVAILABLE",
    alignment: "ALIGNED",
    measure: { kind: "CONVERSION_RATE", unit: "basisPoints" },
    aggregation: "EXACT_MEDIAN",
    version: "baseline-v1",
    period: historicalPeriod,
    median,
    mad: 10,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [
      {
        ...reference,
        id: "historical-conversion",
        period: historicalPeriod,
        measure: { kind: "CONVERSION_RATE", unit: "basisPoints" },
      },
    ],
  };
}
function ratio(numerator: number | null, denominator: number | null, window: EventPeriod = period) {
  const scaled = numerator === null ? null : BigInt(numerator) * 10000n;
  const base = denominator === null || denominator === 0 ? null : BigInt(denominator);
  const bp =
    scaled === null || base === null
      ? null
      : Number(scaled / base + ((scaled % base) * 2n >= base ? 1n : 0n));
  return { numerator, denominator, valueBasisPoints: bp, period: window };
}
function facts(overrides: Partial<Conversion["facts"]> = {}): Conversion["facts"] {
  return {
    visitors: 1000,
    cart: 300,
    checkout: 150,
    paidOrders: 65,
    conversion: ratio(65, 1000),
    baselineConversion: ratio(100, 1000, historicalPeriod),
    priceChangeBasisPoints: 1000,
    priceEffectiveAt: period.periodStart,
    variantAvailabilityBasisPoints: 10000,
    relationship: "CORRELATION_ONLY",
    ...overrides,
  };
}
function evidence(overrides: Partial<Conversion["facts"]> = {}): Conversion {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "CONVERSION_DROP",
    entity: { kind: "STORE" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 1000,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: baseline(),
    baselineVersion: "baseline-v1",
    baselineAlignment: "ALIGNED",
    sourceReferences: [reference],
    facts: facts(overrides),
  };
}
function request(
  value = evidence(),
  snapshots: readonly MetricSnapshotV1[] = [],
): EventDetectionRequest {
  return EventDetectionRequestSchema.parse({
    evidence: value,
    snapshots,
    baseline: value.baseline,
    policy,
  });
}
function outcome(
  value = evidence(),
  snapshots: readonly MetricSnapshotV1[] = [],
): EventDetectionOutcome {
  const result = new ConversionDropDetector().detect(request(value, snapshots));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function limited(code: DataQualityIssueV1["code"], field: string): Conversion {
  return { ...evidence(), dataStatus: "INSUFFICIENT", issues: [issue(code, field)] };
}
function counts(paidOrders: number | null, visitors: number | null): Conversion {
  return evidence({ paidOrders, visitors, conversion: ratio(paidOrders, visitors) });
}

it("detects the inclusive 35 percent relative drop with correlation-only immutable evidence", () => {
  const value = evidence();
  const result = outcome(value);
  expect(result).toMatchObject({ disposition: "CANDIDATE", quality: { dataStatus: "VERIFIED" } });
  if (result.disposition !== "CANDIDATE") throw new Error("Expected candidate");
  expect(result.candidate.evidence).toEqual(value);
  expect(result.candidate.fingerprint).toBe(createEventFingerprint(value));
  expect(result.candidate.rulePolicyVersion).toBe(policy.version);
  expect(result.candidate.severityFloor).toBe("MEDIUM");
});
it.each([64, 65, 66, 100])("compares %s paid orders against a ten percent baseline", (paid) => {
  expect(outcome(counts(paid, 1000)).disposition).toBe(paid <= 65 ? "CANDIDATE" : "NO_CANDIDATE");
});
it("uses actual count fractions when rounded current basis points would cross the threshold", () => {
  expect(outcome(counts(6504, 100000))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it("uses a fractional historical median independently of a representative baseline rate", () => {
  const value = { ...counts(130, 2000), baseline: baseline(1000.5) };
  expect(outcome(value).disposition).toBe("CANDIDATE");
  expect(outcome({ ...value, baseline: baseline(999.5) }).disposition).toBe("NO_CANDIDATE");
});
it("handles a nontrivial exact rational boundary at safe integer counts", () => {
  const value = { ...counts(637000000000000, 8000000000000000), baseline: baseline(1225) };
  expect(outcome(value).disposition).toBe("CANDIDATE");
  expect(
    outcome({ ...counts(637000000000001, 8000000000000000), baseline: baseline(1225) }).disposition,
  ).toBe("NO_CANDIDATE");
});
it("honors the injected threshold and minimum traffic policy", () => {
  const custom = { ...rule, thresholds: { relativeDropBasisPoints: 4000, minimumVisitors: 100 } };
  expect(
    new ConversionDropDetector().detect({ ...request(), policy: { ...policy, rules: [custom] } }),
  ).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" },
  });
});
it.each([null, 0, 99])("suppresses a drop with %s visitors", (visitors) => {
  expect(outcome(counts(visitors === null || visitors === 0 ? 0 : 1, visitors)).disposition).toBe(
    "NO_CANDIDATE",
  );
});
it("does not reinterpret unknown paid orders as zero conversion", () => {
  expect(outcome(counts(null, 1000))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it("gates sample and measured coverage independently", () => {
  expect(outcome({ ...evidence(), sampleSize: 9 }).disposition).toBe("NO_CANDIDATE");
  expect(
    outcome({ ...limited("PARTIAL_COVERAGE", "source"), coverageBasisPoints: 8999 }).disposition,
  ).toBe("NO_CANDIDATE");
});
it("accepts exact quality and visitor boundaries", () => {
  const value = { ...counts(0, 100), sampleSize: 10 };
  expect(outcome(value).disposition).toBe("CANDIDATE");
  const covered = {
    ...value,
    dataStatus: "INSUFFICIENT" as const,
    coverageBasisPoints: 9000,
    issues: [issue("COST_MISSING", "frozenCosts")],
  };
  expect(outcome(covered).disposition).toBe("CANDIDATE");
});
it.each(["2026-10-24T23:00:00Z", "2026-10-24T22:59:59.999Z"])(
  "derives freshness at %s",
  (sourceWatermark) => {
    const value = { ...limited("COST_MISSING", "frozenCosts"), sourceWatermark };
    expect(outcome(value).disposition).toBe(
      sourceWatermark.endsWith("00:00Z") ? "CANDIDATE" : "NO_CANDIDATE",
    );
  },
);
it("keeps missing watermarks explicit", () => {
  const result = outcome({
    ...limited("SOURCE_TIME_MISSING", "sourceWatermark"),
    sourceWatermark: null,
  });
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "INSUFFICIENT_EVIDENCE" });
});
it.each(["STALE_SOURCE", "SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH"] as const)(
  "gates all current and historical conversion dependencies for %s",
  (code) => {
    for (const field of [
      "facts.visitors",
      "facts.paidOrders",
      "facts.conversion",
      "baseline",
      "traffic",
      "paymentFacts",
      "sourceWatermark",
    ]) {
      const value = limited(code, field);
      expect(outcome(value).disposition, field).toBe("NO_CANDIDATE");
      expect(outcome(value).quality.issues).toContainEqual(value.issues[0]);
    }
  },
);
it.each(["STALE_SOURCE", "SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH"] as const)(
  "keeps optional context limitations independent of conversion for %s",
  (code) => {
    for (const field of [
      "facts.cart",
      "facts.checkout",
      "traffic.funnel.cart",
      "traffic.funnel.checkout",
      "facts.priceChangeBasisPoints",
      "facts.priceEffectiveAt",
      "facts.variantAvailabilityBasisPoints",
      "frozenCosts",
    ]) {
      const value = limited(code, field);
      const result = outcome(value);
      expect(result.disposition, field).toBe("CANDIDATE");
      expect(result.quality.issues).toContainEqual(value.issues[0]);
    }
  },
);
it("suppresses conversion for the upstream shared traffic funnel conflict", () => {
  const value = limited("SOURCE_INCONSISTENT", "traffic.funnel");
  const result = outcome(value);
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "SOURCE_CONFLICT" });
  expect(result.quality.issues).toContainEqual(value.issues[0]);
});
it("retains missing price, funnel and variant context as explicit limitations", () => {
  const value = evidence({
    cart: null,
    checkout: null,
    priceChangeBasisPoints: null,
    priceEffectiveAt: null,
    variantAvailabilityBasisPoints: null,
  });
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.dataStatus).toBe("INSUFFICIENT");
  for (const field of [
    "facts.cart",
    "facts.checkout",
    "facts.priceChangeBasisPoints",
    "facts.priceEffectiveAt",
    "facts.variantAvailabilityBasisPoints",
  ]) {
    expect(
      result.quality.issues.some((row) => row.field === field),
      field,
    ).toBe(true);
  }
});
it.each([0, 5000, 9999])(
  "retains known %s availability while limiting price association for unsellable variants",
  (variantAvailabilityBasisPoints) => {
    const result = outcome(evidence({ variantAvailabilityBasisPoints }));
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      quality: { dataStatus: "INSUFFICIENT" },
    });
    expect(result.quality.issues).toContainEqual(
      issue("PARTIAL_COVERAGE", "facts.variantAvailabilityBasisPoints"),
    );
    expect(result.quality.issues.some((row) => row.code === "INVENTORY_UNKNOWN")).toBe(false);
    if (
      result.disposition === "CANDIDATE" &&
      result.candidate.evidence.eventType === "CONVERSION_DROP"
    ) {
      expect(result.candidate.evidence.facts.variantAvailabilityBasisPoints).toBe(
        variantAvailabilityBasisPoints,
      );
      expect(result.candidate.evidence.facts.relationship).toBe("CORRELATION_ONLY");
    }
  },
);
it.each(["2026-10-24T12:00:00Z", "2026-10-25T00:00:00Z"])(
  "retains a drop while marking the price at %s as outside a full post-change window",
  (priceEffectiveAt) => {
    const result = outcome(evidence({ priceEffectiveAt }));
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(
      issue("WINDOW_MISMATCH", "facts.priceEffectiveAt"),
    );
  },
);
it("rejects a price change after the observation cutoff", () => {
  expect(
    new ConversionDropDetector().detect({
      ...request(),
      evidence: evidence({ priceEffectiveAt: "2026-10-25T00:00:00.001Z" }),
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("does not mutate inputs or read wall-clock time", () => {
  const value = request();
  const before = JSON.stringify(value);
  expect(new ConversionDropDetector().detect(value)).toEqual(
    new ConversionDropDetector().detect(value),
  );
  expect(JSON.stringify(value)).toBe(before);
});

it("requires an authoritative aligned conversion baseline without requiring a representative ratio", () => {
  const value = evidence({ baselineConversion: null });
  expect(outcome(value).disposition).toBe("CANDIDATE");
  const missing = {
    ...value,
    baseline: null,
    baselineVersion: null,
    baselineAlignment: "MISSING" as const,
  };
  expect(outcome(missing)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it.each(["MISSING", "UNALIGNED", "INSUFFICIENT", "STALE"] as const)(
  "does not consume a %s baseline",
  (status) => {
    const unavailable: RobustBaselineV1 = {
      status,
      alignment:
        status === "MISSING" ? "MISSING" : status === "UNALIGNED" ? "UNALIGNED" : "ALIGNED",
      measure: { kind: "CONVERSION_RATE", unit: "basisPoints" },
      aggregation: "EXACT_MEDIAN",
      version: "baseline-v1",
      period: status === "MISSING" ? null : historicalPeriod,
      median: null,
      mad: null,
      sampleSize: 0,
      coverageBasisPoints: 0,
      sourceReferences: [],
    };
    const value = {
      ...evidence({ baselineConversion: null }),
      baseline: unavailable,
      baselineAlignment: unavailable.alignment,
    };
    expect(outcome(value)).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "BASELINE_UNAVAILABLE",
    });
  },
);
it("does not calculate a relative drop against a zero baseline", () => {
  const zero: RobustBaselineV1 = { ...baseline(), status: "ZERO", median: 0 };
  const result = outcome({ ...evidence(), baseline: zero });
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" });
  expect(result.quality.issues).toContainEqual(issue("ZERO_DENOMINATOR", "baseline.median"));
});
it("gates insufficient baseline samples and coverage", () => {
  const value = baseline();
  expect(outcome({ ...evidence(), baseline: { ...value, sampleSize: 3 } }).disposition).toBe(
    "NO_CANDIDATE",
  );
  expect(
    outcome({ ...evidence(), baseline: { ...value, coverageBasisPoints: 8999 } }).disposition,
  ).toBe("NO_CANDIDATE");
});
it("does not use a baseline with the wrong typed measure", () => {
  const value = baseline();
  const wrong: RobustBaselineV1 = {
    ...value,
    measure: { kind: "CART_RATE", unit: "basisPoints" },
    sourceReferences: value.sourceReferences.map((row) => ({
      ...row,
      measure: { kind: "CART_RATE", unit: "basisPoints" },
    })),
  };
  expect(outcome({ ...evidence(), baseline: wrong })).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it("strictly rejects unrecognized input and absent policy rules", () => {
  expect(
    new ConversionDropDetector().detect({ ...request(), ignored: true } as EventDetectionRequest),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    new ConversionDropDetector().detect({ ...request(), policy: { ...policy, rules: [] } }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});

function snapshot(
  kind: "CONVERSION_RATE" | "PAID_ORDERS" | "CART_RATE" | "CHECKOUT_RATE",
  value: number,
): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    definitionVersion: "metrics-v1",
    inputRevision: "source-v1",
    binding,
    ...period,
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    evidenceIds: [reference.id],
    sampleSize: 1000,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric:
      kind === "PAID_ORDERS"
        ? { kind, unit: "units", value }
        : { kind, unit: "basisPoints", value },
  };
}
function referenced(value: Conversion, rows: readonly MetricSnapshotV1[]): Conversion {
  return {
    ...value,
    sourceReferences: [
      reference,
      ...rows.map((row, index) => ({
        ...reference,
        kind: "METRIC_SNAPSHOT" as const,
        id: `snapshot-${index}`,
        measure: EventMeasureSchema.parse({ kind: row.metric.kind, unit: row.metric.unit }),
      })),
    ],
  };
}
function withSnapshots(rows: readonly MetricSnapshotV1[]): EventDetectionOutcome {
  return outcome(referenced(evidence(), rows), rows);
}
it("checks consistent observed snapshots without requiring new snapshots", () => {
  const rows = [
    snapshot("CONVERSION_RATE", 650),
    snapshot("PAID_ORDERS", 65),
    snapshot("CART_RATE", 3000),
    snapshot("CHECKOUT_RATE", 1500),
  ];
  expect(withSnapshots(rows).disposition).toBe("CANDIDATE");
});
it.each(["CONVERSION_RATE", "PAID_ORDERS"] as const)(
  "rejects contradictions in the supplied %s snapshot",
  (kind) => {
    const result = withSnapshots([snapshot(kind, 100)]);
    expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "SOURCE_CONFLICT" });
    expect(result.quality.issues.some((row) => row.code === "SOURCE_INCONSISTENT")).toBe(true);
  },
);
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "gates a supplied current conversion snapshot with %s",
  (code) => {
    const row = {
      ...snapshot("CONVERSION_RATE", 650),
      status: "INSUFFICIENT" as const,
      issues: [issue(code, "traffic")],
    };
    const result = withSnapshots([row]);
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(row.issues[0]);
  },
);
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "keeps a limited optional funnel snapshot independent for %s",
  (code) => {
    const row = {
      ...snapshot("CART_RATE", 3000),
      status: "INSUFFICIENT" as const,
      issues: [issue(code, "traffic")],
    };
    const result = withSnapshots([row]);
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(row.issues[0]);
    expect(result.quality.dataStatus).not.toBe("VERIFIED");
  },
);
it("retains funnel snapshot contradictions as an independent context limitation", () => {
  const result = withSnapshots([snapshot("CHECKOUT_RATE", 100)]);
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues).toContainEqual(
    expect.objectContaining({ code: "SOURCE_INCONSISTENT", field: "snapshots.CHECKOUT_RATE" }),
  );
});
it("does not compare known funnel observations against an unknown count", () => {
  const rows = [snapshot("CART_RATE", 3000)];
  const result = outcome(referenced(evidence({ cart: null }), rows), rows);
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues.some((row) => row.code === "SOURCE_INCONSISTENT")).toBe(false);
});
it("gates low samples, partial coverage and stale times on supplied current metrics", () => {
  const base = snapshot("CONVERSION_RATE", 650);
  expect(withSnapshots([{ ...base, sampleSize: 9 }]).disposition).toBe("NO_CANDIDATE");
  expect(
    withSnapshots([
      {
        ...base,
        coverageBasisPoints: 8999,
        status: "INSUFFICIENT",
        issues: [issue("PARTIAL_COVERAGE", "traffic")],
      },
    ]).disposition,
  ).toBe("NO_CANDIDATE");
  expect(
    withSnapshots([
      {
        ...base,
        sourceWatermark: "2026-10-24T22:00:00Z",
        status: "STALE",
        issues: [issue("STALE_SOURCE", "traffic")],
      },
    ]),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "STALE_SOURCE" });
});
it("rejects scope, definition, period, baseline version and unknown evidence fields", () => {
  const value = request();
  const detector = new ConversionDropDetector();
  const invalid = [
    { ...value.evidence, binding: { ...binding, storeId: "other" } },
    { ...value.evidence, definitionVersion: "other" },
    { ...value.evidence, periodStart: "2026-10-23T00:00:00Z" },
    { ...value.evidence, baselineVersion: "other" },
    { ...value.evidence, unrecognized: true },
  ];
  for (const evidence of invalid)
    expect(detector.detect({ ...value, evidence })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
});

it("retains a missing current snapshot as unavailable rather than inventing a source contradiction", () => {
  const base = snapshot("CONVERSION_RATE", 650);
  const row: MetricSnapshotV1 = {
    ...base,
    metric: { ...base.metric, value: null },
    sourceWatermark: null,
    status: "UNAVAILABLE",
    issues: [issue("NOT_SYNCHRONIZED", "traffic")],
  };
  const result = withSnapshots([row]);
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "INSUFFICIENT_EVIDENCE" });
  expect(result.quality.issues.some((row) => row.code === "SOURCE_INCONSISTENT")).toBe(false);
});

it("preserves an unavailable snapshot status in the outcome quality", () => {
  const base = snapshot("CONVERSION_RATE", 650);
  const row: MetricSnapshotV1 = {
    ...base,
    metric: { ...base.metric, value: null },
    sourceWatermark: null,
    status: "UNAVAILABLE",
    issues: [issue("NOT_SYNCHRONIZED", "traffic")],
  };
  expect(withSnapshots([row]).quality.dataStatus).toBe("UNAVAILABLE");
});
