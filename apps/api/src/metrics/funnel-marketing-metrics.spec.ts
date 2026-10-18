import { expect, it } from "vitest";
import {
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricRatioEvidenceSchema,
  type MetricInputV1,
  type MetricResult,
  type MetricSubject,
} from "@shopmate/contracts";
import { exactMinorMath } from "./exact-math.js";
import { createFunnelMarketingCalculator } from "./funnel-marketing-metrics.js";

const now = "2026-10-10T04:00:00Z";
const window = {
  periodStart: "2026-10-10T00:00:00Z",
  periodEnd: now,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const binding = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "external-store",
};
const kinds = ["CONVERSION_RATE", "CART_RATE", "CHECKOUT_RATE", "ROAS"] as const;
const store = { kind: "STORE" } as const;
function context() {
  return {
    schemaVersion: 1 as const,
    definitionVersion: "v1",
    inputRevision: "r1",
    binding,
    ...window,
    visibleAt: now,
    sourceWatermark: now,
    evidenceIds: ["sync"],
  };
}
function fact<T>(data: T, id = "traffic") {
  return { binding, observedAt: now, sourceVersion: "source-v1", evidenceIds: [id], data };
}
function traffic(patch: Partial<NonNullable<MetricInputV1["traffic"]>[number]["data"]> = {}) {
  return fact({
    ...window,
    visitors: 1000,
    cart: 300,
    checkout: 200,
    paidOrders: 100,
    coverageBasisPoints: 10000,
    ...patch,
  });
}
function campaign() {
  return {
    ...fact(
      {
        externalStoreId: binding.externalStoreId,
        externalCampaignId: "ad",
        date: "2026-10-10",
        impressions: 2000,
        clicks: 200,
        attributedOrders: 50,
        spendMinor: 10000,
        attributedRevenueMinor: 30000,
        currency: "CNY" as const,
        source: {
          version: "v1",
          updatedAt: now,
          quality: { state: "COMPLETE" as const, issues: [] },
        },
      },
      "campaign",
    ),
    measuredCoverage: {
      ...fact(null, "campaign"),
      ...window,
      coverageBasisPoints: 10000,
      data: undefined,
    },
  };
}
function measuredCampaign(): NonNullable<MetricInputV1["campaignFacts"]>[number] {
  const row = campaign();
  const { data: unused, ...measuredCoverage } = row.measuredCoverage;
  void unused;
  return { ...row, measuredCoverage };
}
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  return {
    ...context(),
    status: "VERIFIED",
    paymentFacts: [],
    refundFacts: [],
    inventoryFacts: [],
    campaignFacts: [measuredCampaign()],
    frozenCosts: [],
    refundAllocations: [],
    returnReceipts: [],
    fees: [],
    traffic: [traffic()],
    inventoryExtensions: [],
    metricCoverage: kinds.map((kind) => ({
      ...context(),
      kind,
      subject: store,
      observedAt: now,
      sourceVersion: "v1",
      collections: [kind === "ROAS" ? "campaignFacts" : "traffic"],
      coverageBasisPoints: 10000,
    })),
    ...patch,
  };
}
const calculator = createFunnelMarketingCalculator({
  math: exactMinorMath,
  rounding: "HALF_AWAY_FROM_ZERO",
});
function value<T>(result: MetricResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function run(raw = input(), subject: MetricSubject = store) {
  return value(calculator.calculate(raw, subject));
}
it("computes visitor funnel rates and 3x ROAS in basis points", () => {
  expect(MetricInputV1Schema.safeParse(input()).success).toBe(true);
  const result = run();
  expect(Object.values(result).map((row) => row.measure.metric.value)).toEqual([
    1000, 3000, 2000, 30000,
  ]);
  expect(result.conversion.numerator).toBe(100);
  expect(result.conversion.denominator).toBe(1000);
  expect(result.roas.numerator).toBe(30000);
  expect(result.roas.denominator).toBe(10000);
  expect(Object.values(result).every((row) => row.measure.quality.status === "VERIFIED")).toBe(
    true,
  );
});
it("preserves zero denominators as unavailable instead of zero", () => {
  const row = measuredCampaign();
  const result = run(
    input({
      traffic: [traffic({ visitors: 0, cart: 0, checkout: 0, paidOrders: 0 })],
      campaignFacts: [{ ...row, data: { ...row.data, spendMinor: 0 } }],
    }),
  );
  for (const leaf of Object.values(result)) {
    expect(leaf.measure.metric.value).toBeNull();
    expect(leaf.measure.quality.status).toBe("UNAVAILABLE");
    expect(leaf.measure.quality.issues).toContainEqual(
      expect.objectContaining({ code: "ZERO_DENOMINATOR" }),
    );
  }
});
it("does not infer attribution from a campaign date", () => {
  const row = measuredCampaign();
  const result = run(input({ campaignFacts: [{ ...row, measuredCoverage: null }] }));
  expect(result.roas.measure.metric.value).toBeNull();
  expect(result.roas.measure.quality.status).toBe("UNAVAILABLE");
  expect(result.conversion.measure.metric.value).toBe(1000);
});
