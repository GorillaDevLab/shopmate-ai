import {
  ConnectorCapabilitiesSchema,
  ConnectorTimestampSchema,
  ExternalIdSchema,
  MinorAmountSchema,
  MetricStatusSchema,
  type SecurityClock,
} from "@shopmate/contracts";
import { z } from "zod";

const BASIS_POINTS = 10_000n;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PriceRiskRulesV1Schema = z
  .strictObject({
    ruleVersion: ExternalIdSchema,
    highAboveBasisPoints: z.number().int().min(1).max(10_000),
    criticalAboveBasisPoints: z.number().int().min(1).max(10_000),
    maxEvidenceAgeMs: z
      .number()
      .int()
      .min(1)
      .max(7 * DAY_MS),
  })
  .refine((rules) => rules.highAboveBasisPoints < rules.criticalAboveBasisPoints)
  .readonly();
export type PriceRiskRulesV1 = z.infer<typeof PriceRiskRulesV1Schema>;

/** PriceRiskPolicyV1 defaults: strictly above 10% is HIGH, strictly above 30% is CRITICAL. */
export const DEFAULT_PRICE_RISK_RULES_V1: PriceRiskRulesV1 = Object.freeze({
  ruleVersion: "price-risk-v1",
  highAboveBasisPoints: 1_000,
  criticalAboveBasisPoints: 3_000,
  maxEvidenceAgeMs: DAY_MS,
});

const priceChangeSchema = z
  .strictObject({
    externalSkuId: ExternalIdSchema,
    oldPriceMinor: MinorAmountSchema,
    newPriceMinor: MinorAmountSchema,
    // Any ISO code is accepted here so a foreign currency is reported, not just malformed.
    currency: z.string().regex(/^[A-Z]{3}$/u),
  })
  .readonly();

/** Deliberately has no event severity, actor or approval field: risk never authorizes. */
export const PriceRiskRequestV1Schema = z
  .strictObject({
    changes: z.array(priceChangeSchema).max(100).readonly(),
    evidence: z
      .strictObject({ status: MetricStatusSchema, observedAt: ConnectorTimestampSchema })
      .readonly(),
    capabilities: ConnectorCapabilitiesSchema,
  })
  .readonly();
export type PriceRiskRequestV1 = z.input<typeof PriceRiskRequestV1Schema>;
type PriceRiskRequest = z.infer<typeof PriceRiskRequestV1Schema>;
type PriceChange = z.infer<typeof priceChangeSchema>;

export type PriceRiskReasonCode =
  | "INVALID_RULES"
  | "INVALID_REQUEST"
  | "CLOCK_UNAVAILABLE"
  | "BATCH_NOT_SUPPORTED"
  | "CURRENCY_NOT_SUPPORTED"
  | "ZERO_OLD_PRICE"
  | "INVALID_TARGET_PRICE"
  | "NO_PRICE_CHANGE"
  | "WRITE_PRICE_UNSUPPORTED"
  | "EVIDENCE_INSUFFICIENT"
  | "EVIDENCE_STALE"
  | "PRICE_INCREASE"
  | "PRICE_DECREASE"
  | "WITHIN_HIGH_THRESHOLD"
  | "ABOVE_HIGH_THRESHOLD"
  | "ABOVE_CRITICAL_THRESHOLD"
  | "CRITICAL_CHANGE_DISABLED";

export type PriceRiskAssessmentV1 = Readonly<{
  ruleVersion: string | null;
  /** APPROVABLE still needs a human; BLOCKED is CRITICAL and disabled in the first release. */
  decision: "APPROVABLE" | "BLOCKED" | "REJECTED";
  riskLevel: "LOW" | "HIGH" | "CRITICAL" | null;
  /** Signed newPrice − oldPrice in CNY fen. */
  changeMinor: number | null;
  /** floor(|change| × 10000 / oldPrice); thresholds are compared on exact integers. */
  changeBasisPoints: number | null;
  reasonCodes: readonly PriceRiskReasonCode[];
  requiresHumanApproval: true;
}>;

function rejected(
  ruleVersion: string | null,
  reasonCodes: readonly PriceRiskReasonCode[],
): PriceRiskAssessmentV1 {
  return Object.freeze({
    ruleVersion,
    decision: "REJECTED",
    riskLevel: null,
    changeMinor: null,
    changeBasisPoints: null,
    reasonCodes: Object.freeze([...reasonCodes]),
    requiresHumanApproval: true,
  });
}

function securityNow(clock: SecurityClock): number | null {
  if (clock.timeDomain !== "SECURITY_UTC") return null;
  try {
    const now = ConnectorTimestampSchema.safeParse(clock.now());
    return now.success ? Date.parse(now.data) : null;
  } catch {
    // Freshness cannot be judged without trusted time, so the request is refused.
    return null;
  }
}

/** Deterministic PriceRiskPolicyV1 for one CNY SKU price change. */
export function evaluatePriceRisk(
  input: unknown,
  clock: SecurityClock,
  candidateRules: unknown = DEFAULT_PRICE_RISK_RULES_V1,
): PriceRiskAssessmentV1 {
  const rules = PriceRiskRulesV1Schema.safeParse(candidateRules);
  if (!rules.success) return rejected(null, ["INVALID_RULES"]);
  const { ruleVersion } = rules.data;
  const request = PriceRiskRequestV1Schema.safeParse(input);
  if (!request.success) return rejected(ruleVersion, ["INVALID_REQUEST"]);
  const now = securityNow(clock);
  if (now === null) return rejected(ruleVersion, ["CLOCK_UNAVAILABLE"]);
  const reasons = rejectionReasons(request.data, rules.data, now);
  const [change] = request.data.changes;
  if (reasons.length > 0 || change === undefined) return rejected(ruleVersion, reasons);
  return assess(change, rules.data);
}

function rejectionReasons(
  request: PriceRiskRequest,
  rules: PriceRiskRulesV1,
  now: number,
): PriceRiskReasonCode[] {
  const reasons: PriceRiskReasonCode[] = [];
  const [change] = request.changes;
  if (request.changes.length !== 1 || change === undefined) reasons.push("BATCH_NOT_SUPPORTED");
  else reasons.push(...priceReasons(change));
  if (!request.capabilities.writePrice) reasons.push("WRITE_PRICE_UNSUPPORTED");
  const evidence = evidenceReason(request.evidence, rules, now);
  if (evidence !== null) reasons.push(evidence);
  return reasons;
}

function priceReasons(change: PriceChange): PriceRiskReasonCode[] {
  const reasons: PriceRiskReasonCode[] = [];
  if (change.currency !== "CNY") reasons.push("CURRENCY_NOT_SUPPORTED");
  // A ratio against a zero old price is undefined, so it is refused rather than guessed.
  if (change.oldPriceMinor === 0) reasons.push("ZERO_OLD_PRICE");
  if (change.newPriceMinor === 0) reasons.push("INVALID_TARGET_PRICE");
  else if (change.newPriceMinor === change.oldPriceMinor) reasons.push("NO_PRICE_CHANGE");
  return reasons;
}

function evidenceReason(
  evidence: PriceRiskRequest["evidence"],
  rules: PriceRiskRulesV1,
  now: number,
): PriceRiskReasonCode | null {
  if (evidence.status === "STALE") return "EVIDENCE_STALE";
  if (evidence.status !== "VERIFIED") return "EVIDENCE_INSUFFICIENT";
  const age = now - Date.parse(evidence.observedAt);
  // Evidence from the future is as untrustworthy as evidence that is too old.
  return age < 0 || age > rules.maxEvidenceAgeMs ? "EVIDENCE_STALE" : null;
}

function assess(change: PriceChange, rules: PriceRiskRulesV1): PriceRiskAssessmentV1 {
  const oldPrice = BigInt(change.oldPriceMinor);
  const delta = BigInt(change.newPriceMinor) - oldPrice;
  const scaled = (delta < 0n ? -delta : delta) * BASIS_POINTS;
  // Cross-multiplying keeps the 10%/30% boundaries exact for every safe integer price.
  const above = (threshold: number) => scaled > BigInt(threshold) * oldPrice;
  const critical = above(rules.criticalAboveBasisPoints);
  const high = critical || above(rules.highAboveBasisPoints);
  const direction: PriceRiskReasonCode = delta > 0n ? "PRICE_INCREASE" : "PRICE_DECREASE";
  const band: PriceRiskReasonCode[] = critical
    ? ["ABOVE_CRITICAL_THRESHOLD", "CRITICAL_CHANGE_DISABLED"]
    : [high ? "ABOVE_HIGH_THRESHOLD" : "WITHIN_HIGH_THRESHOLD"];
  return Object.freeze({
    ruleVersion: rules.ruleVersion,
    decision: critical ? "BLOCKED" : "APPROVABLE",
    riskLevel: critical ? "CRITICAL" : high ? "HIGH" : "LOW",
    changeMinor: change.newPriceMinor - change.oldPriceMinor,
    changeBasisPoints: Number(scaled / oldPrice),
    reasonCodes: Object.freeze([direction, ...band]),
    requiresHumanApproval: true,
  });
}
