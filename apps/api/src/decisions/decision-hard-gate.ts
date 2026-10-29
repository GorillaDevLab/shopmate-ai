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
  type EvaluationContext,
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
function effectiveLabels(request: DecisionHardGateRequest): DecisionHardGateResult {
  if (request.suggestion.status !== "EVALUATED") throw new RangeError("Evaluated labels required");
  const labels = request.suggestion.labels;
  const floor = request.context.event.severityFloor;
  const raised = severityOrder.indexOf(labels.severity) < severityOrder.indexOf(floor);
  return outputSchema.parse({
    effective: { ...labels, severity: raised ? floor : labels.severity },
    overrideReason: raised ? "SEVERITY_FLOOR" : null,
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
      return success(effectiveLabels(request));
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
