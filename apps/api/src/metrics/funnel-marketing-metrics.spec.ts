import { expect, it } from "vitest";
import {
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricRatioEvidenceSchema,
  type MetricInputV1,
  type MetricResult,
  type MetricSubject,
  type MinorRounding,
  type ExactMinorMath,
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

function unknownCampaign(
  field: "clicks" | "impressions" | "attributedOrders" | "spendMinor" | "attributedRevenueMinor",
) {
  const row = measuredCampaign();
  return {
    ...row,
    data: {
      ...row.data,
      [field]: null,
      source: {
        ...row.data.source,
        quality: { state: "PARTIAL" as const, issues: ["MARKETING_UNKNOWN" as const] },
      },
    },
  };
}
it.each(["clicks", "impressions", "attributedOrders"] as const)(
  "retains known ROAS with unknown %s",
  (field) => {
    const result = run(input({ campaignFacts: [unknownCampaign(field)] }));
    expect(result.roas.measure.metric.value).toBe(30000);
    expect(result.roas.measure.quality.status).toBe("ESTIMATED");
    expect(result.roas.measure.quality.issues.length).toBeGreaterThan(0);
  },
);
it.each(["spendMinor", "attributedRevenueMinor"] as const)(
  "cannot treat missing %s as a known subtotal",
  (field) => {
    const result = run(input({ campaignFacts: [unknownCampaign(field)] }));
    expect(result.roas.measure.metric.value).toBeNull();
    expect(result.conversion.measure.metric.value).toBe(1000);
  },
);
it.each(["paidOrders", "cart", "checkout"] as const)("isolates unknown traffic %s", (field) => {
  const result = run(input({ traffic: [traffic({ [field]: null })] }));
  const values = [result.conversion, result.cart, result.checkout].map(
    (row) => row.measure.metric.value,
  );
  expect(values.filter((n) => n === null)).toHaveLength(1);
});
it("keeps all rates unavailable when visitor count is unknown", () => {
  const result = run(input({ traffic: [traffic({ visitors: null })] }));
  expect(result.conversion.numerator).toBe(100);
  expect(result.conversion.denominator).toBeNull();
  expect(result.cart.measure.metric.value).toBeNull();
});
it.each([{ cart: 1100 }, { checkout: 400 }, { paidOrders: 201 }, { cart: null, checkout: 1100 }])(
  "does not clamp inconsistent funnel counts %#",
  (patch) => {
    const result = run(input({ traffic: [traffic(patch)] }));
    for (const row of [result.conversion, result.cart, result.checkout]) {
      expect(row.measure.metric.value).toBeNull();
      expect(row.measure.quality.issues).toContainEqual(
        expect.objectContaining({ code: "SOURCE_INCONSISTENT" }),
      );
    }
  },
);
it("preserves actual numeric zero numerators", () => {
  const row = measuredCampaign();
  const result = run(
    input({
      traffic: [traffic({ paidOrders: 0 })],
      campaignFacts: [{ ...row, data: { ...row.data, attributedRevenueMinor: 0 } }],
    }),
  );
  expect(result.conversion.measure.metric.value).toBe(0);
  expect(result.roas.measure.metric.value).toBe(0);
});
it("takes every matching completeness proof including one missing its required domain", () => {
  const proof = input().metricCoverage[0]!;
  const result = run(
    input({
      metricCoverage: [
        ...input().metricCoverage,
        { ...proof, collections: ["paymentFacts"], coverageBasisPoints: 10000 },
      ],
    }),
  );
  expect(result.conversion.coverageBasisPoints).toBe(0);
  expect(result.conversion.measure.quality.status).toBe("ESTIMATED");
  expect(result.cart.measure.quality.status).toBe("VERIFIED");
});
it("cannot manufacture measured provenance from completeness proofs on empty sources", () => {
  const result = run(input({ traffic: [], campaignFacts: [] }));
  for (const row of Object.values(result)) {
    expect(row.measure.metric.value).toBeNull();
    expect(row.numeratorCoverage).toBeNull();
    expect(row.coverageBasisPoints).toBe(0);
  }
});
it("limits completeness to measured traffic coverage", () => {
  const result = run(input({ traffic: [traffic({ coverageBasisPoints: 6000 })] }));
  expect(result.conversion.coverageBasisPoints).toBe(6000);
  expect(result.conversion.measure.quality.status).toBe("ESTIMATED");
});
it("retains all proof evidence and the minimum proof coverage", () => {
  const proof = input().metricCoverage[0]!;
  const result = run(
    input({
      metricCoverage: [
        ...input().metricCoverage,
        { ...proof, evidenceIds: ["campaign"], coverageBasisPoints: 2000 },
      ],
    }),
  );
  expect(result.conversion.coverageBasisPoints).toBe(2000);
  expect(result.conversion.measure.quality.evidenceIds).toContain("campaign");
});
it.each(["ESTIMATED", "INSUFFICIENT", "STALE"] as const)(
  "retains upstream %s quality",
  (status) => {
    for (const row of Object.values(run(input({ status })))) {
      expect(row.measure.quality.status).toBe(status);
      expect(row.measure.quality.issues.length).toBeGreaterThan(0);
    }
  },
);
it("marks a watermark before the measured end stale", () => {
  const sourceWatermark = "2026-10-10T03:00:00Z";
  const raw = input({
    sourceWatermark,
    metricCoverage: input().metricCoverage.map((row) => ({ ...row, sourceWatermark })),
  });
  expect(run(raw).conversion.measure.quality.status).toBe("STALE");
});
it("retains public source issues without erasing independently known ROAS", () => {
  const row = measuredCampaign(),
    source = {
      ...row.data.source,
      updatedAt: null,
      quality: { state: "PARTIAL" as const, issues: ["SOURCE_TIME_MISSING" as const] },
    };
  const result = run(input({ campaignFacts: [{ ...row, data: { ...row.data, source } }] }));
  expect(result.roas.measure.metric.value).toBe(30000);
  expect(result.roas.measure.quality.issues).toContainEqual(
    expect.objectContaining({ code: "SOURCE_TIME_MISSING" }),
  );
});
it("degrades selected-campaign ROAS when the global public VERIFIED prerequisite fails", () => {
  const row = measuredCampaign(),
    other = {
      ...unknownCampaign("spendMinor"),
      data: { ...unknownCampaign("spendMinor").data, externalCampaignId: "other" },
    };
  const subject = { kind: "CAMPAIGN", externalCampaignId: "ad" } as const;
  const result = run(
    input({ campaignFacts: [row, other], metricCoverage: campaignProofs(subject) }),
    subject,
  );
  expect(result.roas.measure.metric.value).toBe(30000);
  expect(result.roas.measure.quality.status).toBe("ESTIMATED");
});
function rejected(raw: unknown, subject: unknown = store) {
  const result = calculator.calculate(raw as MetricInputV1, subject as MetricSubject);
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
}
it.each([null, {}, { ...input(), extra: true }, { ...input(), visibleAt: "bad" }])(
  "rejects malformed input %#",
  (raw) => rejected(raw),
);
it.each([null, {}, { kind: "STORE", externalSkuId: "sku" }, { kind: "SKU", externalSkuId: " " }])(
  "validates even unsupported subjects %#",
  (subject) => rejected(input(), subject),
);
it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects unsafe traffic counts %s",
  (visitors) => rejected(input({ traffic: [traffic({ visitors })] })),
);
it("rejects future and cross-binding facts", () => {
  rejected(input({ traffic: [{ ...traffic(), observedAt: "2026-10-10T05:00:00Z" }] }));
  rejected(input({ traffic: [{ ...traffic(), binding: { ...binding, storeId: "other" } }] }));
});
it.each(["periodStart", "periodEnd", "visibleAt", "sourceWatermark"] as const)(
  "rejects submillisecond context %s",
  (key) => {
    const raw = input();
    rejected({ ...raw, [key]: raw[key]!.replace("Z", ".0001Z"), metricCoverage: [] });
  },
);
it("rejects submillisecond traffic, campaign source, and coverage timestamps", () => {
  rejected(input({ traffic: [traffic({ periodStart: "2026-10-10T00:00:00.0001Z" })] }));
  const row = measuredCampaign();
  rejected(
    input({
      campaignFacts: [
        {
          ...row,
          data: {
            ...row.data,
            source: { ...row.data.source, updatedAt: "2026-10-10T04:00:00.0001Z" },
          },
        },
      ],
    }),
  );
  rejected(
    input({
      campaignFacts: [
        {
          ...row,
          measuredCoverage: { ...row.measuredCoverage!, periodStart: "2026-10-10T00:00:00.0001Z" },
        },
      ],
    }),
  );
});
it.each([
  null,
  {},
  { math: exactMinorMath, rounding: "bad" },
  { math: {}, rounding: "TOWARD_ZERO" },
])("rejects invalid runtime dependencies %#", (dependencies) => {
  const calc = createFunnelMarketingCalculator(
    dependencies as { math: ExactMinorMath; rounding: MinorRounding },
  );
  expect(calc.calculate(input(), store)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("propagates checked arithmetic failures with source evidence", () => {
  const math = {
    ...exactMinorMath,
    ratio: () => ({
      ok: false as const,
      error: { code: "OVERFLOW" as const, evidenceIds: ["dependency"] },
    }),
  };
  const calc = createFunnelMarketingCalculator({ math, rounding: "TOWARD_ZERO" });
  expect(calc.calculate(input(), store)).toMatchObject({
    ok: false,
    error: { code: "OVERFLOW", evidenceIds: expect.arrayContaining(["dependency"]) },
  });
});
it("propagates unexpected dependency programmer errors", () => {
  const calc = createFunnelMarketingCalculator({
    math: {
      ...exactMinorMath,
      ratio: () => {
        throw new Error("programmer");
      },
    },
    rounding: "TOWARD_ZERO",
  });
  expect(() => calc.calculate(input(), store)).toThrow("programmer");
});
it("rejects a genuine checked count sum overflow", () => {
  const half = "2026-10-10T02:00:00Z",
    huge = { visitors: Number.MAX_SAFE_INTEGER, cart: 0, checkout: 0, paidOrders: 0 };
  expect(
    calculator.calculate(
      input({
        traffic: [traffic({ ...huge, periodEnd: half }), traffic({ ...huge, periodStart: half })],
      }),
      store,
    ),
  ).toMatchObject({ ok: false, error: { code: "OVERFLOW" } });
});
it.each([
  ["HALF_AWAY_FROM_ZERO", 1],
  ["TOWARD_ZERO", 0],
] as const)("rounds once using %s", (rounding, expected) => {
  const calc = createFunnelMarketingCalculator({ math: exactMinorMath, rounding });
  const result = value(
    calc.calculate(
      input({ traffic: [traffic({ visitors: 20000, cart: 1, checkout: 1, paidOrders: 1 })] }),
      store,
    ),
  );
  expect(result.conversion.measure.metric.value).toBe(expected);
});
it("returns deeply frozen independent copies and deterministic replay", () => {
  const raw = input(),
    before = JSON.stringify(raw),
    result = run(raw);
  expect(run(raw)).toEqual(result);
  expect(JSON.stringify(raw)).toBe(before);
  expect(Object.isFrozen(raw)).toBe(false);
  expect(Object.isFrozen(raw.binding)).toBe(false);
  expect(Object.isFrozen(result.conversion.numeratorCoverage?.binding)).toBe(true);
  expect(Object.isFrozen(result.conversion.measure.quality.issues)).toBe(true);
  expect(result.conversion.numeratorCoverage?.binding).not.toBe(raw.binding);
});
it("passes both public output boundaries with exact original context", () => {
  const raw = input();
  for (const row of Object.values(run(raw))) {
    expect(MetricRatioEvidenceSchema.safeParse(row).success).toBe(true);
    expect(
      MetricComputationV1Schema.safeParse({
        input: raw,
        snapshot: {
          ...context(),
          ...row.measure.quality,
          metric: row.measure.metric,
          subject: store,
          computedAt: now,
        },
      }).success,
    ).toBe(true);
  }
});

it("keeps unsynchronized input unavailable with immutable error and value results", () => {
  const raw = input({
    status: "UNAVAILABLE",
    sourceWatermark: null,
    paymentFacts: null,
    refundFacts: null,
    inventoryFacts: null,
    campaignFacts: null,
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    traffic: null,
    inventoryExtensions: null,
    metricCoverage: [],
  });
  for (const row of Object.values(run(raw))) {
    expect(row.measure.quality.status).toBe("UNAVAILABLE");
    expect(row.measure.metric.value).toBeNull();
  }
  const failure = calculator.calculate({} as MetricInputV1, store);
  expect(Object.isFrozen(failure)).toBe(true);
  if (!failure.ok) expect(Object.isFrozen(failure.error.evidenceIds)).toBe(true);
});
it("keeps ROAS unavailable for missing campaigns independently of the funnel", () => {
  const result = run(input({ campaignFacts: null, metricCoverage: [] }));
  expect(result.roas.measure.metric.value).toBeNull();
  expect(result.roas.numeratorCoverage).toBeNull();
  expect(result.conversion.measure.metric.value).toBe(1000);
});
it("rejects a real ROAS quotient overflow instead of clamping", () => {
  const row = measuredCampaign();
  expect(
    calculator.calculate(
      input({
        campaignFacts: [
          {
            ...row,
            data: { ...row.data, spendMinor: 1, attributedRevenueMinor: Number.MAX_SAFE_INTEGER },
          },
        ],
      }),
      store,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "OVERFLOW", evidenceIds: expect.arrayContaining(["campaign"]) },
  });
});
it("keeps exact large intermediate ROAS math inside the safe output range", () => {
  const row = measuredCampaign();
  const result = run(
    input({
      campaignFacts: [
        {
          ...row,
          data: {
            ...row.data,
            spendMinor: Number.MAX_SAFE_INTEGER,
            attributedRevenueMinor: Number.MAX_SAFE_INTEGER,
          },
        },
      ],
    }),
  );
  expect(result.roas.measure.metric.value).toBe(10000);
});
function twoDayInput(): MetricInputV1 {
  const periodStart = "2026-10-08T16:00:00Z",
    middle = "2026-10-09T16:00:00Z";
  const raw = input(),
    row = measuredCampaign();
  const make = (date: string, start: string, end: string) => ({
    ...row,
    data: { ...row.data, date },
    measuredCoverage: { ...row.measuredCoverage!, periodStart: start, periodEnd: end },
  });
  return {
    ...raw,
    periodStart,
    metricCoverage: raw.metricCoverage.map((proof) => ({ ...proof, periodStart })),
    campaignFacts: [make("2026-10-09", periodStart, middle), make("2026-10-10", middle, now)],
  };
}
it("aggregates matching measured applicable business-day cohorts", () => {
  const result = run(twoDayInput());
  expect(result.roas.numerator).toBe(60000);
  expect(result.roas.denominator).toBe(20000);
  expect(result.roas.measure.quality.status).toBe("VERIFIED");
  expect(result.roas.numeratorCoverage?.periodStart).toBe(twoDayInput().periodStart);
});
it("does not fill an unmeasured day from query-completeness proofs", () => {
  const raw = twoDayInput(),
    rows = raw.campaignFacts!;
  const result = run({ ...raw, campaignFacts: [rows[1]!] });
  expect(result.roas.numerator).toBe(30000);
  expect(result.roas.measure.quality.status).toBe("ESTIMATED");
  expect(result.roas.coverageBasisPoints).toBeLessThan(10000);
});
it("keeps traffic gaps explicit without forging contiguous measured provenance", () => {
  const result = run(
    input({
      traffic: [
        traffic({ periodEnd: "2026-10-10T01:00:00Z" }),
        traffic({ periodStart: "2026-10-10T03:00:00Z" }),
      ],
    }),
  );
  expect(result.conversion.measure.metric.value).toBe(1000);
  expect(result.conversion.numeratorCoverage).toBeNull();
  expect(result.conversion.coverageBasisPoints).toBe(5000);
});
it("does not sum unknown selected campaign spend into a confident subtotal", () => {
  const row = measuredCampaign(),
    other = unknownCampaign("spendMinor");
  const result = run(
    input({
      campaignFacts: [row, { ...other, data: { ...other.data, externalCampaignId: "other" } }],
    }),
  );
  expect(result.roas.numerator).toBe(60000);
  expect(result.roas.denominator).toBeNull();
  expect(result.roas.measure.metric.value).toBeNull();
});
it("rejects a submillisecond completeness proof observation time", () => {
  const raw = input();
  rejected({
    ...raw,
    metricCoverage: raw.metricCoverage.map((row) => ({
      ...row,
      observedAt: "2026-10-10T04:00:00.0001Z",
    })),
  });
});
it("accepts zero submillisecond tails as the same exact millisecond", () => {
  const result = run(input({ traffic: [traffic({ periodStart: "2026-10-10T00:00:00.0000Z" })] }));
  expect(result.conversion.measure.metric.value).toBe(1000);
});
it("carries source inconsistency evidence and retains independent store funnel", () => {
  const row = measuredCampaign(),
    source = {
      ...row.data.source,
      quality: { state: "PARTIAL" as const, issues: ["SOURCE_INCONSISTENT" as const] },
    };
  const result = run(input({ campaignFacts: [{ ...row, data: { ...row.data, source } }] }));
  expect(result.roas.measure.metric.value).toBeNull();
  expect(result.roas.measure.quality.issues).toContainEqual(
    expect.objectContaining({ code: "SOURCE_INCONSISTENT", evidenceIds: ["campaign"] }),
  );
  expect(result.conversion.measure.quality.status).toBe("VERIFIED");
});
it("distinguishes unsynchronized traffic from an observed empty collection", () => {
  const absent = run(input({ traffic: null, metricCoverage: [] })).conversion;
  const empty = run(input({ traffic: [] })).conversion;
  expect(absent.measure.quality.issues).toContainEqual(
    expect.objectContaining({ code: "NOT_SYNCHRONIZED" }),
  );
  expect(empty.measure.quality.issues).not.toContainEqual(
    expect.objectContaining({ code: "NOT_SYNCHRONIZED" }),
  );
  expect(absent.measure.quality.issues).not.toEqual(empty.measure.quality.issues);
});
it("retains provenance evidence of a nullable traffic measurement", () => {
  const result = run(input({ traffic: [fact(null, "unknown-traffic")] }));
  expect(result.conversion.measure.quality.evidenceIds).toContain("unknown-traffic");
  expect(result.conversion.measure.quality.issues).toContainEqual(
    expect.objectContaining({ field: "traffic.data" }),
  );
});
it("counts selected measured campaign observations as ROAS samples", () => {
  expect(run().roas.measure.quality.sampleSize).toBe(1);
  expect(run().conversion.measure.quality.sampleSize).toBe(1000);
  expect(run(input(), { kind: "SKU", externalSkuId: "sku" }).roas.measure.quality.sampleSize).toBe(
    0,
  );
});
