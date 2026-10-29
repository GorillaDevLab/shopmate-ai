import {
  DecisionResultSchema,
  DecisionRulesetV1Schema,
  SanitizedDecisionInputSchema,
  sameEventPeriod,
  type DecisionLabels,
  type DecisionReasonCode,
  type DecisionResult,
  type DecisionRulesetV1,
  type InventoryRefundRuleEvaluator,
  type SanitizedDecisionInput,
} from "@shopmate/contracts";

type Stock = Extract<SanitizedDecisionInput, { eventType: "STOCKOUT_RISK" }>;
type Refund = Extract<SanitizedDecisionInput, { eventType: "REFUND_SPIKE" }>;
type Rule = DecisionRulesetV1["inventory"] | DecisionRulesetV1["refund"];
const scale = 1n << 1074n;
/** Preserve the exact represented IEEE-754 fraction, including subnormal medians. */
function scaled(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  return (
    (exponent === 0 ? fraction : fraction + (1n << 52n)) <<
    BigInt(exponent === 0 ? 0 : exponent - 1)
  );
}
function elapsed(start: string, end: string): bigint {
  return BigInt(Date.parse(end)) - BigInt(Date.parse(start));
}
function fresh(time: string | null, input: SanitizedDecisionInput, rule: Rule): boolean {
  if (time === null) return false;
  const age = elapsed(time, input.observedAt);
  return age >= 0n && age <= BigInt(rule.maximumAgeSeconds) * 1000n;
}
function quiet(rules: DecisionRulesetV1): DecisionLabels {
  return {
    ...rules.defaultLabels,
    llmEscalation: "NO_LLM_NEEDED",
    reasonCodes: ["NO_MATERIAL_CHANGE"],
  };
}
function blocked(rules: DecisionRulesetV1, reason: DecisionReasonCode): DecisionLabels {
  return {
    ...quiet(rules),
    severity: "INFO",
    notificationRoute: "IGNORE",
    attentionPriority: "LOW_PRIORITY",
    evidenceSufficiency: reason === "CONFLICTING_DATA" ? "AMBIGUOUS" : "INSUFFICIENT_DATA",
    reasonCodes: [reason],
  };
}
function gate(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  if (
    input.qualityReasons.some((code) =>
      ["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH"].includes(code),
    )
  )
    return "CONFLICTING_DATA";
  if (
    input.dataStatus === "STALE" ||
    input.qualityReasons.includes("STALE_SOURCE") ||
    !fresh(input.sourceWatermark, input, rule)
  )
    return "STALE_DATA";
  if (input.sampleSize < rule.minimumSampleSize || input.qualityReasons.includes("LOW_SAMPLE"))
    return "INSUFFICIENT_SAMPLE";
  if (
    input.coverageBasisPoints < rule.minimumCoverageBasisPoints ||
    input.qualityReasons.includes("PARTIAL_COVERAGE")
  )
    return "PARTIAL_COVERAGE";
  if (
    input.dataStatus !== "VERIFIED" &&
    !(
      input.eventType === "STOCKOUT_RISK" &&
      input.qualityReasons.every((code) => code === "LEAD_TIME_MISSING")
    )
  )
    return "MISSING_DATA";
  return null;
}
function urgent(labels: DecisionLabels, reason: DecisionReasonCode): DecisionLabels {
  return {
    ...labels,
    severity: "CRITICAL",
    notificationRoute: "NOTIFY_NOW",
    attentionPriority: "URGENT",
    llmEscalation: "NO_LLM_NEEDED",
    evidenceSufficiency: "SUFFICIENT",
    reasonCodes: [reason],
  };
}
function inventoryProblem(input: Stock, rule: Rule): DecisionReasonCode | null {
  const f = input.facts;
  if (input.qualityReasons.includes("SOURCE_INCONSISTENT")) return "CONFLICTING_DATA";
  if (f.inventoryStatus === "STALE" || !fresh(f.inventoryObservedAt, input, rule))
    return "STALE_DATA";
  if (
    f.inventoryStatus !== "VERIFIED" ||
    f.availableUnits === null ||
    input.qualityReasons.includes("INVENTORY_UNKNOWN")
  )
    return "MISSING_DATA";
  return null;
}
function assertStock(input: Stock): void {
  const f = input.facts;
  const window = elapsed(f.salesWindow.periodStart, f.salesWindow.periodEnd);
  if (
    !sameEventPeriod(f.salesWindow, input.period) ||
    f.salesWindowHours !== Number(window) / 3600000
  )
    throw new RangeError("Sales window mismatch");
  if (
    f.inventoryAgeSeconds !== null &&
    (f.inventoryObservedAt === null ||
      scaled(f.inventoryAgeSeconds) * 1000n !==
        elapsed(f.inventoryObservedAt, input.observedAt) * scale)
  )
    throw new RangeError("Inventory clock mismatch");
}
function inventory(input: Stock, rules: DecisionRulesetV1): DecisionLabels {
  assertStock(input);
  const rule = rules.inventory;
  const problem = inventoryProblem(input, rule);
  if (problem) return blocked(rules, problem);
  const f = input.facts;
  if (f.availableUnits === 0) return urgent(rule.labels, "CONFIRMED_STOCKOUT");
  const reason = gate(input, rule);
  if (reason) return blocked(rules, reason);
  if (f.salesUnits === null || f.salesUnits === 0) return blocked(rules, "MISSING_DATA");
  const numerator =
    BigInt(f.availableUnits!) * elapsed(f.salesWindow.periodStart, f.salesWindow.periodEnd) * scale;
  const denominator = BigInt(f.salesUnits) * 3600000n;
  if (numerator < denominator * scaled(rule.criticalHoursRemaining))
    return urgent(rule.labels, "INVENTORY_COVERAGE_LOW");
  if (
    f.supplierLeadTimeHours !== null &&
    !input.qualityReasons.includes("LEAD_TIME_MISSING") &&
    numerator < denominator * scaled(f.supplierLeadTimeHours)
  )
    return {
      ...rule.labels,
      llmEscalation: "NO_LLM_NEEDED",
      severity: "HIGH",
      reasonCodes: ["INVENTORY_COVERAGE_LOW"],
    };
  return quiet(rules);
}
function assertRefund(input: Refund): void {
  const f = input.facts;
  if (
    !sameEventPeriod(f.paymentCohort, input.period) ||
    !sameEventPeriod(f.currentRate.period, input.period) ||
    f.currentRate.numerator !== f.refundedOrders ||
    f.currentRate.denominator !== f.paidCohortOrders
  )
    throw new RangeError("Refund cohort counts mismatch");
  if (
    elapsed(f.paymentCohort.periodEnd, f.observedThrough) < 0n ||
    elapsed(f.observedThrough, input.observedAt) < 0n
  )
    throw new RangeError("Refund observation clock mismatch");
}
function alignedBaseline(input: Refund): boolean {
  const period = input.baseline?.period;
  if (!period) return false;
  const start = elapsed(period.periodStart, input.period.periodStart);
  const end = elapsed(period.periodEnd, input.period.periodEnd);
  return start > 0n && start === end && start % (7n * 86400000n) === 0n;
}
function baselineProblem(input: Refund, rule: Rule): DecisionReasonCode | null {
  const baseline = input.baseline;
  if (baseline?.status === "STALE") return "STALE_DATA";
  if (!baseline || baseline.median === null || baseline.alignment !== "ALIGNED")
    return "MISSING_DATA";
  if (
    !alignedBaseline(input) ||
    baseline.measure.kind !== "REFUND_COHORT_ORDER_RATE" ||
    baseline.measure.unit !== "basisPoints"
  )
    return "CONFLICTING_DATA";
  if (baseline.sampleSize < rule.minimumBaselineSamples) return "INSUFFICIENT_SAMPLE";
  if (baseline.coverageBasisPoints < rule.minimumCoverageBasisPoints) return "PARTIAL_COVERAGE";
  return null;
}
function refund(input: Refund, rules: DecisionRulesetV1): DecisionLabels {
  assertRefund(input);
  const rule = rules.refund;
  const problem = gate(input, rule) ?? baselineProblem(input, rule);
  if (problem) return blocked(rules, problem);
  const f = input.facts;
  if (!fresh(f.observedThrough, input, rule)) return blocked(rules, "STALE_DATA");
  if (
    elapsed(f.paymentCohort.periodEnd, f.observedThrough) * scale <
      scaled(f.maturityHours) * 3600000n ||
    input.qualityReasons.includes("IMMATURE_COHORT")
  )
    return blocked(rules, "INSUFFICIENT_SAMPLE");
  if (f.paidCohortOrders === null || f.refundedOrders === null || f.paidCohortOrders === 0)
    return blocked(rules, "MISSING_DATA");
  if (f.paidCohortOrders < rule.minimumSampleSize) return blocked(rules, "INSUFFICIENT_SAMPLE");
  if (f.refundedOrders === 0 || f.refundedOrders < rule.minimumRefundedOrders) return quiet(rules);
  const baseline = input.baseline!;
  const exceeds =
    baseline.status === "ZERO" ||
    BigInt(f.refundedOrders) * 10000n * 10000n * scale >=
      BigInt(f.paidCohortOrders) *
        scaled(baseline.median!) *
        (10000n + BigInt(rule.relativeIncreaseBasisPoints));
  if (!exceeds) return quiet(rules);
  return {
    ...rule.labels,
    severity: "HIGH",
    llmEscalation: "NO_LLM_NEEDED",
    reasonCodes:
      baseline.status === "ZERO" ? ["REFUND_RATE_HIGH", "ZERO_BASELINE"] : ["REFUND_RATE_HIGH"],
  };
}
/** Pure candidate suggestions only; the host owns evidence hashes, routing and authority. */
export class PureInventoryRefundRuleEvaluator implements InventoryRefundRuleEvaluator {
  evaluate(rawInput: SanitizedDecisionInput, rawRuleset: DecisionRulesetV1): DecisionResult {
    const input = SanitizedDecisionInputSchema.parse(rawInput);
    const ruleset = DecisionRulesetV1Schema.parse(rawRuleset);
    const labels =
      input.eventType === "STOCKOUT_RISK"
        ? inventory(input, ruleset)
        : input.eventType === "REFUND_SPIKE"
          ? refund(input, ruleset)
          : quiet(ruleset);
    return DecisionResultSchema.parse({
      schemaVersion: 1,
      correlationId: input.correlationId,
      status: "EVALUATED",
      rulesetVersion: ruleset.version,
      labels,
      confidenceMetadata: null,
    });
  }
}
