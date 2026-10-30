import {
  DecisionLabelsSchema,
  type DecisionLabels,
  type DecisionReasonCode,
  type EventRulePolicyV1,
  type SanitizedDecisionInput,
} from "@shopmate/contracts";

type Rule = EventRulePolicyV1["rules"][number];
type Input<K extends SanitizedDecisionInput["eventType"]> = Extract<
  SanitizedDecisionInput,
  { eventType: K }
>;
type Policy<K extends Rule["eventType"]> = Extract<Rule, { eventType: K }>;
type Comparison = Readonly<{
  current: readonly [bigint, bigint];
  relativeBasisPoints: number;
  drop: boolean;
}>;
const unitScale = 1n << 1074n;

function knownRatio(ratio: {
  readonly numerator: number | null;
  readonly denominator: number | null;
}): boolean {
  return ratio.numerator !== null && ratio.denominator !== null && ratio.denominator > 0;
}

function conversionProblem(
  input: Input<"CONVERSION_DROP">,
  rule: Policy<"CONVERSION_DROP">,
): DecisionReasonCode | null {
  const { facts } = input;
  if (facts.visitors === null || facts.paidOrders === null || !knownRatio(facts.conversion))
    return "MISSING_DATA";
  return facts.visitors < rule.thresholds.minimumVisitors ? "INSUFFICIENT_SAMPLE" : null;
}

function cancellationProblem(
  input: Input<"CANCELLED_ORDER_SPIKE">,
  rule: Policy<"CANCELLED_ORDER_SPIKE">,
): DecisionReasonCode | null {
  const facts = input.facts;
  if (
    facts.cohortOrders === null ||
    facts.paidCancelledOrders === null ||
    facts.pendingCancelledOrders === null ||
    !knownRatio(facts.currentRate)
  )
    return "MISSING_DATA";
  return facts.cohortOrders < rule.minimumSampleSize ? "INSUFFICIENT_SAMPLE" : null;
}

function breakoutProblem(
  input: Input<"PRODUCT_BREAKOUT">,
  rule: Policy<"PRODUCT_BREAKOUT">,
): DecisionReasonCode | null {
  const facts = input.facts;
  if (
    facts.salesUnits === null ||
    facts.salesUnitsPerHour === null ||
    facts.listedAt === null ||
    !knownRatio(facts.conversion)
  )
    return "MISSING_DATA";
  return facts.conversion.numerator! < rule.minimumSampleSize ? "INSUFFICIENT_SAMPLE" : null;
}

function stagnationProblem(
  input: Input<"INVENTORY_STAGNATION">,
  rule: Policy<"INVENTORY_STAGNATION">,
): DecisionReasonCode | null {
  const facts = input.facts;
  if (
    facts.salesUnits === null ||
    facts.salesUnits === 0 ||
    facts.availableUnits === null ||
    facts.holdingDays === null ||
    facts.demandCoverageDays === null ||
    facts.listedAt === null
  )
    return "MISSING_DATA";
  const age = Date.parse(input.observedAt) - Date.parse(facts.listedAt);
  if (
    facts.salesUnits < rule.minimumSampleSize ||
    scaled(age) < scaled(rule.thresholds.minimumListingAgeHours) * 3600000n
  )
    return "INSUFFICIENT_SAMPLE";
  return null;
}

function primaryProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  if (input.eventType === "CONVERSION_DROP" && rule.eventType === "CONVERSION_DROP")
    return conversionProblem(input, rule);
  if (input.eventType === "CANCELLED_ORDER_SPIKE" && rule.eventType === "CANCELLED_ORDER_SPIKE")
    return cancellationProblem(input, rule);
  if (input.eventType === "PRODUCT_BREAKOUT" && rule.eventType === "PRODUCT_BREAKOUT")
    return breakoutProblem(input, rule);
  if (input.eventType === "INVENTORY_STAGNATION" && rule.eventType === "INVENTORY_STAGNATION")
    return stagnationProblem(input, rule);
  if (
    input.eventType === "ROAS_DROP" &&
    rule.eventType === "ROAS_DROP" &&
    input.facts.attributionCoverageBasisPoints <
      rule.thresholds.minimumAttributionCoverageBasisPoints
  )
    return "PARTIAL_COVERAGE";
  return null;
}

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
  if (baseline?.status === "UNALIGNED") return "CONFLICTING_DATA";
  if (baseline?.status === "INSUFFICIENT") return "INSUFFICIENT_SAMPLE";
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

function explanationProblem(input: SanitizedDecisionInput): DecisionReasonCode | null {
  switch (input.eventType) {
    case "UNUSUAL_DISCOUNT":
      return input.facts.discountMinor === null ||
        input.facts.grossMerchandiseMinor === null ||
        input.facts.discountRate.numerator === null ||
        input.facts.discountRate.denominator === null ||
        input.facts.discountRate.denominator === 0
        ? "MISSING_DATA"
        : null;
    case "AD_SPEND_SPIKE":
      return input.facts.spendMinor === null ? "MISSING_DATA" : null;
    case "ROAS_DROP":
      return input.facts.spendMinor === null ||
        input.facts.attributedRevenueMinor === null ||
        input.facts.roas.numerator === null ||
        input.facts.roas.denominator === null ||
        input.facts.roas.denominator === 0
        ? "MISSING_DATA"
        : null;
    default:
      return null;
  }
}

function rateComparison(input: SanitizedDecisionInput, rule: Rule): Comparison | null {
  if (input.eventType === "CONVERSION_DROP" && rule.eventType === "CONVERSION_DROP")
    return {
      current: [BigInt(input.facts.paidOrders!) * 10000n, BigInt(input.facts.visitors!)],
      relativeBasisPoints: rule.thresholds.relativeDropBasisPoints,
      drop: true,
    };
  if (input.eventType === "ROAS_DROP" && rule.eventType === "ROAS_DROP")
    return {
      current: [
        BigInt(input.facts.attributedRevenueMinor!) * 10000n,
        BigInt(input.facts.spendMinor!),
      ],
      relativeBasisPoints: rule.thresholds.relativeDropBasisPoints,
      drop: true,
    };
  if (input.eventType === "CANCELLED_ORDER_SPIKE" && rule.eventType === "CANCELLED_ORDER_SPIKE")
    return {
      current: [
        (BigInt(input.facts.paidCancelledOrders!) + BigInt(input.facts.pendingCancelledOrders!)) *
          10000n,
        BigInt(input.facts.cohortOrders!),
      ],
      relativeBasisPoints: rule.thresholds.relativeIncreaseBasisPoints,
      drop: false,
    };
  return null;
}

function countComparison(input: SanitizedDecisionInput, rule: Rule): Comparison | null {
  if (input.eventType === "AD_SPEND_SPIKE" && rule.eventType === "AD_SPEND_SPIKE")
    return {
      current: [BigInt(input.facts.spendMinor!), 1n],
      relativeBasisPoints: rule.thresholds.relativeIncreaseBasisPoints,
      drop: false,
    };
  if (input.eventType === "PRODUCT_BREAKOUT" && rule.eventType === "PRODUCT_BREAKOUT")
    return {
      current: [BigInt(input.facts.salesUnits!), 1n],
      relativeBasisPoints: rule.thresholds.relativeGrowthBasisPoints,
      drop: false,
    };
  return null;
}

function comparativeProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  const comparison = rateComparison(input, rule) ?? countComparison(input, rule);
  if (!comparison) return null;
  const baseline = input.baseline;
  if (
    !baseline ||
    baseline.median === null ||
    (baseline.median === 0 &&
      input.eventType !== "CANCELLED_ORDER_SPIKE" &&
      input.eventType !== "AD_SPEND_SPIKE")
  )
    return "MISSING_DATA";
  const [numerator, denominator] = comparison.current;
  const before = scaled(baseline.median) * denominator;
  const now = numerator * unitScale;
  const delta = comparison.drop ? before - now : now - before;
  if (delta <= 0n) return "NO_MATERIAL_CHANGE";
  if (delta <= scaled(baseline.mad ?? 0) * denominator) return "NORMAL_SEASONALITY";
  const relative =
    BigInt(comparison.relativeBasisPoints) * BigInt(10000 + rule.toleranceBasisPoints);
  return delta * 100000000n < scaled(Math.abs(baseline.median)) * denominator * relative
    ? "NO_MATERIAL_CHANGE"
    : null;
}

function minimumProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  if (
    (input.eventType === "ROAS_DROP" || input.eventType === "AD_SPEND_SPIKE") &&
    (rule.eventType === "ROAS_DROP" || rule.eventType === "AD_SPEND_SPIKE")
  )
    return input.facts.spendMinor! < rule.thresholds.minimumSpendMinor
      ? "NO_MATERIAL_CHANGE"
      : null;
  if (input.eventType === "CANCELLED_ORDER_SPIKE" && rule.eventType === "CANCELLED_ORDER_SPIKE") {
    const count =
      BigInt(input.facts.paidCancelledOrders!) + BigInt(input.facts.pendingCancelledOrders!);
    return count === 0n || count < BigInt(rule.thresholds.minimumCancelledOrders)
      ? "NO_MATERIAL_CHANGE"
      : null;
  }
  if (input.eventType === "PRODUCT_BREAKOUT" && rule.eventType === "PRODUCT_BREAKOUT") {
    const facts = input.facts;
    return facts.salesUnits! < rule.thresholds.minimumSalesUnits ||
      BigInt(facts.conversion.numerator!) * 10000n <
        BigInt(facts.conversion.denominator!) * BigInt(rule.thresholds.minimumConversionBasisPoints)
      ? "NO_MATERIAL_CHANGE"
      : null;
  }
  return null;
}

function stagnationMaterial(
  input: Input<"INVENTORY_STAGNATION">,
  rule: Policy<"INVENTORY_STAGNATION">,
): DecisionReasonCode | null {
  const facts = input.facts;
  const elapsed =
    BigInt(Date.parse(facts.salesWindow.periodEnd)) -
    BigInt(Date.parse(facts.salesWindow.periodStart));
  const demand = BigInt(facts.availableUnits!) * elapsed * unitScale * 10000n;
  const threshold =
    BigInt(facts.salesUnits!) *
    86400000n *
    scaled(rule.thresholds.minimumDemandCoverageDays) *
    BigInt(10000 + rule.toleranceBasisPoints);
  return demand <= threshold ||
    scaled(facts.holdingDays!) < scaled(rule.thresholds.minimumHoldingDays)
    ? "NO_MATERIAL_CHANGE"
    : null;
}

function absoluteProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  if (input.eventType === "UNUSUAL_DISCOUNT" && rule.eventType === "UNUSUAL_DISCOUNT") {
    const facts = input.facts;
    const threshold =
      BigInt(facts.grossMerchandiseMinor!) *
      BigInt(rule.thresholds.discountBasisPoints) *
      BigInt(10000 + rule.toleranceBasisPoints);
    return facts.discountMinor! < rule.thresholds.minimumDiscountMinor ||
      BigInt(facts.discountMinor!) * 100000000n < threshold
      ? "NO_MATERIAL_CHANGE"
      : null;
  }
  if (input.eventType === "INVENTORY_STAGNATION" && rule.eventType === "INVENTORY_STAGNATION")
    return stagnationMaterial(input, rule);
  if (
    input.eventType === "SYNC_FAILURE" &&
    rule.eventType === "SYNC_FAILURE" &&
    input.facts.typedErrorCode === "NOT_SYNCHRONIZED" &&
    input.facts.lastSuccessAt !== null
  ) {
    const age =
      BigInt(Date.parse(input.observedAt)) - BigInt(Date.parse(input.facts.lastSuccessAt));
    return age * 10000n <=
      BigInt(rule.thresholds.maximumLagSeconds) * 1000n * BigInt(10000 + rule.toleranceBasisPoints)
      ? "NO_MATERIAL_CHANGE"
      : null;
  }
  return null;
}

function materialProblem(input: SanitizedDecisionInput, rule: Rule): DecisionReasonCode | null {
  return (
    minimumProblem(input, rule) ?? comparativeProblem(input, rule) ?? absoluteProblem(input, rule)
  );
}

/** Quality gates precede versioned defaults. Special inventory/refund rules own their independent facts. */
export function rulesEvidenceGate(
  input: SanitizedDecisionInput,
  policy: EventRulePolicyV1,
): DecisionLabels | null {
  const rule = policy.rules.find((candidate) => candidate.eventType === input.eventType);
  if (!rule) throw new RangeError("Missing event quality policy");
  const reason =
    quality(input, rule) ??
    baselineProblem(input, rule) ??
    primaryProblem(input, rule) ??
    financialProblem(input, rule) ??
    explanationProblem(input) ??
    materialProblem(input, rule);
  return reason === null ? null : quiet(reason);
}
