import {
  BaselineRequestSchema,
  EventMeasureSchema,
  MetricSnapshotV1Schema,
  RobustBaselineV1Schema,
} from "@shopmate/contracts";
import type {
  BaselineRequest,
  EventSourceReference,
  MetricSnapshotV1,
  RobustBaselineV1,
} from "@shopmate/contracts";
import { expect, it } from "vitest";
import { createRobustBaseline, type RobustBaselinePolicy } from "./robust-baseline.js";
const binding = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "external",
};
const period = {
  periodStart: "2026-10-24T16:00:00.000Z",
  periodEnd: "2026-10-25T06:00:00.000Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const policy: RobustBaselinePolicy = {
  version: "baseline-v1",
  minimumSamples: 3,
  lookbackWeeks: 8,
  maximumAgeSeconds: 60 * 86400,
};
const measure = { kind: "PAID_REVENUE", unit: "minorCNY" } as const;
const week = 7 * 86400000;
function snapshot(
  value: number | null,
  weeks: number,
  patch: Partial<MetricSnapshotV1> = {},
): MetricSnapshotV1 {
  const periodStart = new Date(Date.parse(period.periodStart) - weeks * week).toISOString();
  const periodEnd = new Date(Date.parse(period.periodEnd) - weeks * week).toISOString();
  return MetricSnapshotV1Schema.parse({
    schemaVersion: 1,
    definitionVersion: "definition-v1",
    inputRevision: `revision-${weeks}`,
    binding,
    periodStart,
    periodEnd,
    timezone: "Asia/Shanghai",
    currency: "CNY",
    visibleAt: periodEnd,
    sourceWatermark: periodEnd,
    computedAt: periodEnd,
    evidenceIds: [`fact-${weeks}`],
    sampleSize: 100,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    issues: [],
    subject: { kind: "STORE" },
    metric: { ...measure, value },
    ...patch,
  });
}
function reference(item: MetricSnapshotV1): EventSourceReference {
  return {
    kind: "METRIC_SNAPSHOT",
    id: `snapshot-${item.periodStart}-${item.inputRevision}`,
    version: item.inputRevision,
    hash: `hash-${item.inputRevision}`,
    binding: item.binding,
    definitionVersion: item.definitionVersion,
    observedAt: item.computedAt,
    measure: EventMeasureSchema.parse({ kind: item.metric.kind, unit: item.metric.unit }),
    period: {
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
      timezone: item.timezone,
      currency: item.currency,
    },
  };
}
function request(
  candidates: readonly MetricSnapshotV1[] = [],
  patch: Partial<BaselineRequest> = {},
): BaselineRequest {
  return {
    binding,
    eventType: "REVENUE_DROP",
    entity: { kind: "STORE" },
    period,
    observedAt: period.periodEnd,
    definitionVersion: "definition-v1",
    baselineVersion: policy.version,
    measure,
    candidates,
    sourceReferences: candidates.map(reference),
    ...patch,
  };
}
function evaluate(input: BaselineRequest, config: RobustBaselinePolicy = policy): RobustBaselineV1 {
  expect(BaselineRequestSchema.safeParse(input).success).toBe(true);
  const result = createRobustBaseline(config).evaluate(input);
  if (!result.ok) throw new Error(`Unexpected failure: ${result.error.code}`);
  expect(RobustBaselineV1Schema.safeParse(result.value).success).toBe(true);
  return result.value;
}
function rejected(input: BaselineRequest, code: string): void {
  expect(createRobustBaseline(policy).evaluate(input)).toMatchObject({
    ok: false,
    error: { code },
  });
}
it("uses Sunday 14:00 windows and resists an outlier", () => {
  const candidates = [snapshot(100, 1), snapshot(110, 2), snapshot(100000, 3)];
  const yesterday = snapshot(999999, 1, {
    periodStart: "2026-10-23T16:00:00.000Z",
    periodEnd: "2026-10-24T16:00:00.000Z",
    visibleAt: "2026-10-24T16:00:00.000Z",
    computedAt: "2026-10-24T16:00:00.000Z",
    sourceWatermark: "2026-10-24T16:00:00.000Z",
  });
  const result = evaluate(request([...candidates, yesterday]));
  expect(result).toMatchObject({
    status: "AVAILABLE",
    alignment: "ALIGNED",
    median: 110,
    mad: 10,
    sampleSize: 3,
    coverageBasisPoints: 3750,
  });
  expect(result.sourceReferences).toEqual(candidates.map(reference));
  expect(result.period).toEqual(reference(candidates[0]).period);
});
it("keeps exact half median and MAD", () => {
  expect(
    evaluate(request([snapshot(100, 1), snapshot(101, 2)]), { ...policy, minimumSamples: 2 }),
  ).toMatchObject({ median: 100.5, mad: 0.5 });
});
it("keeps zero distinct from missing and low samples", () => {
  expect(evaluate(request())).toMatchObject({
    status: "MISSING",
    alignment: "MISSING",
    period: null,
    median: null,
    mad: null,
  });
  expect(evaluate(request([snapshot(0, 1)]))).toMatchObject({
    status: "INSUFFICIENT",
    sampleSize: 1,
    median: null,
  });
  expect(evaluate(request([snapshot(0, 1), snapshot(0, 2), snapshot(0, 3)]))).toMatchObject({
    status: "ZERO",
    median: 0,
    mad: 0,
  });
});
it("excludes wrong cutoff, elapsed duration and current window", () => {
  const shifted = snapshot(100, 1, { periodStart: "2026-10-17T17:00:00.000Z" });
  const minute = snapshot(100, 2, { periodEnd: "2026-10-11T05:59:00.000Z" });
  expect(evaluate(request([shifted, minute, snapshot(100, 0)]))).toMatchObject({
    status: "UNALIGNED",
    alignment: "UNALIGNED",
    sampleSize: 0,
  });
});
it("marks aged history and history outside lookback stale", () => {
  const input = request([snapshot(100, 1), snapshot(100, 2), snapshot(100, 3)]);
  expect(evaluate(input, { ...policy, maximumAgeSeconds: 6 * 86400 })).toMatchObject({
    status: "STALE",
    median: null,
    sampleSize: 0,
  });
  expect(evaluate(request([snapshot(100, 9)]))).toMatchObject({
    status: "STALE",
    sampleSize: 0,
    coverageBasisPoints: 0,
  });
});
it("deduplicates windows using observation time instead of revision IDs", () => {
  const first = snapshot(10, 1, { inputRevision: "z-old" });
  const latest = snapshot(100, 1, {
    inputRevision: "a-new",
    visibleAt: "2026-10-18T07:00:00.000Z",
    computedAt: "2026-10-18T07:00:00.000Z",
  });
  const result = evaluate(request([first, first, latest, snapshot(110, 2), snapshot(120, 3)]));
  expect(result).toMatchObject({ median: 110, sampleSize: 3 });
  expect(result.sourceReferences).toContainEqual(reference(latest));
  expect(result.sourceReferences).not.toContainEqual(reference(first));
});
it("rejects equally observed conflicting revisions", () => {
  rejected(request([snapshot(100, 1), snapshot(200, 1, { inputRevision: "other" })]), "CONFLICT");
});
it("keeps partial and missing quality insufficient", () => {
  const issues = [{ code: "PARTIAL_COVERAGE", field: "revenue", evidenceIds: ["fact-1"] }] as const;
  const partial = snapshot(100, 1, { status: "ESTIMATED", coverageBasisPoints: 5000, issues });
  const result = evaluate(request([partial]));
  expect(result).toMatchObject({
    status: "INSUFFICIENT",
    median: null,
    sampleSize: 0,
    coverageBasisPoints: 0,
  });
  expect(result.sourceReferences).toEqual([reference(partial)]);
  const missing = snapshot(null, 1, {
    status: "UNAVAILABLE",
    sourceWatermark: null,
    issues: [{ ...issues[0], code: "NOT_SYNCHRONIZED" }],
  });
  expect(evaluate(request([missing]))).toMatchObject({ status: "INSUFFICIENT", median: null });
});
it("retains explicit stale-source state", () => {
  const stale = snapshot(100, 1, {
    status: "STALE",
    issues: [{ code: "STALE_SOURCE", field: "revenue", evidenceIds: ["fact-1"] }],
  });
  expect(evaluate(request([stale]))).toMatchObject({ status: "STALE", median: null });
});
it("pins baseline version and snapshots immutable settings", () => {
  rejected(request([], { baselineVersion: "unregistered" }), "VERSION_MISMATCH");
  const config = { ...policy };
  const port = createRobustBaseline(config);
  config.minimumSamples = 1;
  expect(port.evaluate(request([snapshot(100, 1)]))).toMatchObject({
    ok: true,
    value: { status: "INSUFFICIENT" },
  });
});
it.each([
  { minimumSamples: 0 },
  { minimumSamples: 9 },
  { lookbackWeeks: 0 },
  { lookbackWeeks: 201 },
  { maximumAgeSeconds: -1 },
  { version: " " },
  { arbitrary: true },
])("rejects invalid policy %j", (patch) => {
  expect(() => createRobustBaseline({ ...policy, ...patch })).toThrow();
});
it("rejects foreign scope, definitions, units and future data", () => {
  const item = snapshot(100, 1);
  const base = request([item]);
  rejected({ ...base, binding: { ...binding, storeId: "foreign" } }, "INVALID_INPUT");
  rejected({ ...base, definitionVersion: "foreign" }, "INVALID_INPUT");
  rejected({ ...base, measure: { kind: "PAID_UNITS", unit: "units" } }, "INVALID_INPUT");
  rejected(
    { ...base, candidates: [{ ...item, computedAt: "2026-10-26T06:00:00.000Z" }] },
    "INVALID_INPUT",
  );
  rejected(
    { ...base, sourceReferences: [{ ...reference(item), observedAt: "2026-10-26T06:00:00.000Z" }] },
    "INVALID_INPUT",
  );
  rejected({ ...base, merchantJson: {} } as BaselineRequest, "INVALID_INPUT");
});
it("requires a matching observed metric reference", () => {
  const item = snapshot(100, 1);
  rejected(
    request([item], { sourceReferences: [{ ...reference(item), kind: "NORMALIZED_AGGREGATE" }] }),
    "INVALID_INPUT",
  );
  const delayed = { ...item, computedAt: "2026-10-18T07:00:00.000Z" };
  rejected(request([delayed], { sourceReferences: [reference(item)] }), "INVALID_INPUT");
});
it("uses safe BigInt intermediates at the monetary limit", () => {
  expect(
    evaluate(
      request([snapshot(Number.MAX_SAFE_INTEGER, 1), snapshot(Number.MAX_SAFE_INTEGER, 2)]),
      { ...policy, minimumSamples: 2 },
    ),
  ).toMatchObject({ median: Number.MAX_SAFE_INTEGER, mad: 0 });
});
it("returns overflow for unrepresentable exact halves", () => {
  const port = createRobustBaseline({ ...policy, minimumSamples: 2 });
  expect(
    port.evaluate(
      request([snapshot(Number.MAX_SAFE_INTEGER, 1), snapshot(Number.MAX_SAFE_INTEGER - 1, 2)]),
    ),
  ).toMatchObject({ ok: false, error: { code: "OVERFLOW" } });
});
it("supports fractional hours without monetary rounding", () => {
  const rows = [snapshot(1, 1), snapshot(2, 2)].map((item, index) => ({
    ...item,
    metric: {
      kind: "INVENTORY_HOURS_REMAINING",
      unit: "hours",
      value: index === 0 ? 0.25 : 0.5,
    } as const,
  }));
  expect(
    evaluate(request(rows, { measure: { kind: "INVENTORY_HOURS_REMAINING", unit: "hours" } }), {
      ...policy,
      minimumSamples: 2,
    }),
  ).toMatchObject({ median: 0.375, mad: 0.125 });
});
it("is invariant when superseded conflicting rows arrive in another order", () => {
  const old = snapshot(10, 1);
  const ambiguous = snapshot(20, 1, { inputRevision: "old-tie" });
  const latest = snapshot(100, 1, {
    inputRevision: "latest",
    visibleAt: "2026-10-18T07:00:00.000Z",
    computedAt: "2026-10-18T07:00:00.000Z",
  });
  const remaining = [snapshot(110, 2), snapshot(120, 3)];
  const forward = evaluate(request([old, ambiguous, latest, ...remaining]));
  expect(evaluate(request([latest, ambiguous, old, ...remaining]))).toEqual(forward);
});
it("uses a contributing reference as the available baseline period", () => {
  const partial = snapshot(999, 1, {
    status: "INSUFFICIENT",
    issues: [{ code: "LOW_SAMPLE", field: "revenue", evidenceIds: ["fact-1"] }],
  });
  const result = evaluate(request([partial, snapshot(10, 2), snapshot(20, 3), snapshot(30, 4)]));
  expect(result.period).toEqual(reference(snapshot(10, 2)).period);
  expect(result.sourceReferences).not.toContainEqual(reference(partial));
});
function signedSnapshot(value: number, weeks: number): MetricSnapshotV1 {
  return snapshot(0, weeks, { metric: { kind: "GROSS_PROFIT", unit: "minorCNY", value } });
}
it("preserves signed negative median with exact absolute deviations", () => {
  const rows = [signedSnapshot(-10, 1), signedSnapshot(-20, 2), signedSnapshot(-30, 3)];
  expect(
    evaluate(request(rows, { measure: { kind: "GROSS_PROFIT", unit: "minorCNY" } })),
  ).toMatchObject({ status: "AVAILABLE", median: -20, mad: 10 });
});
it("computes maximal signed deviations without unsafe intermediates", () => {
  const limit = Number.MAX_SAFE_INTEGER;
  const rows = [
    signedSnapshot(-limit, 1),
    signedSnapshot(-limit, 2),
    signedSnapshot(limit, 3),
    signedSnapshot(limit, 4),
  ];
  const input = request(rows, { measure: { kind: "GROSS_PROFIT", unit: "minorCNY" } });
  expect(evaluate(input)).toMatchObject({ status: "ZERO", median: 0, mad: limit });
});
it("uses inclusive lookback and freshness boundaries", () => {
  const input = request([snapshot(10, 1), snapshot(20, 2), snapshot(30, 3)]);
  expect(
    evaluate(input, { ...policy, lookbackWeeks: 3, maximumAgeSeconds: 21 * 86400 }),
  ).toMatchObject({ status: "AVAILABLE", sampleSize: 3, coverageBasisPoints: 10000 });
});
it("rejects one immutable reference identity with conflicting content", () => {
  const item = snapshot(100, 1);
  rejected(
    request([item], {
      sourceReferences: [reference(item), { ...reference(item), hash: "different" }],
    }),
    "CONFLICT",
  );
});
it("rejects future visibility even when the metric and reference look historical", () => {
  const item = snapshot(100, 1);
  rejected(
    request([
      { ...item, visibleAt: "2026-10-26T06:00:00.000Z", computedAt: "2026-10-26T06:00:00.000Z" },
    ]),
    "INVALID_INPUT",
  );
});
it.each(["periodStart", "periodEnd", "visibleAt", "computedAt", "sourceWatermark", "all"] as const)(
  "deduplicates equivalent UTC spellings of %s",
  (field) => {
    const item = snapshot(100, 1);
    const equivalent = { ...item };
    const fields = [
      "periodStart",
      "periodEnd",
      "visibleAt",
      "computedAt",
      "sourceWatermark",
    ] as const;
    for (const key of fields) {
      const value = item[key];
      if ((field === "all" || field === key) && value !== null)
        equivalent[key] = value.replace(".000Z", "Z");
    }
    const remaining = [snapshot(110, 2), snapshot(120, 3)];
    const input = request([item, equivalent, ...remaining], {
      sourceReferences: [item, ...remaining].map(reference),
    });
    expect(evaluate(input)).toMatchObject({ status: "AVAILABLE", median: 110, sampleSize: 3 });
  },
);
it("deduplicates immutable references with equivalent timestamp spellings", () => {
  const rows = [snapshot(100, 1), snapshot(110, 2), snapshot(120, 3)];
  const original = reference(rows[0]);
  const equivalent = {
    ...original,
    observedAt: original.observedAt.replace(".000Z", "Z"),
    period: {
      ...original.period,
      periodStart: original.period.periodStart.replace(".000Z", "Z"),
      periodEnd: original.period.periodEnd.replace(".000Z", "Z"),
    },
  };
  const result = evaluate(
    request(rows, { sourceReferences: [original, equivalent, ...rows.slice(1).map(reference)] }),
  );
  expect(result).toMatchObject({ status: "AVAILABLE", median: 110, sampleSize: 3 });
  expect(result.sourceReferences).toHaveLength(3);
});
it("keeps reference selection stable across equivalent timestamp spellings", () => {
  const item = snapshot(100, 1);
  const base = { ...reference(item), id: "a-reference", hash: "same-proof" };
  const later = { ...base, id: "z-reference", observedAt: "2026-10-18T06:00:00.100Z" };
  const compact = { ...base, observedAt: base.observedAt.replace(".000Z", "Z") };
  const other = [snapshot(110, 2), snapshot(120, 3)];
  const normal = evaluate(
    request([item, ...other], { sourceReferences: [base, later, ...other.map(reference)] }),
  );
  const alternative = evaluate(
    request([item, ...other], { sourceReferences: [compact, later, ...other.map(reference)] }),
  );
  expect(alternative.sourceReferences.map((ref) => ref.id)).toEqual(
    normal.sourceReferences.map((ref) => ref.id),
  );
});
it("ignores property insertion order for validated observations and references", () => {
  const item = snapshot(100, 1);
  const reordered = Object.fromEntries(Object.entries(item).reverse()) as MetricSnapshotV1;
  const original = reference(item);
  const reorderedReference = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as EventSourceReference;
  const other = [snapshot(110, 2), snapshot(120, 3)];
  expect(
    evaluate(
      request([item, reordered, ...other], {
        sourceReferences: [original, reorderedReference, ...other.map(reference)],
      }),
    ),
  ).toMatchObject({ median: 110, sampleSize: 3 });
});
it("still rejects genuinely different source watermarks at the same observation instant", () => {
  const item = snapshot(100, 1, {
    visibleAt: "2026-10-18T07:00:00.000Z",
    computedAt: "2026-10-18T07:00:00.000Z",
  });
  rejected(request([item, { ...item, sourceWatermark: "2026-10-18T06:30:00.000Z" }]), "CONFLICT");
});
