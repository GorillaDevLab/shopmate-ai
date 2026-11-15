import { isDeepStrictEqual } from "node:util";
import {
  RoutedPrimaryDecisionRunSchema,
  type EvaluationContext,
  type RoutingPort,
  type SecurityClock,
} from "@shopmate/contracts";
import type { DecisionEvaluationAuthority, DecisionReadPort } from "@shopmate/database";
import { DecisionEvaluationHost, DecisionProviderRegistry } from "./decision-evaluation.host.js";
import { DefaultDecisionInputSanitizer } from "./decision-input-sanitizer.js";
import { DEFAULT_DECISION_RULESET } from "./decision-ruleset.js";
import { DEFAULT_EVENT_RULE_POLICY } from "../events/event-rule-policy.js";
import { DefaultDecisionHardGate } from "./decision-hard-gate.js";
import { RulesDecisionProvider } from "./rules-decision.provider.js";
import { PureInventoryRefundRuleEvaluator } from "./inventory-refund-rules.js";
import { DecisionRoutingService } from "./decision-routing.service.js";
import { RUNTIME_ROUTING_POLICY, RUNTIME_RULE_DEFAULTS } from "./decision-runtime-policy.js";
import { loadRuntimeHistory } from "./decision-runtime-history.js";
import type { EventRuntimeTransaction } from "../events/event-decision-transaction.js";

function runtimeRouting(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  repository: DecisionReadPort,
  clock: SecurityClock,
): RoutingPort {
  return {
    route: async (request) => {
      await scope.reauthorize();
      if (!isDeepStrictEqual(request.context, context)) return { ok: false, code: "CONFLICT" };
      const service = new DecisionRoutingService(
        {
          load: async () => ({
            ok: true,
            value: {
              context,
              activeRun: RoutedPrimaryDecisionRunSchema.parse(request.run),
              decisionKey: request.run.decisionKey,
              provider: request.run.provider,
              rulesetVersion: DEFAULT_DECISION_RULESET.version,
              preferences: null,
              budget: null,
              policy: RUNTIME_ROUTING_POLICY,
              history: await loadRuntimeHistory(scope, repository),
            },
          }),
        },
        clock,
      );
      return service.route(request);
    },
  };
}
function runtimeProvider(
  context: EvaluationContext,
  sanitizer: DefaultDecisionInputSanitizer,
  clock: SecurityClock,
): RulesDecisionProvider {
  const expected = sanitizer.sanitize(context);
  return new RulesDecisionProvider({
    ruleset: DEFAULT_DECISION_RULESET,
    policy: DEFAULT_EVENT_RULE_POLICY,
    defaults: RUNTIME_RULE_DEFAULTS,
    specialRules: new PureInventoryRefundRuleEvaluator(),
    clock,
    assurance: {
      verify: (input, pins) =>
        expected.ok &&
        isDeepStrictEqual(expected.value, input) &&
        pins.rulesetVersion === DEFAULT_DECISION_RULESET.version &&
        pins.eventPolicyVersion === DEFAULT_EVENT_RULE_POLICY.version
          ? { ok: true, value: undefined }
          : { ok: false, code: "HASH_MISMATCH" },
    },
  });
}
export function createRuntimeDecisionHost(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  repository: DecisionEvaluationAuthority & DecisionReadPort,
  clock: SecurityClock,
): DecisionEvaluationHost {
  const sanitizer = new DefaultDecisionInputSanitizer();
  const provider = runtimeProvider(context, sanitizer, clock);
  const hardGate = new DefaultDecisionHardGate({
    read: () => ({
      ok: true,
      value: {
        context,
        ruleset: DEFAULT_DECISION_RULESET,
        eventPolicy: DEFAULT_EVENT_RULE_POLICY,
        budget: "UNKNOWN",
      },
    }),
  });
  return new DecisionEvaluationHost({
    registry: new DecisionProviderRegistry(provider),
    authority: repository,
    clock,
    ruleset: DEFAULT_DECISION_RULESET,
    hardGate,
    sanitizer,
    routing: runtimeRouting(scope, context, repository, clock),
  });
}
