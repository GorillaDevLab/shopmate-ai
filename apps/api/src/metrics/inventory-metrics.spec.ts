import { expect, it } from "vitest";
import {
  type InventoryCoverageRequest,
  type MetricInputV1,
  type MetricResult,
  type QualityPolicy,
} from "@shopmate/contracts";
import { exactMinorMath } from "./exact-math.js";
import { createInventoryCoverageCalculator } from "./inventory-metrics.js";

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
const kinds = ["INVENTORY_AVAILABLE", "INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"] as const;
const domains = [
  ["inventoryFacts"],
  ["inventoryFacts", "paymentFacts", "inventoryExtensions"],
  ["inventoryExtensions"],
] as const;
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
function fact<T>(data: T, evidence = "stock") {
  return { binding, observedAt: now, sourceVersion: "v1", evidenceIds: [evidence], data };
}
function stock(available: number | null = 12) {
  return fact({
    externalStoreId: "external-store",
    externalSkuId: "sku",
    externalLocationId: "location",
    available,
    reserved: 2,
    onHand: 20,
    safetyStock: 4,
    leadTimeDays: 7,
    source: { version: "v1", updatedAt: now, quality: { state: "COMPLETE" as const, issues: [] } },
  });
}
function extension() {
  return fact(
    {
      externalSkuId: "sku",
      externalLocationId: "location",
      asOf: now,
      quarantine: 3,
      inbound: 100,
      leadTimeHours: 3,
      safetyBufferHours: 1,
      eta: null,
    },
    "extension",
  );
}
function policy(): QualityPolicy {
  const fields = [["available"], ["available", "soldUnits", "salesWindowHours"], ["leadTimeHours"]];
  return {
    version: "test-policy-v1",
    precedence: ["UNAVAILABLE", "STALE", "INSUFFICIENT", "ESTIMATED", "VERIFIED"],
    rules: kinds.map((kind, index) => ({
      kind,
      requiredFields: fields[index]!,
      minimumSampleSize: 1,
      maximumAgeHours: 24,
      minimumCoverageBasisPoints: 10000,
      allowVerifiedEmptyWindow: false,
    })),
  };
}
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  return {
    ...context(),
    status: "VERIFIED",
    inventoryFacts: [stock()],
    inventoryExtensions: [extension()],
    paymentFacts: [],
    refundFacts: [],
    campaignFacts: [],
    frozenCosts: [],
    refundAllocations: [],
    returnReceipts: [],
    fees: [],
    traffic: [],
    metricCoverage: kinds.map((kind, index) => ({
      ...context(),
      kind,
      subject: { kind: "SKU", externalSkuId: "sku" },
      observedAt: now,
      sourceVersion: "v1",
      collections: domains[index]!,
      coverageBasisPoints: 10000,
    })),
    ...patch,
  };
}
function request(patch: Partial<InventoryCoverageRequest> = {}): InventoryCoverageRequest {
  return {
    input: input(),
    externalSkuId: "sku",
    externalLocationId: "location",
    salesWindow: window,
    soldUnits: {
      metric: { kind: "PAID_UNITS", unit: "units", value: 12 },
      quality: {
        status: "VERIFIED",
        sampleSize: 12,
        coverageBasisPoints: 10000,
        evidenceIds: ["sync"],
        issues: [],
      },
    },
    policy: policy(),
    ...patch,
  };
}
const calculator = createInventoryCoverageCalculator({
  math: exactMinorMath,
  clock: {
    snapshot: () => ({ now, revision: 1 }),
  },
});
function value<T>(result: MetricResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function run(req = request()) {
  return value(calculator.calculate(req));
}
it("uses explicit available and the supplied four-hour denominator", () => {
  const result = run();
  expect(result.available.metric.value).toBe(12);
  expect(result.salesUnitsPerHour).toBe(3);
  expect(result.hoursRemaining.metric.value).toBe(4);
  expect(result.daysRemaining).toBe(1 / 6);
  expect(result.belowLeadTimeWithBuffer).toBe(false);
});
it("retains independent sold-out stock with positive demand", () => {
  const result = run(request({ input: input({ inventoryFacts: [stock(0)] }) }));
  expect(result.available.metric.value).toBe(0);
  expect(result.hoursRemaining.metric.value).toBe(0);
});
it("keeps stock but cannot forecast zero demand", () => {
  const req = request();
  const result = run({
    ...req,
    soldUnits: { ...req.soldUnits, metric: { ...req.soldUnits.metric, value: 0 } },
  });
  expect(result.available.metric.value).toBe(12);
  expect(result.salesUnitsPerHour).toBe(0);
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality.status).toBe("UNAVAILABLE");
  expect(result.hoursRemaining.quality.issues).toContainEqual(
    expect.objectContaining({ code: "ZERO_DENOMINATOR" }),
  );
});
it("keeps missing lead and ETA null without inferring from legacy days", () => {
  const ext = extension();
  const result = run(
    request({
      input: input({
        inventoryExtensions: [{ ...ext, data: { ...ext.data, leadTimeHours: null } }],
      }),
    }),
  );
  expect(result.leadTimeHours.metric.value).toBeNull();
  expect(result.eta).toBeNull();
  expect(result.hoursRemaining.metric.value).toBe(4);
  expect(result.belowLeadTimeWithBuffer).toBeNull();
});
it("discloses stale source inventory", () => {
  const row = stock();
  const source = { ...row.data.source, updatedAt: "2026-10-08T00:00:00Z" };
  const result = run(
    request({ input: input({ inventoryFacts: [{ ...row, data: { ...row.data, source } }] }) }),
  );
  expect(result.available.quality.status).toBe("STALE");
  expect(result.hoursRemaining.quality.status).toBe("STALE");
});

function rejected(raw: unknown, code = "INVALID_INPUT", evidence: readonly string[] = []) {
  const result = calculator.calculate(raw as InventoryCoverageRequest);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejection");
  expect(result.error.code).toBe(code);
  expect(result.error.evidenceIds).toEqual(expect.arrayContaining([...evidence]));
}
it.each([null, {}, { ...request(), extra: true }, { ...request(), externalSkuId: " " }])(
  "rejects malformed request %#",
  (raw) => rejected(raw),
);
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
  "rejects unsafe sold units %s",
  (units) => {
    const req = request();
    rejected({
      ...req,
      soldUnits: { ...req.soldUnits, metric: { ...req.soldUnits.metric, value: units } },
    });
  },
);
it.each(["periodStart", "periodEnd"] as const)("rejects submillisecond sales %s", (key) => {
  const salesWindow = { ...window, [key]: window[key].replace("Z", ".0001Z") };
  rejected(request({ salesWindow }));
});
it("rejects upstream kind, unit, evidence and quality mismatch", () => {
  const req = request();
  rejected({
    ...req,
    soldUnits: { ...req.soldUnits, metric: { kind: "PAID_ORDERS", unit: "units", value: 12 } },
  });
  rejected({
    ...req,
    soldUnits: { ...req.soldUnits, metric: { ...req.soldUnits.metric, unit: "hours" } },
  });
  rejected({
    ...req,
    soldUnits: {
      ...req.soldUnits,
      quality: { ...req.soldUnits.quality, evidenceIds: ["invented"] },
    },
  });
  rejected({
    ...req,
    soldUnits: { ...req.soldUnits, quality: { ...req.soldUnits.quality, status: "STALE" } },
  });
});
it("rejects future sales or nonpositive and mismatched windows", () => {
  rejected(request({ salesWindow: { ...window, periodEnd: "2026-10-11T00:00:00Z" } }));
  rejected(request({ salesWindow: { ...window, periodStart: now } }));
  rejected({ ...request(), salesWindow: { ...window, timezone: "UTC" } });
  rejected({ ...request(), salesWindow: { ...window, currency: "USD" } });
});
it.each(["inventoryFacts", "inventoryExtensions"] as const)(
  "rejects duplicate selected %s with all evidence",
  (key) => {
    const req = request();
    const row = req.input[key]![0]!;
    const rows = [row, { ...row, sourceVersion: "v2", evidenceIds: ["duplicate"] }];
    rejected({ ...req, input: { ...req.input, [key]: rows } }, "CONFLICT", [
      row.evidenceIds[0]!,
      "duplicate",
    ]);
  },
);
it("rejects aligned stock counts that exceed on-hand", () => {
  const ext = extension();
  rejected(
    request({
      input: input({ inventoryExtensions: [{ ...ext, data: { ...ext.data, quarantine: 7 } }] }),
    }),
    "CONFLICT",
    ["stock", "extension"],
  );
});
it("does not combine stock counts across observation instants", () => {
  const ext = extension();
  const result = run(
    request({
      input: input({
        inventoryExtensions: [
          { ...ext, data: { ...ext.data, asOf: "2026-10-10T03:00:00Z", quarantine: 100 } },
        ],
      }),
    }),
  );
  expect(result.available.metric.value).toBe(12);
});
it("isolates exact location and SKU including their stale values", () => {
  const row = stock(0);
  const other = {
    ...row,
    data: {
      ...row.data,
      externalLocationId: "elsewhere",
      source: { ...row.data.source, updatedAt: "2026-10-01T00:00:00Z" },
    },
  };
  const result = run(request({ input: input({ inventoryFacts: [other, stock()] }) }));
  expect(result.available.metric.value).toBe(12);
  expect(result.available.quality.status).toBe("VERIFIED");
});
it.each(["inventoryFacts", "inventoryExtensions"] as const)(
  "does not fabricate absent %s",
  (key) => {
    const result = run(request({ input: input({ [key]: [] }) }));
    expect(result.hoursRemaining.metric.value).toBeNull();
    if (key === "inventoryFacts") expect(result.available.metric.value).toBeNull();
    else expect(result.available.metric.value).toBe(12);
  },
);
it("checks aligned quantities with injected math and preserves typed errors", () => {
  const math = {
    ...exactMinorMath,
    add: () => ({
      ok: false as const,
      error: { code: "OVERFLOW" as const, evidenceIds: ["math-proof"] },
    }),
  };
  const calc = createInventoryCoverageCalculator({
    math,
    clock: { snapshot: () => ({ now, revision: 1 }) },
  });
  expect(calc.calculate(request())).toEqual({
    ok: false,
    error: { code: "OVERFLOW", evidenceIds: ["math-proof"] },
  });
});
it("rejects invalid clock snapshots and future visible input", () => {
  for (const snapshot of [
    { now, revision: -1 },
    { now: now.replace("Z", ".0001Z"), revision: 1 },
    { now: "2026-10-10T03:00:00Z", revision: 1 },
  ]) {
    const calc = createInventoryCoverageCalculator({
      math: exactMinorMath,
      clock: { snapshot: () => snapshot },
    });
    expect(calc.calculate(request())).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  }
});
