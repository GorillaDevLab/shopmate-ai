import { expect, it } from "vitest";
import type {
  DataQualityIssueV1,
  MetricQualityDependency,
  MetricQualityRequest,
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
