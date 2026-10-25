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
import { StockoutDetector } from "./stockout.detector.js";

type Stockout = Extract<EventEvidenceV1, { eventType: "STOCKOUT_RISK" }>;
const binding = {
  organizationId: "org-stock",
  workspaceId: "workspace-stock",
  storeId: "store-stock",
  connectionId: "connection-stock",
  externalStoreId: "external-stock",
};
const period = {
  periodStart: "2026-10-24T00:00:00Z",
  periodEnd: "2026-10-25T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const policy = {
  schemaVersion: 1,
  version: "event-rules-v1",
  baselineVersion: "baseline-v1",
  rules: [
    {
      eventType: "STOCKOUT_RISK",
      minimumSampleSize: 10,
      minimumCoverageBasisPoints: 9000,
      maximumAgeSeconds: 3600,
      minimumBaselineSamples: 4,
      requireAlignedBaseline: false,
      toleranceBasisPoints: 0,
      thresholds: { criticalHoursRemaining: 6, leadTimeBufferHours: 1 },
    },
  ],
} satisfies EventRulePolicyV1;
const aggregateReference = {
  kind: "NORMALIZED_AGGREGATE",
  id: "observed-stock",
  version: "source-v1",
  hash: "stock-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: period.periodEnd,
  measure: null,
} as const;
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: ["observed-stock"] };
}
function evidence(facts: Partial<Stockout["facts"]> = {}): Stockout {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "STOCKOUT_RISK",
    entity: { kind: "SKU", externalSkuId: "sku-stock" },
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
    sourceReferences: [aggregateReference],
    facts: {
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
      ...facts,
    },
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
  const result = new StockoutDetector().detect(request(value, snapshots));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function snapshot(
  kind: "INVENTORY_AVAILABLE" | "PAID_UNITS" | "LEAD_TIME_HOURS",
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
    evidenceIds: ["observed-stock"],
    sampleSize: 24,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: evidence().entity,
    metric:
      kind === "LEAD_TIME_HOURS" ? { kind, unit: "hours", value } : { kind, unit: "units", value },
  };
}
function withReferences(value: Stockout, snapshots: readonly MetricSnapshotV1[]): Stockout {
  return {
    ...value,
    sourceReferences: [
      ...value.sourceReferences,
      ...snapshots.map((row, index) => ({
        kind: "METRIC_SNAPSHOT" as const,
        id: `snapshot-${index}`,
        version: row.inputRevision,
        hash: `snapshot-hash-${index}`,
        binding,
        definitionVersion: row.definitionVersion,
        period,
        observedAt: period.periodEnd,
        measure: EventMeasureSchema.parse({ kind: row.metric.kind, unit: row.metric.unit }),
      })),
    ],
  };
}

it("detects four-hour cover with immutable typed facts, policy version and stable identity", () => {
  const value = evidence();
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected candidate");
  expect(result.candidate.evidence).toEqual(value);
  expect(result.candidate.rulePolicyVersion).toBe(policy.version);
  expect(result.candidate.fingerprint).toBe(createEventFingerprint(value));
  expect(result.candidate.severityFloor).toBe("HIGH");
});

it.each([6, 6.001, 100])("does not flag adequate cover of %s hours", (hours) => {
  expect(
    outcome(
      evidence({ availableUnits: hours * 1000, salesUnits: 24000, estimatedHoursRemaining: hours }),
    ).disposition,
  ).toBe("NO_CANDIDATE");
});

it("flags just below the exclusive critical threshold", () => {
  expect(
    outcome(evidence({ availableUnits: 5999, salesUnits: 24000, estimatedHoursRemaining: 5.999 }))
      .disposition,
  ).toBe("CANDIDATE");
});

it("uses the injected critical threshold", () => {
  const value = request();
  const custom = {
    ...policy,
    rules: policy.rules.map((row) => ({
      ...row,
      thresholds: { criticalHoursRemaining: 3, leadTimeBufferHours: 0 },
    })),
  };
  expect(new StockoutDetector().detect({ ...value, policy: custom })).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" },
  });
});

it.each([9, 10])("flags coverage %s below observed lead time plus configured buffer", (hours) => {
  expect(
    outcome(
      evidence({
        availableUnits: hours,
        estimatedHoursRemaining: hours,
        supplierLeadTimeHours: 10,
      }),
    ).disposition,
  ).toBe("CANDIDATE");
});

it("keeps the lead time plus buffer boundary exclusive", () => {
  expect(
    outcome(
      evidence({ availableUnits: 11, estimatedHoursRemaining: 11, supplierLeadTimeHours: 10 }),
    ).disposition,
  ).toBe("NO_CANDIDATE");
});

it("retains a late observed ETA as a supply-delay clue without asserting a supplier cause", () => {
  const value = evidence({
    availableUnits: 12,
    estimatedHoursRemaining: 12,
    inboundETA: "2026-10-25T13:00:00Z",
  });
  const result = outcome(value);
  expect(result.disposition).toBe("CANDIDATE");
  if (result.disposition !== "CANDIDATE") throw new Error("Expected candidate");
  expect(result.candidate.evidence).toEqual(value);
  expect(result.candidate.severityFloor).toBe("MEDIUM");
});

it("does not flag an ETA exactly at depletion", () => {
  expect(
    outcome(
      evidence({
        availableUnits: 12,
        estimatedHoursRemaining: 12,
        inboundETA: "2026-10-25T12:00:00Z",
      }),
    ).disposition,
  ).toBe("NO_CANDIDATE");
});

it("never treats a proposed purchase as inventory", () => {
  const value = request();
  expect(
    new StockoutDetector().detect({
      ...value,
      proposedProcurementUnits: 10000,
    } as EventDetectionRequest),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(outcome().disposition).toBe("CANDIDATE");
});

it.each([
  { salesUnits: 0, estimatedHoursRemaining: null },
  { salesUnits: null, estimatedHoursRemaining: null },
  { supplierLeadTimeHours: null },
  { estimatedHoursRemaining: null },
  { inventoryObservedAt: null, inventoryAgeSeconds: null },
] satisfies Partial<Stockout["facts"]>[])(
  "suppresses the dependent forecast for missing or zero data: %j",
  (facts) => {
    expect(outcome(evidence(facts))).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "INSUFFICIENT_EVIDENCE",
    });
  },
);

it.each(["WINDOW_MISMATCH", "VERSION_MISMATCH"] as const)(
  "gates dependent sales with %s while keeping reliable sold-out facts",
  (code) => {
    const limitation = issue(code, "facts.salesUnits");
    const value = {
      ...nontrivialCover(2),
      dataStatus: "UNAVAILABLE" as const,
      issues: [limitation],
    };
    const result = outcome(value);
    expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "INSUFFICIENT_EVIDENCE" });
    expect(result.quality.issues).toContainEqual(limitation);
    const soldOut = {
      ...value,
      facts: { ...value.facts, availableUnits: 0, estimatedHoursRemaining: 0 },
    };
    expect(outcome(soldOut).disposition).toBe("CANDIDATE");
  },
);

it.each(["WINDOW_MISMATCH", "VERSION_MISMATCH"] as const)(
  "keeps %s limited to its inventory, lead-time or cost dependency",
  (code) => {
    const value = nontrivialCover(2);
    const limited = (field: string): Stockout => ({
      ...value,
      dataStatus: "INSUFFICIENT",
      issues: [issue(code, field)],
    });
    expect(outcome(limited("facts.availableUnits")).disposition).toBe("NO_CANDIDATE");
    expect(outcome(limited("facts.supplierLeadTimeHours")).disposition).toBe("NO_CANDIDATE");
    expect(outcome(limited("frozenCosts")).disposition).toBe("CANDIDATE");
    const soldOut = limited("facts.supplierLeadTimeHours");
    expect(
      outcome({
        ...soldOut,
        facts: { ...soldOut.facts, availableUnits: 0, estimatedHoursRemaining: 0 },
      }).disposition,
    ).toBe("CANDIDATE");
  },
);

it("derives inventory age from the observation cutoff when diagnostic age is absent", () => {
  const result = outcome(
    evidence({ inventoryAgeSeconds: null, inventoryObservedAt: "2026-10-24T22:59:59Z" }),
  );
  expect(result).toMatchObject({ disposition: "NO_CANDIDATE", reason: "STALE_SOURCE" });
  expect(result.quality.issues).toContainEqual(issue("STALE_SOURCE", "facts.inventoryObservedAt"));
});

it("accepts freshness exactly at the configured maximum age", () => {
  expect(
    outcome(evidence({ inventoryAgeSeconds: 3600, inventoryObservedAt: "2026-10-24T23:00:00Z" }))
      .disposition,
  ).toBe("CANDIDATE");
});

it("preserves independently verified sold-out stock despite missing forecast inputs and cost gaps", () => {
  const value = {
    ...evidence({
      availableUnits: 0,
      salesUnits: 0,
      estimatedHoursRemaining: null,
      supplierLeadTimeHours: null,
    }),
    dataStatus: "INSUFFICIENT" as const,
    issues: [issue("COST_MISSING", "frozenCosts")],
  };
  const result = outcome(value);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    quality: { dataStatus: "INSUFFICIENT" },
  });
  if (result.disposition !== "CANDIDATE") throw new Error("Expected sold-out fact");
  expect(result.candidate.evidence.facts).toEqual(value.facts);
  expect(result.candidate.severityFloor).toBe("CRITICAL");
  expect(result.quality.issues).toContainEqual(value.issues[0]);
});

it("does not elevate stale zero inventory into a reliable sold-out fact", () => {
  expect(
    outcome(
      evidence({
        availableUnits: 0,
        estimatedHoursRemaining: 0,
        inventoryObservedAt: "2026-10-24T22:00:00Z",
        inventoryAgeSeconds: 7200,
      }),
    ),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "STALE_SOURCE" });
});

it("preserves unrelated cost quality without suppressing reliable inventory forecasts", () => {
  const value = {
    ...evidence(),
    dataStatus: "INSUFFICIENT" as const,
    issues: [issue("COST_MISSING", "frozenCosts")],
  };
  expect(outcome(value).disposition).toBe("CANDIDATE");
});

it.each(["STALE", "UNAVAILABLE", "INSUFFICIENT", "ESTIMATED"] as const)(
  "does not use %s inventory for sold-out facts",
  (inventoryStatus) => {
    expect(
      outcome(evidence({ availableUnits: 0, estimatedHoursRemaining: 0, inventoryStatus }))
        .disposition,
    ).toBe("NO_CANDIDATE");
  },
);

it("gates a low sample forecast without suppressing a reliable sold-out fact", () => {
  const value = { ...evidence(), sampleSize: 1 };
  expect(outcome(value)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
  expect(
    outcome({ ...value, facts: { ...value.facts, availableUnits: 0, estimatedHoursRemaining: 0 } })
      .disposition,
  ).toBe("CANDIDATE");
});

it("gates incomplete coverage and retains its quality reason", () => {
  const value = {
    ...evidence(),
    dataStatus: "INSUFFICIENT" as const,
    coverageBasisPoints: 8000,
    issues: [issue("PARTIAL_COVERAGE", "salesUnits")],
  };
  expect(outcome(value)).toMatchObject({
    disposition: "NO_CANDIDATE",
    quality: { coverageBasisPoints: 8000 },
  });
});

it("rejects facts that contradict a typed observed inventory snapshot", () => {
  const rows = [snapshot("INVENTORY_AVAILABLE", 100)];
  expect(outcome(withReferences(evidence(), rows), rows)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
  });
});

it("does not let a stale sales dependency suppress independently observed sold-out stock", () => {
  const rows = [
    {
      ...snapshot("PAID_UNITS", 24),
      status: "STALE" as const,
      issues: [issue("STALE_SOURCE", "paymentFacts")],
    },
  ];
  const value = withReferences(
    evidence({ availableUnits: 0, estimatedHoursRemaining: null }),
    rows,
  );
  expect(outcome(value, rows).disposition).toBe("CANDIDATE");
  expect(outcome(withReferences(evidence(), rows), rows)).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
  });
});

it("detects inconsistent forecast arithmetic without trusting the supplied estimate", () => {
  expect(outcome(evidence({ estimatedHoursRemaining: 1 }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
  });
});

it("rejects out-of-range derived coverage instead of emitting a nonfinite candidate", () => {
  expect(
    new StockoutDetector().detect(
      request(
        evidence({
          availableUnits: Number.MAX_SAFE_INTEGER,
          salesUnits: 1,
          estimatedHoursRemaining: 1,
        }),
      ),
    ),
  ).toMatchObject({ ok: false, error: { code: "OVERFLOW" } });
});

it("preserves reliable sold-out facts despite conflicting sales snapshots", () => {
  const rows = [snapshot("PAID_UNITS", 100)];
  expect(
    outcome(
      withReferences(evidence({ availableUnits: 0, estimatedHoursRemaining: null }), rows),
      rows,
    ).disposition,
  ).toBe("CANDIDATE");
});

it("rejects unknown fields and malformed scopes without throwing", () => {
  const value = request();
  const detector = new StockoutDetector();
  expect(
    detector.detect({ ...value, evidence: { ...value.evidence, observedAt: "bad" } }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(detector.detect({ ...value, policy: { ...policy, rules: [] } })).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(
    detector.detect({
      ...value,
      evidence: { ...value.evidence, binding: { ...binding, storeId: "other" } },
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});

it("does not mutate the caller's evidence or make results depend on wall-clock time", () => {
  const value = evidence();
  const before = JSON.stringify(value);
  expect(outcome(value)).toEqual(outcome(value));
  expect(JSON.stringify(value)).toBe(before);
});

it.each([
  issue("INVENTORY_UNKNOWN", "facts.estimatedHoursRemaining"),
  issue("STALE_SOURCE", "inventoryExtensions.leadTimeHours"),
])("keeps a sold-out fact independent from forecast issue %j", (limitation) => {
  const value = {
    ...evidence({ availableUnits: 0, estimatedHoursRemaining: null }),
    dataStatus: "INSUFFICIENT" as const,
    issues: [limitation],
  };
  expect(outcome(value).disposition).toBe("CANDIDATE");
});

it("honors explicitly required baselines only for the dependent forecast", () => {
  const configured = {
    ...policy,
    rules: policy.rules.map((row) => ({ ...row, requireAlignedBaseline: true })),
  };
  const detector = new StockoutDetector();
  expect(detector.detect({ ...request(), policy: configured })).toMatchObject({
    ok: true,
    value: { disposition: "NO_CANDIDATE", reason: "BASELINE_UNAVAILABLE" },
  });
  expect(
    detector.detect({
      ...request(evidence({ availableUnits: 0, estimatedHoursRemaining: 0 })),
      policy: configured,
    }),
  ).toMatchObject({ ok: true, value: { disposition: "CANDIDATE" } });
});

it("rejects overflowing lead-time and buffer sums", () => {
  expect(
    new StockoutDetector().detect(
      request(evidence({ supplierLeadTimeHours: Number.MAX_SAFE_INTEGER, safetyBufferHours: 1 })),
    ),
  ).toMatchObject({ ok: false, error: { code: "OVERFLOW" } });
});

function nontrivialCover(availableUnits = 5): Stockout {
  const salesWindow = { ...period, periodStart: "2026-10-24T10:48:00Z" };
  const value = evidence({
    availableUnits,
    salesUnits: 11,
    salesWindow,
    salesWindowHours: 13.2,
    estimatedHoursRemaining: availableUnits * 1.2,
  });
  return {
    ...value,
    ...salesWindow,
    sourceReferences: value.sourceReferences.map((row) => ({ ...row, period: salesWindow })),
  };
}

it.each([4, 5, 6])(
  "compares exact critical cover for %s units over the nontrivial 13.2-hour window",
  (units) => {
    expect(outcome(nontrivialCover(units))).toMatchObject({
      disposition: units < 5 ? "CANDIDATE" : "NO_CANDIDATE",
    });
  },
);

it("keeps the exact lead-time boundary exclusive with a nontrivial coverage ratio", () => {
  const value = nontrivialCover();
  const configured = {
    ...policy,
    rules: policy.rules.map((row) => ({
      ...row,
      thresholds: { criticalHoursRemaining: 3, leadTimeBufferHours: 1 },
    })),
  };
  expect(
    new StockoutDetector().detect({
      ...request({ ...value, facts: { ...value.facts, supplierLeadTimeHours: 5 } }),
      policy: configured,
    }),
  ).toMatchObject({ ok: true, value: { disposition: "NO_CANDIDATE" } });
});

it.each(["2026-10-25T05:59:59.999Z", "2026-10-25T06:00:00Z", "2026-10-25T06:00:00.001Z"])(
  "compares ETA %s exactly at depletion",
  (inboundETA) => {
    const value = nontrivialCover();
    const configured = {
      ...policy,
      rules: policy.rules.map((row) => ({
        ...row,
        thresholds: { criticalHoursRemaining: 3, leadTimeBufferHours: 1 },
      })),
    };
    expect(
      new StockoutDetector().detect({
        ...request({ ...value, facts: { ...value.facts, inboundETA } }),
        policy: configured,
      }),
    ).toMatchObject({
      ok: true,
      value: { disposition: inboundETA.endsWith("00.001Z") ? "CANDIDATE" : "NO_CANDIDATE" },
    });
  },
);

type OptionalField = "inboundETA" | "safetyBufferHours";
const optionalLimitations = [
  ["inboundETA", "STALE_SOURCE"],
  ["safetyBufferHours", "STALE_SOURCE"],
  ["inboundETA", "WINDOW_MISMATCH"],
  ["safetyBufferHours", "WINDOW_MISMATCH"],
  ["inboundETA", "VERSION_MISMATCH"],
  ["safetyBufferHours", "VERSION_MISMATCH"],
  ["inboundETA", "SOURCE_INCONSISTENT"],
  ["safetyBufferHours", "SOURCE_INCONSISTENT"],
] as const;
function optionalSupply(field: OptionalField, code?: DataQualityIssueV1["code"]): Stockout {
  const facts =
    field === "inboundETA" ? { inboundETA: "2026-10-25T13:00:00Z" } : { safetyBufferHours: 20 };
  const value = evidence({ availableUnits: 12, estimatedHoursRemaining: 12, ...facts });
  return code === undefined
    ? value
    : { ...value, dataStatus: "INSUFFICIENT", issues: [issue(code, `facts.${field}`)] };
}

it("uses only observed optional supply values to extend an otherwise adequate cover risk", () => {
  expect(outcome(evidence({ availableUnits: 12, estimatedHoursRemaining: 12 })).disposition).toBe(
    "NO_CANDIDATE",
  );
  expect(outcome(optionalSupply("inboundETA")).disposition).toBe("CANDIDATE");
  expect(outcome(optionalSupply("safetyBufferHours")).disposition).toBe("CANDIDATE");
});

it.each(optionalLimitations)(
  "does not let limited %s with %s trigger its optional risk branch",
  (field, code) => {
    const value = optionalSupply(field, code);
    const result = outcome(value);
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(value.issues[0]);
  },
);

it.each(optionalLimitations)(
  "preserves independent critical, sold-out and reliable lead risk despite %s %s",
  (field, code) => {
    const value = optionalSupply(field, code);
    const withFacts = (facts: Partial<Stockout["facts"]>) =>
      outcome({ ...value, facts: { ...value.facts, ...facts } });
    expect(withFacts({ availableUnits: 4, estimatedHoursRemaining: 4 })).toMatchObject({
      disposition: "CANDIDATE",
      candidate: { severityFloor: "HIGH" },
    });
    expect(withFacts({ availableUnits: 0, estimatedHoursRemaining: null })).toMatchObject({
      disposition: "CANDIDATE",
      candidate: { severityFloor: "CRITICAL" },
    });
    const leadRisk = withFacts({ supplierLeadTimeHours: 13 });
    expect(leadRisk).toMatchObject({
      disposition: "CANDIDATE",
      candidate: { severityFloor: "MEDIUM" },
    });
    expect(leadRisk.quality.issues).toContainEqual(value.issues[0]);
  },
);

it("falls back to the policy buffer when the observed buffer is unreliable", () => {
  const value = optionalSupply("safetyBufferHours", "STALE_SOURCE");
  const result = outcome({
    ...value,
    facts: { ...value.facts, supplierLeadTimeHours: 11.5, safetyBufferHours: 0 },
  });
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    candidate: { severityFloor: "MEDIUM" },
  });
  expect(result.quality.issues).toContainEqual(value.issues[0]);
});

it("keeps valid optional supply branches independent from each other's limitations", () => {
  const etaLimited = optionalSupply("inboundETA", "SOURCE_INCONSISTENT");
  const bufferLimited = optionalSupply("safetyBufferHours", "VERSION_MISMATCH");
  expect(
    outcome({ ...etaLimited, facts: { ...etaLimited.facts, safetyBufferHours: 20 } }).disposition,
  ).toBe("CANDIDATE");
  expect(
    outcome({
      ...bufferLimited,
      facts: { ...bufferLimited.facts, inboundETA: "2026-10-25T13:00:00Z" },
    }).disposition,
  ).toBe("CANDIDATE");
});
