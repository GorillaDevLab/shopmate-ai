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

function campaignProofs(subject: MetricSubject) {
  return input().metricCoverage.map((row) => ({ ...row, subject }));
}
it("selects campaign ROAS without relabeling store traffic", () => {
  const row = measuredCampaign(),
    subject = { kind: "CAMPAIGN", externalCampaignId: "other" } as const;
  const other = {
    ...row,
    evidenceIds: ["other"],
    data: { ...row.data, externalCampaignId: "other", spendMinor: 5000 },
    measuredCoverage: { ...row.measuredCoverage!, evidenceIds: ["other"] },
  };
  const result = run(
    input({ campaignFacts: [row, other], metricCoverage: campaignProofs(subject) }),
    subject,
  );
  expect(result.roas.measure.metric.value).toBe(60000);
  expect(result.conversion.measure.metric.value).toBeNull();
});
it("treats an unmatched campaign as missing scope", () => {
  expect(
    run(input(), { kind: "CAMPAIGN", externalCampaignId: "absent" }).roas.measure.metric.value,
  ).toBeNull();
});
it("returns explicit unavailable leaves for SKU scope", () => {
  for (const leaf of Object.values(run(input(), { kind: "SKU", externalSkuId: "sku" }))) {
    expect(leaf.measure.metric.value).toBeNull();
    expect(leaf.measure.quality.issues.length).toBeGreaterThan(0);
  }
});
it.each([null, [], [fact(null)]])("keeps missing and empty traffic unmeasured %#", (rows) => {
  const result = run(input({ traffic: rows, metricCoverage: [] }));
  expect(result.conversion.numerator).toBeNull();
  expect(result.conversion.numeratorCoverage).toBeNull();
  expect(result.roas.measure.metric.value).toBe(30000);
});
it("aggregates adjacent traffic segments using checked exact sums", () => {
  const middle = "2026-10-10T02:00:00Z";
  const result = run(
    input({ traffic: [traffic({ periodEnd: middle }), traffic({ periodStart: middle })] }),
  );
  expect(result.conversion.numerator).toBe(200);
  expect(result.conversion.denominator).toBe(2000);
  expect(result.conversion.measure.metric.value).toBe(1000);
  expect(result.conversion.measure.quality.status).toBe("VERIFIED");
});
it("retains a partial measured traffic ratio with restricted coverage", () => {
  const result = run(input({ traffic: [traffic({ periodEnd: "2026-10-10T02:00:00Z" })] }));
  expect(result.conversion.measure.metric.value).toBe(1000);
  expect(result.conversion.measure.quality.status).toBe("ESTIMATED");
  expect(result.conversion.coverageBasisPoints).toBe(5000);
});
it("does not prorate traffic that crosses the requested boundary", () => {
  const result = run(input({ traffic: [traffic({ periodStart: "2026-10-09T23:00:00Z" })] }));
  expect(result.conversion.measure.metric.value).toBeNull();
  expect(result.conversion.measure.quality.issues).toContainEqual(
    expect.objectContaining({ code: "WINDOW_MISMATCH" }),
  );
});
it("excludes wholly out-of-window traffic", () => {
  const outside = traffic({ periodStart: "2026-10-09T20:00:00Z", periodEnd: window.periodStart });
  expect(run(input({ traffic: [outside, traffic()] })).conversion.denominator).toBe(1000);
});
it.each(["duplicate", "overlap"])("rejects %s traffic intervals with both evidences", (mode) => {
  const other = {
    ...traffic({ periodStart: mode === "overlap" ? "2026-10-10T02:00:00Z" : window.periodStart }),
    evidenceIds: ["other"],
  };
  const result = calculator.calculate(input({ traffic: [traffic(), other] }), store);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: expect.arrayContaining(["traffic", "other"]) },
  });
});
it("rejects duplicate normalized campaign keys with both evidences", () => {
  const row = measuredCampaign(),
    other = { ...row, evidenceIds: ["other"], measuredCoverage: null };
  expect(calculator.calculate(input({ campaignFacts: [row, other] }), store)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: expect.arrayContaining(["campaign", "other"]) },
  });
});
it("sums measured campaigns on the identical interval", () => {
  const row = measuredCampaign(),
    other = { ...row, data: { ...row.data, externalCampaignId: "other" } };
  const result = run(input({ campaignFacts: [row, other] }));
  expect(result.roas.numerator).toBe(60000);
  expect(result.roas.denominator).toBe(20000);
  expect(result.roas.measure.metric.value).toBe(30000);
});
it("refuses to mix campaign cohorts measured over different intervals", () => {
  const row = measuredCampaign(),
    other = {
      ...row,
      data: { ...row.data, externalCampaignId: "other" },
      measuredCoverage: { ...row.measuredCoverage!, periodStart: "2026-10-10T02:00:00Z" },
    };
  expect(run(input({ campaignFacts: [row, other] })).roas.measure.metric.value).toBeNull();
});
it("does not forge a combined source version", () => {
  const middle = "2026-10-10T02:00:00Z",
    other = { ...traffic({ periodStart: middle }), sourceVersion: "v2" };
  const result = run(input({ traffic: [traffic({ periodEnd: middle }), other] }));
  expect(result.conversion.measure.metric.value).toBe(1000);
  expect(result.conversion.numeratorCoverage).toBeNull();
  expect(result.conversion.measure.quality.status).toBe("ESTIMATED");
});
it("accepts equal timestamp instants while retaining source timestamp spellings", () => {
  const row = traffic({ periodStart: "2026-10-10T00:00:00.000Z" });
  const result = run(input({ traffic: [row] }));
  expect(result.conversion.measure.metric.value).toBe(1000);
  expect(result.conversion.numeratorCoverage?.periodStart).toBe(row.data.periodStart);
  expect(result.conversion.measure.quality.status).toBe("ESTIMATED");
});
