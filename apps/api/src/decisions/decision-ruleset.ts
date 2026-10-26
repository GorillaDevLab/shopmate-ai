import {
  DecisionRulesetV1Schema,
  SourceVersionSchema,
  type DecisionLabels,
  type DecisionRulesetV1,
  type EventRulePolicyV1,
} from "@shopmate/contracts";
import { z } from "zod";
import { DEFAULT_EVENT_RULE_POLICY, EventRulePolicyRegistry } from "../events/event-rule-policy.js";

const defaultLabels: DecisionLabels = {
  severity: "INFO",
  notificationRoute: "IGNORE",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "LOW_PRIORITY",
  reasonCodes: ["NO_MATERIAL_CHANGE"],
};

function policyRules(policy: EventRulePolicyV1) {
  const inventory = policy.rules.find((rule) => rule.eventType === "STOCKOUT_RISK");
  const refund = policy.rules.find((rule) => rule.eventType === "REFUND_SPIKE");
  if (!inventory || !refund)
    throw new RangeError("Decision policy requires stockout and refund rules");
  return { inventory, refund };
}

function quality(rule: EventRulePolicyV1["rules"][number]) {
  return {
    minimumSampleSize: rule.minimumSampleSize,
    minimumCoverageBasisPoints: rule.minimumCoverageBasisPoints,
    maximumAgeSeconds: rule.maximumAgeSeconds,
    minimumBaselineSamples: rule.minimumBaselineSamples,
  };
}

const defaults = policyRules(DEFAULT_EVENT_RULE_POLICY);
/** Product routing/labels and thresholds, never statistical confidence or execution authority. */
export const DEFAULT_DECISION_RULESET: DecisionRulesetV1 = DecisionRulesetV1Schema.parse({
  schemaVersion: 1,
  version: "decision-rules-v1",
  defaultLabels,
  inventory: {
    ...quality(defaults.inventory),
    eventType: "STOCKOUT_RISK",
    criticalHoursRemaining: defaults.inventory.thresholds.criticalHoursRemaining,
    labels: {
      ...defaultLabels,
      severity: "HIGH",
      notificationRoute: "NOTIFY_NOW",
      attentionPriority: "HIGH_PRIORITY",
      reasonCodes: ["INVENTORY_COVERAGE_LOW"],
    },
  },
  refund: {
    ...quality(defaults.refund),
    eventType: "REFUND_SPIKE",
    relativeIncreaseBasisPoints: defaults.refund.thresholds.relativeIncreaseBasisPoints,
    minimumRefundedOrders: defaults.refund.thresholds.minimumRefundedOrders,
    labels: {
      ...defaultLabels,
      severity: "HIGH",
      notificationRoute: "NOTIFY_NOW",
      attentionPriority: "HIGH_PRIORITY",
      reasonCodes: ["REFUND_RATE_HIGH"],
    },
  },
});

const registrationSchema = z
  .strictObject({
    eventPolicyVersion: SourceVersionSchema,
    ruleset: DecisionRulesetV1Schema,
  })
  .readonly();

export interface RegisteredDecisionRuleset {
  readonly eventPolicyVersion: string;
  readonly baselineVersion: string;
  readonly ruleset: DecisionRulesetV1;
}

function sameQuality(left: ReturnType<typeof quality>, right: ReturnType<typeof quality>): boolean {
  return (
    left.minimumSampleSize === right.minimumSampleSize &&
    left.minimumCoverageBasisPoints === right.minimumCoverageBasisPoints &&
    left.maximumAgeSeconds === right.maximumAgeSeconds &&
    left.minimumBaselineSamples === right.minimumBaselineSamples
  );
}

function assertConsistent(policy: EventRulePolicyV1, ruleset: DecisionRulesetV1): void {
  const { inventory, refund } = policyRules(policy);
  // The frozen decision DTO cannot express a tolerance; refuse a silent semantic mismatch.
  if (
    !sameQuality(inventory, ruleset.inventory) ||
    !sameQuality(refund, ruleset.refund) ||
    inventory.toleranceBasisPoints !== 0 ||
    refund.toleranceBasisPoints !== 0 ||
    inventory.thresholds.criticalHoursRemaining !== ruleset.inventory.criticalHoursRemaining ||
    refund.thresholds.relativeIncreaseBasisPoints !== ruleset.refund.relativeIncreaseBasisPoints ||
    refund.thresholds.minimumRefundedOrders !== ruleset.refund.minimumRefundedOrders
  )
    throw new RangeError("Decision ruleset and pinned event policy disagree");
}

/** Explicitly injected server registry; lookups retain baseline/event/ruleset version pins. */
export class DecisionRulesetRegistry {
  readonly #rulesets = new Map<string, RegisteredDecisionRuleset>();

  constructor(
    private readonly policies: EventRulePolicyRegistry,
    registrations: readonly unknown[],
  ) {
    for (const registration of z.array(registrationSchema).parse(registrations)) {
      const policy = policies.get(registration.eventPolicyVersion);
      assertConsistent(policy, registration.ruleset);
      if (this.#rulesets.has(registration.ruleset.version))
        throw new RangeError(
          `Decision ruleset version already registered: ${registration.ruleset.version}`,
        );
      this.#rulesets.set(
        registration.ruleset.version,
        Object.freeze({
          ...registration,
          baselineVersion: policy.baselineVersion,
        }),
      );
    }
    Object.freeze(this);
  }

  get(version: string): RegisteredDecisionRuleset {
    const registration = this.#rulesets.get(SourceVersionSchema.parse(version));
    if (!registration) throw new RangeError(`Unknown decision ruleset version: ${version}`);
    return registration;
  }

  append(registration: unknown): DecisionRulesetRegistry {
    const previous = [...this.#rulesets.values()].map(({ eventPolicyVersion, ruleset }) => ({
      eventPolicyVersion,
      ruleset,
    }));
    return new DecisionRulesetRegistry(this.policies, [...previous, registration]);
  }
}
