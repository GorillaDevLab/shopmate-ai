import { expect, it } from "vitest";
import { SanitizedDecisionInputSchema, type SanitizedDecisionInput } from "@shopmate/contracts";
import { DEFAULT_DECISION_RULESET as rules } from "./decision-ruleset.js";
import { PureInventoryRefundRuleEvaluator } from "./inventory-refund-rules.js";

const period = {
  periodStart: "2026-10-20T00:00:00Z",
  periodEnd: "2026-10-21T00:00:00Z",
  timezone: "Asia/Shanghai" as const,
  currency: "CNY" as const,
};
const observedAt = "2026-10-23T00:00:00Z";
const common = {
  schemaVersion: 1,
  correlationId: "11111111-1111-4111-8111-111111111111",
  period,
  observedAt,
  sourceWatermark: observedAt,
  dataStatus: "VERIFIED",
  sampleSize: 100,
  coverageBasisPoints: 10000,
  qualityReasons: [],
  baseline: null,
};
function stock(available = 599, sales = 2400): SanitizedDecisionInput {
  return SanitizedDecisionInputSchema.parse({
    ...common,
    eventType: "STOCKOUT_RISK",
    facts: {
      availableUnits: available,
      salesUnits: sales,
      salesWindow: period,
      salesWindowHours: 24,
      estimatedHoursRemaining: (available / sales) * 24,
      supplierLeadTimeHours: 8,
      safetyBufferHours: null,
      inboundETA: null,
      inventoryObservedAt: observedAt,
      inventoryAgeSeconds: 0,
      inventoryStatus: "VERIFIED",
    },
  });
}
function rate(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    valueBasisPoints: Math.round((numerator / denominator) * 10000),
    period,
  };
}
function refund(refunded = 20, paid = 100, median = 1000): SanitizedDecisionInput {
  return SanitizedDecisionInputSchema.parse({
    ...common,
    eventType: "REFUND_SPIKE",
    baseline: {
      status: median === 0 ? "ZERO" : "AVAILABLE",
      alignment: "ALIGNED",
      measure: { kind: "REFUND_COHORT_ORDER_RATE", unit: "basisPoints" },
      aggregation: "EXACT_MEDIAN",
      period: { ...period, periodStart: "2026-10-13T00:00:00Z", periodEnd: "2026-10-14T00:00:00Z" },
      median,
      mad: 0,
      sampleSize: 4,
      coverageBasisPoints: 10000,
    },
    facts: {
      paymentCohort: period,
      observedThrough: observedAt,
      maturityHours: 48,
      paidCohortOrders: paid,
      refundedOrders: refunded,
      currentRate: rate(refunded, paid),
      baselineRate: null,
      affectedSkuShare: rate(0, refunded),
      reasonCounts: [],
    },
  });
}
const evaluator = new PureInventoryRefundRuleEvaluator();
function labels(input: SanitizedDecisionInput) {
  const result = evaluator.evaluate(input, rules);
  if (result.status !== "EVALUATED") throw new Error("Expected evaluated result");
  return result.labels;
}

it("returns critical at 5.99 raw hours", () => {
  expect(labels(stock())).toMatchObject({
    severity: "CRITICAL",
    notificationRoute: "NOTIFY_NOW",
    attentionPriority: "URGENT",
    reasonCodes: ["INVENTORY_COVERAGE_LOW"],
  });
});
it("uses independent lead risk at exactly six hours", () => {
  expect(labels(stock(600))).toMatchObject({
    severity: "HIGH",
    reasonCodes: ["INVENTORY_COVERAGE_LOW"],
  });
});
it("retains fresh sold out with insufficient sales samples", () => {
  const input = stock(0);
  expect(
    labels({
      ...input,
      sampleSize: 0,
      dataStatus: "INSUFFICIENT",
      qualityReasons: ["LOW_SAMPLE"],
    }),
  ).toMatchObject({ severity: "CRITICAL", reasonCodes: ["CONFIRMED_STOCKOUT"] });
});
it("includes exactly doubled refund rates", () => {
  expect(labels(refund()).severity).toBe("HIGH");
});
it("compares fractional median without rounded current-rate thresholds", () => {
  expect(labels(refund(20, 101, 990.1)).severity).toBe("INFO");
});
it("uses explicit zero baseline minimum count", () => {
  expect(labels(refund(10, 100, 0))).toMatchObject({
    severity: "HIGH",
    reasonCodes: ["REFUND_RATE_HIGH", "ZERO_BASELINE"],
  });
  expect(labels(refund(9, 100, 0)).llmEscalation).toBe("NO_LLM_NEEDED");
});

it("uses fractional clock windows without rounded hours", () => {
  const input = stock();
  if (input.eventType !== "STOCKOUT_RISK") throw new Error("stock fixture");
  const short = { ...period, periodStart: "2026-10-20T23:59:59.999Z" };
  expect(
    labels({
      ...input,
      period: short,
      facts: { ...input.facts, salesWindow: short, salesWindowHours: 1 / 3600000 },
    }).severity,
  ).toBe("CRITICAL");
});
it("allows critical forecast when only lead time is missing", () => {
  const input = stock();
  expect(
    labels({ ...input, dataStatus: "INSUFFICIENT", qualityReasons: ["LEAD_TIME_MISSING"] })
      .severity,
  ).toBe("CRITICAL");
});
it("treats immaturity as insufficient without deep reasoning", () => {
  const input = refund();
  if (input.eventType !== "REFUND_SPIKE") throw new Error("refund fixture");
  expect(labels({ ...input, facts: { ...input.facts, maturityHours: 49 } })).toMatchObject({
    evidenceSufficiency: "INSUFFICIENT_DATA",
    llmEscalation: "NO_LLM_NEEDED",
  });
});
it("does not substitute representative baseline rate for historical median", () => {
  const input = refund();
  if (input.eventType !== "REFUND_SPIKE" || !input.baseline?.period)
    throw new Error("refund fixture");
  expect(
    labels({
      ...input,
      facts: { ...input.facts, baselineRate: { ...rate(50, 100), period: input.baseline.period } },
    }).severity,
  ).toBe("HIGH");
});
it.each(["STALE_SOURCE", "PARTIAL_COVERAGE", "LOW_SAMPLE", "SOURCE_INCONSISTENT"] as const)(
  "gates refunds with %s",
  (code) => {
    const input = refund();
    expect(labels({ ...input, dataStatus: "INSUFFICIENT", qualityReasons: [code] }).severity).toBe(
      "INFO",
    );
  },
);
it("requires current paid cohort sample minimum", () => {
  expect(labels(refund(10, 19))).toMatchObject({ evidenceSufficiency: "INSUFFICIENT_DATA" });
});
it("rejects malformed input and ruleset extensions", () => {
  expect(() =>
    evaluator.evaluate({ ...stock(), unexpected: 1 } as unknown as SanitizedDecisionInput, rules),
  ).toThrow();
  expect(() =>
    evaluator.evaluate(stock(), { ...rules, toleranceBasisPoints: 1 } as typeof rules),
  ).toThrow();
});
it("echoes versions and correlation without mutation or authority", () => {
  const input = stock();
  const before = JSON.stringify(input);
  const result = evaluator.evaluate(input, { ...rules, version: "test-rules-v2" });
  expect(result).toMatchObject({
    schemaVersion: 1,
    correlationId: input.correlationId,
    rulesetVersion: "test-rules-v2",
    confidenceMetadata: null,
  });
  expect(JSON.stringify(input)).toBe(before);
  expect(evaluator.evaluate(input, rules)).toEqual(evaluator.evaluate(input, rules));
});

it("rejects a baseline falsely marked aligned for another duration", () => {
  const input = refund();
  if (!input.baseline?.period) throw new Error("baseline fixture");
  expect(
    labels({
      ...input,
      baseline: {
        ...input.baseline,
        period: { ...input.baseline.period, periodStart: "2026-10-12T00:00:00Z" },
      },
    }).reasonCodes,
  ).toEqual(["CONFLICTING_DATA"]);
});
it("keeps exactly six quiet when observed lead equals six", () => {
  const input = stock(600);
  if (input.eventType !== "STOCKOUT_RISK") throw new Error("stock fixture");
  expect(labels({ ...input, facts: { ...input.facts, supplierLeadTimeHours: 6 } }).severity).toBe(
    "INFO",
  );
});
it("uses raw forecast rather than rounded estimated hours", () => {
  const input = stock(600);
  if (input.eventType !== "STOCKOUT_RISK") throw new Error("stock fixture");
  expect(
    labels({ ...input, facts: { ...input.facts, estimatedHoursRemaining: 5.99 } }).severity,
  ).toBe("HIGH");
});
it("blocks stale confirmed inventory even if forecast is sufficient", () => {
  const input = stock(0);
  if (input.eventType !== "STOCKOUT_RISK") throw new Error("stock fixture");
  expect(
    labels({
      ...input,
      facts: {
        ...input.facts,
        inventoryObservedAt: "2026-10-22T22:59:59Z",
        inventoryAgeSeconds: 3601,
      },
    }).reasonCodes,
  ).toEqual(["STALE_DATA"]);
});
it("requires historical sample and coverage", () => {
  const input = refund();
  if (!input.baseline) throw new Error("baseline fixture");
  expect(labels({ ...input, baseline: { ...input.baseline, sampleSize: 3 } }).reasonCodes).toEqual([
    "INSUFFICIENT_SAMPLE",
  ]);
  expect(
    labels({ ...input, baseline: { ...input.baseline, coverageBasisPoints: 8999 } }).reasonCodes,
  ).toEqual(["PARTIAL_COVERAGE"]);
});
it("rejects mismatched current cohort counts", () => {
  const input = refund();
  if (input.eventType !== "REFUND_SPIKE") throw new Error("refund fixture");
  expect(() => labels({ ...input, facts: { ...input.facts, refundedOrders: 21 } })).toThrow(
    "Refund cohort counts mismatch",
  );
});
