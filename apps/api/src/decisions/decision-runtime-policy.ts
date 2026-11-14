import {
  EventTypeSchema,
  DecisionProviderDescriptorSchema,
  type EvaluationContext,
} from "@shopmate/contracts";
import { stableKey } from "./decision-evaluation.host.js";
import { DEFAULT_DECISION_RULESET } from "./decision-ruleset.js";

export const RUNTIME_RULES_DESCRIPTOR = DecisionProviderDescriptorSchema.parse({
  key: "rules",
  version: "rules-provider-v1",
  supportedInputVersions: [1],
});
export const RUNTIME_ROUTING_POLICY = Object.freeze({
  version: "event-routing-v1",
  cooldownSeconds: 3600,
  breakOnSeverityUpgrade: true,
  breakOnRecovery: true,
  batchWindowSeconds: 3600,
  maximumImmediatePerStore: 5,
});
// Historical epochs are literals so a future current-policy change cannot relabel old winners.
const routingEpochs = Object.freeze({ "decision-rules-v1": "event-routing-v1" });
export function runtimeRoutingEpoch(rulesetVersion: string): string | null {
  return Object.entries(routingEpochs).find(([ruleset]) => ruleset === rulesetVersion)?.[1] ?? null;
}
export const RUNTIME_RULE_DEFAULTS = EventTypeSchema.options.map((eventType) => ({
  eventType,
  labels: DEFAULT_DECISION_RULESET.defaultLabels,
}));
export function runtimeDecisionKey(context: EvaluationContext): string {
  const provider = { descriptor: RUNTIME_RULES_DESCRIPTOR };
  return stableKey(context, DEFAULT_DECISION_RULESET, provider, provider);
}
