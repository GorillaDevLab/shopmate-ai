import {
  DecisionControlSchema,
  DecisionCorrelationIdSchema,
  DecisionLabelsSchema,
  DecisionProviderDescriptorSchema,
  DecisionResultSchema,
  DecisionRulesetV1Schema,
  EventRulePolicyV1Schema,
  EventTimestampSchema,
  EventTypeSchema,
  SanitizedDecisionInputSchema,
  type DecisionUnavailableCode,
  type DecisionControl,
  type DecisionLabels,
  type DecisionPortResult,
  type DecisionProvider,
  type DecisionResult,
  type DecisionRulesetV1,
  type EventRulePolicyV1,
  type EventType,
  type InventoryRefundRuleEvaluator,
  type SanitizedDecisionInput,
  type SecurityClock,
} from "@shopmate/contracts";
import { z } from "zod";
import { EventRulePolicyRegistry } from "../events/event-rule-policy.js";
import { DecisionRulesetRegistry } from "./decision-ruleset.js";
import { rulesEvidenceGate } from "./rules-evidence-gate.js";

/** The host checks its full evidence digest and binding before accepting this exact projection. */
export interface PreparedDecisionInputAssurance {
  readonly verify: (
    input: SanitizedDecisionInput,
    pins: Readonly<{ rulesetVersion: string; eventPolicyVersion: string }>,
  ) => DecisionPortResult<void>;
}

export interface RulesDecisionProviderOptions {
  readonly ruleset: DecisionRulesetV1;
  readonly policy: EventRulePolicyV1;
  readonly defaults: readonly Readonly<{ eventType: EventType; labels: DecisionLabels }>[];
  readonly specialRules: InventoryRefundRuleEvaluator;
  readonly assurance: PreparedDecisionInputAssurance;
  readonly clock: SecurityClock;
}

const configurationSchema = z
  .strictObject({
    ruleset: DecisionRulesetV1Schema,
    policy: EventRulePolicyV1Schema,
    defaults: z
      .array(
        z.strictObject({ eventType: EventTypeSchema, labels: DecisionLabelsSchema }).readonly(),
      )
      .length(EventTypeSchema.options.length)
      .readonly(),
  })
  .refine(
    (value) =>
      new Set(value.defaults.map((row) => row.eventType)).size === EventTypeSchema.options.length,
  )
  .refine((value) => value.policy.rules.length === EventTypeSchema.options.length)
  .readonly();

class ProviderFailure extends Error {
  constructor(readonly code: DecisionUnavailableCode) {
    super(code);
  }
}

function unavailable(correlationId: string, code: DecisionUnavailableCode): DecisionResult {
  return DecisionResultSchema.parse({
    schemaVersion: 1,
    correlationId,
    status: "UNAVAILABLE",
    code,
  });
}

function composite(input: SanitizedDecisionInput): boolean {
  if (input.eventType !== "PROFIT_MARGIN_DROP" || input.dataStatus !== "VERIFIED") return false;
  const { facts, baseline } = input;
  if (
    facts.costCoverageBasisPoints !== 10000 ||
    facts.feeCoverageBasisPoints !== 10000 ||
    facts.contributionMinor === null ||
    facts.profitDeltaMinor === null ||
    baseline?.measure.kind !== "CONTRIBUTION" ||
    baseline.median === null ||
    baseline.median - facts.contributionMinor !== -facts.profitDeltaMinor
  )
    return false;
  const rows = facts.contributions;
  return (
    rows.length === 6 &&
    new Set(rows.map((row) => row.kind)).size === 6 &&
    rows.every((row) => row.amountMinor !== null) &&
    rows.filter((row) => row.kind !== "RESIDUAL" && row.amountMinor !== 0).length > 1 &&
    rows.reduce((sum, row) => sum + BigInt(row.amountMinor ?? 0), 0n) ===
      BigInt(facts.profitDeltaMinor)
  );
}

function boundedLabels(input: SanitizedDecisionInput, labels: DecisionLabels): DecisionLabels {
  const special = input.eventType === "STOCKOUT_RISK" || input.eventType === "REFUND_SPIKE";
  const opportunity = input.eventType === "PRODUCT_BREAKOUT";
  return DecisionLabelsSchema.parse({
    ...labels,
    severity: opportunity && labels.severity !== "INFO" ? "LOW" : labels.severity,
    attentionPriority: opportunity ? "LOW_PRIORITY" : labels.attentionPriority,
    llmEscalation:
      special || labels.evidenceSufficiency !== "SUFFICIENT"
        ? "NO_LLM_NEEDED"
        : labels.llmEscalation,
  });
}

export class RulesDecisionProvider implements DecisionProvider {
  readonly descriptor = DecisionProviderDescriptorSchema.parse({
    key: "rules",
    version: "rules-provider-v1",
    supportedInputVersions: [1],
  });
  readonly #config: z.infer<typeof configurationSchema>;
  readonly #verify: PreparedDecisionInputAssurance["verify"];
  readonly #now: SecurityClock["now"];
  readonly #special: InventoryRefundRuleEvaluator["evaluate"];

  constructor(options: RulesDecisionProviderOptions) {
    this.#config = configurationSchema.parse({
      ruleset: options.ruleset,
      policy: options.policy,
      defaults: options.defaults,
    });
    new DecisionRulesetRegistry(new EventRulePolicyRegistry([this.#config.policy]), [
      { eventPolicyVersion: this.#config.policy.version, ruleset: this.#config.ruleset },
    ]);
    if (options.clock.timeDomain !== "SECURITY_UTC")
      throw new RangeError("Security UTC clock required");
    this.#verify = options.assurance.verify.bind(options.assurance);
    this.#now = options.clock.now.bind(options.clock);
    this.#special = options.specialRules.evaluate.bind(options.specialRules);
    Object.freeze(this);
  }

  async evaluate(input: SanitizedDecisionInput, control: DecisionControl): Promise<DecisionResult> {
    const correlationId = DecisionCorrelationIdSchema.parse(input.correlationId);
    try {
      if (input.schemaVersion !== 1) throw new ProviderFailure("UNSUPPORTED_SCHEMA");
      const parsed = SanitizedDecisionInputSchema.safeParse(input);
      if (!parsed.success) throw new ProviderFailure("INVALID_RESULT");
      this.checkControl(control);
      const pins = {
        rulesetVersion: this.#config.ruleset.version,
        eventPolicyVersion: this.#config.policy.version,
      };
      if (!this.#verify(parsed.data, Object.freeze(pins)).ok)
        throw new ProviderFailure("INVALID_RESULT");
      const labels = boundedLabels(parsed.data, this.labels(parsed.data));
      this.checkControl(control);
      return DecisionResultSchema.parse({
        schemaVersion: 1,
        correlationId,
        status: "EVALUATED",
        rulesetVersion: pins.rulesetVersion,
        labels,
        confidenceMetadata: null,
      });
    } catch (error) {
      return unavailable(
        correlationId,
        error instanceof ProviderFailure ? error.code : "PROVIDER_FAILURE",
      );
    }
  }

  private checkControl(control: DecisionControl): void {
    const parsed = DecisionControlSchema.safeParse(control);
    const now = EventTimestampSchema.safeParse(this.#now());
    if (!parsed.success || !now.success) throw new ProviderFailure("INVALID_RESULT");
    if (parsed.data.signal.aborted) throw new ProviderFailure("ABORTED");
    if (Date.parse(now.data) >= Date.parse(parsed.data.deadlineAt))
      throw new ProviderFailure("TIMEOUT");
  }

  private labels(input: SanitizedDecisionInput): DecisionLabels {
    if (input.eventType === "STOCKOUT_RISK" || input.eventType === "REFUND_SPIKE") {
      const result = DecisionResultSchema.safeParse(this.#special(input, this.#config.ruleset));
      if (
        !result.success ||
        result.data.status !== "EVALUATED" ||
        result.data.correlationId !== input.correlationId ||
        result.data.rulesetVersion !== this.#config.ruleset.version
      )
        throw new ProviderFailure("INVALID_RESULT");
      return result.data.labels;
    }
    const gated = rulesEvidenceGate(input, this.#config.policy);
    if (gated) return gated;
    const defaults = this.#config.defaults.find((row) => row.eventType === input.eventType)!.labels;
    const llmEscalation = composite(input)
      ? "DEEP_REASONING_REQUIRED"
      : defaults.llmEscalation === "DEEP_REASONING_REQUIRED"
        ? "SIMPLE_EXPLANATION"
        : defaults.llmEscalation;
    return DecisionLabelsSchema.parse({ ...defaults, llmEscalation });
  }
}
