import {
  EventDetectionOutcomeSchema,
  EventDetectionRequestSchema,
  EventMeasureSchema,
  type DataQualityIssueV1,
  type EventDetectionOutcome,
  type EventDetectionRequest,
  type EventEvidenceV1,
  type EventSourceReference,
  type MetricSnapshotV1,
} from "@shopmate/contracts";
import { expect, it } from "vitest";
import { createInventoryStagnationDetector } from "./inventory-stagnation.detector.js";

type Evidence = Extract<EventEvidenceV1, { eventType: "INVENTORY_STAGNATION" }>;
type Facts = Evidence["facts"];
const binding = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "external",
};
const period = {
  periodStart: "2026-09-25T00:00:00.000Z",
  periodEnd: "2026-10-25T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
function aggregate(): EventSourceReference {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: "aggregate",
    hash: "hash",
    version: "revision-v1",
    binding,
    definitionVersion: "definition-v1",
    period,
    observedAt: period.periodEnd,
    measure: null,
  };
}
function facts(patch: Partial<Facts>): Facts {
  return {
    availableUnits: 100,
    salesUnits: 30,
    salesWindow: period,
    salesWindowHours: 720,
    holdingDays: 100,
    demandCoverageDays: 100,
    listedAt: "2026-01-01T00:00:00.000Z",
    inventoryCostMinor: 12300,
    costCoverageBasisPoints: 10000,
    ...patch,
  };
}
function evidence(patch: Partial<Facts> = {}): Evidence {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    eventType: "INVENTORY_STAGNATION",
    entity: { kind: "SKU", externalSkuId: "sku" },
    observedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    dataStatus: "VERIFIED",
    sampleSize: 30,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "definition-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [aggregate()],
    facts: facts(patch),
  };
}
function request(item: Evidence = evidence()): EventDetectionRequest {
  return {
    evidence: item,
    snapshots: [],
    baseline: null,
    policy: {
      schemaVersion: 1,
      version: "policy-v1",
      baselineVersion: "baseline-v1",
      rules: [
        {
          eventType: "INVENTORY_STAGNATION",
          minimumSampleSize: 10,
          minimumCoverageBasisPoints: 9000,
          maximumAgeSeconds: 3600,
          minimumBaselineSamples: 3,
          requireAlignedBaseline: false,
          toleranceBasisPoints: 0,
          thresholds: {
            minimumHoldingDays: 90,
            minimumDemandCoverageDays: 90,
            minimumListingAgeHours: 2160,
          },
        },
      ],
    },
  };
}
function detect(input = request()): EventDetectionOutcome {
  expect(EventDetectionRequestSchema.safeParse(input).success).toBe(true);
  const result = createInventoryStagnationDetector().detect(input);
  if (!result.ok) throw new Error(`Unexpected detector failure: ${result.error.code}`);
  expect(EventDetectionOutcomeSchema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function issue(code: DataQualityIssueV1["code"], field: string): DataQualityIssueV1 {
  return { code, field, evidenceIds: ["source-fact"] };
}
function limited(item: Evidence, diagnostic: DataQualityIssueV1): Evidence {
  return { ...item, dataStatus: "INSUFFICIENT", issues: [diagnostic] };
}
it("creates a validated candidate with immutable evidence and policy identity", () => {
  const input = request();
  const original = JSON.stringify(input);
  const result = detect(input);
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    blockedResources: [],
    candidate: {
      severityFloor: "MEDIUM",
      rulePolicyVersion: "policy-v1",
      evidence: { facts: input.evidence.facts, sourceReferences: input.evidence.sourceReferences },
    },
  });
  expect(JSON.stringify(input)).toBe(original);
  expect(detect(input)).toEqual(result);
});
it.each([89, 90])("excludes demand coverage of %s days", (days) => {
  expect(
    detect(request(evidence({ availableUnits: days, demandCoverageDays: days }))),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "BELOW_THRESHOLD" });
});
it("honors injected holding and listing minimums inclusively", () => {
  const item = evidence({ holdingDays: 90, listedAt: "2026-07-27T00:00:00.000Z" });
  expect(detect(request(item)).disposition).toBe("CANDIDATE");
  expect(detect(request(evidence({ holdingDays: 89.9 })))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it("reports a new one-order SKU as insufficient without guessing its identity", () => {
  const item = {
    ...evidence({ salesUnits: 1, demandCoverageDays: 3000, listedAt: "2026-10-24T00:00:00.000Z" }),
    sampleSize: 1,
  };
  expect(detect(request(item))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
    quality: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "LOW_SAMPLE" }),
        expect.objectContaining({ code: "IMMATURE_COHORT" }),
      ]),
    },
  });
});
it.each([null, 0])("keeps %s sales insufficient without division by zero", (salesUnits) => {
  expect(detect(request(evidence({ salesUnits, demandCoverageDays: null })))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each(["availableUnits", "holdingDays", "listedAt", "demandCoverageDays"] as const)(
  "requires known %s",
  (field) => {
    expect(detect(request(evidence({ [field]: null })))).toMatchObject({
      disposition: "NO_CANDIDATE",
      reason: "INSUFFICIENT_EVIDENCE",
      quality: { dataStatus: "INSUFFICIENT", issues: expect.any(Array) },
    });
  },
);
it("rejects a contradictory demand coverage fact with explicit source conflict", () => {
  expect(detect(request(evidence({ demandCoverageDays: 101 })))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "SOURCE_CONFLICT",
    quality: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_INCONSISTENT", field: "demandCoverageDays" }),
      ]),
    },
  });
});
it("accepts the existing P03 fractional demand coverage representation", () => {
  const demandCoverageDays = ((94 / 31) * 720) / 24;
  expect(demandCoverageDays).toBe(90.96774193548386);
  const item = evidence({ availableUnits: 94, salesUnits: 31, demandCoverageDays });
  expect(detect(request(item))).toMatchObject({
    disposition: "CANDIDATE",
    candidate: { evidence: { facts: { demandCoverageDays } } },
  });
});
it.each([null, 9000])("preserves the inventory signal with unavailable/partial cost %s", (cost) => {
  const item = evidence({
    inventoryCostMinor: cost,
    costCoverageBasisPoints: cost === null ? 0 : 5000,
  });
  expect(detect(request(item))).toMatchObject({
    disposition: "CANDIDATE",
    candidate: {
      evidence: {
        facts: { inventoryCostMinor: null, costCoverageBasisPoints: cost === null ? 0 : 5000 },
      },
    },
    quality: {
      dataStatus: "INSUFFICIENT",
      issues: expect.arrayContaining([expect.objectContaining({ code: "COST_MISSING" })]),
    },
  });
});
it("preserves known zero cost", () => {
  expect(detect(request(evidence({ inventoryCostMinor: 0 })))).toMatchObject({
    disposition: "CANDIDATE",
    candidate: { evidence: { facts: { inventoryCostMinor: 0 } } },
  });
});
const coreFields = [
  "availableUnits",
  "salesUnits",
  "salesWindow",
  "salesWindowHours",
  "holdingDays",
  "listedAt",
  "demandCoverageDays",
  "inventoryFacts",
  "paymentFacts",
];
const blockers = [
  "WINDOW_MISMATCH",
  "VERSION_MISMATCH",
  "STALE_SOURCE",
  "SOURCE_INCONSISTENT",
] as const;
it.each(blockers.flatMap((code) => coreFields.map((field) => ({ code, field }))))(
  "gates required $field on $code and preserves its reason",
  ({ code, field }) => {
    const diagnostic = issue(code, field);
    const result = detect(request(limited(evidence(), diagnostic)));
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it.each(blockers)(
  "redacts optional cost for %s while keeping independent inventory evidence",
  (code) => {
    const diagnostic = issue(code, "inventoryCostMinor");
    const result = detect(request(limited(evidence(), diagnostic)));
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      candidate: {
        evidence: { facts: { inventoryCostMinor: null, availableUnits: 100 } },
      },
    });
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it("does not let unrelated traffic quality suppress inventory facts", () => {
  const diagnostic = issue("STALE_SOURCE", "visitors");
  expect(detect(request(limited(evidence(), diagnostic))).disposition).toBe("CANDIDATE");
});
it("keeps nested unrelated quality independent of inventory eligibility", () => {
  const diagnostic = issue("WINDOW_MISMATCH", "evidence.facts.visitors");
  expect(detect(request(limited(evidence(), diagnostic))).disposition).toBe("CANDIDATE");
});
it("suppresses old source watermarks and retains original facts", () => {
  const item = {
    ...evidence(),
    sourceWatermark: "2026-10-24T00:00:00.000Z",
    dataStatus: "INSUFFICIENT" as const,
    issues: [issue("PARTIAL_COVERAGE", "sourceWatermark")],
  };
  expect(detect(request(item))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
  });
});
it("uses an exclusive exact threshold at large integer quantities", () => {
  const item = evidence({
    availableUnits: 7777777777777770,
    salesUnits: 2592592592592590,
    demandCoverageDays: 90,
  });
  expect(detect(request(item))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
  expect(
    detect(
      request({
        ...item,
        facts: {
          ...item.facts,
          availableUnits: 7777777777777771,
          demandCoverageDays: (7777777777777771 * 30) / 2592592592592590,
        },
      }),
    ),
  ).toMatchObject({ disposition: "CANDIDATE" });
});
it("rejects malformed input and unknown fields", () => {
  expect(
    createInventoryStagnationDetector().detect({
      ...request(),
      extra: true,
    } as EventDetectionRequest),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
function snapshot(patch: Partial<MetricSnapshotV1> = {}): MetricSnapshotV1 {
  return {
    schemaVersion: 1,
    definitionVersion: "definition-v1",
    inputRevision: "revision-v1",
    binding,
    ...period,
    visibleAt: period.periodEnd,
    computedAt: period.periodEnd,
    sourceWatermark: period.periodEnd,
    sampleSize: 30,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    evidenceIds: ["inventory-fact", "source-fact"],
    subject: { kind: "SKU", externalSkuId: "sku" },
    metric: { kind: "INVENTORY_AVAILABLE", unit: "units", value: 100 },
    ...patch,
  };
}
function withSnapshot(item: MetricSnapshotV1): EventDetectionRequest {
  const base = request();
  const ref: EventSourceReference = {
    ...aggregate(),
    kind: "METRIC_SNAPSHOT",
    id: "snapshot",
    measure: EventMeasureSchema.parse({ kind: item.metric.kind, unit: item.metric.unit }),
  };
  return {
    ...base,
    evidence: { ...base.evidence, sourceReferences: [aggregate(), ref] },
    snapshots: [item],
  };
}
it("rejects contradictory typed inventory observations", () => {
  expect(
    detect(
      withSnapshot(
        snapshot({ metric: { kind: "INVENTORY_AVAILABLE", unit: "units", value: 101 } }),
      ),
    ),
  ).toMatchObject({ disposition: "NO_CANDIDATE", reason: "SOURCE_CONFLICT" });
});
it.each(blockers)(
  "gates typed inventory snapshot diagnostics regardless of field spelling: %s",
  (code) => {
    const diagnostic = issue(code, "upstreamResource");
    const result = detect(withSnapshot(snapshot({ status: "INSUFFICIENT", issues: [diagnostic] })));
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it("gates low snapshot coverage independently of the aggregate coverage", () => {
  const item = snapshot({
    status: "INSUFFICIENT",
    coverageBasisPoints: 8000,
    issues: [issue("PARTIAL_COVERAGE", "inventoryFacts")],
  });
  expect(detect(withSnapshot(item)).disposition).toBe("NO_CANDIDATE");
});
it("redacts cost when its typed source reference is stale", () => {
  const item = evidence();
  const cost: EventSourceReference = {
    ...aggregate(),
    id: "cost",
    measure: { kind: "COGS", unit: "minorCNY" },
  };
  const old = {
    ...item,
    observedAt: "2026-10-25T02:00:00.000Z",
    sourceWatermark: "2026-10-25T02:00:00.000Z",
    sourceReferences: [{ ...aggregate(), observedAt: "2026-10-25T02:00:00.000Z" }, cost],
  };
  expect(detect(request(old))).toMatchObject({
    disposition: "CANDIDATE",
    candidate: { evidence: { facts: { inventoryCostMinor: null } } },
    quality: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "STALE_SOURCE", field: "inventoryCostMinor" }),
      ]),
    },
  });
});
it("requires fresh source references even when the aggregate watermark is fresh", () => {
  const item = {
    ...evidence(),
    observedAt: "2026-10-25T02:00:00.000Z",
    sourceWatermark: "2026-10-25T02:00:00.000Z",
  };
  expect(detect(request(item))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "STALE_SOURCE",
  });
});
it("reports missing inventory and sales source provenance", () => {
  const item = {
    ...evidence(),
    sourceReferences: [
      { ...aggregate(), measure: { kind: "PAID_REVENUE", unit: "minorCNY" } as const },
    ],
  };
  expect(detect(request(item))).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "INSUFFICIENT_EVIDENCE",
  });
});
it.each(["INVENTORY_AVAILABLE", "PAID_UNITS"])(
  "matches required metric diagnostic spelling %s",
  (field) => {
    expect(detect(request(limited(evidence(), issue("VERSION_MISMATCH", field)))).disposition).toBe(
      "NO_CANDIDATE",
    );
  },
);
it("handles repeated source IDs across distinct immutable revisions", () => {
  const item = evidence({ holdingDays: null });
  const refs = [aggregate(), { ...aggregate(), version: "revision-v2" }];
  expect(detect(request({ ...item, sourceReferences: refs }))).toMatchObject({
    disposition: "NO_CANDIDATE",
    quality: {
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "holdingDays", evidenceIds: ["aggregate"] }),
      ]),
    },
  });
});
it.each(blockers)(
  "preserves independent inventory when a snapshot only diagnoses optional cost: %s",
  (code) => {
    const diagnostic = issue(code, "inventoryCostMinor");
    const input = withSnapshot(snapshot({ status: "INSUFFICIENT", issues: [diagnostic] }));
    expect(detect(input)).toMatchObject({
      disposition: "CANDIDATE",
      candidate: { evidence: { facts: { inventoryCostMinor: null } } },
    });
  },
);
it("compares decimal policy coverage thresholds exactly", () => {
  const input = request(
    evidence({ availableUnits: 901, salesUnits: 300, demandCoverageDays: 90.1 }),
  );
  const rules = input.policy.rules.map((rule) =>
    rule.eventType === "INVENTORY_STAGNATION"
      ? { ...rule, thresholds: { ...rule.thresholds, minimumDemandCoverageDays: 90.1 } }
      : rule,
  );
  expect(detect({ ...input, policy: { ...input.policy, rules } })).toMatchObject({
    disposition: "NO_CANDIDATE",
    reason: "BELOW_THRESHOLD",
  });
});
it.each([3600000, 3600001])(
  "uses the exact inclusive freshness limit at %s milliseconds",
  (elapsed) => {
    const observedAt = new Date(Date.parse(period.periodEnd) + elapsed).toISOString();
    expect(detect(request({ ...evidence(), observedAt })).disposition).toBe(
      elapsed === 3600000 ? "CANDIDATE" : "NO_CANDIDATE",
    );
  },
);
it("does not copy a sold-goods cost snapshot into inventory exposure", () => {
  const item = snapshot({ metric: { kind: "COGS", unit: "minorCNY", value: 999 } });
  expect(detect(withSnapshot(item))).toMatchObject({
    disposition: "CANDIDATE",
    candidate: { evidence: { facts: { inventoryCostMinor: 12300 } } },
  });
});
it.each(blockers)("scopes original global-looking optional COGS diagnostics: %s", (code) => {
  const diagnostic = issue(code, "sourceWatermark");
  const cost = snapshot({
    metric: { kind: "COGS", unit: "minorCNY", value: 999 },
    status: code === "STALE_SOURCE" ? "STALE" : "INSUFFICIENT",
    issues: [diagnostic],
    sourceWatermark: code === "STALE_SOURCE" ? "2026-10-24T00:00:00.000Z" : period.periodEnd,
  });
  const result = detect(withSnapshot(cost));
  expect(result).toMatchObject({
    disposition: "CANDIDATE",
    candidate: {
      evidence: {
        facts: { inventoryCostMinor: null, availableUnits: 100, salesUnits: 30 },
      },
    },
  });
  expect(result.quality.issues).toContainEqual(diagnostic);
  expect(result.quality.issues).toContainEqual(
    expect.objectContaining({ code, field: "inventoryCostMinor" }),
  );
});
it.each(["COST_MISSING", "COST_ESTIMATED"] as const)(
  "scopes optional COGS cost limitations: %s",
  (code) => {
    const diagnostic = issue(code, "sourceWatermark");
    const cost = snapshot({
      metric: { kind: "COGS", unit: "minorCNY", value: 999 },
      status: "INSUFFICIENT",
      issues: [diagnostic],
    });
    const result = detect(withSnapshot(cost));
    expect(result).toMatchObject({
      disposition: "CANDIDATE",
      candidate: { evidence: { facts: { inventoryCostMinor: null } } },
    });
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it.each(blockers)(
  "keeps matching required diagnostics blocking alongside optional COGS: %s",
  (code) => {
    const diagnostic = issue(code, "sourceWatermark");
    const inventory = snapshot({ status: "INSUFFICIENT", issues: [diagnostic] });
    const cost = snapshot({
      metric: { kind: "COGS", unit: "minorCNY", value: 999 },
      status: "INSUFFICIENT",
      issues: [diagnostic],
    });
    const input = withSnapshot(inventory);
    const costRef: EventSourceReference = {
      ...aggregate(),
      id: "cost-snapshot",
      kind: "METRIC_SNAPSHOT",
      measure: { kind: "COGS", unit: "minorCNY" },
    };
    const result = detect({
      ...input,
      snapshots: [inventory, cost],
      evidence: {
        ...input.evidence,
        sourceReferences: [...input.evidence.sourceReferences, costRef],
      },
    });
    expect(result.disposition).toBe("NO_CANDIDATE");
    expect(result.quality.issues).toContainEqual(diagnostic);
  },
);
it.each(["store", "version", "window", "unknown", "future"])(
  "rejects invalid %s evidence",
  (mutation) => {
    const input = request();
    const ref = aggregate();
    const changed =
      mutation === "store"
        ? { ...ref, binding: { ...binding, storeId: "other" } }
        : mutation === "version"
          ? { ...ref, definitionVersion: "other" }
          : mutation === "window"
            ? { ...ref, period: { ...period, periodStart: "2026-09-26T00:00:00.000Z" } }
            : mutation === "future"
              ? { ...ref, observedAt: "2026-10-25T01:00:00.000Z" }
              : { ...ref, unknown: true };
    const result = createInventoryStagnationDetector().detect({
      ...input,
      evidence: { ...input.evidence, sourceReferences: [changed] },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  },
);

function toleratedStagnation(patch: Partial<Facts>, tolerance = 1000) {
  const input = request(evidence(patch));
  const rules = input.policy.rules.map((row) => ({ ...row, toleranceBasisPoints: tolerance }));
  return detect({ ...input, policy: { ...input.policy, rules } });
}
it.each([
  [98, "NO_CANDIDATE"],
  [99, "NO_CANDIDATE"],
  [100, "CANDIDATE"],
] as const)("applies exclusive coverage tolerance at %s days", (days, disposition) => {
  expect(toleratedStagnation({ availableUnits: days, demandCoverageDays: days }).disposition).toBe(
    disposition,
  );
});
it("keeps holding and listing eligibility raw with nonzero tolerance", () => {
  expect(
    toleratedStagnation({ holdingDays: 90, listedAt: "2026-07-27T00:00:00.000Z" }).disposition,
  ).toBe("CANDIDATE");
  expect(toleratedStagnation({ holdingDays: 89.999 }).disposition).toBe("NO_CANDIDATE");
});
it("doubles only coverage at full tolerance and keeps exact large rational boundaries", () => {
  expect(
    toleratedStagnation({ availableUnits: 180, demandCoverageDays: 180 }, 10000).disposition,
  ).toBe("NO_CANDIDATE");
  expect(
    toleratedStagnation({ availableUnits: 181, demandCoverageDays: 181 }, 10000).disposition,
  ).toBe("CANDIDATE");
  const salesUnits = 2000000000000000;
  const availableUnits = 6600000000000000;
  expect(
    toleratedStagnation({ salesUnits, availableUnits, demandCoverageDays: 99 }).disposition,
  ).toBe("NO_CANDIDATE");
  const above = availableUnits + 1;
  expect(
    toleratedStagnation({
      salesUnits,
      availableUnits: above,
      demandCoverageDays: ((above / salesUnits) * 720) / 24,
    }).disposition,
  ).toBe("CANDIDATE");
});
