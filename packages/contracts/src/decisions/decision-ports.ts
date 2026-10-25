import type { EventEvidenceV1 } from "../events/event-evidence.schema.js";
import type { DecisionControl } from "./decision-provider.js";
import type {
  DecisionLabels,
  DecisionOverrideReason,
  DecisionResult,
  DecisionRulesetV1,
  DecisionRun,
  EvaluationContext,
  PrimaryDecisionRun,
  RoutedPrimaryDecisionRun,
  SanitizedDecisionInput,
  ShadowComparison,
} from "./decision.schema.js";

export type DecisionPortError =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "SCOPE_MISMATCH"
  | "VERSION_MISMATCH"
  | "HASH_MISMATCH"
  | "CONFLICT"
  | "UNAVAILABLE";
export type DecisionPortResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; code: DecisionPortError }
>;
export interface SecurityClock {
  readonly timeDomain: "SECURITY_UTC";
  readonly now: () => string;
}
/** Validate the internal context before projecting only the declared ID-free aggregate schema. */
export interface DecisionInputSanitizer {
  readonly sanitize: (context: EvaluationContext) => DecisionPortResult<SanitizedDecisionInput>;
}
/** Host canonical evidence hash; this is not a provider assertion or authorization token. */
export interface HostEvidenceHash {
  readonly hash: (evidence: EventEvidenceV1) => DecisionPortResult<string>;
}
export interface InventoryRefundRuleEvaluator {
  readonly evaluate: (input: SanitizedDecisionInput, ruleset: DecisionRulesetV1) => DecisionResult;
}
export interface DecisionHardGateRequest {
  readonly context: EvaluationContext;
  readonly suggestion: DecisionResult;
  readonly ruleset: DecisionRulesetV1;
}
export interface DecisionHardGateResult {
  readonly effective: DecisionLabels;
  readonly overrideReason: DecisionOverrideReason | null;
}
/** Preserves deterministic severity floors and evidence gates; cannot grant approval/execution authority. */
export interface DecisionHardGate {
  readonly evaluate: (
    request: DecisionHardGateRequest,
  ) => DecisionPortResult<DecisionHardGateResult>;
}
export interface RoutingRequest {
  readonly context: EvaluationContext;
  readonly run: PrimaryDecisionRun;
  readonly control: DecisionControl;
}
/** Host checks ownership, current decision key and deadline, preferences, quiet hours, cooldown and budget. */
export interface RoutingPort {
  readonly route: (request: RoutingRequest) => Promise<DecisionPortResult<PrimaryDecisionRun>>;
}
/** Append-only history; verify scope/hash/version and fallback target atomically. Reject late superseded runs. */
export interface DecisionRunRepository {
  readonly append: (
    context: EvaluationContext,
    run: DecisionRun,
  ) => Promise<DecisionPortResult<DecisionRun>>;
}
export interface ShadowComparisonPort {
  readonly append: (
    context: EvaluationContext,
    comparison: ShadowComparison,
  ) => Promise<DecisionPortResult<ShadowComparison>>;
}
export interface DecisionAuditPort {
  readonly append: (
    context: EvaluationContext,
    run: DecisionRun,
  ) => Promise<DecisionPortResult<void>>;
}
/** Product side effects accept only an evaluated PRIMARY run with an effective route. Transactional with audit. */
export interface DecisionOutboxPort {
  readonly enqueue: (request: DecisionOutboxRequest) => Promise<DecisionPortResult<void>>;
}
export interface DecisionOutboxRequest {
  readonly context: EvaluationContext;
  readonly run: RoutedPrimaryDecisionRun;
  readonly control: DecisionControl;
}
