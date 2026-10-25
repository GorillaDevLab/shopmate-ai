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
import { ProfitMarginDropDetector } from "./profit-margin-drop.detector.js";

type Evidence = Extract<EventEvidenceV1, { eventType: "PROFIT_MARGIN_DROP" }>;
const binding = {
  organizationId: "org-profit",
  workspaceId: "workspace-profit",
  storeId: "store-profit",
  connectionId: "connection-profit",
  externalStoreId: "external-profit",
};
const period = {
  periodStart: "2026-10-23T16:00:00Z",
  periodEnd: "2026-10-24T16:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const previous = {
  ...period,
  periodStart: "2026-10-16T16:00:00Z",
  periodEnd: "2026-10-17T16:00:00Z",
};
const policy = {
  schemaVersion: 1,
  version: "profit-rules-v1",
  baselineVersion: "baseline-v1",
  rules: [
    {
      eventType: "PROFIT_MARGIN_DROP",
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
  id: "computed-profit",
  version: "source-v1",
  hash: "profit-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: null,
} as const;
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: [reference.id] };
}
function baseline(
  median = 10000,
  kind: "GROSS_PROFIT" | "CONTRIBUTION" = "CONTRIBUTION",
): RobustBaselineV1 {
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
        kind: "METRIC_SNAPSHOT",
        id: "historical-profit",
        period: previous,
        observedAt: previous.periodEnd,
        measure: { kind, unit: "minorCNY" },
      },
    ],
  } as RobustBaselineV1;
}
function facts(overrides: Partial<Evidence["facts"]> = {}): Evidence["facts"] {
  return {
    paidRevenueMinor: 60000,
    netRevenueMinor: 58000,
    grossMerchandiseMinor: 70000,
    grossProfitMinor: 20000,
    contributionMinor: 7000,
    discountMinor: 7000,
    spendMinor: 5000,
    costCoverageBasisPoints: 10000,
    feeCoverageBasisPoints: 10000,
    profitDeltaMinor: -3000,
    attributionVersion: "profit-delta-sequential-v1",
    contributions: [
      { kind: "VOLUME", amountMinor: 1000 },
      { kind: "PRICE_DISCOUNT", amountMinor: -1500 },
      { kind: "SKU_MIX", amountMinor: -500 },
      { kind: "COGS", amountMinor: -1000 },
      { kind: "ADVERTISING", amountMinor: -1000 },
      { kind: "RESIDUAL", amountMinor: 0 },
    ],
    skuContributions: [{ externalSkuId: "sku-a", revenueMinor: 58000, profitDeltaMinor: -3000 }],
    discountRate: { numerator: 7000, denominator: 70000, valueBasisPoints: 1000, period },
    promotionPeriod: null,
    ...overrides,
  };
}
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  const value = baseline();
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "PROFIT_MARGIN_DROP",
    entity: { kind: "STORE" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 30,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: value,
    baselineVersion: value.version,
    baselineAlignment: value.alignment,
    sourceReferences: [reference],
    facts: facts(),
    ...overrides,
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
function detect(value = evidence()): EventDetectionOutcome {
  const result = new ProfitMarginDropDetector().detect(request(value));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function changedProfit(current: number, before = 10000): Evidence {
  return evidence({
    baseline: baseline(before),
    facts: facts({
      contributionMinor: current,
      profitDeltaMinor: null,
      attributionVersion: null,
      contributions: [],
      skuContributions: [],
    }),
  });
}
function limited(code: DataQualityIssueV1["code"], field: string): Evidence {
  return evidence({ dataStatus: "ESTIMATED", issues: [issue(code, field)] });
}

it("emits a stable candidate with immutable computed contributions and residual", () => {
  const value = evidence();
  const result = detect(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected candidate");
  expect(result.candidate.fingerprint).toBe(createEventFingerprint(value));
  expect(result.candidate.rulePolicyVersion).toBe(policy.version);
  expect(result.candidate.evidence.facts).toEqual(value.facts);
  expect(result.quality.dataStatus).toBe("VERIFIED");
  expect(
    value.facts.contributions.reduce((sum, row) => sum + BigInt(row.amountMinor ?? 0), 0n),
  ).toBe(-3000n);
});

function snapshot(overrides: Partial<MetricSnapshotV1> = {}): MetricSnapshotV1 {
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
    sampleSize: 30,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric: { kind: "CONTRIBUTION", unit: "minorCNY", value: 7000 },
    ...overrides,
  };
}
function withSnapshot(row: MetricSnapshotV1): EventDetectionRequest {
  const ref = {
    ...reference,
    kind: "METRIC_SNAPSHOT" as const,
    measure: EventMeasureSchema.parse({
      kind: row.metric.kind,
      unit: row.metric.unit,
    }),
    id: "profit-snapshot",
  };
  const value = evidence({ sourceReferences: [reference, ref] });
  return request(value, [row]);
}
it("preserves a fresh matching snapshot as verified evidence", () => {
  expect(new ProfitMarginDropDetector().detect(withSnapshot(snapshot()))).toMatchObject({
    ok: true,
    value: { disposition: "CANDIDATE", quality: { dataStatus: "VERIFIED" } },
  });
});
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "withholds a contribution whose gross-profit dependency has %s",
  (code) => {
    expect(detect(limited(code, "grossProfitMinor")).disposition).toBe("NO_CANDIDATE");
  },
);
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "withholds matching snapshot diagnostic %s",
  (code) => {
    const row = snapshot({ status: "ESTIMATED", issues: [issue(code, "contribution")] });
    expect(new ProfitMarginDropDetector().detect(withSnapshot(row))).toMatchObject({
      ok: true,
      value: {
        disposition: "NO_CANDIDATE",
        quality: { issues: expect.arrayContaining([...row.issues]) },
      },
    });
  },
);
it("does not inherit an unrelated snapshot limitation", () => {
  const row = snapshot({
    metric: { kind: "INVENTORY_AVAILABLE", unit: "units", value: 0 },
    status: "STALE",
    issues: [issue("STALE_SOURCE", "inventory")],
  });
  expect(new ProfitMarginDropDetector().detect(withSnapshot(row))).toMatchObject({
    ok: true,
    value: { disposition: "CANDIDATE", quality: { dataStatus: "VERIFIED" } },
  });
});
it("does not round a large exact threshold into a false positive", () => {
  const raw = request(changedProfit(5504099304587058, 6880124130733822));
  expect(new ProfitMarginDropDetector().detect(raw)).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" },
  });
});
it.each([-999, -1000])("uses absolute-only zero-baseline policy for %s", (amount) => {
  const raw = request(changedProfit(amount, 0));
  const rules = policy.rules.map((row) => ({
    ...row,
    thresholds: { ...row.thresholds, relativeDropBasisPoints: 0 },
  }));
  expect(
    new ProfitMarginDropDetector().detect({ ...raw, policy: { ...policy, rules } }),
  ).toMatchObject({
    ok: true,
    value: { disposition: amount === -1000 ? "CANDIDATE" : "NO_CANDIDATE" },
  });
});
it("does not claim advertising attribution explains a gross-profit delta", () => {
  const result = detect(evidence({ baseline: baseline(30000, "GROSS_PROFIT") }));
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues).toContainEqual(
    issue("ATTRIBUTION_MISSING", "profitDeltaMinor.basis"),
  );
});
it("retains a gross-profit candidate independently from stale fee coverage", () => {
  const value = limited("STALE_SOURCE", "fees");
  expect(detect({ ...value, baseline: baseline(30000, "GROSS_PROFIT") }).disposition).toBe(
    "CANDIDATE",
  );
});
it("enforces the configured tolerance beyond relative drop", () => {
  const raw = request(changedProfit(8000));
  const rules = policy.rules.map((row) => ({ ...row, toleranceBasisPoints: 1 }));
  expect(
    new ProfitMarginDropDetector().detect({ ...raw, policy: { ...policy, rules } }),
  ).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" },
  });
});
it.each(["costCoverageBasisPoints", "feeCoverageBasisPoints"] as const)(
  "keeps partial %s estimated above the policy minimum",
  (field) => {
    const result = detect(evidence({ facts: facts({ [field]: 9500 }) }));
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      quality: {
        dataStatus: "ESTIMATED",
        coverageBasisPoints: 9500,
      },
    });
    expect(result.quality.issues.length).toBeGreaterThan(0);
  },
);
it("does not mutate the supplied observations", () => {
  const raw = request();
  const before = structuredClone(raw);
  const result = new ProfitMarginDropDetector().detect(raw);
  expect(raw).toEqual(before);
  expect(result.ok).toBe(true);
});
it("preserves a stale baseline diagnostic", () => {
  const before = baseline();
  const result = detect(
    evidence({ baseline: { ...before, status: "STALE", median: null, mad: null } }),
  );
  expect(result).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
    quality: {
      dataStatus: "STALE",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "STALE_SOURCE", field: "baseline" }),
      ]),
    },
  });
});
it("does not compare without a historical baseline", () => {
  expect(
    detect(evidence({ baseline: null, baselineVersion: null, baselineAlignment: "MISSING" })),
  ).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it("rejects a historical partial/full-day mismatch", () => {
  const raw = request();
  const before = { ...baseline(), period: { ...previous, periodEnd: "2026-10-17T08:00:00Z" } };
  expect(
    new ProfitMarginDropDetector().detect({
      ...raw,
      baseline: before,
      evidence: { ...raw.evidence, baseline: before },
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it.each([8001, 10000, 11000])("does not flag profit %s above the drop threshold", (current) => {
  expect(detect(changedProfit(current))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it("includes exact relative and monetary threshold equality", () => {
  expect(detect(changedProfit(8000)).disposition).toBe("CANDIDATE");
});
it("requires the material monetary threshold independently", () => {
  expect(detect(changedProfit(0, 999))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it.each([
  [-13000, -10000, "CANDIDATE"],
  [-9000, -10000, "NO_CANDIDATE"],
  [-1000, 10000, "CANDIDATE"],
])("compares signed profit %s against %s by baseline magnitude", (current, before, disposition) => {
  expect(detect(changedProfit(Number(current), Number(before))).disposition).toBe(disposition);
});
it("keeps zero baseline explicit without dividing by zero", () => {
  expect(detect(changedProfit(-3000, 0))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
    quality: {
      issues: expect.arrayContaining([expect.objectContaining({ code: "ZERO_DENOMINATOR" })]),
    },
  });
});
it("uses exact rational arithmetic at a fractional median boundary", () => {
  expect(detect(changedProfit(8000, 10000.5)).disposition).toBe("CANDIDATE");
});
it("uses only the financial measure selected by the monetary baseline", () => {
  expect(detect(evidence({ baseline: baseline(10000, "GROSS_PROFIT") }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it("does not substitute contribution when matching gross profit is missing", () => {
  const value = evidence({
    baseline: baseline(10000, "GROSS_PROFIT"),
    facts: facts({ grossProfitMinor: null }),
  });
  expect(detect(value).disposition).toBe("NO_CANDIDATE");
});
it("rejects an unrelated monetary baseline instead of using a proxy", () => {
  const before = {
    ...baseline(),
    measure: { kind: "NET_MERCHANDISE_REVENUE", unit: "minorCNY" },
  } as const;
  const refs = before.sourceReferences.map((row) => ({ ...row, measure: before.measure }));
  expect(detect(evidence({ baseline: { ...before, sourceReferences: refs } }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BASELINE_UNAVAILABLE",
  });
});
it.each(["COST_MISSING", "COST_ESTIMATED", "FEE_MISSING", "ATTRIBUTION_MISSING"] as const)(
  "never upgrades %s because paid revenue is verified",
  (code) => {
    const result = detect(limited(code, code.startsWith("COST") ? "cogsMinor" : "fees"));
    expect(result.quality.dataStatus).not.toBe("VERIFIED");
    expect(result.quality.issues).toContainEqual(
      issue(code, code.startsWith("COST") ? "cogsMinor" : "fees"),
    );
  },
);
it("withholds profit deterioration when COGS coverage is absent", () => {
  expect(detect(evidence({ facts: facts({ costCoverageBasisPoints: 0 }) }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it("withholds contribution deterioration when fee coverage is absent", () => {
  expect(detect(evidence({ facts: facts({ feeCoverageBasisPoints: 0 }) }))).toMatchObject({
    disposition: "NO_CANDIDATE",
  });
});
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "blocks a profit dependency with %s while preserving its reason",
  (code) => {
    const result = detect(limited(code, "contributionMinor"));
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(issue(code, "contributionMinor"));
  },
);
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "retains an independent profit drop when only attribution has %s",
  (code) => {
    const result = detect(limited(code, "contributions.ADVERTISING"));
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(issue(code, "contributions.ADVERTISING"));
  },
);
it("retains explicitly unknown contribution amounts and residual", () => {
  const value = evidence({
    dataStatus: "ESTIMATED",
    issues: [issue("ATTRIBUTION_MISSING", "contributions")],
    facts: facts({
      contributions: [
        { kind: "ADVERTISING", amountMinor: null },
        { kind: "RESIDUAL", amountMinor: null },
      ],
    }),
  });
  const result = detect(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition === "CANDIDATE")
    expect(result.candidate.evidence.facts).toEqual(value.facts);
});
it("rejects complete contributions that do not match the supplied profit delta", () => {
  const value = evidence({ facts: facts({ profitDeltaMinor: -3001 }) });
  expect(new ProfitMarginDropDetector().detect({ ...request(), evidence: value })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it.each(["sample", "coverage", "watermark", "baselineSamples"])(
  "withholds insufficient %s",
  (field) => {
    const value = evidence({
      ...(field === "sample" ? { sampleSize: 0 } : {}),
      ...(field === "coverage"
        ? {
            dataStatus: "ESTIMATED",
            coverageBasisPoints: 8000,
            issues: [issue("PARTIAL_COVERAGE", "source")],
          }
        : {}),
      ...(field === "watermark" ? { observedAt: "2026-10-24T18:00:00Z" } : {}),
      ...(field === "baselineSamples" ? { baseline: { ...baseline(), sampleSize: 1 } } : {}),
    });
    expect(detect(value).disposition).toBe("NO_CANDIDATE");
  },
);
it("rejects strict unknown fields", () => {
  expect(
    new ProfitMarginDropDetector().detect({
      ...request(),
      unexpected: true,
    } as EventDetectionRequest),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it.each(["binding", "definition", "window"])("rejects mismatched %s", (field) => {
  const ref = {
    ...reference,
    ...(field === "binding" ? { binding: { ...binding, storeId: "other-store" } } : {}),
    ...(field === "definition" ? { definitionVersion: "other-definition" } : {}),
    ...(field === "window" ? { period: { ...period, periodEnd: "2026-10-24T15:00:00Z" } } : {}),
  };
  const raw = { ...request(), evidence: { ...evidence(), sourceReferences: [ref] } };
  expect(new ProfitMarginDropDetector().detect(raw)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
