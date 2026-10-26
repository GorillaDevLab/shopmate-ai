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
import { MarketingDetector } from "./marketing.detector.js";

type Marketing = Extract<EventEvidenceV1, { eventType: "ROAS_DROP" | "AD_SPEND_SPIKE" }>;
type Kind = Marketing["eventType"];
const binding = {
  organizationId: "org-marketing",
  workspaceId: "workspace-marketing",
  storeId: "store-marketing",
  connectionId: "connection-marketing",
  externalStoreId: "external-marketing",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const historical = {
  ...period,
  periodStart: "2026-10-17T00:00:00Z",
  periodEnd: "2026-10-18T00:00:00Z",
};
const commonRule = {
  minimumSampleSize: 10,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 0,
};
const policy: EventRulePolicyV1 = {
  schemaVersion: 1,
  version: "event-rules-v1",
  baselineVersion: "baseline-v1",
  rules: [
    {
      ...commonRule,
      eventType: "ROAS_DROP",
      thresholds: {
        relativeDropBasisPoints: 3000,
        minimumSpendMinor: 1000,
        minimumAttributionCoverageBasisPoints: 9000,
      },
    },
    {
      ...commonRule,
      eventType: "AD_SPEND_SPIKE",
      thresholds: {
        relativeIncreaseBasisPoints: 20000,
        minimumSpendMinor: 1000,
      },
    },
  ],
};
const reference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "campaign-record",
  version: "source-v1",
  hash: "campaign-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: { kind: "AD_SPEND", unit: "minorCNY" },
} as const;
function baseline(kind: Kind, median = kind === "ROAS_DROP" ? 20000 : 1000): RobustBaselineV1 {
  const measure =
    kind === "ROAS_DROP"
      ? ({ kind: "ROAS", unit: "basisPoints" } as const)
      : ({ kind: "AD_SPEND", unit: "minorCNY" } as const);
  const common = {
    alignment: "ALIGNED" as const,
    measure,
    aggregation: "EXACT_MEDIAN" as const,
    version: "baseline-v1",
    period: historical,
    median,
    mad: 0,
    sampleSize: 4,
    coverageBasisPoints: 10000,
    sourceReferences: [{ ...reference, id: "historical-campaign", period: historical, measure }],
  };
  return median === 0
    ? { ...common, status: "ZERO", median: 0 }
    : { ...common, status: "AVAILABLE", median };
}
function facts(spend: number | null = 3000, revenue: number | null = 4200): Marketing["facts"] {
  const scaled = revenue === null ? null : BigInt(revenue) * 10000n;
  const divisor = spend === null || spend === 0 ? null : BigInt(spend);
  const value =
    scaled === null || divisor === null
      ? null
      : Number(scaled / divisor + ((scaled % divisor) * 2n >= divisor ? 1n : 0n));
  return {
    spendMinor: spend,
    attributedRevenueMinor: revenue,
    impressions: 1000,
    clicks: 100,
    attributedOrders: 10,
    attributionCoverageBasisPoints: 10000,
    roas: { numerator: revenue, denominator: spend, valueBasisPoints: value, period },
  };
}
function evidence(kind: Kind = "ROAS_DROP", values = facts()): Marketing {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: kind,
    entity: { kind: "CAMPAIGN", externalCampaignId: "campaign-a" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 10,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baseline: baseline(kind),
    baselineVersion: "baseline-v1",
    baselineAlignment: "ALIGNED",
    sourceReferences: [
      reference,
      { ...reference, id: "attributed-campaign", measure: { kind: "ROAS", unit: "basisPoints" } },
    ],
    facts: values,
  };
}
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: [reference.id] };
}
function limited(kind: Kind, code: DataQualityIssueV1["code"], field: string): Marketing {
  return { ...evidence(kind), dataStatus: "INSUFFICIENT", issues: [issue(code, field)] };
}
function request(value = evidence(), configuration = policy): EventDetectionRequest {
  return EventDetectionRequestSchema.parse({
    evidence: value,
    baseline: value.baseline,
    policy: configuration,
    snapshots: [],
  });
}
function outcome(value = evidence(), configuration = policy): EventDetectionOutcome {
  const result = new MarketingDetector().detect(request(value, configuration));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function snapshot(patch: Partial<MetricSnapshotV1> = {}): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    definitionVersion: "metrics-v1",
    inputRevision: "source-v1",
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    evidenceIds: ["attributed-campaign"],
    status: "VERIFIED",
    sampleSize: 10,
    coverageBasisPoints: 10000,
    issues: [],
    subject: { kind: "CAMPAIGN", externalCampaignId: "campaign-a" },
    metric: { kind: "ROAS", unit: "basisPoints", value: 14000 },
    ...patch,
  };
}
function withSnapshot(value: Marketing, observed: MetricSnapshotV1): EventDetectionOutcome {
  const input = EventDetectionRequestSchema.parse({ ...request(value), snapshots: [observed] });
  const result = new MarketingDetector().detect(input);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

it("emits two campaign candidates from the same facts through distinct typed requests", () => {
  const values = facts(),
    before = JSON.stringify(values);
  const candidates = (["ROAS_DROP", "AD_SPEND_SPIKE"] as const).map((kind) =>
    outcome(evidence(kind, values)),
  );
  for (const result of candidates) {
    expect(result.disposition).toBe("CANDIDATE");
    if (result.disposition !== "CANDIDATE") throw new Error("Expected candidate");
    expect(result.candidate.evidence.facts).toEqual(values);
    expect(result.candidate.fingerprint).toBe(createEventFingerprint(result.candidate.evidence));
    expect(result.candidate.rulePolicyVersion).toBe(policy.version);
  }
  expect(JSON.stringify(values)).toBe(before);
  expect(candidates[0]).not.toEqual(candidates[1]);
});
it.each([4199, 4200, 4201])("compares raw revenue %s at the inclusive ROAS boundary", (revenue) => {
  expect(outcome(evidence("ROAS_DROP", facts(3000, revenue))).disposition).toBe(
    revenue <= 4200 ? "CANDIDATE" : "NO_CANDIDATE",
  );
});
it.each([2999, 3000, 3001])("compares raw spend %s at the inclusive spend boundary", (spend) => {
  expect(outcome(evidence("AD_SPEND_SPIKE", facts(spend))).disposition).toBe(
    spend >= 3000 ? "CANDIDATE" : "NO_CANDIDATE",
  );
});
it.each(["ROAS_DROP", "AD_SPEND_SPIKE"] as const)("keeps zero spend nullable for %s", (kind) => {
  const result = outcome(evidence(kind, facts(0, 0)));
  expect(result.disposition).toBe("NO_CANDIDATE");
  expect(JSON.stringify(result)).not.toContain("Infinity");
});
it("retains independent spend with explicitly missing attribution", () => {
  const values = facts(3000, null);
  for (const kind of ["ROAS_DROP", "AD_SPEND_SPIKE"] as const) {
    const value = {
      ...limited(kind, "ATTRIBUTION_MISSING", "facts.attributedRevenueMinor"),
      facts: values,
    };
    const result = outcome(value);
    expect(result.disposition).toBe(kind === "ROAS_DROP" ? "NO_CANDIDATE" : "CANDIDATE");
    expect(result.quality.issues).toContainEqual(value.issues[0]);
  }
});
it("keeps an attribution-only missing code independent even on the shared marketing collection", () => {
  const value = limited("AD_SPEND_SPIKE", "ATTRIBUTION_MISSING", "marketing");
  expect(outcome(value).disposition).toBe("CANDIDATE");
  expect(outcome(value).quality.issues).toContainEqual(value.issues[0]);
  expect(outcome(limited("ROAS_DROP", "ATTRIBUTION_MISSING", "marketing")).disposition).toBe(
    "NO_CANDIDATE",
  );
});
it("preserves unavailable attribution while accepting independently complete actual spend", () => {
  const value = {
    ...limited("AD_SPEND_SPIKE", "ATTRIBUTION_MISSING", "marketing.attribution"),
    dataStatus: "UNAVAILABLE" as const,
    facts: facts(3000, null),
  };
  expect(outcome(value)).toMatchObject({
    disposition: "CANDIDATE",
    quality: { dataStatus: "UNAVAILABLE" },
  });
  expect(outcome(value).quality.issues).toContainEqual(value.issues[0]);
});
it.each(["COST_ESTIMATED", "FEE_ESTIMATED"] as const)(
  "keeps independent %s quality estimated without suppressing marketing",
  (code) => {
    for (const kind of ["ROAS_DROP", "AD_SPEND_SPIKE"] as const) {
      const value = { ...limited(kind, code, "frozenCosts"), dataStatus: "ESTIMATED" as const };
      expect(outcome(value)).toMatchObject({
        disposition: "CANDIDATE",
        quality: { dataStatus: "ESTIMATED" },
      });
      expect(outcome(value).quality.issues).toContainEqual(value.issues[0]);
    }
  },
);
it("fails closed for unexplained, global or mixed unavailable spend quality", () => {
  const value = {
    ...limited("AD_SPEND_SPIKE", "ATTRIBUTION_MISSING", "marketing.attribution"),
    dataStatus: "UNAVAILABLE" as const,
  };
  const variants = [
    { ...value, issues: [issue("COST_MISSING", "frozenCosts")] },
    { ...value, issues: [issue("NOT_SYNCHRONIZED", "marketing")] },
    { ...value, issues: [...value.issues, issue("SOURCE_INCONSISTENT", "facts.spendMinor")] },
    { ...value, sourceWatermark: null },
    { ...value, coverageBasisPoints: 9000 },
    { ...value, sourceWatermark: "2026-10-24T22:00:00Z" },
  ];
  for (const variant of variants) expect(outcome(variant).disposition).toBe("NO_CANDIDATE");
  expect(
    new MarketingDetector().detect({ ...request(), evidence: { ...value, issues: [] } }),
  ).toMatchObject({ ok: false });
});
it.each(["facts.spendMinor", "sourceWatermark", "period", "binding"])(
  "does not hide an explicit %s dependency under an attribution-only code",
  (field) => {
    expect(outcome(limited("AD_SPEND_SPIKE", "ATTRIBUTION_MISSING", field)).disposition).toBe(
      "NO_CANDIDATE",
    );
  },
);
it("treats the ROAS denominator diagnostic as a shared actual-spend dependency", () => {
  const value = limited("AD_SPEND_SPIKE", "WINDOW_MISMATCH", "facts.roas.denominator");
  expect(outcome(value).disposition).toBe("NO_CANDIDATE");
});
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "scopes attribution %s to ROAS dependencies",
  (code) => {
    for (const field of [
      "facts.attributedRevenueMinor",
      "facts.roas",
      "facts.attributionCoverageBasisPoints",
      "marketing.attribution",
    ]) {
      expect(outcome(limited("ROAS_DROP", code, field)).disposition, field).toBe("NO_CANDIDATE");
      const result = outcome(limited("AD_SPEND_SPIKE", code, field));
      expect(result.disposition, field).toBe("CANDIDATE");
      expect(result.quality.issues).toContainEqual(issue(code, field));
    }
  },
);
it.each(["STALE_SOURCE", "WINDOW_MISMATCH", "VERSION_MISMATCH", "SOURCE_INCONSISTENT"] as const)(
  "gates all common spend dependencies for %s",
  (code) => {
    for (const field of [
      "facts.spendMinor",
      "marketing",
      "campaignFacts",
      "sourceWatermark",
      "coverageBasisPoints",
      "facts",
      "definitionVersion",
      "binding",
      "period",
    ]) {
      for (const kind of ["ROAS_DROP", "AD_SPEND_SPIKE"] as const)
        expect(outcome(limited(kind, code, field)).disposition, `${kind}:${field}`).toBe(
          "NO_CANDIDATE",
        );
    }
  },
);
it.each(["facts.impressions", "facts.clicks", "facts.attributedOrders", "frozenCosts", "fees"])(
  "preserves optional %s limitations without gating either event",
  (field) => {
    for (const kind of ["ROAS_DROP", "AD_SPEND_SPIKE"] as const) {
      const result = outcome(limited(kind, "SOURCE_INCONSISTENT", field));
      expect(result.disposition).toBe("CANDIDATE");
      expect(result.quality.issues).toContainEqual(issue("SOURCE_INCONSISTENT", field));
    }
  },
);
it.each(["ROAS_DROP", "AD_SPEND_SPIKE"] as const)("requires measured quality for %s", (kind) => {
  expect(outcome({ ...evidence(kind), sampleSize: 9 }).disposition).toBe("NO_CANDIDATE");
  expect(
    outcome({
      ...limited(kind, "PARTIAL_COVERAGE", "coverageBasisPoints"),
      coverageBasisPoints: 8999,
    }).disposition,
  ).toBe("NO_CANDIDATE");
  expect(
    outcome({
      ...limited(kind, "PARTIAL_COVERAGE", "coverageBasisPoints"),
      coverageBasisPoints: 9000,
    }).disposition,
  ).toBe("CANDIDATE");
});
it("requires configured attribution coverage only for ROAS", () => {
  for (const kind of ["ROAS_DROP", "AD_SPEND_SPIKE"] as const) {
    const value = evidence(kind, { ...facts(), attributionCoverageBasisPoints: 8999 });
    expect(outcome(value).disposition).toBe(kind === "ROAS_DROP" ? "NO_CANDIDATE" : "CANDIDATE");
    expect(
      outcome(evidence(kind, { ...facts(), attributionCoverageBasisPoints: 9000 })).disposition,
    ).toBe("CANDIDATE");
  }
});
it.each(["ROAS_DROP", "AD_SPEND_SPIKE"] as const)(
  "requires known spend and minimum volume for %s",
  (kind) => {
    expect(outcome(evidence(kind, facts(null))).disposition).toBe("NO_CANDIDATE");
    expect(outcome(evidence(kind, facts(999, 0))).disposition).toBe("NO_CANDIDATE");
  },
);
it.each(["ROAS_DROP", "AD_SPEND_SPIKE"] as const)(
  "checks freshness without overriding the global cutoff for %s",
  (kind) => {
    const value = limited(kind, "ATTRIBUTION_MISSING", "facts.attributedRevenueMinor");
    expect(outcome({ ...value, sourceWatermark: "2026-10-24T23:00:00Z" }).disposition).toBe(
      kind === "ROAS_DROP" ? "NO_CANDIDATE" : "CANDIDATE",
    );
    expect(outcome({ ...value, sourceWatermark: "2026-10-24T22:59:59.999Z" }).disposition).toBe(
      "NO_CANDIDATE",
    );
    expect(outcome({ ...value, sourceWatermark: null }).disposition).toBe("NO_CANDIDATE");
  },
);
it("requires typed actual spend and ROAS provenance independently", () => {
  const spendOnly = { ...evidence(), sourceReferences: [reference] };
  expect(outcome(spendOnly).disposition).toBe("NO_CANDIDATE");
  const absentSpend = {
    ...evidence("AD_SPEND_SPIKE"),
    sourceReferences: evidence().sourceReferences.slice(1),
  };
  expect(outcome(absentSpend).disposition).toBe("NO_CANDIDATE");
});
it("marks unattributed provenance as a limitation on an otherwise reliable spend candidate", () => {
  const result = outcome({ ...evidence("AD_SPEND_SPIKE"), sourceReferences: [reference] });
  expect(result.disposition).toBe("CANDIDATE");
  expect(result.quality.issues).toContainEqual(
    expect.objectContaining({ code: "ATTRIBUTION_MISSING", field: "facts.attributedRevenueMinor" }),
  );
});
it("blocks stale actual-spend provenance despite a fresh global watermark", () => {
  for (const dataStatus of ["VERIFIED", "UNAVAILABLE"] as const) {
    const current = evidence("AD_SPEND_SPIKE", facts(3000, null));
    const value = {
      ...current,
      observedAt: "2026-10-25T02:00:00Z",
      sourceWatermark: "2026-10-25T02:00:00Z",
      dataStatus,
      issues:
        dataStatus === "UNAVAILABLE" ? [issue("ATTRIBUTION_MISSING", "marketing.attribution")] : [],
      sourceReferences: [reference],
    };
    const result = outcome(value);
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(
      expect.objectContaining({ code: "STALE_SOURCE", field: "sourceReferences.AD_SPEND" }),
    );
  }
});
it.each(["ROAS_DROP", "AD_SPEND_SPIKE"] as const)(
  "requires the matching baseline for %s",
  (kind) => {
    const value = evidence(kind),
      wrong = { ...baseline(kind), measure: { kind: "PAID_REVENUE", unit: "minorCNY" } as const };
    const changed = {
      ...wrong,
      sourceReferences: wrong.sourceReferences.map((row) => ({ ...row, measure: wrong.measure })),
    };
    expect(outcome({ ...value, baseline: changed }).disposition).toBe("NO_CANDIDATE");
    expect(outcome({ ...value, baseline: baseline(kind, 0) }).disposition).toBe("NO_CANDIDATE");
    expect(
      outcome({ ...value, baseline: null, baselineVersion: null, baselineAlignment: "MISSING" })
        .disposition,
    ).toBe("NO_CANDIDATE");
  },
);
it("keeps a known zero baseline distinct from insufficient historical sample", () => {
  const result = outcome({
    ...evidence("AD_SPEND_SPIKE"),
    baseline: baseline("AD_SPEND_SPIKE", 0),
  });
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" });
  expect(result.quality.issues.some((row) => row.code === "ZERO_DENOMINATOR")).toBe(true);
  expect(result.quality.issues.some((row) => row.code === "LOW_SAMPLE")).toBe(false);
});
it.each(["ROAS_DROP", "AD_SPEND_SPIKE"] as const)("gates historical quality for %s", (kind) => {
  for (const patch of [{ sampleSize: 3 }, { coverageBasisPoints: 8999 }])
    expect(
      outcome({ ...evidence(kind), baseline: { ...baseline(kind), ...patch } }).disposition,
    ).toBe("NO_CANDIDATE");
  for (const code of [
    "STALE_SOURCE",
    "VERSION_MISMATCH",
    "SOURCE_INCONSISTENT",
    "WINDOW_MISMATCH",
  ] as const)
    expect(outcome(limited(kind, code, "baseline")).disposition).toBe("NO_CANDIDATE");
});
it("applies multiplicative tolerance to relative delta rather than rounded ROAS", () => {
  const configured = {
    ...policy,
    rules: policy.rules.map((row) => ({ ...row, toleranceBasisPoints: 1000 })),
  };
  expect(outcome(evidence("ROAS_DROP", facts(3000, 4020)), configured).disposition).toBe(
    "CANDIDATE",
  );
  expect(outcome(evidence("ROAS_DROP", facts(3000, 4021)), configured).disposition).toBe(
    "NO_CANDIDATE",
  );
  expect(outcome(evidence("AD_SPEND_SPIKE", facts(3200)), configured).disposition).toBe(
    "CANDIDATE",
  );
  expect(outcome(evidence("AD_SPEND_SPIKE", facts(3199)), configured).disposition).toBe(
    "NO_CANDIDATE",
  );
});
it("uses injected relative change thresholds for both events", () => {
  const configured: EventRulePolicyV1 = {
    ...policy,
    rules: policy.rules.map((row) => {
      if (row.eventType === "ROAS_DROP")
        return { ...row, thresholds: { ...row.thresholds, relativeDropBasisPoints: 4000 } };
      if (row.eventType === "AD_SPEND_SPIKE")
        return { ...row, thresholds: { ...row.thresholds, relativeIncreaseBasisPoints: 30000 } };
      return row;
    }),
  };
  expect(outcome(evidence(), configured).disposition).toBe("NO_CANDIDATE");
  expect(outcome(evidence("AD_SPEND_SPIKE"), configured).disposition).toBe("NO_CANDIDATE");
});
it("does not let rounded current ROAS manufacture a threshold crossing", () => {
  const value = evidence("ROAS_DROP", facts(300000, 420001));
  expect(value.facts.roas.valueBasisPoints).toBe(14000);
  expect(outcome(value)).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" });
});
it("compares safe integer spend at a large inclusive boundary exactly", () => {
  const value = {
    ...evidence("AD_SPEND_SPIKE", facts(6004799503160658)),
    baseline: baseline("AD_SPEND_SPIKE", 2001599834386886),
  };
  expect(outcome(value).disposition).toBe("CANDIDATE");
  expect(outcome({ ...value, facts: facts(6004799503160657) }).disposition).toBe("NO_CANDIDATE");
});
it("uses exact raw integer ratios at a large nontrivial ROAS boundary", () => {
  const value = {
    ...evidence("ROAS_DROP", facts(8000000000000000, 686000000000000)),
    baseline: baseline("ROAS_DROP", 1225),
  };
  expect(outcome(value).disposition).toBe("CANDIDATE");
  expect(outcome({ ...value, facts: facts(8000000000000000, 686000000000001) }).disposition).toBe(
    "NO_CANDIDATE",
  );
});
it("compares half-unit median spend without floating point rounding", () => {
  const value = {
    ...evidence("AD_SPEND_SPIKE", facts(3001)),
    baseline: baseline("AD_SPEND_SPIKE", 1000.5),
  };
  expect(outcome(value).disposition).toBe("NO_CANDIDATE");
  expect(outcome({ ...value, facts: facts(3002) }).disposition).toBe("CANDIDATE");
});
it("rejects unknown fields, negative spend and contradictory displayed ROAS", () => {
  const detector = new MarketingDetector(),
    value = request();
  const extra = { ...value, unexpected: true };
  expect(detector.detect(extra)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  for (const patch of [{ spendMinor: -1 }, { roas: { ...facts().roas, valueBasisPoints: 14001 } }])
    expect(
      detector.detect({
        ...value,
        evidence: { ...evidence(), facts: { ...facts(), ...patch } },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("validates supplementary ROAS observations while keeping spend independent", () => {
  expect(withSnapshot(evidence(), snapshot()).disposition).toBe("CANDIDATE");
  const conflict = snapshot({ metric: { kind: "ROAS", unit: "basisPoints", value: 13999 } });
  expect(withSnapshot(evidence(), conflict)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
  });
  expect(withSnapshot(evidence("AD_SPEND_SPIKE"), conflict).disposition).toBe("CANDIDATE");
});
it.each(["STALE", "ESTIMATED", "INSUFFICIENT", "UNAVAILABLE"] as const)(
  "retains %s supplementary attribution quality without authorizing ROAS",
  (status) => {
    const code = status === "STALE" ? "STALE_SOURCE" : "ATTRIBUTION_MISSING";
    const observed = snapshot({
      status,
      issues: [{ code, field: "marketing", evidenceIds: ["attributed-campaign"] }],
      metric: { kind: "ROAS", unit: "basisPoints", value: status === "UNAVAILABLE" ? null : 14000 },
      sourceWatermark: status === "UNAVAILABLE" ? null : period.periodEnd,
    });
    expect(withSnapshot(evidence(), observed).disposition).toBe("NO_CANDIDATE");
    const independent = withSnapshot(evidence("AD_SPEND_SPIKE"), observed);
    expect(independent.disposition).toBe("CANDIDATE");
    expect(independent.quality.issues).toContainEqual(observed.issues[0]);
  },
);
it.each([{ sampleSize: 9 }])(
  "derives source time and sample limits from supplementary ROAS %j",
  (patch) => {
    expect(withSnapshot(evidence(), snapshot(patch)).disposition).toBe("NO_CANDIDATE");
    expect(withSnapshot(evidence("AD_SPEND_SPIKE"), snapshot(patch)).disposition).toBe("CANDIDATE");
  },
);
it("derives supplementary freshness from the observed cutoff without inventing source time", () => {
  const value = {
    ...evidence(),
    observedAt: "2026-10-25T01:00:00.001Z",
    sourceWatermark: "2026-10-25T01:00:00.001Z",
  };
  expect(withSnapshot(value, snapshot()).disposition).toBe("NO_CANDIDATE");
  expect(
    withSnapshot(
      { ...value, observedAt: "2026-10-25T01:00:00Z", sourceWatermark: "2026-10-25T01:00:00Z" },
      snapshot(),
    ).disposition,
  ).toBe("CANDIDATE");
});
it("checks both injected minimum spend thresholds independently", () => {
  for (const kind of ["ROAS_DROP", "AD_SPEND_SPIKE"] as const) {
    const configured = {
      ...policy,
      rules: policy.rules.map((row) => {
        if (row.eventType === "ROAS_DROP")
          return { ...row, thresholds: { ...row.thresholds, minimumSpendMinor: 3001 } };
        if (row.eventType === "AD_SPEND_SPIKE")
          return { ...row, thresholds: { ...row.thresholds, minimumSpendMinor: 3001 } };
        return row;
      }),
    };
    expect(outcome(evidence(kind), configured).disposition).toBe("NO_CANDIDATE");
    const boundary = evidence(kind, facts(3001, 0));
    expect(outcome(boundary, configured).disposition).toBe("CANDIDATE");
  }
});
it.each(["MISSING", "UNALIGNED", "INSUFFICIENT", "STALE"] as const)(
  "preserves the unavailable %s baseline quality",
  (status) => {
    const unavailable: RobustBaselineV1 = {
      status,
      alignment:
        status === "MISSING" ? "MISSING" : status === "UNALIGNED" ? "UNALIGNED" : "ALIGNED",
      measure: { kind: "ROAS", unit: "basisPoints" },
      aggregation: "EXACT_MEDIAN",
      version: "baseline-v1",
      period: status === "MISSING" ? null : historical,
      median: null,
      mad: null,
      sampleSize: 0,
      coverageBasisPoints: 0,
      sourceReferences: [],
    };
    const value = {
      ...evidence(),
      baseline: unavailable,
      baselineAlignment: unavailable.alignment,
    };
    const result = outcome(value);
    expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" });
    if (status === "STALE")
      expect(result.quality.issues).toContainEqual(
        expect.objectContaining({ code: "STALE_SOURCE", field: "baseline" }),
      );
  },
);
it("retains unknown optional counts without manufacturing zero observations", () => {
  const value = evidence("AD_SPEND_SPIKE", {
    ...facts(),
    impressions: null,
    clicks: null,
    attributedOrders: null,
  });
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected spend candidate");
  expect(result.candidate.evidence.facts).toEqual(value.facts);
  for (const field of ["impressions", "clicks", "attributedOrders"])
    expect(result.quality.issues).toContainEqual(
      expect.objectContaining({ code: "PARTIAL_COVERAGE", field: `facts.${field}` }),
    );
});
it("rejects cross-scope, future, cross-window and cross-definition provenance", () => {
  const detector = new MarketingDetector();
  const patches = [
    { binding: { ...binding, storeId: "foreign" } },
    { definitionVersion: "other-metrics" },
    { period: historical },
    { observedAt: "2026-10-25T00:00:00.001Z" },
  ];
  for (const patch of patches) {
    const value = { ...evidence(), sourceReferences: [{ ...reference, ...patch }] };
    expect(detector.detect({ ...request(), evidence: value })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  }
});
it("rejects a supplementary observation from another campaign, revision or cutoff", () => {
  const detector = new MarketingDetector();
  const patches: Partial<MetricSnapshotV1>[] = [
    { subject: { kind: "CAMPAIGN", externalCampaignId: "campaign-b" } },
    { inputRevision: "unknown-revision" },
    { definitionVersion: "other-definition" },
    { computedAt: "2026-10-25T00:00:00.001Z" },
  ];
  for (const patch of patches)
    expect(detector.detect({ ...request(), snapshots: [snapshot(patch)] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
});
it("rejects policy version mismatch and unavailable rules", () => {
  const detector = new MarketingDetector(),
    value = request();
  expect(
    detector.detect({ ...value, policy: { ...policy, baselineVersion: "other-baseline" } }),
  ).toMatchObject({ ok: false });
  expect(
    detector.detect({ ...value, policy: { ...policy, rules: policy.rules.slice(1) } }),
  ).toMatchObject({ ok: false });
});
it("does not mutate frozen input facts or depend on ambient time", () => {
  const value = request(),
    before = JSON.stringify(value),
    detector = new MarketingDetector();
  expect(detector.detect(value)).toEqual(detector.detect(value));
  expect(JSON.stringify(value)).toBe(before);
});
it("rejects a valid public request for another detector", () => {
  const value = EventDetectionRequestSchema.parse({
    ...request(),
    baseline: null,
    evidence: {
      ...evidence(),
      eventType: "SYNC_FAILURE",
      baseline: null,
      baselineVersion: null,
      baselineAlignment: "MISSING",
      sourceReferences: [{ ...reference, measure: null }],
      entity: { kind: "CONNECTION", connectionId: binding.connectionId },
      facts: {
        lastSuccessAt: period.periodEnd,
        lagSeconds: 0,
        typedErrorCode: "TEMPORARY",
        affectedResourceKind: "MARKETING",
      },
    },
    policy: {
      ...policy,
      rules: [
        { ...commonRule, eventType: "SYNC_FAILURE", thresholds: { maximumLagSeconds: 3600 } },
      ],
    },
  });
  expect(new MarketingDetector().detect(value)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
