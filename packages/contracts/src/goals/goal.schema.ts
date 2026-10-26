import { z } from "zod";
import {
  ConnectorBindingSchema,
  ConnectorTimestampSchema,
  CurrencySchema,
  ExternalIdSchema,
  MinorAmountSchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import {
  BasisPointsSchema,
  DataQualityIssueV1Schema,
  MetricEvidenceIdsSchema,
  MetricStatusSchema,
  MetricValueSchema,
  MetricWindowSchema,
  SignedMinorSchema,
} from "../metrics/metric.schema.js";
import { TenantIdSchema } from "../tenant/tenant.schema.js";

const id = TenantIdSchema;
const revision = z.number().int().min(1).safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const GoalScopeSchema = ConnectorBindingSchema;

export const GoalTargetV1Schema = z
  .discriminatedUnion("targetMetric", [
    z.strictObject({
      targetMetric: z.enum(["GMV", "PAID_REVENUE"]),
      unit: z.literal("minorCNY"),
      currency: CurrencySchema,
      targetMinor: MinorAmountSchema,
    }),
    z.strictObject({
      targetMetric: z.literal("ESTIMATED_NET_PROFIT"),
      unit: z.literal("minorCNY"),
      currency: CurrencySchema,
      targetMinor: SignedMinorSchema,
    }),
    z.strictObject({
      targetMetric: z.literal("CONVERSION_RATE"),
      unit: z.literal("basisPoints"),
      targetBasisPoints: BasisPointsSchema,
    }),
  ])
  .readonly();

const budgetConstraint = z.strictObject({
  kind: z.literal("BUDGET"),
  currency: CurrencySchema,
  maximumBudgetMinor: MinorAmountSchema,
});

const marginConstraint = z.strictObject({
  kind: z.literal("MIN_GROSS_MARGIN"),
  minimumGrossMarginBasisPoints: BasisPointsSchema,
});

const actionConstraint = z.strictObject({
  kind: z.literal("ALLOWED_ACTION_SCOPE"),
  scope: GoalScopeSchema,
  allowedActionKinds: z.array(z.literal("PRICE_SET")).length(1).readonly(),
});

export const GoalConstraintV1Schema = z
  .discriminatedUnion("kind", [budgetConstraint, marginConstraint, actionConstraint])
  .readonly();

export const GoalV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    goalId: id,
    revision,
    goalHash: hash,
    previousGoalHash: hash.nullable(),
    scope: GoalScopeSchema,
    target: GoalTargetV1Schema,
    window: MetricWindowSchema,
    deadlineAt: ConnectorTimestampSchema,
    createdAt: ConnectorTimestampSchema,
    constraints: z
      .array(GoalConstraintV1Schema)
      .max(3)
      .refine((items) => new Set(items.map((item) => item.kind)).size === items.length)
      .readonly(),
  })
  .superRefine((goal, context) => {
    if ((goal.revision === 1) !== (goal.previousGoalHash === null)) {
      context.addIssue({ code: "custom", message: "Invalid goal revision ancestry" });
    }
    if (
      Date.parse(goal.createdAt) > Date.parse(goal.deadlineAt) ||
      Date.parse(goal.window.periodEnd) > Date.parse(goal.deadlineAt)
    ) {
      context.addIssue({ code: "custom", message: "Invalid goal deadline" });
    }
    for (const constraint of goal.constraints) {
      if (constraint.kind === "ALLOWED_ACTION_SCOPE" && !sameScope(goal.scope, constraint.scope)) {
        context.addIssue({ code: "custom", message: "Cross-scope action constraint" });
      }
    }
  })
  .readonly();

function sameScope(
  left: z.infer<typeof GoalScopeSchema>,
  right: z.infer<typeof GoalScopeSchema>,
): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof typeof left] === right[key as keyof typeof right],
  );
}

export const GoalMetricEvidenceV1Schema = z
  .strictObject({
    snapshotId: id,
    binding: GoalScopeSchema,
    window: MetricWindowSchema,
    metric: MetricValueSchema,
    definitionVersion: SourceVersionSchema,
    inputRevision: SourceVersionSchema,
    evidenceIds: MetricEvidenceIdsSchema,
    status: MetricStatusSchema,
    coverageBasisPoints: BasisPointsSchema,
    issues: z.array(DataQualityIssueV1Schema).max(100).readonly(),
    sourceWatermark: ConnectorTimestampSchema.nullable(),
    visibleAt: ConnectorTimestampSchema,
    computedAt: ConnectorTimestampSchema,
  })
  .readonly();

function evidenceQualityValid(evidence: z.infer<typeof GoalMetricEvidenceV1Schema>): boolean {
  const verified = evidence.status === "VERIFIED";
  if (verified)
    return (
      evidence.metric.value !== null &&
      evidence.issues.length === 0 &&
      evidence.coverageBasisPoints === 10000 &&
      evidence.sourceWatermark !== null &&
      Date.parse(evidence.sourceWatermark) >= Date.parse(evidence.window.periodEnd)
    );
  return (
    evidence.issues.length > 0 &&
    (evidence.status !== "UNAVAILABLE" || evidence.metric.value === null)
  );
}

function evidenceMatchesGoal(
  goal: z.infer<typeof GoalV1Schema>,
  evidence: z.infer<typeof GoalMetricEvidenceV1Schema>,
): boolean {
  return (
    sameScope(goal.scope, evidence.binding) &&
    goal.window.periodStart === evidence.window.periodStart &&
    goal.window.periodEnd === evidence.window.periodEnd &&
    goal.window.timezone === evidence.window.timezone &&
    goal.window.currency === evidence.window.currency &&
    goal.target.targetMetric === evidence.metric.kind &&
    goal.target.unit === evidence.metric.unit
  );
}

export const GoalEvaluationV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    goal: GoalV1Schema,
    evidence: GoalMetricEvidenceV1Schema,
    evaluatedAt: ConnectorTimestampSchema,
    outcome: z.enum(["ACHIEVED", "NOT_ACHIEVED", "INDETERMINATE"]),
    progressBasisPoints: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .superRefine((evaluation, context) => {
    const { goal, evidence } = evaluation;
    const evaluated = Date.parse(evaluation.evaluatedAt);
    if (!evidenceMatchesGoal(goal, evidence)) {
      context.addIssue({ code: "custom", message: "Goal and evidence mismatch" });
    }
    if (
      !evidenceQualityValid(evidence) ||
      Date.parse(evidence.visibleAt) < Date.parse(evidence.window.periodEnd) ||
      Date.parse(evidence.computedAt) < Date.parse(evidence.visibleAt) ||
      Date.parse(evidence.computedAt) > evaluated ||
      (evidence.sourceWatermark !== null &&
        Date.parse(evidence.sourceWatermark) > Date.parse(evidence.visibleAt))
    ) {
      context.addIssue({ code: "custom", message: "Invalid evidence quality or chronology" });
    }
    if (
      evidence.status !== "VERIFIED" &&
      (evaluation.outcome !== "INDETERMINATE" || evaluation.progressBasisPoints !== null)
    ) {
      context.addIssue({ code: "custom", message: "Unverified evidence cannot prove progress" });
    }
    if (
      evidence.status === "VERIFIED" &&
      evaluation.outcome !== "INDETERMINATE" &&
      evaluation.progressBasisPoints === null
    ) {
      context.addIssue({ code: "custom", message: "Missing progress assessment" });
    }
  })
  .readonly();

export const GoalPlanCandidateV1Schema = z
  .strictObject({
    candidateId: id,
    goalId: id,
    goalRevision: revision,
    goalHash: hash,
    scope: GoalScopeSchema,
    evidenceIds: MetricEvidenceIdsSchema,
    candidateKind: z.literal("PRICE_SET"),
    explanationCode: z.enum(["REVENUE_GAP", "PROFIT_GAP", "CONVERSION_GAP"]),
    requiresHumanApproval: z.literal(true),
    grantsActionPermission: z.literal(false),
  })
  .readonly();

export type GoalV1 = z.infer<typeof GoalV1Schema>;
export type GoalConstraintV1 = z.infer<typeof GoalConstraintV1Schema>;
export type GoalEvaluationV1 = z.infer<typeof GoalEvaluationV1Schema>;
export type GoalPlanCandidateV1 = z.infer<typeof GoalPlanCandidateV1Schema>;

export interface GoalRepository {
  getCurrent(goalId: string, scope: z.infer<typeof GoalScopeSchema>): Promise<GoalV1 | null>;

  appendRevision(
    goal: GoalV1,
    expectedPreviousRevision: number | null,
  ): Promise<"APPENDED" | "REVISION_CONFLICT">;
}

export interface GoalPlanningPort {
  proposeCandidates(
    goal: GoalV1,
    evaluation: GoalEvaluationV1,
  ): Promise<readonly GoalPlanCandidateV1[]>;
}

// Goals and planning results contain no execution or authorization port.
export const GOAL_CONTRACT_VERSION = SourceVersionSchema.parse("goal-v1");
export const GOAL_CURRENCY = CurrencySchema.parse("CNY");
export const GOAL_EVIDENCE_ID = ExternalIdSchema;
