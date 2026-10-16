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

type Rule = QualityPolicy["rules"][number];
function ruled(kind: (typeof kinds)[number], patch: Partial<Rule>): QualityPolicy {
  const base = policy();
  return {
    ...base,
    rules: base.rules.map((rule) => (rule.kind === kind ? { ...rule, ...patch } : rule)),
  };
}
function sales(
  units: number | null,
  patch: Partial<InventoryCoverageRequest["soldUnits"]["quality"]> = {},
) {
  const base = request().soldUnits;
  return { metric: { ...base.metric, value: units }, quality: { ...base.quality, ...patch } };
}
function sourceIssue(
  code: "INVENTORY_UNKNOWN" | "INVENTORY_STALE" | "SOURCE_INCONSISTENT" | "SOURCE_TIME_MISSING",
) {
  const row = stock();
  return {
    ...row,
    data: {
      ...row.data,
      source: { ...row.data.source, quality: { state: "PARTIAL" as const, issues: [code] } },
    },
  };
}
function issue(code: "LOW_SAMPLE" | "STALE_SOURCE" | "PAYMENT_UNKNOWN") {
  return { code, field: "soldUnits", evidenceIds: ["sync"] };
}
function withoutCollection(key: "inventoryFacts" | "paymentFacts" | "inventoryExtensions") {
  const base = input({ [key]: null });
  return {
    ...base,
    metricCoverage: base.metricCoverage.filter(
      (proof) => !proof.collections.includes(key as never),
    ),
  };
}
it("retains observed sales rate but withholds low sample cover", () => {
  const result = run(
    request({
      soldUnits: sales(12, { sampleSize: 2 }),
      policy: ruled("INVENTORY_HOURS_REMAINING", { minimumSampleSize: 3 }),
    }),
  );
  expect(result.salesUnitsPerHour).toBe(3);
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality.status).toBe("INSUFFICIENT");
  expect(result.hoursRemaining.quality.issues).toContainEqual(
    expect.objectContaining({ code: "LOW_SAMPLE" }),
  );
  expect(result.available.quality.status).toBe("VERIFIED");
});
it("uses sales sample size rather than stock snapshot count", () => {
  const result = run(
    request({ policy: ruled("INVENTORY_HOURS_REMAINING", { minimumSampleSize: 12 }) }),
  );
  expect(result.hoursRemaining.metric.value).toBe(4);
  expect(result.hoursRemaining.quality.sampleSize).toBe(12);
});
it.each(kinds)("enforces per-output minimum sample for %s", (kind) => {
  const result = run(request({ policy: ruled(kind, { minimumSampleSize: 13 }) }));
  const measures = {
    INVENTORY_AVAILABLE: result.available,
    INVENTORY_HOURS_REMAINING: result.hoursRemaining,
    LEAD_TIME_HOURS: result.leadTimeHours,
  };
  expect(measures[kind].quality.status).toBe("INSUFFICIENT");
  if (kind === "INVENTORY_HOURS_REMAINING") expect(measures[kind].metric.value).toBeNull();
});
it("retains stale plus low sample reasons while withholding cover", () => {
  const result = run(
    request({
      input: input({ inventoryFacts: [sourceIssue("INVENTORY_STALE")] }),
      policy: ruled("INVENTORY_HOURS_REMAINING", { minimumSampleSize: 13 }),
    }),
  );
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality.status).toBe("STALE");
  expect(result.hoursRemaining.quality.issues.map((row) => row.code)).toEqual(
    expect.arrayContaining(["STALE_SOURCE", "LOW_SAMPLE"]),
  );
});
it.each(["inventoryFacts", "paymentFacts", "inventoryExtensions"] as const)(
  "respects null required domain %s",
  (key) => {
    const result = run(request({ input: withoutCollection(key) }));
    expect(result.hoursRemaining.metric.value).toBeNull();
    expect(result.hoursRemaining.quality).toMatchObject({
      status: "UNAVAILABLE",
      sampleSize: 0,
      coverageBasisPoints: 0,
    });
    expect(result.hoursRemaining.quality.issues).toContainEqual(
      expect.objectContaining({ code: "NOT_SYNCHRONIZED", field: key }),
    );
    if (key !== "inventoryFacts") expect(result.available.metric.value).toBe(12);
  },
);
it("retains every matching proof including a low proof behind a complete one", () => {
  const base = input();
  const proof = base.metricCoverage[1]!;
  const metricCoverage = [
    ...base.metricCoverage,
    { ...proof, coverageBasisPoints: 4000, evidenceIds: ["extension"] },
  ];
  const result = run(request({ input: { ...base, metricCoverage } }));
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality).toMatchObject({
    status: "INSUFFICIENT",
    coverageBasisPoints: 4000,
  });
  expect(result.hoursRemaining.quality.evidenceIds).toContain("extension");
});
it("cannot hide incomplete source domains behind a complete proof", () => {
  const base = input();
  const proof = base.metricCoverage[1]!;
  const result = run(
    request({
      input: {
        ...base,
        metricCoverage: [...base.metricCoverage, { ...proof, collections: ["paymentFacts"] }],
      },
    }),
  );
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality.coverageBasisPoints).toBe(0);
});
it.each(["STORE", "OTHER_SKU", "OTHER_KIND"])(
  "ignores unrelated %s completeness proofs",
  (variant) => {
    const base = input();
    const metricCoverage = base.metricCoverage.map((proof) =>
      variant === "STORE"
        ? { ...proof, subject: { kind: "STORE" as const } }
        : variant === "OTHER_SKU"
          ? { ...proof, subject: { kind: "SKU" as const, externalSkuId: "other" } }
          : { ...proof, kind: "GMV" as const },
    );
    const result = run(request({ input: { ...base, metricCoverage } }));
    expect(result.available.quality.coverageBasisPoints).toBe(0);
    expect(result.hoursRemaining.metric.value).toBeNull();
  },
);
it("accepts coverage equality and retains partial coverage disclosure", () => {
  const base = input();
  const metricCoverage = base.metricCoverage.map((proof) =>
    proof.kind === "INVENTORY_HOURS_REMAINING" ? { ...proof, coverageBasisPoints: 7000 } : proof,
  );
  const result = run(
    request({
      input: { ...base, metricCoverage },
      policy: ruled("INVENTORY_HOURS_REMAINING", { minimumCoverageBasisPoints: 7000 }),
    }),
  );
  expect(result.hoursRemaining.metric.value).toBe(4);
  expect(result.hoursRemaining.quality.status).toBe("ESTIMATED");
});
it("takes upstream coverage and issues into forecast quality", () => {
  const result = run(
    request({
      soldUnits: sales(12, {
        status: "INSUFFICIENT",
        coverageBasisPoints: 5000,
        issues: [issue("LOW_SAMPLE")],
      }),
    }),
  );
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality.coverageBasisPoints).toBe(5000);
  expect(result.hoursRemaining.quality.issues).toContainEqual(issue("LOW_SAMPLE"));
});
it("keeps unknown upstream sales null without erasing stock", () => {
  const result = run(
    request({
      soldUnits: sales(null, { status: "UNAVAILABLE", issues: [issue("PAYMENT_UNKNOWN")] }),
    }),
  );
  expect(result.salesUnitsPerHour).toBeNull();
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.hoursRemaining.quality.status).toBe("UNAVAILABLE");
  expect(result.available.metric.value).toBe(12);
});
it("retains numeric cover for stale known sales", () => {
  const result = run(
    request({ soldUnits: sales(12, { status: "STALE", issues: [issue("STALE_SOURCE")] }) }),
  );
  expect(result.hoursRemaining.metric.value).toBe(4);
  expect(result.hoursRemaining.quality.status).toBe("STALE");
});
it.each([
  "available",
  "onHand",
  "reserved",
  "quarantine",
  "asOf",
  "soldUnits",
  "salesWindowHours",
  "leadTimeHours",
  "safetyBufferHours",
  "eta",
])("supports declared logical dependency %s", (field) => {
  const result = run(
    request({ policy: ruled("INVENTORY_AVAILABLE", { requiredFields: [field] }) }),
  );
  expect(result.available.metric.value).toBe(field === "eta" ? null : 12);
  if (field === "eta")
    expect(result.available.quality.issues).toContainEqual(
      expect.objectContaining({ code: "LEAD_TIME_MISSING", field: "inventoryExtensions.eta" }),
    );
});
it("does not erase explicit available for independent missing on-hand", () => {
  const row = sourceIssue("INVENTORY_UNKNOWN");
  const data = { ...row.data, onHand: null };
  const base = input({ inventoryFacts: [{ ...row, data }] });
  const result = run(request({ input: base }));
  expect(result.available.metric.value).toBe(12);
  expect(result.available.quality.status).toBe("INSUFFICIENT");
  const required = run(
    request({
      input: base,
      policy: ruled("INVENTORY_AVAILABLE", { requiredFields: ["available", "onHand"] }),
    }),
  );
  expect(required.available.metric.value).toBeNull();
});
it("invalidates inconsistent stock values while preserving independent lead", () => {
  const result = run(
    request({ input: input({ inventoryFacts: [sourceIssue("SOURCE_INCONSISTENT")] }) }),
  );
  expect(result.available.metric.value).toBeNull();
  expect(result.hoursRemaining.metric.value).toBeNull();
  expect(result.leadTimeHours.metric.value).toBe(3);
});
it("does not use newer observedAt to mask source freshness or clock time to age replay", () => {
  const row = stock();
  const old = {
    ...row,
    data: { ...row.data, source: { ...row.data.source, updatedAt: "2026-10-09T04:00:00Z" } },
  };
  const req = request({ input: input({ inventoryFacts: [old] }) });
  const calc = createInventoryCoverageCalculator({
    math: exactMinorMath,
    clock: { snapshot: () => ({ now: "2027-10-10T04:00:00Z", revision: 500 }) },
  });
  expect(value(calc.calculate(req)).available.quality.status).toBe("VERIFIED");
  const strict = { ...req, policy: ruled("INVENTORY_AVAILABLE", { maximumAgeHours: 23.99 }) };
  expect(value(calc.calculate(strict)).available.quality.status).toBe("STALE");
});
it("includes extension and watermark freshness in forecast independently", () => {
  const ext = extension();
  const base = input({
    inventoryExtensions: [{ ...ext, data: { ...ext.data, asOf: "2026-10-09T03:00:00Z" } }],
  });
  const result = run(request({ input: base }));
  expect(result.hoursRemaining.quality.status).toBe("STALE");
  expect(result.available.quality.status).toBe("VERIFIED");
  expect(result.leadTimeHours.quality.status).toBe("STALE");
});
it.each([
  "version",
  "precedence",
  "duplicate",
  "missing",
  "field",
  "sample",
  "age",
  "coverage",
  "flag",
])("rejects malformed policy %s", (variant) => {
  const base = policy();
  const changes = {
    version: { ...base, version: "" },
    precedence: { ...base, precedence: [...base.precedence].reverse() },
    duplicate: { ...base, rules: [...base.rules, base.rules[0]!] },
    missing: { ...base, rules: base.rules.slice(1) },
    field: ruled("INVENTORY_AVAILABLE", { requiredFields: ["invented"] }),
    sample: ruled("INVENTORY_AVAILABLE", { minimumSampleSize: -1 }),
    age: ruled("INVENTORY_AVAILABLE", { maximumAgeHours: Infinity }),
    coverage: ruled("INVENTORY_AVAILABLE", { minimumCoverageBasisPoints: 10001 }),
    flag: {
      ...base,
      rules: [{ ...base.rules[0]!, allowVerifiedEmptyWindow: "yes" }, ...base.rules.slice(1)],
    },
  };
  rejected({ ...request(), policy: changes[variant as keyof typeof changes] });
});
it("preserves representable global unsynchronized state", () => {
  const base = input();
  const unsynced = {
    ...base,
    status: "UNAVAILABLE" as const,
    sourceWatermark: null,
    metricCoverage: [],
    inventoryFacts: null,
    paymentFacts: null,
    inventoryExtensions: null,
    refundFacts: null,
    campaignFacts: null,
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    traffic: null,
  };
  const result = run(
    request({
      input: unsynced,
      soldUnits: sales(null, { status: "UNAVAILABLE", issues: [issue("PAYMENT_UNKNOWN")] }),
    }),
  );
  expect(result.available.quality.status).toBe("UNAVAILABLE");
  expect(result.hoursRemaining.quality.status).toBe("UNAVAILABLE");
  expect(result.leadTimeHours.quality.status).toBe("UNAVAILABLE");
});
