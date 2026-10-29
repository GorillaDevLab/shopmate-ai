import {
  DecisionLabelsSchema,
  type DecisionLabels,
  type DecisionReasonCode,
  type EventRulePolicyV1,
  type SanitizedDecisionInput,
} from "@shopmate/contracts";

type Rule = EventRulePolicyV1["rules"][number];

function quiet(reason: DecisionReasonCode): DecisionLabels {
  return DecisionLabelsSchema.parse({
    severity: "INFO",
    notificationRoute: "IGNORE",
    attentionPriority: "LOW_PRIORITY",
    llmEscalation: "NO_LLM_NEEDED",
    evidenceSufficiency:
      reason === "CONFLICTING_DATA"
        ? "AMBIGUOUS"
        : reason === "NORMAL_SEASONALITY" || reason === "NO_MATERIAL_CHANGE"
          ? "SUFFICIENT"
          : "INSUFFICIENT_DATA",
    reasonCodes: [reason],
  });
}

function quality(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  const reasons = input.qualityReasons;
  if (
    reasons.some((code) =>
      ["SOURCE_INCONSISTENT", "WINDOW_MISMATCH", "VERSION_MISMATCH"].includes(code),
    )
  )
    return "CONFLICTING_DATA";
  const age =
    input.sourceWatermark === null
      ? null
      : Date.parse(input.observedAt) - Date.parse(input.sourceWatermark);
  if (
    input.dataStatus === "STALE" ||
    reasons.includes("STALE_SOURCE") ||
    (age !== null && age > rule.maximumAgeSeconds * 1000)
  )
    return "STALE_DATA";
  if (input.sampleSize < rule.minimumSampleSize || reasons.includes("LOW_SAMPLE"))
    return "INSUFFICIENT_SAMPLE";
  if (
    input.coverageBasisPoints < rule.minimumCoverageBasisPoints ||
    reasons.includes("PARTIAL_COVERAGE")
  )
    return "PARTIAL_COVERAGE";
  if (input.dataStatus !== "VERIFIED" || age === null || reasons.length > 0) return "MISSING_DATA";
  return null;
}

function aligned(input: SanitizedDecisionInput): boolean {
  const previous = input.baseline?.period;
  if (!previous) return false;
  const start = Date.parse(input.period.periodStart) - Date.parse(previous.periodStart);
  const end = Date.parse(input.period.periodEnd) - Date.parse(previous.periodEnd);
  return (
    start > 0 &&
    start === end &&
    start % (7 * 86400000) === 0 &&
    previous.currency === input.period.currency &&
    previous.timezone === input.period.timezone
  );
}

function measureMatches(input: SanitizedDecisionInput): boolean {
  const kind = input.baseline?.measure.kind;
  switch (input.eventType) {
    case "PROFIT_MARGIN_DROP":
      return kind === "CONTRIBUTION" || kind === "GROSS_PROFIT";
    case "REVENUE_DROP":
      return kind === "PAID_REVENUE";
    case "ROAS_DROP":
      return kind === "ROAS";
    case "AD_SPEND_SPIKE":
      return kind === "AD_SPEND";
    case "CONVERSION_DROP":
      return kind === "CONVERSION_RATE";
    case "CANCELLED_ORDER_SPIKE":
      return kind === "CANCELLED_ORDER_RATE";
    case "PRODUCT_BREAKOUT":
      return kind === "PAID_UNITS";
    default:
      return true;
  }
}

function baselineProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  if (!rule.requireAlignedBaseline) return null;
  const baseline = input.baseline;
  if (baseline?.status === "STALE") return "STALE_DATA";
  if (!baseline || baseline.status === "MISSING" || baseline.median === null) return "MISSING_DATA";
  if (baseline.alignment !== "ALIGNED" || !aligned(input) || !measureMatches(input))
    return "CONFLICTING_DATA";
  if (baseline.sampleSize < rule.minimumBaselineSamples) return "INSUFFICIENT_SAMPLE";
  if (baseline.coverageBasisPoints < rule.minimumCoverageBasisPoints) return "PARTIAL_COVERAGE";
  return null;
}

/** Signed dyadic scaling keeps median/MAD and money comparisons exact at boundaries. */
function scaled(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const magnitude =
    (exponent === 0 ? fraction : fraction + (1n << 52n)) <<
    BigInt(exponent === 0 ? 0 : exponent - 1);
  return bits >> 63n === 0n ? magnitude : -magnitude;
}

function financialProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  if (input.eventType !== "PROFIT_MARGIN_DROP" && input.eventType !== "REVENUE_DROP") return null;
  if (rule.eventType !== input.eventType) return "CONFLICTING_DATA";
  const facts = input.facts;
  const kind = input.baseline?.measure.kind;
  const current =
    input.eventType === "REVENUE_DROP"
      ? facts.paidRevenueMinor
      : kind === "GROSS_PROFIT"
        ? facts.grossProfitMinor
        : facts.contributionMinor;
  if (current === null || input.baseline?.median === null || !input.baseline) return "MISSING_DATA";
  if (
    input.eventType === "PROFIT_MARGIN_DROP" &&
    (facts.costCoverageBasisPoints !== 10000 ||
      (kind === "CONTRIBUTION" && facts.feeCoverageBasisPoints !== 10000))
  )
    return "MISSING_DATA";
  if (rule.eventType !== "PROFIT_MARGIN_DROP" && rule.eventType !== "REVENUE_DROP")
    return "CONFLICTING_DATA";
  const delta = scaled(input.baseline.median) - scaled(current);
  if (delta <= 0n) return "NO_MATERIAL_CHANGE";
  // One observed MAD is the narrow normal band; it is never a confidence score.
  if (delta <= scaled(input.baseline.mad ?? 0)) return "NORMAL_SEASONALITY";
  const relative =
    BigInt(rule.thresholds.relativeDropBasisPoints) * BigInt(10000 + rule.toleranceBasisPoints);
  if (
    delta < scaled(rule.thresholds.minimumDropMinor) ||
    delta * 100000000n < scaled(Math.abs(input.baseline.median)) * relative
  )
    return "NO_MATERIAL_CHANGE";
  return null;
}

/** Quality gates precede versioned defaults. Special inventory/refund rules own their independent facts. */
export function rulesEvidenceGate(
  input: SanitizedDecisionInput,
  policy: EventRulePolicyV1,
): DecisionLabels | null {
  const rule = policy.rules.find((candidate) => candidate.eventType === input.eventType);
  if (!rule) throw new RangeError("Missing event quality policy");
  const reason =
    quality(input, rule) ?? baselineProblem(input, rule) ?? financialProblem(input, rule);
  return reason === null ? null : quiet(reason);
}
