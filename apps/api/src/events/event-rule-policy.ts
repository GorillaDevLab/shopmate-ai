import {
  BasisPointsSchema,
  EventRulePolicyV1Schema,
  SourceVersionSchema,
  type EventRulePolicyV1,
  type EventType,
} from "@shopmate/contracts";
import { z } from "zod";

/**
 * Product policy, not statistical confidence: 20 observations, 90% coverage,
 * at most one hour old and four aligned baseline samples for comparative rules.
 * Tolerance defaults to zero so the published 6h/90d/2x/35% boundaries are exact.
 * Independently observed inventory and sync facts do not require a baseline.
 */
const quality = {
  minimumSampleSize: 20,
  minimumCoverageBasisPoints: 9000,
  maximumAgeSeconds: 3600,
  minimumBaselineSamples: 4,
  requireAlignedBaseline: true,
  toleranceBasisPoints: 0,
} as const;

/** Every threshold below is a product default, never vendor or statistical confidence. */
const defaultRules = [
  {
    ...quality,
    eventType: "STOCKOUT_RISK",
    requireAlignedBaseline: false,
    thresholds: { criticalHoursRemaining: 6, leadTimeBufferHours: 4 },
  },
  {
    ...quality,
    eventType: "INVENTORY_STAGNATION",
    requireAlignedBaseline: false,
    thresholds: {
      minimumHoldingDays: 90,
      minimumDemandCoverageDays: 90,
      minimumListingAgeHours: 720,
    },
  },
  {
    ...quality,
    eventType: "REFUND_SPIKE",
    thresholds: {
      relativeIncreaseBasisPoints: 10000,
      minimumRefundedOrders: 10,
      maturityHours: 48,
    },
  },
  {
    ...quality,
    eventType: "CANCELLED_ORDER_SPIKE",
    thresholds: { relativeIncreaseBasisPoints: 10000, minimumCancelledOrders: 10 },
  },
  {
    ...quality,
    eventType: "PROFIT_MARGIN_DROP",
    thresholds: { relativeDropBasisPoints: 1000, minimumDropMinor: 1000 },
  },
  {
    ...quality,
    eventType: "UNUSUAL_DISCOUNT",
    requireAlignedBaseline: false,
    thresholds: { discountBasisPoints: 3000, minimumDiscountMinor: 1000 },
  },
  {
    ...quality,
    eventType: "ROAS_DROP",
    thresholds: {
      relativeDropBasisPoints: 3000,
      minimumSpendMinor: 1000,
      minimumAttributionCoverageBasisPoints: 9000,
    },
  },
  {
    ...quality,
    eventType: "AD_SPEND_SPIKE",
    thresholds: { relativeIncreaseBasisPoints: 20000, minimumSpendMinor: 1000 },
  },
  {
    ...quality,
    eventType: "CONVERSION_DROP",
    thresholds: { relativeDropBasisPoints: 3500, minimumVisitors: 100 },
  },
  {
    ...quality,
    eventType: "PRODUCT_BREAKOUT",
    thresholds: {
      relativeGrowthBasisPoints: 20000,
      minimumSalesUnits: 20,
      minimumConversionBasisPoints: 1000,
    },
  },
  {
    ...quality,
    eventType: "SYNC_FAILURE",
    requireAlignedBaseline: false,
    minimumSampleSize: 1,
    thresholds: { maximumLagSeconds: 3600 },
  },
  {
    ...quality,
    eventType: "REVENUE_DROP",
    thresholds: { relativeDropBasisPoints: 2000, minimumDropMinor: 1000 },
  },
] as const;

export const DEFAULT_EVENT_RULE_POLICY: EventRulePolicyV1 = EventRulePolicyV1Schema.parse({
  schemaVersion: 1,
  version: "event-policy-v1",
  baselineVersion: "robust-baseline-v1",
  rules: defaultRules,
});

/** V1 threshold inclusion; eligibility minimums are inclusive, freshness maximums inclusive. */
export const EVENT_THRESHOLD_BOUNDARIES = Object.freeze({
  STOCKOUT_RISK: "EXCLUSIVE",
  INVENTORY_STAGNATION: "EXCLUSIVE",
  REFUND_SPIKE: "INCLUSIVE",
  CANCELLED_ORDER_SPIKE: "INCLUSIVE",
  PROFIT_MARGIN_DROP: "INCLUSIVE",
  UNUSUAL_DISCOUNT: "INCLUSIVE",
  ROAS_DROP: "INCLUSIVE",
  AD_SPEND_SPIKE: "INCLUSIVE",
  CONVERSION_DROP: "INCLUSIVE",
  PRODUCT_BREAKOUT: "INCLUSIVE",
  SYNC_FAILURE: "EXCLUSIVE",
  REVENUE_DROP: "INCLUSIVE",
} as const satisfies Record<EventType, "INCLUSIVE" | "EXCLUSIVE">);

const comparisonSchema = z.strictObject({
  value: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
  threshold: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
  direction: z.enum(["ABOVE", "BELOW"]),
  boundary: z.enum(["INCLUSIVE", "EXCLUSIVE"]),
  toleranceBasisPoints: BasisPointsSchema,
});

/** Exact dyadic scaling avoids multiplication rounding at an inclusive/exclusive boundary. */
function scaled(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  return exponent === 0 ? fraction : (fraction + (1n << 52n)) << BigInt(exponent - 1);
}

/**
 * Same-unit nonnegative scalars only. Relative changes are already expressed in bp:
 * refund doubling is +10000bp; a 35% conversion decrease is 3500bp. A zero baseline
 * has no relative delta and must remain a distinct detector outcome, never zero bp.
 * Tolerance widens the threshold by threshold*tolerance/10000, without rounding:
 * ABOVE uses (10000+tolerance), BELOW uses (10000-tolerance). No confidence meaning.
 */
export function compareEventThreshold(
  value: number,
  threshold: number,
  direction: "ABOVE" | "BELOW",
  boundary: "INCLUSIVE" | "EXCLUSIVE",
  toleranceBasisPoints: number,
): boolean {
  const input = comparisonSchema.parse({
    value,
    threshold,
    direction,
    boundary,
    toleranceBasisPoints,
  });
  const factor = 10000 + (input.direction === "ABOVE" ? 1 : -1) * input.toleranceBasisPoints;
  const delta = scaled(input.value) * 10000n - scaled(input.threshold) * BigInt(factor);
  if (delta === 0n) return input.boundary === "INCLUSIVE";
  return input.direction === "ABOVE" ? delta > 0n : delta < 0n;
}

/** Server construction only: no merchant JSON/provider descriptor or global active version. */
export class EventRulePolicyRegistry {
  readonly #policies = new Map<string, EventRulePolicyV1>();

  constructor(policies: readonly unknown[]) {
    for (const input of policies) {
      const policy = EventRulePolicyV1Schema.parse(input);
      if (this.#policies.has(policy.version))
        throw new RangeError(`Event policy version already registered: ${policy.version}`);
      this.#policies.set(policy.version, policy);
    }
    Object.freeze(this);
  }

  get(version: string): EventRulePolicyV1 {
    const policy = this.#policies.get(SourceVersionSchema.parse(version));
    if (!policy) throw new RangeError(`Unknown event policy version: ${version}`);
    return policy;
  }

  append(policy: unknown): EventRulePolicyRegistry {
    return new EventRulePolicyRegistry([...this.#policies.values(), policy]);
  }
}
