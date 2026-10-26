import { describe, expect, it } from "vitest";
import {
  GoalConstraintV1Schema,
  GoalEvaluationV1Schema,
  GoalMetricEvidenceV1Schema,
  GoalPlanCandidateV1Schema,
  GoalTargetV1Schema,
  GoalV1Schema,
} from "./goal.schema.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const scope = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-store-a",
};

const window = {
  periodStart: "2026-10-01T00:00:00Z",
  periodEnd: "2026-10-24T00:00:00Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
};

function goalFixture() {
  return {
    schemaVersion: 1,
    goalId: "goal-a",
    revision: 1,
    goalHash: hashA,
    previousGoalHash: null,
    scope,
    target: {
      targetMetric: "GMV",
      unit: "minorCNY",
      currency: "CNY",
      targetMinor: 100000,
    },
    window,
    deadlineAt: "2026-10-31T08:00:00+08:00",
    createdAt: "2026-10-20T00:00:00Z",
    constraints: [
      { kind: "BUDGET", currency: "CNY", maximumBudgetMinor: 20000 },
      { kind: "MIN_GROSS_MARGIN", minimumGrossMarginBasisPoints: 3000 },
      { kind: "ALLOWED_ACTION_SCOPE", scope, allowedActionKinds: ["PRICE_SET"] },
    ],
  };
}

function evidenceFixture() {
  return {
    snapshotId: "snapshot-a",
    binding: scope,
    window,
    metric: { kind: "GMV", unit: "minorCNY", value: 80000 },
    definitionVersion: "definition-v1",
    inputRevision: "input-v1",
    evidenceIds: ["evidence-a"],
    status: "VERIFIED",
    coverageBasisPoints: 10000,
    issues: [],
    sourceWatermark: "2026-10-24T00:00:00Z",
    visibleAt: "2026-10-24T01:00:00Z",
    computedAt: "2026-10-24T02:00:00Z",
  };
}

function evaluationFixture() {
  return {
    schemaVersion: 1,
    goal: goalFixture(),
    evidence: evidenceFixture(),
    evaluatedAt: "2026-10-24T03:00:00Z",
    outcome: "NOT_ACHIEVED",
    progressBasisPoints: 8000,
  };
}

describe("P11-001 goal and evidence contracts", () => {
  it("accepts a strict CNY store-scoped versioned goal", () => {
    const result = GoalV1Schema.parse(goalFixture());
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.target.unit).toBe("minorCNY");
  });

  it.each([
    { targetMetric: "GMV", unit: "basisPoints", targetBasisPoints: 3000 },
    { targetMetric: "CONVERSION_RATE", unit: "minorCNY", targetMinor: 3000 },
    { targetMetric: "GMV", unit: "minorCNY", currency: "USD", targetMinor: 100 },
    { targetMetric: "GMV", unit: "minorCNY", currency: "CNY", targetMinor: -1 },
    { targetMetric: "GMV", unit: "minorCNY", currency: "CNY", targetMinor: 1.5 },
    { targetMetric: "GMV", unit: "minorCNY", currency: "CNY", targetMinor: 2 ** 53 },
    { targetMetric: "UNAPPROVED_METRIC", unit: "minorCNY", targetMinor: 10 },
  ])("rejects unsupported target and unit combinations %o", (target) => {
    expect(GoalTargetV1Schema.safeParse(target).success).toBe(false);
  });

  it("supports an approved percentage metric measured in basis points", () => {
    expect(
      GoalTargetV1Schema.safeParse({
        targetMetric: "CONVERSION_RATE",
        unit: "basisPoints",
        targetBasisPoints: 2500,
      }).success,
    ).toBe(true);

    expect(
      GoalTargetV1Schema.safeParse({
        targetMetric: "CONVERSION_RATE",
        unit: "basisPoints",
        targetBasisPoints: 10001,
      }).success,
    ).toBe(false);
  });

  it("supports signed net-profit targets without unsafe integers", () => {
    expect(
      GoalTargetV1Schema.safeParse({
        targetMetric: "ESTIMATED_NET_PROFIT",
        unit: "minorCNY",
        currency: "CNY",
        targetMinor: -1000,
      }).success,
    ).toBe(true);
  });

  it("rejects missing revision and invalid version history", () => {
    const goal = goalFixture();
    const { revision: removed, ...withoutRevision } = goal;
    expect(removed).toBe(1);
    expect(GoalV1Schema.safeParse(withoutRevision).success).toBe(false);

    for (const changes of [
      { revision: 0 },
      { revision: 2 },
      { previousGoalHash: hashB },
      { goalHash: "not-a-hash" },
    ]) {
      expect(
        GoalV1Schema.safeParse({
          ...goal,
          ...changes,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a revised goal with linked previous hash", () => {
    expect(
      GoalV1Schema.safeParse({
        ...goalFixture(),
        revision: 2,
        previousGoalHash: hashA,
        goalHash: hashB,
      }).success,
    ).toBe(true);
  });

  it("requires a timezone-aware deadline after the window", () => {
    for (const deadlineAt of [
      "2026-10-31T08:00:00",
      "invalid",
      "2026-10-23T00:00:00Z",
      "2026-10-19T00:00:00Z",
    ]) {
      expect(
        GoalV1Schema.safeParse({
          ...goalFixture(),
          deadlineAt,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects incomplete or cross-store tenant context", () => {
    for (const changes of [
      { scope: { organizationId: "org-a" } },
      { scope: { ...scope, workspaceId: "" } },
      { scope: { ...scope, storeId: null } },
      { window: { ...window, timezone: "UTC" } },
      { window: { ...window, currency: "USD" } },
    ]) {
      expect(
        GoalV1Schema.safeParse({
          ...goalFixture(),
          ...changes,
        }).success,
      ).toBe(false);
    }
  });

  it("validates typed budget, margin and action constraints", () => {
    for (const constraint of goalFixture().constraints) {
      expect(GoalConstraintV1Schema.safeParse(constraint).success).toBe(true);
    }

    for (const constraint of [
      { kind: "BUDGET", currency: "USD", maximumBudgetMinor: 50 },
      { kind: "BUDGET", currency: "CNY", maximumBudgetMinor: -1 },
      { kind: "MIN_GROSS_MARGIN", minimumGrossMarginBasisPoints: 10001 },
      { kind: "ALLOWED_ACTION_SCOPE", scope, allowedActionKinds: ["AUTO_EXECUTE"] },
      { kind: "APPROVE", value: true },
    ]) {
      expect(GoalConstraintV1Schema.safeParse(constraint).success).toBe(false);
    }
  });

  it("rejects duplicate and cross-scope constraints", () => {
    const goal = goalFixture();
    expect(
      GoalV1Schema.safeParse({
        ...goal,
        constraints: [goal.constraints[0], goal.constraints[0]],
      }).success,
    ).toBe(false);

    expect(
      GoalV1Schema.safeParse({
        ...goal,
        constraints: [
          {
            kind: "ALLOWED_ACTION_SCOPE",
            scope: { ...scope, storeId: "store-b" },
            allowedActionKinds: ["PRICE_SET"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("never accepts goal-level authorization or execution fields", () => {
    for (const field of [
      "approvedBy",
      "approvalId",
      "execute",
      "permissionOverride",
      "grantsActionPermission",
      "autoApprove",
      "token",
      "rawPrompt",
    ]) {
      expect(
        GoalV1Schema.safeParse({
          ...goalFixture(),
          [field]: true,
        }).success,
      ).toBe(false);
    }
  });

  it("retains metric evidence definition, version and quality", () => {
    const evidence = GoalMetricEvidenceV1Schema.parse(evidenceFixture());
    expect(evidence.definitionVersion).toBe("definition-v1");
    expect(evidence.inputRevision).toBe("input-v1");
    expect(evidence.coverageBasisPoints).toBe(10000);
    expect(evidence.evidenceIds).toEqual(["evidence-a"]);
  });

  it("accepts matching verified goal evaluation", () => {
    const evaluation = GoalEvaluationV1Schema.parse(evaluationFixture());
    expect(evaluation.outcome).toBe("NOT_ACHIEVED");
    expect(evaluation.progressBasisPoints).toBe(8000);
  });

  it("rejects cross-tenant and cross-store evidence", () => {
    for (const changes of [
      { organizationId: "org-b" },
      { workspaceId: "workspace-b" },
      { storeId: "store-b" },
      { connectionId: "connection-b" },
      { externalStoreId: "external-store-b" },
    ]) {
      const base = evaluationFixture();
      expect(
        GoalEvaluationV1Schema.safeParse({
          ...base,
          evidence: {
            ...base.evidence,
            binding: { ...base.evidence.binding, ...changes },
          },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects mismatched metric kinds, units and windows", () => {
    const base = evaluationFixture();
    for (const patch of [
      { metric: { kind: "PAID_REVENUE", unit: "minorCNY", value: 80000 } },
      { metric: { kind: "CONVERSION_RATE", unit: "basisPoints", value: 2500 } },
      { window: { ...window, periodStart: "2026-10-02T00:00:00Z" } },
    ]) {
      expect(
        GoalEvaluationV1Schema.safeParse({
          ...base,
          evidence: { ...base.evidence, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects missing evidence versions and fabricated quality", () => {
    const base = evaluationFixture();
    for (const patch of [
      { definitionVersion: "" },
      { inputRevision: "" },
      { evidenceIds: [] },
      { coverageBasisPoints: 5000 },
      { sourceWatermark: null },
      { metric: { kind: "GMV", unit: "minorCNY", value: null } },
    ]) {
      expect(
        GoalEvaluationV1Schema.safeParse({
          ...base,
          evidence: { ...base.evidence, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it.each(["ESTIMATED", "INSUFFICIENT", "STALE", "UNAVAILABLE"])(
    "keeps %s evidence indeterminate",
    (status) => {
      const base = evaluationFixture();
      const evidence = {
        ...base.evidence,
        status,
        metric: {
          ...base.evidence.metric,
          value: status === "UNAVAILABLE" ? null : 80000,
        },
        issues: [
          {
            code: "STALE_SOURCE",
            field: "source",
            evidenceIds: ["evidence-a"],
          },
        ],
      };
      expect(
        GoalEvaluationV1Schema.safeParse({
          ...base,
          evidence,
          outcome: "INDETERMINATE",
          progressBasisPoints: null,
        }).success,
      ).toBe(true);

      expect(
        GoalEvaluationV1Schema.safeParse({
          ...base,
          evidence,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects future watermarks and inconsistent timestamps", () => {
    const base = evaluationFixture();
    for (const patch of [
      { sourceWatermark: "2026-11-01T00:00:00Z" },
      { computedAt: "2026-10-25T00:00:00Z" },
      { visibleAt: "2026-10-23T00:00:00Z" },
    ]) {
      expect(
        GoalEvaluationV1Schema.safeParse({
          ...base,
          evidence: { ...base.evidence, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it("allows planning candidates but forbids authority grants", () => {
    const candidate = {
      candidateId: "candidate-a",
      goalId: "goal-a",
      goalRevision: 1,
      goalHash: hashA,
      scope,
      evidenceIds: ["evidence-a"],
      candidateKind: "PRICE_SET",
      explanationCode: "REVENUE_GAP",
      requiresHumanApproval: true,
      grantsActionPermission: false,
    };
    expect(GoalPlanCandidateV1Schema.safeParse(candidate).success).toBe(true);
    for (const patch of [
      { grantsActionPermission: true },
      { requiresHumanApproval: false },
      { candidateKind: "EXECUTE" },
      { approvedBy: "ai-agent" },
    ]) {
      expect(
        GoalPlanCandidateV1Schema.safeParse({
          ...candidate,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });
});
