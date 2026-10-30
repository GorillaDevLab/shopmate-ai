import {
  DecisionLabelsSchema,
  DecisionOverrideReasonSchema,
  DecisionResultSchema,
  DecisionRulesetV1Schema,
  EvaluationContextSchema,
  EventRulePolicyV1Schema,
  sameEventBinding,
  sameDecisionEvidence,
  type DecisionHardGate,
  type DecisionHardGateRequest,
  type DecisionHardGateResult,
  type DecisionPortError,
  type DecisionPortResult,
  type DecisionLabels,
  type DecisionReasonCode,
  type EvaluationContext,
  type EventEvidenceV1,
  type EventRulePolicyV1,
  type EventType,
} from "@shopmate/contracts";
import { z } from "zod";
import { CanonicalHostEvidenceHash } from "./decision-input-sanitizer.js";
import { DecisionRulesetRegistry } from "./decision-ruleset.js";
import { EventRulePolicyRegistry } from "../events/event-rule-policy.js";

const policySchema = z
  .strictObject({
    context: EvaluationContextSchema,
    ruleset: DecisionRulesetV1Schema,
    eventPolicy: EventRulePolicyV1Schema,
    budget: z.enum(["ELIGIBLE", "BLOCKED", "UNKNOWN"]),
  })
  .readonly();
export type CurrentDecisionHardGatePolicy = z.infer<typeof policySchema>;
/** Server-owned read-only authorization/ownership snapshot, refreshed for every evaluation. */
export interface CurrentDecisionHardGateAccess {
  readonly read: (context: EvaluationContext) => DecisionPortResult<CurrentDecisionHardGatePolicy>;
}
const requestSchema = z
  .strictObject({
    context: EvaluationContextSchema,
    suggestion: DecisionResultSchema,
    ruleset: DecisionRulesetV1Schema,
  })
  .readonly();
const accessResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: policySchema }).readonly(),
  z
    .strictObject({
      ok: z.literal(false),
      code: z.enum([
        "INVALID_INPUT",
        "FORBIDDEN",
        "SCOPE_MISMATCH",
        "VERSION_MISMATCH",
        "HASH_MISMATCH",
        "CONFLICT",
        "UNAVAILABLE",
      ]),
    })
    .readonly(),
]);
const outputSchema = z
  .strictObject({
    effective: DecisionLabelsSchema,
    overrideReason: DecisionOverrideReasonSchema.nullable(),
  })
  .readonly();
const severityOrder = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const hasher = new CanonicalHostEvidenceHash();

function failure<T>(code: DecisionPortError): DecisionPortResult<T> {
  return Object.freeze({ ok: false, code });
}
function success<T>(value: T): DecisionPortResult<T> {
  return Object.freeze({ ok: true, value });
}
function contextKey(context: EvaluationContext): string {
  return JSON.stringify({
    ...context,
    evidence: context.evidence.reference,
    event: {
      ...context.event,
      firstSeenAt: new Date(context.event.firstSeenAt).toISOString(),
      lastSeenAt: new Date(context.event.lastSeenAt).toISOString(),
    },
  });
}
function hashProblem(context: EvaluationContext): DecisionPortError | null {
  const digest = hasher.hash(context.evidence.evidence);
  if (!digest.ok) return digest.code;
  return digest.value === context.evidence.reference.hash ? null : "HASH_MISMATCH";
}
function bindingProblem(
  request: DecisionHardGateRequest,
  current: CurrentDecisionHardGatePolicy,
): DecisionPortError | null {
  const left = request.context;
  const right = current.context;
  if (!sameEventBinding(left.event.binding, right.event.binding)) return "SCOPE_MISMATCH";
  if (
    !right.actor.permissions.includes("tenant:read") ||
    JSON.stringify(left.actor) !== JSON.stringify(right.actor)
  )
    return "FORBIDDEN";
  const hash = hashProblem(left) ?? hashProblem(right);
  if (hash) return hash;
  if (
    JSON.stringify(request.ruleset) !== JSON.stringify(current.ruleset) ||
    left.event.rulePolicyVersion !== current.eventPolicy.version ||
    right.event.rulePolicyVersion !== current.eventPolicy.version ||
    left.evidence.reference.definitionVersion !== right.evidence.reference.definitionVersion ||
    left.evidence.reference.baselineVersion !== right.evidence.reference.baselineVersion ||
    (left.evidence.reference.baselineVersion !== null &&
      left.evidence.reference.baselineVersion !== current.eventPolicy.baselineVersion)
  )
    return "VERSION_MISMATCH";
  if (
    !sameDecisionEvidence(left.evidence.reference, right.evidence.reference) ||
    contextKey(left) !== contextKey(right)
  )
    return "CONFLICT";
  return null;
}
function policyProblem(current: CurrentDecisionHardGatePolicy): DecisionPortError | null {
  try {
    new DecisionRulesetRegistry(new EventRulePolicyRegistry([current.eventPolicy]), [
      { eventPolicyVersion: current.eventPolicy.version, ruleset: current.ruleset },
    ]);
    return null;
  } catch {
    // An inconsistent server policy cannot authorize a result merely by sharing its version string.
    return "VERSION_MISMATCH";
  }
}
function suggestionProblem(request: DecisionHardGateRequest): DecisionPortError | null {
  if (request.suggestion.correlationId !== request.context.correlationId) return "CONFLICT";
  if (request.suggestion.status !== "EVALUATED") return "UNAVAILABLE";
  return request.suggestion.rulesetVersion === request.ruleset.version ? null : "VERSION_MISMATCH";
}
type QualityRule = EventRulePolicyV1["rules"][number];
const baselineMeasures: Partial<Readonly<Record<EventType, readonly string[]>>> = {
  REFUND_SPIKE: ["REFUND_COHORT_ORDER_RATE"],
  CANCELLED_ORDER_SPIKE: ["CANCELLED_ORDER_RATE"],
  PROFIT_MARGIN_DROP: ["GROSS_PROFIT", "CONTRIBUTION"],
  ROAS_DROP: ["ROAS"],
  AD_SPEND_SPIKE: ["AD_SPEND"],
  CONVERSION_DROP: ["CONVERSION_RATE"],
  PRODUCT_BREAKOUT: ["PAID_UNITS"],
  REVENUE_DROP: ["PAID_REVENUE"],
};
function fresh(time: string | null, evidence: EventEvidenceV1, rule: QualityRule): boolean {
  if (time === null) return false;
  const age = BigInt(Date.parse(evidence.observedAt)) - BigInt(Date.parse(time));
  return age >= 0n && age <= BigInt(rule.maximumAgeSeconds) * 1000n;
}
function qualityProblem(evidence: EventEvidenceV1, rule: QualityRule): DecisionReasonCode | null {
  const codes = evidence.issues.map((issue) => issue.code);
  if (
    codes.some((code) =>
      ["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH"].includes(code),
    )
  )
    return "CONFLICTING_DATA";
  if (evidence.sourceWatermark === null || evidence.dataStatus === "UNAVAILABLE")
    return "MISSING_DATA";
  if (
    evidence.dataStatus === "STALE" ||
    codes.includes("STALE_SOURCE") ||
    !fresh(evidence.sourceWatermark, evidence, rule)
  )
    return "STALE_DATA";
  if (evidence.sampleSize < rule.minimumSampleSize || codes.includes("LOW_SAMPLE"))
    return "INSUFFICIENT_SAMPLE";
  if (
    evidence.coverageBasisPoints < rule.minimumCoverageBasisPoints ||
    codes.includes("PARTIAL_COVERAGE")
  )
    return "PARTIAL_COVERAGE";
  if (evidence.dataStatus !== "VERIFIED" || codes.length > 0) return "MISSING_DATA";
  return null;
}
function baselineProblem(evidence: EventEvidenceV1, rule: QualityRule): DecisionReasonCode | null {
  if (!rule.requireAlignedBaseline) return null;
  const baseline = evidence.baseline;
  if (baseline?.status === "STALE") return "STALE_DATA";
  if (!baseline || baseline.median === null || baseline.alignment !== "ALIGNED")
    return "MISSING_DATA";
  const measures = baselineMeasures[evidence.eventType];
  if (!measures || !measures.includes(baseline.measure.kind)) return "CONFLICTING_DATA";
  if (baseline.sampleSize < rule.minimumBaselineSamples) return "INSUFFICIENT_SAMPLE";
  if (baseline.coverageBasisPoints < rule.minimumCoverageBasisPoints) return "PARTIAL_COVERAGE";
  return null;
}
function cancellationProblem(
  evidence: Extract<EventEvidenceV1, { eventType: "CANCELLED_ORDER_SPIKE" }>,
  rule: QualityRule,
): DecisionReasonCode | null {
  const { cohortOrders, paidCancelledOrders, pendingCancelledOrders } = evidence.facts;
  if (cohortOrders === null || paidCancelledOrders === null || pendingCancelledOrders === null)
    return "MISSING_DATA";
  if (evidence.sampleSize !== cohortOrders) return "CONFLICTING_DATA";
  if (cohortOrders === 0 || cohortOrders < rule.minimumSampleSize) return "INSUFFICIENT_SAMPLE";
  return null;
}
function stagnationProblem(
  evidence: Extract<EventEvidenceV1, { eventType: "INVENTORY_STAGNATION" }>,
  rule: QualityRule,
): DecisionReasonCode | null {
  const facts = evidence.facts;
  if (
    facts.availableUnits === null ||
    facts.salesUnits === null ||
    facts.holdingDays === null ||
    facts.listedAt === null ||
    facts.demandCoverageDays === null
  )
    return "MISSING_DATA";
  if (facts.salesUnits === 0 || facts.salesUnits < rule.minimumSampleSize)
    return "INSUFFICIENT_SAMPLE";
  return null;
}
function financialProblem(
  evidence: Extract<
    EventEvidenceV1,
    { eventType: "PROFIT_MARGIN_DROP" | "UNUSUAL_DISCOUNT" | "REVENUE_DROP" }
  >,
  rule: QualityRule,
): DecisionReasonCode | null {
  const facts = evidence.facts;
  if (evidence.eventType === "REVENUE_DROP")
    return facts.paidRevenueMinor === null ? "MISSING_DATA" : null;
  if (evidence.eventType === "UNUSUAL_DISCOUNT") {
    if (
      facts.discountMinor === null ||
      !facts.grossMerchandiseMinor ||
      facts.promotionPeriod === null
    )
      return "MISSING_DATA";
    return null;
  }
  // The pinned baseline selects the primary profit measure; attribution remains optional context.
  const contribution = evidence.baseline?.measure.kind === "CONTRIBUTION";
  if ((contribution ? facts.contributionMinor : facts.grossProfitMinor) === null)
    return "MISSING_DATA";
  if (
    facts.costCoverageBasisPoints < rule.minimumCoverageBasisPoints ||
    (contribution && facts.feeCoverageBasisPoints < rule.minimumCoverageBasisPoints)
  )
    return "PARTIAL_COVERAGE";
  return null;
}
function marketingProblem(
  evidence: Extract<EventEvidenceV1, { eventType: "ROAS_DROP" | "AD_SPEND_SPIKE" }>,
  rule: QualityRule,
): DecisionReasonCode | null {
  const facts = evidence.facts;
  if (!facts.spendMinor) return "MISSING_DATA";
  if (evidence.eventType === "AD_SPEND_SPIKE") return null;
  if (facts.attributedRevenueMinor === null) return "MISSING_DATA";
  if (
    rule.eventType === "ROAS_DROP" &&
    facts.attributionCoverageBasisPoints < rule.thresholds.minimumAttributionCoverageBasisPoints
  )
    return "PARTIAL_COVERAGE";
  return null;
}
function conversionProblem(
  evidence: Extract<EventEvidenceV1, { eventType: "CONVERSION_DROP" }>,
  rule: QualityRule,
): DecisionReasonCode | null {
  const facts = evidence.facts;
  if (facts.visitors === null || facts.paidOrders === null) return "MISSING_DATA";
  if (
    facts.visitors === 0 ||
    (rule.eventType === "CONVERSION_DROP" && facts.visitors < rule.thresholds.minimumVisitors)
  )
    return "INSUFFICIENT_SAMPLE";
  return null;
}
function breakoutProblem(
  evidence: Extract<EventEvidenceV1, { eventType: "PRODUCT_BREAKOUT" }>,
  rule: QualityRule,
): DecisionReasonCode | null {
  const facts = evidence.facts;
  if (
    facts.salesUnits === null ||
    facts.salesUnitsPerHour === null ||
    facts.listedAt === null ||
    facts.conversion.numerator === null ||
    facts.conversion.denominator === null
  )
    return "MISSING_DATA";
  if (facts.conversion.denominator === 0 || facts.conversion.numerator < rule.minimumSampleSize)
    return "INSUFFICIENT_SAMPLE";
  return null;
}
function primaryFactProblem(
  evidence: EventEvidenceV1,
  rule: QualityRule,
): DecisionReasonCode | null {
  switch (evidence.eventType) {
    case "INVENTORY_STAGNATION":
      return stagnationProblem(evidence, rule);
    case "PROFIT_MARGIN_DROP":
    case "UNUSUAL_DISCOUNT":
    case "REVENUE_DROP":
      return financialProblem(evidence, rule);
    case "ROAS_DROP":
    case "AD_SPEND_SPIKE":
      return marketingProblem(evidence, rule);
    case "CONVERSION_DROP":
      return conversionProblem(evidence, rule);
    case "PRODUCT_BREAKOUT":
      return breakoutProblem(evidence, rule);
    default:
      return null;
  }
}
function factProblem(evidence: EventEvidenceV1, rule: QualityRule): DecisionReasonCode | null {
  if (evidence.eventType === "CANCELLED_ORDER_SPIKE") return cancellationProblem(evidence, rule);
  if (evidence.eventType === "STOCKOUT_RISK") {
    const facts = evidence.facts;
    if (facts.inventoryStatus === "STALE" || !fresh(facts.inventoryObservedAt, evidence, rule))
      return "STALE_DATA";
    if (facts.inventoryStatus !== "VERIFIED" || facts.availableUnits === null)
      return "MISSING_DATA";
    if (facts.availableUnits > 0 && (facts.salesUnits === null || facts.salesUnits === 0))
      return "MISSING_DATA";
  }
  if (evidence.eventType === "REFUND_SPIKE" && rule.eventType === "REFUND_SPIKE") {
    const facts = evidence.facts;
    if (!fresh(facts.observedThrough, evidence, rule)) return "STALE_DATA";
    if (
      facts.paidCohortOrders === null ||
      facts.refundedOrders === null ||
      facts.paidCohortOrders === 0
    )
      return "MISSING_DATA";
    if (facts.paidCohortOrders < rule.minimumSampleSize) return "INSUFFICIENT_SAMPLE";
    const maturity = Math.max(facts.maturityHours, rule.thresholds.maturityHours);
    if (
      (Date.parse(facts.observedThrough) - Date.parse(facts.paymentCohort.periodEnd)) / 3600000 <
      maturity
    )
      return "INSUFFICIENT_SAMPLE";
  }
  return primaryFactProblem(evidence, rule);
}
function reliableSoldOut(evidence: EventEvidenceV1, rule: QualityRule): boolean {
  return (
    evidence.eventType === "STOCKOUT_RISK" &&
    evidence.facts.availableUnits === 0 &&
    evidence.facts.inventoryStatus === "VERIFIED" &&
    fresh(evidence.facts.inventoryObservedAt, evidence, rule) &&
    !evidence.issues.some((issue) =>
      ["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH", "INVENTORY_UNKNOWN"].includes(
        issue.code,
      ),
    )
  );
}
function raisedLabels(
  labels: DecisionLabels,
  request: DecisionHardGateRequest,
  soldOut: boolean,
): DecisionLabels {
  const floor = soldOut ? "CRITICAL" : request.context.event.severityFloor;
  const severity =
    severityOrder.indexOf(labels.severity) < severityOrder.indexOf(floor) ? floor : labels.severity;
  if (!soldOut) return { ...labels, severity };
  return {
    ...labels,
    severity,
    notificationRoute: "NOTIFY_NOW",
    attentionPriority: "URGENT",
    llmEscalation: "NO_LLM_NEEDED",
    reasonCodes: ["CONFIRMED_STOCKOUT"],
  };
}
function limitedLabels(
  labels: DecisionLabels,
  problem: DecisionReasonCode,
  soldOut: boolean,
): DecisionLabels {
  return {
    ...labels,
    llmEscalation: "NO_LLM_NEEDED",
    evidenceSufficiency: problem === "CONFLICTING_DATA" ? "AMBIGUOUS" : "INSUFFICIENT_DATA",
    reasonCodes: soldOut ? ["CONFIRMED_STOCKOUT", problem] : [problem],
  };
}
function declaredProblem(labels: DecisionLabels): DecisionReasonCode | null {
  if (labels.evidenceSufficiency === "AMBIGUOUS" || labels.reasonCodes.includes("CONFLICTING_DATA"))
    return "CONFLICTING_DATA";
  const reason = labels.reasonCodes.find((code) =>
    ["INSUFFICIENT_SAMPLE", "MISSING_DATA", "STALE_DATA", "PARTIAL_COVERAGE"].includes(code),
  );
  return reason ?? (labels.evidenceSufficiency === "INSUFFICIENT_DATA" ? "MISSING_DATA" : null);
}
/** Rejections produce no route. One override: evidence limitations > budget > deterministic floor. */
function effectiveLabels(
  request: DecisionHardGateRequest,
  current: CurrentDecisionHardGatePolicy,
): DecisionHardGateResult {
  if (request.suggestion.status !== "EVALUATED") throw new RangeError("Evaluated labels required");
  const labels = request.suggestion.labels;
  const evidence = request.context.evidence.evidence;
  const rule = current.eventPolicy.rules.find((item) => item.eventType === evidence.eventType);
  const soldOut = rule !== undefined && reliableSoldOut(evidence, rule);
  const raised = raisedLabels(labels, request, soldOut);
  const problem =
    (rule
      ? (qualityProblem(evidence, rule) ??
        factProblem(evidence, rule) ??
        baselineProblem(evidence, rule))
      : "MISSING_DATA") ?? declaredProblem(labels);
  if (problem)
    return outputSchema.parse({
      effective: limitedLabels(raised, problem, soldOut),
      overrideReason: "INSUFFICIENT_EVIDENCE",
    });
  if (raised.llmEscalation === "DEEP_REASONING_REQUIRED" && current.budget !== "ELIGIBLE")
    return outputSchema.parse({
      effective: { ...raised, llmEscalation: "NO_LLM_NEEDED" },
      overrideReason: "LLM_BUDGET",
    });
  return outputSchema.parse({
    effective: raised,
    overrideReason: JSON.stringify(raised) === JSON.stringify(labels) ? null : "SEVERITY_FLOOR",
  });
}
/** Component boundary only: labels carry no action approval, executor or price-risk authority. */
export class DefaultDecisionHardGate implements DecisionHardGate {
  constructor(private readonly access: CurrentDecisionHardGateAccess) {}

  evaluate(raw: unknown): DecisionPortResult<DecisionHardGateResult> {
    try {
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) return failure("INVALID_INPUT");
      const request = parsed.data;
      const current = this.readCurrent(request.context);
      if (!current.ok) return current;
      const problem =
        bindingProblem(request, current.value) ??
        policyProblem(current.value) ??
        suggestionProblem(request);
      if (problem) return failure(problem);
      return success(effectiveLabels(request, current.value));
    } catch {
      // Nested arithmetic refinements can throw; malformed requests must never produce labels.
      return failure("INVALID_INPUT");
    }
  }

  private readCurrent(
    context: EvaluationContext,
  ): DecisionPortResult<CurrentDecisionHardGatePolicy> {
    try {
      const current = accessResultSchema.safeParse(this.access.read(context));
      return current.success ? current.data : failure("UNAVAILABLE");
    } catch {
      // Host lookup/authorization failure is unavailable, never an implicit allow.
      return failure("UNAVAILABLE");
    }
  }
}
