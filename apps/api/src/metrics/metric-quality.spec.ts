import { expect, it } from "vitest";
import type {
  DataQualityIssueV1,
  MetricQualityDependency,
  MetricQualityRequest,
  MetricStatus,
  QualityPolicy,
} from "@shopmate/contracts";
import { createMetricQualityReducer } from "./metric-quality.js";

const end = "2026-10-01T16:00:00.000Z";
const visibleAt = "2026-10-01T18:00:00.000Z";
type Rule = QualityPolicy["rules"][number];
function dependency(overrides: Partial<MetricQualityDependency> = {}): MetricQualityDependency {
  return {
    field: "paymentFacts",
    status: "VERIFIED",
    sourceWatermark: end,
    observedAt: end,
    sampleSize: 10,
    knownCount: 10,
    expectedCount: 10,
    coverageBasisPoints: 10000,
    evidenceIds: ["payment-proof"],
    issues: [],
    ...overrides,
  };
}
function request(
  dependencies: readonly MetricQualityDependency[] = [dependency()],
  rule: Partial<Rule> = {},
): MetricQualityRequest {
  return {
    kind: "PAID_REVENUE",
    window: {
      periodStart: "2026-09-30T16:00:00.000Z",
      periodEnd: end,
      timezone: "Asia/Shanghai",
      currency: "CNY",
    },
    visibleAt,
    dependencies,
    policy: {
      version: "quality-v1",
      precedence: ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"],
      rules: [
        {
          kind: "PAID_REVENUE",
          requiredFields: ["paymentFacts"],
          minimumSampleSize: 5,
          maximumAgeHours: 2,
          minimumCoverageBasisPoints: 9000,
          allowVerifiedEmptyWindow: true,
          ...rule,
        },
      ],
    },
  };
}
function issue(code: DataQualityIssueV1["code"], field = "paymentFacts", id = "payment-proof") {
  return { code, field, evidenceIds: [id] };
}
const reducer = createMetricQualityReducer();
function reduceRaw(value: unknown) {
  return reducer.reduce(value as MetricQualityRequest);
}

it("retains unsynchronized empty-source metadata as unavailable", () => {
  const result = reducer.reduce(
    request([
      dependency({
        knownCount: 0,
        expectedCount: 0,
        sampleSize: 0,
        sourceWatermark: null,
        status: "UNAVAILABLE",
      }),
    ]),
  );
  expect(result).toMatchObject({ status: "UNAVAILABLE", coverageBasisPoints: 0, sampleSize: 0 });
  expect(result.issues).toContainEqual(issue("NOT_SYNCHRONIZED"));
});
it("permits a verified observed empty window only with explicit policy allowance", () => {
  const rows = [dependency({ knownCount: 0, expectedCount: 0, sampleSize: 0 })];
  expect(reducer.reduce(request(rows))).toEqual({
    status: "VERIFIED",
    sampleSize: 0,
    coverageBasisPoints: 10000,
    evidenceIds: ["payment-proof"],
    issues: [],
  });
  const denied = reducer.reduce(
    request(rows, { allowVerifiedEmptyWindow: false, minimumSampleSize: 0 }),
  );
  expect(denied.status).toBe("INSUFFICIENT");
  expect(denied.issues).toContainEqual(issue("LOW_SAMPLE"));
});
it("isolates paid revenue from a missing cost dependency", () => {
  const cost = dependency({
    field: "frozenCosts",
    status: "UNAVAILABLE",
    evidenceIds: ["cost-proof"],
    issues: [issue("COST_MISSING", "frozenCosts", "cost-proof")],
  });
  expect(reducer.reduce(request([dependency(), cost]))).toEqual({
    status: "VERIFIED",
    sampleSize: 10,
    coverageBasisPoints: 10000,
    evidenceIds: ["payment-proof"],
    issues: [],
  });
});
it("retains stale, missing-cost and low-sample reasons together", () => {
  const result = reducer.reduce(
    request([
      dependency({
        observedAt: "2026-10-01T15:00:00.000Z",
        sampleSize: 1,
        issues: [issue("COST_MISSING")],
      }),
    ]),
  );
  expect(result.status).toBe("UNAVAILABLE");
  expect(result.issues).toEqual(
    expect.arrayContaining([issue("STALE_SOURCE"), issue("COST_MISSING"), issue("LOW_SAMPLE")]),
  );
});
it("rejects verified assertions backed by inconsistent source counts", () => {
  const result = reducer.reduce(request([dependency({ issues: [issue("SOURCE_INCONSISTENT")] })]));
  expect(result).toMatchObject({ status: "UNAVAILABLE", coverageBasisPoints: 0 });
  expect(result.issues).toContainEqual(issue("SOURCE_INCONSISTENT"));
});

it.each([
  { kind: "unknown" },
  { extra: true },
  { visibleAt: "2026-10-01T15:59:59.999Z" },
  { visibleAt: "2026-10-01T18:00:00+00:00" },
  { visibleAt: "2026-02-30T18:00:00Z" },
  { visibleAt: "2026-10-01T18:00:00.0001Z" },
  { window: { ...request().window, currency: "USD" } },
  { window: { ...request().window, timezone: "UTC" } },
  { window: { ...request().window, periodStart: end } },
  { window: { ...request().window, periodStart: visibleAt } },
  { window: { ...request().window, periodEnd: "2026-10-01T16:00:00.0001Z" } },
  { window: { ...request().window, extra: true } },
])("rejects malformed request context %j", (overrides) => {
  expect(() => reduceRaw({ ...request(), ...overrides })).toThrow(TypeError);
});

it.each([
  { sampleSize: -1 },
  { sampleSize: 0.1 },
  { sampleSize: Number.MAX_SAFE_INTEGER + 1 },
  { knownCount: -1 },
  { knownCount: 11 },
  { expectedCount: -1 },
  { expectedCount: 0.5 },
  { knownCount: Number.MAX_SAFE_INTEGER + 1 },
  { expectedCount: Number.POSITIVE_INFINITY },
  { coverageBasisPoints: -1 },
  { coverageBasisPoints: 10001 },
  { coverageBasisPoints: 1.5 },
  { status: "unavailable" },
  { field: "" },
  { field: " hidden" },
  { extra: true },
  { evidenceIds: [] },
  { evidenceIds: ["proof", "proof"] },
  { evidenceIds: [""] },
  { issues: [{ ...issue("LOW_SAMPLE"), extra: true }] },
  { issues: [issue("LOW_SAMPLE", "paymentFacts", "orphan-proof")] },
  { issues: [{ ...issue("LOW_SAMPLE"), evidenceIds: [] }] },
  { issues: [{ ...issue("LOW_SAMPLE"), code: "UNKNOWN" }] },
  { issues: [{ ...issue("LOW_SAMPLE"), field: "" }] },
  { observedAt: "2026-10-01T18:00:00.001Z" },
  { sourceWatermark: "2026-10-01T18:00:00.001Z" },
  { observedAt: "2026-10-01T16:00:00.0001Z" },
  { sourceWatermark: "2026-10-01T16:00:00.0001Z" },
])("rejects malformed even irrelevant dependency %j", (overrides) => {
  const invalid = { ...dependency({ field: "irrelevant" }), ...overrides };
  expect(() => reduceRaw({ ...request(), dependencies: [dependency(), invalid] })).toThrow(
    TypeError,
  );
});

it.each([
  { minimumSampleSize: -1 },
  { minimumSampleSize: 0.1 },
  { minimumSampleSize: Number.MAX_SAFE_INTEGER + 1 },
  { maximumAgeHours: -1 },
  { maximumAgeHours: Number.NaN },
  { maximumAgeHours: Number.POSITIVE_INFINITY },
  { minimumCoverageBasisPoints: -1 },
  { minimumCoverageBasisPoints: 10001 },
  { minimumCoverageBasisPoints: 0.5 },
  { requiredFields: ["paymentFacts", "paymentFacts"] },
  { requiredFields: [""] },
  { requiredFields: [] },
  { kind: "INVALID" },
  { allowVerifiedEmptyWindow: "yes" },
  { extra: true },
])("rejects malformed policy rule %j", (overrides) => {
  const base = request(),
    rule = { ...base.policy.rules[0], ...overrides };
  expect(() => reduceRaw({ ...base, policy: { ...base.policy, rules: [rule] } })).toThrow(
    TypeError,
  );
});

it.each([
  { version: "" },
  { version: " v1" },
  { extra: true },
  { rules: [] },
  { rules: [request().policy.rules[0], request().policy.rules[0]] },
  { rules: [{ ...request().policy.rules[0], kind: "COGS" }] },
  {
    rules: [request().policy.rules[0], { ...request().policy.rules[0], kind: "COGS", extra: true }],
  },
  { precedence: ["STALE", "UNAVAILABLE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"] },
  { precedence: ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED"] },
])("rejects absent or malformed policy %j", (overrides) => {
  const base = request();
  expect(() => reduceRaw({ ...base, policy: { ...base.policy, ...overrides } })).toThrow(TypeError);
});

it.each([{ dependencies: [] }, { dependencies: [dependency({ field: "unrelated" })] }])(
  "fails closed without relevant source provenance %j",
  ({ dependencies }) => {
    expect(() => reducer.reduce(request(dependencies))).toThrow(TypeError);
  },
);

it("accepts exact trailing-zero precision and independent sync-through/observation times", () => {
  const result = reducer.reduce(
    request([
      dependency({
        sourceWatermark: visibleAt,
        observedAt: "2026-10-01T16:00:00.000000Z",
        evidenceIds: ["2026-10-01T16:00:00.0001Z"],
      }),
    ]),
  );
  expect(result.status).toBe("VERIFIED");
  expect(result.evidenceIds).toEqual(["2026-10-01T16:00:00.0001Z"]);
});

it.each([
  [9, 10, 10000, 9000, "ESTIMATED", 9000],
  [8999, 10000, 10000, 9000, "INSUFFICIENT", 8999],
  [10, 10, 8999, 9000, "INSUFFICIENT", 8999],
  [10, 10, 9500, 9000, "ESTIMATED", 9500],
  [1, 3, 10000, 0, "ESTIMATED", 3333],
  [0, 10, 10000, 0, "UNAVAILABLE", 0],
  [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, 10000, 0, "ESTIMATED", 9999],
  [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1, 10000, 0, "ESTIMATED", 9999],
] as const)(
  "conservatively combines counts %i/%i and declared coverage %i",
  (
    knownCount,
    expectedCount,
    coverageBasisPoints,
    minimumCoverageBasisPoints,
    status,
    coverage,
  ) => {
    const result = reducer.reduce(
      request([dependency({ knownCount, expectedCount, coverageBasisPoints })], {
        minimumCoverageBasisPoints,
      }),
    );
    expect(result).toMatchObject({ status, coverageBasisPoints: coverage });
    expect(result.issues).toContainEqual(issue("PARTIAL_COVERAGE"));
  },
);

it("does not infer sample count from the number of field records", () => {
  const result = reducer.reduce(
    request([dependency({ knownCount: 1, expectedCount: 1, sampleSize: 1000 })], {
      minimumSampleSize: 1000,
    }),
  );
  expect(result).toMatchObject({ status: "VERIFIED", sampleSize: 1000 });
});

it("conserves every required field and every duplicate-field source", () => {
  const result = reducer.reduce(
    request(
      [
        dependency(),
        dependency({
          sampleSize: 2,
          knownCount: 1,
          expectedCount: 2,
          evidenceIds: ["second-proof"],
        }),
        dependency({ field: "traffic", sampleSize: 8, evidenceIds: ["traffic-proof"] }),
      ],
      { requiredFields: ["paymentFacts", "traffic"] },
    ),
  );
  expect(result).toMatchObject({
    status: "INSUFFICIENT",
    sampleSize: 2,
    coverageBasisPoints: 5000,
  });
  expect(result.evidenceIds).toEqual(["payment-proof", "second-proof", "traffic-proof"]);
  expect(result.issues).toContainEqual(issue("LOW_SAMPLE", "paymentFacts", "second-proof"));
});

it.each([
  ["frozenCosts", "COST_MISSING"],
  ["paymentFacts", "PAYMENT_UNKNOWN"],
  ["refundFacts", "REFUND_UNKNOWN"],
  ["fees", "FEE_MISSING"],
  ["traffic", "TRAFFIC_MISSING"],
  ["campaignFacts", "ATTRIBUTION_MISSING"],
  ["inventoryFacts", "INVENTORY_UNKNOWN"],
  ["leadTimeHours", "LEAD_TIME_MISSING"],
  ["returnReceipts", "RETURN_UNKNOWN"],
  ["custom-cost-count", "NOT_SYNCHRONIZED"],
] as const)("fails missing field %s closed with honest %s evidence", (field, code) => {
  const result = reducer.reduce(
    request([dependency({ field: "context" })], {
      requiredFields: ["context", field],
    }),
  );
  expect(result).toMatchObject({ status: "UNAVAILABLE", sampleSize: 0, coverageBasisPoints: 0 });
  expect(result.issues).toContainEqual(issue(code, field));
  expect(result.evidenceIds).toEqual(["payment-proof"]);
});

it("keeps known partial missing-field coverage as a disclosed lower bound", () => {
  const result = reducer.reduce(
    request([dependency({ knownCount: 8, expectedCount: 10, issues: [issue("PAYMENT_UNKNOWN")] })]),
  );
  expect(result).toMatchObject({ status: "UNAVAILABLE", coverageBasisPoints: 8000 });
  expect(result.issues).toContainEqual(issue("PAYMENT_UNKNOWN"));
  expect(result.issues).toContainEqual(issue("PARTIAL_COVERAGE"));
});

it.each([
  { observedAt: "2026-10-01T15:59:59.999Z" },
  { sourceWatermark: null },
  { observedAt: null },
  { sourceWatermark: "2026-10-01T15:59:59.999Z" },
  { coverageBasisPoints: 9999 },
  { issues: [issue("COST_ESTIMATED")] },
] satisfies Partial<MetricQualityDependency>[])(
  "does not verify incomplete empty proof %j",
  (defect) => {
    const row = dependency({ knownCount: 0, expectedCount: 0, sampleSize: 0, ...defect });
    const result = reducer.reduce(
      request([row], { minimumSampleSize: 0, minimumCoverageBasisPoints: 0, maximumAgeHours: 3 }),
    );
    expect(result.status).not.toBe("VERIFIED");
    expect(result.coverageBasisPoints).toBe(0);
    expect(result.issues.length).toBeGreaterThan(0);
  },
);

it("bypasses zero sample only when all required dependencies prove an empty window", () => {
  const result = reducer.reduce(
    request(
      [
        dependency(),
        dependency({ field: "traffic", knownCount: 0, expectedCount: 0, sampleSize: 0 }),
      ],
      {
        requiredFields: ["paymentFacts", "traffic"],
      },
    ),
  );
  expect(result).toMatchObject({ status: "INSUFFICIENT", sampleSize: 0 });
  expect(result.issues).toContainEqual(issue("LOW_SAMPLE", "traffic"));
});

it("does not bypass a missing required field when the other source is observed empty", () => {
  const result = reducer.reduce(
    request([dependency({ knownCount: 0, expectedCount: 0, sampleSize: 0 })], {
      requiredFields: ["paymentFacts", "traffic"],
    }),
  );
  expect(result.status).toBe("UNAVAILABLE");
  expect(result.issues).toContainEqual(issue("TRAFFIC_MISSING", "traffic"));
  expect(result.issues).toContainEqual(issue("LOW_SAMPLE"));
});

const issueFloors = [
  ["NOT_SYNCHRONIZED", "UNAVAILABLE"],
  ["SOURCE_INCONSISTENT", "UNAVAILABLE"],
  ["PAYMENT_UNKNOWN", "UNAVAILABLE"],
  ["REFUND_UNKNOWN", "UNAVAILABLE"],
  ["COST_MISSING", "UNAVAILABLE"],
  ["RETURN_UNKNOWN", "UNAVAILABLE"],
  ["FEE_MISSING", "UNAVAILABLE"],
  ["TRAFFIC_MISSING", "UNAVAILABLE"],
  ["ATTRIBUTION_MISSING", "UNAVAILABLE"],
  ["INVENTORY_UNKNOWN", "UNAVAILABLE"],
  ["LEAD_TIME_MISSING", "UNAVAILABLE"],
  ["ZERO_DENOMINATOR", "UNAVAILABLE"],
  ["WINDOW_MISMATCH", "UNAVAILABLE"],
  ["VERSION_MISMATCH", "UNAVAILABLE"],
  ["STALE_SOURCE", "STALE"],
  ["LOW_SAMPLE", "INSUFFICIENT"],
  ["IMMATURE_COHORT", "INSUFFICIENT"],
  ["COST_ESTIMATED", "ESTIMATED"],
  ["FEE_ESTIMATED", "ESTIMATED"],
  ["PARTIAL_COVERAGE", "ESTIMATED"],
  ["SOURCE_TIME_MISSING", "ESTIMATED"],
] as const;
it.each(issueFloors)("applies %s floor %s even to a VERIFIED source", (code, status) => {
  const result = reducer.reduce(request([dependency({ issues: [issue(code)] })]));
  expect(result.status).toBe(status);
  expect(result.issues).toContainEqual(issue(code));
  expect(result.coverageBasisPoints).toBe(code === "SOURCE_INCONSISTENT" ? 0 : 10000);
});

const statuses: readonly MetricStatus[] = [
  "UNAVAILABLE",
  "STALE",
  "INSUFFICIENT",
  "ESTIMATED",
  "VERIFIED",
];
function declared(status: MetricStatus): MetricQualityDependency {
  const reasons = {
    UNAVAILABLE: "COST_MISSING",
    STALE: "STALE_SOURCE",
    INSUFFICIENT: "LOW_SAMPLE",
    ESTIMATED: "COST_ESTIMATED",
  } as const;
  return dependency({ status, issues: status === "VERIFIED" ? [] : [issue(reasons[status])] });
}
const precedenceCases = statuses.flatMap((left, leftIndex) =>
  statuses.map((right, rightIndex) => ({
    left,
    right,
    expected: statuses[Math.min(leftIndex, rightIndex)],
  })),
);
it.each(precedenceCases)("takes highest defect for $left + $right", ({ left, right, expected }) => {
  const rows = [declared(left), { ...declared(right), field: "traffic" }];
  const result = reducer.reduce(request(rows, { requiredFields: ["paymentFacts", "traffic"] }));
  expect(result.status).toBe(expected);
  expect(result.issues).toEqual(expect.arrayContaining(rows.flatMap((row) => row.issues)));
});

it.each(statuses.filter((status) => status !== "VERIFIED"))(
  "fails closed for unexplained %s status without inventing a cause",
  (status) => {
    expect(() => reducer.reduce(request([dependency({ status })]))).toThrow(TypeError);
  },
);

it("preserves a source status stronger than its supplied reason floor", () => {
  const result = reducer.reduce(
    request([dependency({ status: "STALE", issues: [issue("LOW_SAMPLE")] })]),
  );
  expect(result.status).toBe("STALE");
  expect(result.issues).toEqual([issue("LOW_SAMPLE")]);
});

it("keeps unsynchronized, stale, missing, partial and low sample defects simultaneously", () => {
  const result = reducer.reduce(
    request([
      dependency({
        sourceWatermark: null,
        observedAt: "2026-10-01T15:00:00.000Z",
        knownCount: 0,
        sampleSize: 0,
        issues: [issue("FEE_MISSING")],
      }),
    ]),
  );
  expect(result.status).toBe("UNAVAILABLE");
  expect(result.issues).toEqual(
    expect.arrayContaining([
      issue("NOT_SYNCHRONIZED"),
      issue("STALE_SOURCE"),
      issue("PAYMENT_UNKNOWN"),
      issue("PARTIAL_COVERAGE"),
      issue("LOW_SAMPLE"),
      issue("FEE_MISSING"),
    ]),
  );
});

it.each([
  ["2026-10-01T15:59:59.999Z", "STALE"],
  [end, "VERIFIED"],
  ["2026-10-01T16:00:00.001Z", "VERIFIED"],
] as const)("uses exact observedAt freshness boundary %s", (observedAt, status) => {
  expect(reducer.reduce(request([dependency({ observedAt })])).status).toBe(status);
});
it.each([
  ["2026-10-01T15:59:59.999Z", "STALE"],
  [end, "VERIFIED"],
  ["2026-10-01T16:00:00.001Z", "VERIFIED"],
] as const)("uses exact watermark completeness boundary %s", (sourceWatermark, status) => {
  expect(reducer.reduce(request([dependency({ sourceWatermark })])).status).toBe(status);
});
it.each([
  [4, "INSUFFICIENT"],
  [5, "VERIFIED"],
  [6, "VERIFIED"],
] as const)("uses inclusive minimum sample boundary %i", (sampleSize, status) => {
  expect(reducer.reduce(request([dependency({ sampleSize })])).status).toBe(status);
});
it("allows a zero maximum age only at the exact supplied visibility cutoff", () => {
  expect(
    reducer.reduce(
      request([dependency({ observedAt: visibleAt })], {
        maximumAgeHours: 0,
      }),
    ).status,
  ).toBe("VERIFIED");
  expect(
    reducer.reduce(
      request([dependency({ observedAt: "2026-10-01T17:59:59.999Z" })], {
        maximumAgeHours: 0,
      }),
    ).status,
  ).toBe("STALE");
});
it.each(["__proto__", "constructor", "toString"])(
  "treats arbitrary logical field %s literally",
  (field) => {
    const result = reducer.reduce(
      request([dependency({ field, knownCount: 0 })], {
        requiredFields: [field],
      }),
    );
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.issues).toContainEqual(issue("NOT_SYNCHRONIZED", field));
  },
);
