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
