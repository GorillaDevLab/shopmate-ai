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
} from "@shopmate/contracts";
import { UnusualDiscountDetector } from "./unusual-discount.detector.js";

type Discount = Extract<EventEvidenceV1, { eventType: "UNUSUAL_DISCOUNT" }>;
const binding = {
  organizationId: "org-discount",
  workspaceId: "workspace-discount",
  storeId: "store-discount",
  connectionId: "connection-discount",
  externalStoreId: "external-discount",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const policy = {
  schemaVersion: 1,
  version: "rules-v1",
  baselineVersion: "baseline-v1",
  rules: [
    {
      eventType: "UNUSUAL_DISCOUNT",
      minimumSampleSize: 10,
      minimumCoverageBasisPoints: 9000,
      maximumAgeSeconds: 3600,
      minimumBaselineSamples: 4,
      requireAlignedBaseline: false,
      toleranceBasisPoints: 0,
      thresholds: { discountBasisPoints: 3000, minimumDiscountMinor: 3000 },
    },
  ],
} satisfies EventRulePolicyV1;
const reference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "source-discount",
  version: "source-v1",
  hash: "hash-discount",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: null,
} as const;
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: [reference.id] };
}
function facts(patch: Partial<Discount["facts"]> = {}): Discount["facts"] {
  return {
    paidRevenueMinor: 7000,
    netRevenueMinor: 7000,
    grossMerchandiseMinor: 10000,
    grossProfitMinor: 3000,
    contributionMinor: 2500,
    discountMinor: 3000,
    spendMinor: 0,
    costCoverageBasisPoints: 10000,
    feeCoverageBasisPoints: 10000,
    profitDeltaMinor: null,
    attributionVersion: null,
    contributions: [],
    skuContributions: [],
    discountRate: { numerator: 3000, denominator: 10000, valueBasisPoints: 3000, period },
    promotionPeriod: period,
    ...patch,
  };
}
function evidence(patch: Partial<Discount["facts"]> = {}): Discount {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "UNUSUAL_DISCOUNT",
    entity: { kind: "STORE" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 20,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: null,
    baselineVersion: null,
    baselineAlignment: "MISSING",
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
  const result = new UnusualDiscountDetector().detect(request(value, snapshots));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function discounted(discount: number, original = 10000): Discount {
  const scaled = BigInt(discount) * 10000n,
    base = BigInt(original);
  const bp = base === 0n ? null : Number(scaled / base + ((scaled % base) * 2n >= base ? 1n : 0n));
  return evidence({
    discountMinor: discount,
    grossMerchandiseMinor: original,
    discountRate: { numerator: discount, denominator: original, valueBasisPoints: bp, period },
  });
}
function limited(code: DataQualityIssueV1["code"], field: string): Discount {
  return { ...evidence(), dataStatus: "INSUFFICIENT", issues: [issue(code, field)] };
}

it("emits an immutable candidate at inclusive rate and amount thresholds", () => {
  const value = evidence(),
    before = JSON.stringify(value),
    result = outcome(value);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    candidate: {
      severityFloor: "MEDIUM",
      rulePolicyVersion: policy.version,
      fingerprint: createEventFingerprint(value),
      evidence: value,
    },
  });
  expect(JSON.stringify(value)).toBe(before);
  expect(outcome(value)).toEqual(result);
});
it("retains already discounted revenue and contribution without a second deduction", () => {
  const result = outcome();
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected discount candidate");
  expect(result.candidate.evidence.facts).toEqual(facts());
  expect(result.candidate.evidence.sourceReferences).toEqual([reference]);
});
it.each([
  [2999, 10000],
  [3000, 10001],
  [4000, 20000],
])("requires both exact thresholds for discount %s on original %s", (discount, original) => {
  expect(outcome(discounted(discount, original))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it("uses injected thresholds rather than hardcoded policy values", () => {
  const configured = {
    ...policy,
    rules: policy.rules.map((row) => ({
      ...row,
      thresholds: { discountBasisPoints: 4000, minimumDiscountMinor: 4000 },
    })),
  };
  expect(new UnusualDiscountDetector().detect({ ...request(), policy: configured })).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" },
  });
});
it.each([0, null])("suppresses missing or zero original amount %s", (original) => {
  const value =
    original === null
      ? evidence({
          grossMerchandiseMinor: null,
          discountRate: { numerator: 3000, denominator: null, valueBasisPoints: null, period },
        })
      : discounted(0, 0);
  expect(outcome(value)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it("suppresses an unknown source discount rather than turning it into zero", () => {
  expect(
    outcome(
      evidence({
        discountMinor: null,
        discountRate: {
          numerator: null,
          denominator: 10000,
          valueBasisPoints: null,
          period,
        },
      }),
    ),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "INSUFFICIENT_EVIDENCE" });
});
it.each([null, { ...period, periodStart: "2026-10-24T12:00:00Z" }])(
  "requires a known promotion covering the complete observed window %j",
  (promotionPeriod) => {
    expect(outcome(evidence({ promotionPeriod }))).toMatchObject({ disposition: "NO_CANDIDATE" });
  },
);
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "gates a %s issue on every discount dependency",
  (code) => {
    for (const field of [
      "facts.discountMinor",
      "facts.grossMerchandiseMinor",
      "facts.discountRate",
      "facts.promotionPeriod",
      "paymentFacts",
      "sourceWatermark",
    ]) {
      const value = limited(code, field),
        result = outcome(value);
      expect(result.disposition).toBe("NO_CANDIDATE");
      expect(result.quality.issues).toContainEqual(value.issues[0]);
    }
  },
);
it.each([
  "grossProfitMinor",
  "contributionMinor",
  "netRevenueMinor",
  "frozenCosts",
  "fees",
  "attributionVersion",
])("preserves independent discount reliability despite a limited %s", (field) => {
  const value = limited("SOURCE_INCONSISTENT", field),
    result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues).toContainEqual(value.issues[0]);
});
it("retains missing cost and gross-profit quality independently", () => {
  const value = {
    ...limited("COST_MISSING", "frozenCosts"),
    facts: facts({
      costCoverageBasisPoints: 0,
      grossProfitMinor: null,
      contributionMinor: null,
    }),
  };
  const result = outcome(value);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    quality: { dataStatus: "INSUFFICIENT" },
  });
  expect(result.quality.issues).toContainEqual(value.issues[0]);
});
it("suppresses low samples and incomplete coverage", () => {
  expect(outcome({ ...evidence(), sampleSize: 9 })).toMatchObject({ disposition: "NO_CANDIDATE" });
  expect(
    outcome({ ...limited("PARTIAL_COVERAGE", "discountRate"), coverageBasisPoints: 8999 }),
  ).toMatchObject({ disposition: "NO_CANDIDATE" });
});
it.each([3599, 3600, 3601])(
  "uses the observation cutoff and inclusive freshness at %s seconds",
  (age) => {
    const observedAt = new Date(Date.parse(period.periodEnd) + age * 1000).toISOString();
    expect(outcome({ ...evidence(), observedAt }).disposition).toBe(
      age > 3600 ? "NO_CANDIDATE" : "CANDIDATE",
    );
  },
);
it("does not interpret missing watermark as fresh", () => {
  expect(
    outcome({ ...limited("SOURCE_TIME_MISSING", "sourceWatermark"), sourceWatermark: null }),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "INSUFFICIENT_EVIDENCE" });
});
it("honors an explicitly required baseline", () => {
  const configured = {
    ...policy,
    rules: policy.rules.map((row) => ({ ...row, requireAlignedBaseline: true })),
  };
  expect(new UnusualDiscountDetector().detect({ ...request(), policy: configured })).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" },
  });
});
it("validates malformed runtime input without throwing", () => {
  const detector = new UnusualDiscountDetector(),
    value = request();
  expect(
    detector.detect({ ...value, evidence: { ...value.evidence, observedAt: "bad" } }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(detector.detect({ ...value, policy: { ...policy, rules: [] } })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

function snapshot(
  kind: "PAID_REVENUE" | "GROSS_PROFIT" | "CONTRIBUTION",
  amount: number,
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
    sampleSize: 20,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric: { kind, unit: "minorCNY", value: amount },
  };
}
function withSnapshots(value: Discount, rows: readonly MetricSnapshotV1[]): Discount {
  return {
    ...value,
    sourceReferences: [
      ...value.sourceReferences,
      ...rows.map((row, index) => ({
        ...reference,
        id: `snapshot-${index}`,
        kind: "METRIC_SNAPSHOT" as const,
        measure: EventMeasureSchema.parse({ kind: row.metric.kind, unit: row.metric.unit }),
      })),
    ],
  };
}
function withBaseline(value = evidence()): Discount {
  const historical = {
    ...period,
    periodStart: "2026-10-17T00:00:00Z",
    periodEnd: "2026-10-18T00:00:00Z",
  };
  const measure = { kind: "PAID_REVENUE", unit: "minorCNY" } as const;
  return {
    ...value,
    baselineVersion: "baseline-v1",
    baselineAlignment: "ALIGNED",
    baseline: {
      status: "AVAILABLE",
      alignment: "ALIGNED",
      measure,
      aggregation: "EXACT_MEDIAN",
      version: "baseline-v1",
      period: historical,
      median: 6000,
      mad: 500,
      sampleSize: 4,
      coverageBasisPoints: 10000,
      sourceReferences: [{ ...reference, id: "historical-revenue", measure, period: historical }],
    },
  };
}
function requiringBaseline(value: Discount): EventDetectionOutcome {
  const configured = {
    ...policy,
    rules: policy.rules.map((row) => ({ ...row, requireAlignedBaseline: true })),
  };
  const result = new UnusualDiscountDetector().detect({ ...request(value), policy: configured });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
it("accepts consistent typed paid-revenue snapshots", () => {
  const rows = [snapshot("PAID_REVENUE", 7000)];
  expect(outcome(withSnapshots(evidence(), rows), rows).disposition).toBe("CANDIDATE");
});
it("suppresses discount evidence contradicted by a supplied paid-revenue snapshot", () => {
  const rows = [snapshot("PAID_REVENUE", 7001)];
  expect(outcome(withSnapshots(evidence(), rows), rows)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
  });
});
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "suppresses relevant snapshot dependency limitation %s",
  (code) => {
    const rows = [
      {
        ...snapshot("PAID_REVENUE", 7000),
        status: "INSUFFICIENT" as const,
        issues: [issue(code, "paymentFacts")],
      },
    ];
    expect(outcome(withSnapshots(evidence(), rows), rows).disposition).toBe("NO_CANDIDATE");
  },
);
it("derives relevant snapshot freshness and sample restrictions", () => {
  const rows = [{ ...snapshot("PAID_REVENUE", 7000), sampleSize: 1 }];
  expect(outcome(withSnapshots(evidence(), rows), rows).disposition).toBe("NO_CANDIDATE");
  const value = {
    ...withSnapshots(evidence(), rows),
    observedAt: "2026-10-25T02:00:00Z",
    sourceWatermark: "2026-10-25T02:00:00Z",
  };
  expect(outcome(value, rows)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
  });
});
it.each(["GROSS_PROFIT", "CONTRIBUTION"] as const)(
  "preserves independent discount despite contradictory %s snapshot",
  (kind) => {
    const rows = [snapshot(kind, 1)],
      result = outcome(withSnapshots(evidence(), rows), rows);
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(issue("SOURCE_INCONSISTENT", `snapshots.${kind}`));
  },
);
it("preserves a stale profit snapshot as a separate quality limitation", () => {
  const rows = [
    {
      ...snapshot("GROSS_PROFIT", 3000),
      status: "STALE" as const,
      issues: [issue("STALE_SOURCE", "frozenCosts")],
    },
  ];
  const result = outcome(withSnapshots(evidence(), rows), rows);
  expect(result).toMatchObject({ disposition: "CANDIDATE", quality: { dataStatus: "STALE" } });
  expect(result.quality.issues).toContainEqual(rows[0]?.issues[0]);
});
it("retains typed baseline context without inventing a discount growth comparison", () => {
  const value = withBaseline(),
    result = requiringBaseline(value);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    candidate: { evidence: { baseline: value.baseline } },
  });
});
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "gates explicitly required baseline diagnostic %s independently",
  (code) => {
    const value = withBaseline(limited(code, "baseline.median"));
    expect(requiringBaseline(value)).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "BASELINE_UNAVAILABLE",
    });
    expect(outcome(value).disposition).toBe("CANDIDATE");
  },
);
it("requires configured baseline sample and coverage", () => {
  const value = withBaseline();
  if (value.baseline === null) throw new Error("Expected baseline");
  expect(
    requiringBaseline({ ...value, baseline: { ...value.baseline, sampleSize: 3 } }).disposition,
  ).toBe("NO_CANDIDATE");
  expect(
    requiringBaseline({ ...value, baseline: { ...value.baseline, coverageBasisPoints: 8999 } })
      .disposition,
  ).toBe("NO_CANDIDATE");
});
it.each([3002399751580329, 3002399751580330, 3002399751580331])(
  "compares exact safe integer discount %s without intermediate precision loss",
  (amount) => {
    const configured = {
      ...policy,
      rules: policy.rules.map((row) => ({
        ...row,
        thresholds: { discountBasisPoints: 5000, minimumDiscountMinor: 0 },
      })),
    };
    const result = new UnusualDiscountDetector().detect({
      ...request(discounted(amount, 6004799503160660)),
      policy: configured,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { disposition: amount < 3002399751580330 ? "NO_CANDIDATE" : "CANDIDATE" },
    });
  },
);
it.each(["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH", "STALE_SOURCE"] as const)(
  "does not overlook a global %s diagnostic",
  (code) => {
    expect(outcome(limited(code, "facts")).disposition).toBe("NO_CANDIDATE");
  },
);

it("preserves the explicit stale status of a required baseline", () => {
  const value = withBaseline();
  if (value.baseline === null) throw new Error("Expected baseline");
  const stale = {
    ...value,
    baseline: { ...value.baseline, status: "STALE" as const, median: null, mad: null },
  };
  const result = requiringBaseline(stale);
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" });
  expect(result.quality.issues).toContainEqual(issue("STALE_SOURCE", "baseline"));
});
it("rejects extra runtime fields, negative money and foreign bindings", () => {
  const detector = new UnusualDiscountDetector(),
    value = request();
  const extra = { ...value, unexpected: true };
  expect(detector.detect(extra)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    detector.detect({ ...value, evidence: { ...evidence(), facts: facts({ discountMinor: -1 }) } }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    detector.detect({
      ...value,
      evidence: { ...evidence(), binding: { ...binding, storeId: "foreign" } },
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("rejects supplied rounded rates that contradict source money", () => {
  const value = evidence({
    discountRate: { numerator: 3000, denominator: 10000, valueBasisPoints: 3001, period },
  });
  expect(new UnusualDiscountDetector().detect({ ...request(), evidence: value })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

it.each(["definitionVersion", "period", "observedAt", "binding"])(
  "suppresses global version/window/visibility restrictions on %s",
  (field) => {
    expect(outcome(limited("VERSION_MISMATCH", field)).disposition).toBe("NO_CANDIDATE");
  },
);
it.each(["traffic", "inventoryExtensions", "refundFacts", "returnReceipts", "marketing"])(
  "keeps unrelated source diagnostic %s independent",
  (field) => {
    const value = limited("STALE_SOURCE", field),
      result = outcome(value);
    expect(result.disposition).toBe("CANDIDATE");
    expect(result.quality.issues).toContainEqual(value.issues[0]);
  },
);

it.each([
  ["costCoverageBasisPoints", "COST_ESTIMATED", "facts.grossProfitMinor"],
  ["feeCoverageBasisPoints", "FEE_ESTIMATED", "facts.contributionMinor"],
] as const)(
  "retains 9500 %s as an independent estimated limitation above the 9000 policy minimum",
  (field, code, target) => {
    const value = evidence({ [field]: 9500 }),
      before = JSON.stringify(value),
      result = outcome(value);
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      quality: { dataStatus: "ESTIMATED", coverageBasisPoints: 10000 },
    });
    expect(result.quality.issues).toContainEqual(issue(code, target));
    if (result.disposition !== "CANDIDATE") throw new Error("Expected discount candidate");
    expect(result.candidate.evidence.facts).toEqual(value.facts);
    expect(JSON.stringify(value)).toBe(before);
  },
);
it.each([
  ["costCoverageBasisPoints", "COST_ESTIMATED", "facts.grossProfitMinor"],
  ["feeCoverageBasisPoints", "FEE_ESTIMATED", "facts.contributionMinor"],
] as const)(
  "keeps partial %s below the core policy minimum independent from discount eligibility",
  (field, code, target) => {
    const result = outcome(evidence({ [field]: 8999 }));
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      quality: { dataStatus: "ESTIMATED" },
    });
    expect(result.quality.issues).toContainEqual(issue(code, target));
  },
);
it.each([
  ["costCoverageBasisPoints", "COST_MISSING", "facts.grossProfitMinor"],
  ["feeCoverageBasisPoints", "FEE_MISSING", "facts.contributionMinor"],
] as const)(
  "retains zero %s as missing without suppressing the independent discount",
  (field, code, target) => {
    const result = outcome(evidence({ [field]: 0 }));
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      quality: { dataStatus: "INSUFFICIENT" },
    });
    expect(result.quality.issues).toContainEqual(issue(code, target));
  },
);
it.each([0, 7000])(
  "preserves full coverage and known zero-valued financial inputs for gross profit %s",
  (grossProfitMinor) => {
    const value = evidence({ grossProfitMinor, contributionMinor: grossProfitMinor });
    const result = outcome(value);
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      quality: { dataStatus: "VERIFIED", issues: [] },
    });
    if (result.disposition !== "CANDIDATE") throw new Error("Expected discount candidate");
    expect(result.candidate.evidence.facts).toEqual(value.facts);
  },
);
it.each([
  ["INSUFFICIENT", "COST_MISSING"],
  ["STALE", "STALE_SOURCE"],
] as const)(
  "does not upgrade existing %s quality when partial financial estimates are added",
  (dataStatus, code) => {
    const value = {
      ...limited(code, "frozenCosts"),
      dataStatus,
      facts: facts({ feeCoverageBasisPoints: 9500 }),
    };
    const result = outcome(value);
    expect(result).toMatchObject({ disposition: "CANDIDATE", quality: { dataStatus } });
    expect(result.quality.issues).toContainEqual(value.issues[0]);
    expect(result.quality.issues).toContainEqual(issue("FEE_ESTIMATED", "facts.contributionMinor"));
  },
);
