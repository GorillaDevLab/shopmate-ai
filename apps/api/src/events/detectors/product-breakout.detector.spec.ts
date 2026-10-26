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
  type MetricSnapshotV1,
  type RobustBaselineV1,
} from "@shopmate/contracts";
import { ProductBreakoutDetector } from "./product-breakout.detector.js";

type Breakout = Extract<EventEvidenceV1, { eventType: "PRODUCT_BREAKOUT" }>;
const binding = {
  organizationId: "org-breakout",
  workspaceId: "workspace-breakout",
  storeId: "store-breakout",
  connectionId: "connection-breakout",
  externalStoreId: "external-breakout",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const policy = {
  schemaVersion: 1,
  version: "breakout-policy-v1",
  baselineVersion: "baseline-v1",
  rules: [
    {
      eventType: "PRODUCT_BREAKOUT",
      minimumSampleSize: 10,
      minimumCoverageBasisPoints: 9000,
      maximumAgeSeconds: 3600,
      minimumBaselineSamples: 4,
      requireAlignedBaseline: true,
      toleranceBasisPoints: 0,
      thresholds: {
        relativeGrowthBasisPoints: 10000,
        minimumSalesUnits: 20,
        minimumConversionBasisPoints: 500,
      },
    },
  ],
} satisfies EventRulePolicyV1;
const reference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "visible-breakout",
  version: "input-v1",
  hash: "visible-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: null,
} as const;

function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: [reference.id] };
}
function historicalReference(day: number) {
  const start = new Date(Date.parse(period.periodStart) - day * 86400000);
  const end = new Date(start.getTime() + 86400000);
  return {
    ...reference,
    kind: "METRIC_SNAPSHOT" as const,
    id: `history-${day}`,
    period: { ...period, periodStart: start.toISOString(), periodEnd: end.toISOString() },
    observedAt: end.toISOString(),
    measure: { kind: "PAID_UNITS", unit: "units" } as const,
  };
}
function baseline(median = 24): RobustBaselineV1 {
  const refs = [7, 14, 21, 28].map(historicalReference);
  const common = {
    alignment: "ALIGNED" as const,
    measure: { kind: "PAID_UNITS", unit: "units" } as const,
    aggregation: "EXACT_MEDIAN" as const,
    version: "baseline-v1",
    period: refs[0]!.period,
    mad: 2,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: refs,
  };
  return median === 0
    ? { ...common, status: "ZERO", median: 0 }
    : { ...common, status: "AVAILABLE", median };
}
function facts(patch: Partial<Breakout["facts"]> = {}): Breakout["facts"] {
  return {
    salesUnits: 48,
    salesWindow: period,
    salesWindowHours: 24,
    salesUnitsPerHour: 2,
    conversion: { numerator: 20, denominator: 400, valueBasisPoints: 500, period },
    grossProfitMinor: 0,
    netRevenueMinor: 12000,
    costCoverageBasisPoints: 10000,
    listedAt: "2026-09-20T00:00:00Z",
    ...patch,
  };
}
function evidence(patch: Partial<Breakout["facts"]> = {}): Breakout {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "PRODUCT_BREAKOUT",
    entity: { kind: "SKU", externalSkuId: "sku-breakout" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 20,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: baseline(),
    baselineVersion: "baseline-v1",
    baselineAlignment: "ALIGNED",
    sourceReferences: [reference],
    facts: facts(patch),
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
  const result = new ProductBreakoutDetector().detect(request(value, snapshots));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function withBaseline(value: RobustBaselineV1 | null): Breakout {
  return {
    ...evidence(),
    baseline: value,
    baselineVersion: value?.version ?? null,
    baselineAlignment: value?.alignment ?? "MISSING",
  };
}
function limited(value: Breakout, diagnostic: DataQualityIssueV1): Breakout {
  return { ...value, dataStatus: "INSUFFICIENT", issues: [diagnostic] };
}
function snapshot(
  kind: "PAID_UNITS" | "CONVERSION_RATE" | "PAID_ORDERS",
  value: number,
): MetricSnapshotV1 {
  const metric =
    kind === "CONVERSION_RATE"
      ? { kind, unit: "basisPoints" as const, value }
      : kind === "PAID_UNITS"
        ? { kind, unit: "units" as const, value }
        : { kind, unit: "units" as const, value };
  return {
    schemaVersion: 1,
    definitionVersion: "metrics-v1",
    inputRevision: "input-v1",
    binding,
    ...period,
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    evidenceIds: [reference.id],
    sampleSize: 20,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: evidence().entity,
    metric,
  };
}
function snapshotEvidence(rows: readonly MetricSnapshotV1[]): Breakout {
  return {
    ...evidence(),
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

it("emits a LOW opportunity at exact paid-unit growth and conversion boundaries", () => {
  const value = evidence();
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected opportunity");
  expect(result.candidate).toEqual({
    schemaVersion: 1,
    severityFloor: "LOW",
    rulePolicyVersion: policy.version,
    fingerprint: createEventFingerprint(value),
    evidence: value,
  });
  expect(Object.keys(result.candidate).sort()).toEqual([
    "evidence",
    "fingerprint",
    "rulePolicyVersion",
    "schemaVersion",
    "severityFloor",
  ]);
  expect(result.blockedResources).toEqual([]);
});
it.each([1, 2])("does not declare a breakout from %s paid orders", (orders) => {
  const value = {
    ...evidence({
      conversion: { numerator: orders, denominator: 20, valueBasisPoints: orders * 500, period },
    }),
    sampleSize: orders,
  };
  expect(outcome(value)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each([19, 47])("requires both absolute sales and relative growth for %s units", (units) => {
  expect(outcome(evidence({ salesUnits: units, salesUnitsPerHour: units / 24 }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it("uses an injected growth policy instead of a hidden threshold", () => {
  const custom = {
    ...policy,
    rules: [
      {
        ...policy.rules[0],
        thresholds: {
          ...policy.rules[0].thresholds,
          relativeGrowthBasisPoints: 10001,
        },
      },
    ],
  };
  expect(new ProductBreakoutDetector().detect({ ...request(), policy: custom })).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" },
  });
});
it("checks the exact conversion ratio rather than a rounded-up basis point value", () => {
  const conversion = { numerator: 20, denominator: 401, valueBasisPoints: 499, period };
  expect(outcome(evidence({ conversion })).disposition).toBe("NO_CANDIDATE");
});
it("does not let rounded equality fabricate conversion threshold attainment", () => {
  const conversion = { numerator: 19999, denominator: 400000, valueBasisPoints: 500, period };
  expect(outcome(evidence({ conversion })).disposition).toBe("NO_CANDIDATE");
});
it.each([null, 0])("explicitly rejects unavailable or zero baseline %s", (median) => {
  expect(outcome(withBaseline(median === null ? null : baseline(median)))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it("does not bypass growth evidence when the generic baseline switch is false", () => {
  const custom = { ...policy, rules: [{ ...policy.rules[0], requireAlignedBaseline: false }] };
  expect(
    new ProductBreakoutDetector().detect({ ...request(withBaseline(null)), policy: custom }),
  ).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" },
  });
});
it("does not compare units per hour with a paid-unit count baseline", () => {
  expect(outcome().disposition).toBe("CANDIDATE");
  expect(evidence().facts.salesUnitsPerHour).toBeLessThan(24);
});
it("rejects a baseline of an incompatible typed measure", () => {
  const original = baseline();
  const wrong = {
    ...original,
    measure: { kind: "PAID_ORDERS", unit: "units" } as const,
    sourceReferences: original.sourceReferences.map((ref) => ({
      ...ref,
      measure: { kind: "PAID_ORDERS", unit: "units" } as const,
    })),
  };
  expect(outcome(withBaseline(wrong))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it("requires sufficient distinct historical windows", () => {
  const original = baseline();
  expect(
    outcome(withBaseline({ ...original, sourceReferences: original.sourceReferences.slice(0, 1) })),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" });
});
it("rejects history before the known listing date", () => {
  expect(outcome(evidence({ listedAt: "2026-10-01T00:00:00Z" }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
  });
});
it("requires a visible known listing time", () => {
  expect(outcome(evidence({ listedAt: null }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it("preserves listing context without an unversioned recency cutoff", () => {
  expect(outcome(evidence({ listedAt: "2020-01-01T00:00:00Z" })).disposition).toBe("CANDIDATE");
});
it.each([0, 9500, 9999])(
  "discloses incomplete cost coverage %s without erasing opportunity",
  (coverage) => {
    const value = evidence({ costCoverageBasisPoints: coverage, grossProfitMinor: null });
    const result = outcome(value);
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.dataStatus).not.toBe("VERIFIED");
    expect(result.quality.issues).toContainEqual(issue("COST_MISSING", "facts.grossProfitMinor"));
    if (result.disposition === "CANDIDATE")
      expect(result.candidate.evidence.facts).toEqual(value.facts);
  },
);
it("marks partial cost coverage even with a supplied known profit", () => {
  const result = outcome(evidence({ costCoverageBasisPoints: 9500 }));
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues).toContainEqual(
    issue("PARTIAL_COVERAGE", "facts.costCoverageBasisPoints"),
  );
});
it.each([
  "facts.salesUnits",
  "facts.salesUnitsPerHour",
  "facts.conversion",
  "facts.listedAt",
  "baseline",
  "sourceWatermark",
])("suppresses an opportunity with incompatible dependency %s", (field) => {
  const diagnostic = issue("VERSION_MISMATCH", field);
  const result = outcome(limited(evidence(), diagnostic));
  expect(result.disposition).toBe("NO_CANDIDATE");
  expect(result.quality.issues).toContainEqual(diagnostic);
});
it.each(["COST_MISSING", "STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH"] as const)(
  "preserves independent opportunity and optional margin limitation %s",
  (code) => {
    const diagnostic = issue(code, "facts.grossProfitMinor");
    const result = outcome(limited(evidence({ grossProfitMinor: null }), diagnostic));
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it.each([null, "2026-10-24T22:59:59Z"])("requires fresh source watermark %s", (watermark) => {
  const diagnostic = issue(
    watermark === null ? "SOURCE_TIME_MISSING" : "STALE_SOURCE",
    "sourceWatermark",
  );
  const value = { ...limited(evidence(), diagnostic), sourceWatermark: watermark };
  expect(outcome(value).disposition).toBe("NO_CANDIDATE");
});
it("allows exact freshness equality", () => {
  const value = limited(evidence(), issue("COST_MISSING", "facts.grossProfitMinor"));
  expect(outcome({ ...value, sourceWatermark: "2026-10-24T23:00:00Z" }).disposition).toBe(
    "CANDIDATE",
  );
});
it.each(["PAID_UNITS", "CONVERSION_RATE", "PAID_ORDERS"] as const)(
  "rejects conflicting typed snapshot %s",
  (kind) => {
    const rows = [snapshot(kind, 1)];
    expect(outcome(snapshotEvidence(rows), rows)).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "SOURCE_CONFLICT",
    });
  },
);
it("preserves all snapshot diagnostics and suppresses stale sales", () => {
  const diagnostic = issue("WINDOW_MISMATCH", "paidUnits");
  const rows: MetricSnapshotV1[] = [
    { ...snapshot("PAID_UNITS", 48), status: "STALE", issues: [diagnostic] },
  ];
  const result = outcome(snapshotEvidence(rows), rows);
  expect(result.disposition).toBe("NO_CANDIDATE");
  expect(result.quality.issues).toContainEqual(diagnostic);
});
it("uses exact large integer growth at nontrivial equality", () => {
  const units = 9007199254740990;
  const value = {
    ...withBaseline(baseline(4503599627370495)),
    facts: facts({ salesUnits: units, salesUnitsPerHour: units / 24 }),
  };
  expect(outcome(value).disposition).toBe("CANDIDATE");
});
it("supports a half-unit median without rounding it to an integer", () => {
  const value = {
    ...withBaseline(baseline(24.5)),
    facts: facts({ salesUnits: 49, salesUnitsPerHour: 49 / 24 }),
  };
  expect(outcome(value).disposition).toBe("CANDIDATE");
});
it.each(["salesUnits", "salesUnitsPerHour"] as const)("rejects missing required sales %s", () => {
  expect(outcome(evidence({ salesUnits: null, salesUnitsPerHour: null })).disposition).toBe(
    "NO_CANDIDATE",
  );
});
it("rejects future listing time at the strict request boundary", () => {
  const value = { ...request(), evidence: evidence({ listedAt: "2026-10-26T00:00:00Z" }) };
  expect(new ProductBreakoutDetector().detect(value)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("rejects unknown input fields", () => {
  expect(new ProductBreakoutDetector().detect({ ...request(), action: "EXECUTE" })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("rejects extra references for a duplicated historical slot", () => {
  const original = baseline();
  const duplicate = { ...original.sourceReferences[0]!, id: "duplicate-window" };
  expect(
    outcome(
      withBaseline({ ...original, sourceReferences: [...original.sourceReferences, duplicate] }),
    ),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" });
});
it.each([1, 9000, 9500, 9999])("marks all partial cost coverage %s as estimated", (coverage) => {
  const result = outcome(evidence({ costCoverageBasisPoints: coverage }));
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.dataStatus).toBe("ESTIMATED");
  expect(result.quality.issues).toContainEqual(
    issue("PARTIAL_COVERAGE", "facts.costCoverageBasisPoints"),
  );
});
it.each(["WINDOW_MISMATCH", "VERSION_MISMATCH", "STALE_SOURCE", "SOURCE_INCONSISTENT"] as const)(
  "requires every core dependency to be usable for %s",
  (code) => {
    for (const field of [
      "facts.salesUnits",
      "facts.salesUnitsPerHour",
      "facts.conversion",
      "facts.listedAt",
      "baseline",
      "sourceWatermark",
    ]) {
      const diagnostic = issue(code, field);
      const result = outcome(limited(evidence(), diagnostic));
      expect(result.disposition, field).toBe("NO_CANDIDATE");
      expect(result.quality.issues).toContainEqual(diagnostic);
    }
  },
);
it("does not round up growth immediately below an exact large threshold", () => {
  const units = 9007199254740989;
  const value = {
    ...withBaseline(baseline(4503599627370495)),
    facts: facts({ salesUnits: units, salesUnitsPerHour: units / 24 }),
  };
  expect(outcome(value)).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" });
});
it("rejects a fractional median incompatible with integer paid units", () => {
  expect(outcome(withBaseline(baseline(24.25)))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it("rejects zero denominator conversion without fabricating a rate", () => {
  const conversion = { numerator: 0, denominator: 0, valueBasisPoints: null, period };
  const result = outcome(evidence({ conversion }));
  expect(result.disposition).toBe("NO_CANDIDATE");
  expect(result.quality.issues).toContainEqual(issue("ZERO_DENOMINATOR", "facts.conversion"));
});
it("does not trust a large aggregate sample when paid orders are tiny", () => {
  const conversion = { numerator: 2, denominator: 20, valueBasisPoints: 1000, period };
  expect(outcome(evidence({ conversion }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
