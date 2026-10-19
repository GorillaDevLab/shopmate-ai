import { expect, it } from "vitest";
import {
  MetricInputV1Schema,
  type MetricCalculator,
  type MetricInputV1,
  type MetricResult,
} from "@shopmate/contracts";
import { createMetricDefinitionRegistry } from "./metric-definition-registry.js";
import { createMetricEvidenceHasher } from "./metric-evidence-hash.js";

const binding = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  storeId: "store-1",
  connectionId: "connection-1",
  externalStoreId: "external-1",
};
const hasher = createMetricEvidenceHasher(
  createMetricDefinitionRegistry([
    { definitionVersion: "v1", calculator: calculator("NOT_FOUND") },
    { definitionVersion: "v2", calculator: calculator("SOURCE_UNAVAILABLE") },
  ]),
);
function input(patch: Partial<MetricInputV1> = {}): MetricInputV1 {
  return {
    schemaVersion: 1,
    definitionVersion: "v1",
    inputRevision: "revision-1",
    binding,
    periodStart: "2026-10-01T00:00:00Z",
    periodEnd: "2026-10-02T00:00:00Z",
    timezone: "Asia/Shanghai",
    currency: "CNY",
    visibleAt: "2026-10-03T00:00:00Z",
    sourceWatermark: "2026-10-02T00:00:00Z",
    evidenceIds: ["source-a", "source-b"],
    status: "VERIFIED",
    paymentFacts: [],
    refundFacts: [],
    inventoryFacts: [],
    campaignFacts: [],
    frozenCosts: [],
    refundAllocations: [],
    returnReceipts: [],
    fees: [],
    traffic: [],
    inventoryExtensions: [],
    metricCoverage: [],
    ...patch,
  };
}
function create(data: MetricInputV1 = input()) {
  return hasher.create({ input: data, kind: "GMV", subject: { kind: "STORE" } });
}
function inventory() {
  return {
    binding,
    observedAt: "2026-10-02T00:00:00Z",
    sourceVersion: "source-v1",
    evidenceIds: ["inventory-a"],
    data: {
      externalStoreId: binding.externalStoreId,
      externalSkuId: "sku-a",
      externalLocationId: "location-a",
      available: 4,
      reserved: 1,
      onHand: 5,
      safetyStock: 0,
      leadTimeDays: 1,
      source: {
        version: "provider-v1",
        updatedAt: "2026-10-01T08:00:00+08:00",
        quality: { state: "COMPLETE" as const, issues: [] },
      },
    },
  };
}
function extension() {
  return {
    binding,
    observedAt: "2026-10-02T00:00:00Z",
    sourceVersion: "extension-v1",
    evidenceIds: ["extension-a"],
    data: {
      externalSkuId: "sku-a",
      externalLocationId: "location-a",
      asOf: "2026-10-01T00:00:00Z",
      quarantine: 0,
      inbound: 2,
      leadTimeHours: 24.5,
      safetyBufferHours: 1.25,
      eta: "2026-10-03T00:00:00Z",
    },
  };
}
function proofInput(): MetricInputV1 {
  const base = input();
  return {
    ...base,
    inventoryFacts: [inventory()],
    inventoryExtensions: [extension()],
    metricCoverage: [
      {
        schemaVersion: 1,
        definitionVersion: base.definitionVersion,
        inputRevision: base.inputRevision,
        binding,
        periodStart: base.periodStart,
        periodEnd: base.periodEnd,
        timezone: base.timezone,
        currency: base.currency,
        visibleAt: base.visibleAt,
        sourceWatermark: base.sourceWatermark,
        evidenceIds: ["source-a"],
        observedAt: base.visibleAt,
        sourceVersion: "coverage-v1",
        kind: "GMV",
        subject: { kind: "STORE" },
        collections: ["inventoryFacts", "inventoryExtensions"],
        coverageBasisPoints: 10000,
      },
    ],
  };
}
function payment() {
  const item = (id: string) => ({
    externalLineId: id,
    externalProductId: "product-a",
    externalSkuId: "sku-a",
    quantity: 1,
    unitPriceMinor: 10,
    grossMinor: 10,
    discountMinor: 0,
    netMinor: 10,
  });
  return {
    ...inventory(),
    evidenceIds: ["payment-a"],
    data: {
      externalStoreId: binding.externalStoreId,
      externalOrderId: "order-a",
      source: inventory().data.source,
      status: "PAID" as const,
      orderedAt: "2026-10-01T00:00:00Z",
      paidAt: "2026-10-01T01:00:00Z",
      currency: "CNY" as const,
      items: [item("line-a"), item("line-b")],
      grossMinor: 20,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: 20,
      paidMinor: 20,
      refundedMinor: 0,
    },
  };
}
function campaign() {
  const provenance = { ...inventory(), evidenceIds: ["campaign-a", "campaign-b"] };
  return {
    ...provenance,
    data: {
      externalStoreId: binding.externalStoreId,
      source: inventory().data.source,
      externalCampaignId: "campaign-1",
      date: "2026-10-01",
      impressions: 10,
      clicks: 3,
      attributedOrders: 1,
      spendMinor: 5,
      attributedRevenueMinor: 20,
      currency: "CNY" as const,
    },
    measuredCoverage: {
      binding,
      observedAt: provenance.observedAt,
      sourceVersion: "measured-v1",
      evidenceIds: ["campaign-a"],
      periodStart: "2026-10-01T00:00:00Z",
      periodEnd: "2026-10-01T12:00:00Z",
      timezone: "Asia/Shanghai" as const,
      currency: "CNY" as const,
      coverageBasisPoints: 5000,
    },
  };
}

it.each([null, {}, { resolve: 1 }])("rejects malformed registry construction %#", (registry) => {
  expect(() => createMetricEvidenceHasher(registry as never)).toThrow(TypeError);
});

it.each([
  null,
  {},
  { input: input(), kind: "UNKNOWN", subject: { kind: "STORE" } },
  { input: input(), kind: "GMV", subject: { kind: "STORE", email: "private@example.invalid" } },
  { input: input(), kind: "GMV", subject: { kind: "STORE" }, metadata: true },
])("strictly rejects malformed evidence request %#", (request) => {
  expect(hasher.create(request as never)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it.each([
  { ...input(), buyer: "private@example.invalid" },
  { ...input(), inputRevision: " revision" },
  {
    ...input(),
    inventoryFacts: [{ ...inventory(), data: { ...inventory().data, phone: "private" } }],
  },
  {
    ...input(),
    inventoryFacts: [
      { ...inventory(), data: { ...inventory().data, available: Number.MAX_SAFE_INTEGER + 1 } },
    ],
  },
  {
    ...input(),
    inventoryExtensions: [
      { ...extension(), data: { ...extension().data, leadTimeHours: Infinity } },
    ],
  },
  {
    ...input(),
    inventoryExtensions: [{ ...extension(), data: { ...extension().data, leadTimeHours: NaN } }],
  },
  { ...input(), traffic: undefined },
  { ...input(), fees: [undefined] },
  { ...input(), sourceWatermark: null },
  { ...input(), evidenceIds: ["source-a", "source-a"] },
])("rejects complete malformed input including irrelevant collections %#", (data) => {
  const result = create(data as never);
  expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
  expect(JSON.stringify(result)).not.toContain("private");
});

it.each(["visibleAt", "periodStart", "periodEnd", "sourceWatermark"] as const)(
  "rejects lost submillisecond input precision in %s",
  (key) => {
    const data = input({ [key]: input()[key]!.replace("Z", ".0001Z") });
    expect(create(data)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", evidenceIds: [] },
    });
  },
);

it.each(["observedAt", "updatedAt", "asOf", "eta"])(
  "rejects lost nested timestamp precision in %s",
  (key) => {
    const fact = extension();
    const stock = inventory();
    const data =
      key === "observedAt"
        ? input({ inventoryFacts: [{ ...stock, observedAt: "2026-10-02T00:00:00.0001Z" }] })
        : key === "updatedAt"
          ? input({
              inventoryFacts: [
                {
                  ...stock,
                  data: {
                    ...stock.data,
                    source: { ...stock.data.source, updatedAt: "2026-10-01T08:00:00.0001+08:00" },
                  },
                },
              ],
            })
          : input({
              inventoryExtensions: [
                { ...fact, data: { ...fact.data, [key]: "2026-10-01T00:00:00.0001Z" } },
              ],
            });
    expect(create(data)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  },
);

it("normalizes known timestamp instants while preserving timestamp-shaped IDs", () => {
  const stock = inventory();
  const original = value(create(input({ inventoryFacts: [stock] })));
  const same = {
    ...stock,
    observedAt: "2026-10-02T00:00:00.000000Z",
    data: {
      ...stock.data,
      source: { ...stock.data.source, updatedAt: "2026-10-01T00:00:00.000Z" },
    },
  };
  expect(value(create(input({ inventoryFacts: [same] })))).toEqual(original);
  const first = value(create(input({ inputRevision: "2026-10-01T00:00:00Z" })));
  const second = value(create(input({ inputRevision: "2026-10-01T00:00:00.000Z" })));
  expect(first.inputHash).not.toBe(second.inputHash);
});

it("hashes distinct evidence union and fact multiplicity without deduping facts", () => {
  const data = proofInput();
  expect(MetricInputV1Schema.safeParse(data).success).toBe(true);
  const single = value(create(data));
  expect(single.evidenceIds).toHaveLength(4);
  const duplicate = value(create({ ...data, inventoryFacts: [inventory(), inventory()] }));
  expect(duplicate.inputHash).not.toBe(single.inputHash);
  expect(duplicate.evidenceIds).toHaveLength(4);
});

it("preserves null collections and real fractional numeric facts", () => {
  expect(value(create(input({ inventoryFacts: null }))).inputHash).not.toBe(
    value(create()).inputHash,
  );
  const fact = extension();
  const first = value(create(input({ inventoryExtensions: [fact] })));
  const second = value(
    create(
      input({ inventoryExtensions: [{ ...fact, data: { ...fact.data, leadTimeHours: 24.75 } }] }),
    ),
  );
  expect(first.inputHash).not.toBe(second.inputHash);
});

function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected successful metric result");
  return result.value;
}
function calculator(code: "NOT_FOUND" | "SOURCE_UNAVAILABLE"): MetricCalculator {
  return { calculate: () => ({ ok: false, error: { code, evidenceIds: [] } }) };
}
function calculationRequest(): Parameters<MetricCalculator["calculate"]>[0] {
  return { input: input(), kind: "GMV", subject: { kind: "STORE" }, computedAt: input().visibleAt };
}

it("resolves only the requested immutable definition after newer versions exist", () => {
  const old = calculator("NOT_FOUND"),
    newer = calculator("SOURCE_UNAVAILABLE");
  const registry = createMetricDefinitionRegistry([
    { definitionVersion: "v1", calculator: old },
    { definitionVersion: "v2", calculator: newer },
  ]);
  expect(value(registry.resolve("v1")).calculator.calculate).toBeTypeOf("function");
  expect(value(registry.resolve("v1")).definitionVersion).toBe("v1");
  expect(value(registry.resolve("v1")).calculator.calculate(calculationRequest())).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(value(registry.resolve("v2")).calculator.calculate(calculationRequest())).toMatchObject({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE" },
  });
  expect(registry.resolve("latest")).toEqual({
    ok: false,
    error: { code: "VERSION_MISMATCH", evidenceIds: [] },
  });
  expect(Object.isFrozen(registry)).toBe(true);
  expect(Object.isFrozen(value(registry.resolve("v1")))).toBe(true);
});

it("snapshots caller configuration without freezing it", () => {
  const original = { ...calculator("NOT_FOUND") };
  const entry = { definitionVersion: "v1", calculator: original };
  const definitions = [entry];
  const registry = createMetricDefinitionRegistry(definitions);
  entry.definitionVersion = "v2";
  entry.calculator = calculator("SOURCE_UNAVAILABLE");
  original.calculate = calculator("SOURCE_UNAVAILABLE").calculate;
  definitions.length = 0;
  expect(value(registry.resolve("v1")).calculator.calculate(calculationRequest())).toEqual({
    ok: false,
    error: { code: "NOT_FOUND", evidenceIds: [] },
  });
  expect(registry.resolve("v2")).toMatchObject({ ok: false });
  expect(Object.isFrozen(entry)).toBe(false);
  expect(Object.isFrozen(original)).toBe(false);
  expect(Object.isFrozen(value(registry.resolve("v1")).calculator)).toBe(true);
});

it.each(["", " v1", "v1\n", 7, null, undefined])("rejects malformed version %s", (version) => {
  const registry = createMetricDefinitionRegistry([]);
  expect(registry.resolve(version as string)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it.each([
  null,
  {},
  [null],
  [{ definitionVersion: "", calculator: calculator("NOT_FOUND") }],
  [{ definitionVersion: "v1", calculator: {} }],
  [{ definitionVersion: "v1", calculator: { calculate: 1 } }],
  [{ definitionVersion: "v1", calculator: calculator("NOT_FOUND"), extra: true }],
  ["v1", "v1"].map((definitionVersion) => ({
    definitionVersion,
    calculator: calculator("NOT_FOUND"),
  })),
])("rejects invalid server construction configuration %#", (definitions) => {
  expect(() => createMetricDefinitionRegistry(definitions as never)).toThrow(TypeError);
});

it("creates stable scoped evidence from strict synthetic normalized input", () => {
  expect(MetricInputV1Schema.safeParse(input()).success).toBe(true);
  const descriptor = value(create());
  expect(descriptor.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(descriptor.evidenceIds).toHaveLength(2);
  expect(descriptor.evidenceIds.every((id) => /^metric-evidence-v1:[a-f0-9]{64}$/.test(id))).toBe(
    true,
  );
  expect(descriptor).toMatchObject({
    schemaVersion: 1,
    hashVersion: "metric-input-sha256-v1",
    definitionVersion: "v1",
    inputRevision: "revision-1",
    binding,
    kind: "GMV",
    subject: { kind: "STORE" },
  });
  expect(JSON.stringify(descriptor)).not.toContain("source-a");
  expect(descriptor.window.periodStart).toBe("2026-10-01T00:00:00.000Z");
});

it("canonicalizes object keys and unordered evidence without changing multiplicity", () => {
  const reordered = Object.fromEntries(
    Object.entries(input()).reverse(),
  ) as unknown as MetricInputV1;
  expect(value(create({ ...reordered, evidenceIds: ["source-b", "source-a"] }))).toEqual(
    value(create()),
  );
  expect(value(create(input({ inputRevision: "revision-2" }))).inputHash).not.toBe(
    value(create()).inputHash,
  );
});

it.each(Object.keys(binding) as (keyof typeof binding)[])(
  "binds proof identity to scope component %s",
  (key) => {
    const first = value(create());
    const changed = value(create(input({ binding: { ...binding, [key]: "other" } })));
    expect(changed.inputHash).not.toBe(first.inputHash);
    expect(changed.evidenceIds.some((id) => first.evidenceIds.includes(id))).toBe(false);
  },
);

it("rejects unknown definition versions without an implicit upgrade", () => {
  expect(create(input({ definitionVersion: "v3" }))).toEqual({
    ok: false,
    error: { code: "VERSION_MISMATCH", evidenceIds: [] },
  });
  expect(value(create(input({ definitionVersion: "v1" })))).toMatchObject({
    definitionVersion: "v1",
  });
});

it("replays the registered historical definition with set-order independent proof IDs", () => {
  const descriptor = value(create());
  expect(value(hasher.verify({ descriptor, input: input() }))).toEqual(descriptor);
  const reordered = { ...descriptor, evidenceIds: [...descriptor.evidenceIds].reverse() };
  expect(value(hasher.verify({ descriptor: reordered, input: input() }))).toEqual(descriptor);
  expect(value(hasher.verify({ descriptor, input: input() })).definitionVersion).toBe("v1");
});

it.each(Object.keys(binding) as (keyof typeof binding)[])(
  "rejects foreign %s before returning foreign evidence",
  (key) => {
    const foreign = value(create(input({ binding: { ...binding, [key]: "foreign" } })));
    const result = hasher.verify({ descriptor: foreign, input: input() });
    expect(result).toEqual({ ok: false, error: { code: "SCOPE_MISMATCH", evidenceIds: [] } });
    expect(JSON.stringify(result)).not.toContain(foreign.evidenceIds[0]);
  },
);

it.each(["v2", "unknown"])(
  "rejects changed definition %s without upgrading replay",
  (definitionVersion) => {
    const descriptor = { ...value(create()), definitionVersion };
    expect(hasher.verify({ descriptor, input: input() })).toEqual({
      ok: false,
      error: { code: "VERSION_MISMATCH", evidenceIds: [] },
    });
  },
);

it.each(["periodStart", "periodEnd"] as const)("rejects changed descriptor window %s", (key) => {
  const original = value(create());
  const descriptor = {
    ...original,
    window: { ...original.window, [key]: original.window[key].replace("00:00:00", "01:00:00") },
  };
  expect(hasher.verify({ descriptor, input: input() })).toEqual({
    ok: false,
    error: { code: "WINDOW_MISMATCH", evidenceIds: [] },
  });
});

it.each([
  { inputRevision: "changed" },
  { visibleAt: "2026-10-04T00:00:00Z" },
  { sourceWatermark: null },
  { inputHash: `sha256:${"0".repeat(64)}` },
  { kind: "PAID_REVENUE" },
  { subject: { kind: "SKU", externalSkuId: "sku-other" } },
  { evidenceIds: [`metric-evidence-v1:${"0".repeat(64)}`] },
])("rejects tampered complete descriptor context %#", (patch) => {
  const descriptor = { ...value(create()), ...patch };
  expect(hasher.verify({ descriptor, input: input() } as never)).toEqual({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: [] },
  });
});

it.each(["missing", "extra", "foreign"])(
  "rejects %s evidence membership despite the same inputHash",
  (mode) => {
    const original = value(create());
    const foreign = value(create(input({ inputRevision: "foreign" }))).evidenceIds[0]!;
    const evidenceIds =
      mode === "missing"
        ? original.evidenceIds.slice(1)
        : mode === "extra"
          ? [...original.evidenceIds, foreign]
          : [foreign, original.evidenceIds[1]!];
    expect(hasher.verify({ descriptor: { ...original, evidenceIds }, input: input() })).toEqual({
      ok: false,
      error: { code: "CONFLICT", evidenceIds: [] },
    });
  },
);

it.each([
  null,
  { schemaVersion: 2 },
  { hashVersion: "metric-input-sha256-v2" },
  { inputHash: `sha256:${"A".repeat(64)}` },
  { evidenceIds: ["source-a"] },
  { evidenceIds: [] },
  { evidenceIds: [`metric-evidence-v1:${"0".repeat(64)}`, `metric-evidence-v1:${"0".repeat(64)}`] },
  { rawFacts: "private@example.invalid" },
  { visibleAt: "2026-10-03T00:00:00.0001Z" },
])("strictly rejects malformed descriptors %#", (patch) => {
  const descriptor = patch === null ? null : { ...value(create()), ...patch };
  expect(hasher.verify({ descriptor, input: input() } as never)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it.each([
  null,
  {},
  { descriptor: value(create()), input: input(), extra: true },
  { descriptor: value(create()), input: { ...input(), email: "private" } },
])("strictly validates complete verification request %#", (request) => {
  expect(hasher.verify(request as never)).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", evidenceIds: [] },
  });
});

it("detects changed facts even with an unchanged revision and source evidence", () => {
  const data = proofInput();
  const descriptor = value(create(data));
  const stock = inventory();
  const changed = {
    ...data,
    inventoryFacts: [{ ...stock, data: { ...stock.data, available: 3 } }],
  };
  expect(hasher.verify({ descriptor, input: changed })).toEqual({
    ok: false,
    error: { code: "CONFLICT", evidenceIds: [] },
  });
});

it("returns independent deep frozen copies without freezing or retaining caller input", () => {
  const data = input({ binding: { ...binding } });
  const descriptor = value(create(data));
  expect(Object.isFrozen(data)).toBe(false);
  expect(Object.isFrozen(data.binding)).toBe(false);
  expect(descriptor.binding).not.toBe(data.binding);
  expect(Object.isFrozen(descriptor.binding)).toBe(true);
  expect(Object.isFrozen(descriptor.window)).toBe(true);
  expect(Object.isFrozen(descriptor.subject)).toBe(true);
  expect(Object.isFrozen(descriptor.evidenceIds)).toBe(true);
  Object.assign(data.binding, { storeId: "changed" });
  expect(descriptor.binding.storeId).toBe(binding.storeId);
  expect(value(create()).inputHash).toBe(descriptor.inputHash);
  expect(value(create())).not.toBe(descriptor);
});

it("matches the literal SHA256 golden for the explicitly versioned canonical input", () => {
  expect(value(create()).inputHash).toBe(
    "sha256:a6b1b71b1bc60d6f392e21bc7f4b46f763e7e801596df834a20e0118f41de8ca",
  );
});

it.each([
  { definitionVersion: "v2" },
  { inputRevision: "revision-2" },
  { status: "ESTIMATED" },
  { visibleAt: "2026-10-04T00:00:00Z" },
  { sourceWatermark: "2026-10-01T00:00:00Z" },
  { evidenceIds: ["source-c", "source-b"] },
  { periodStart: "2026-10-01T01:00:00Z" },
])("hashes every logical input context change %#", (patch) => {
  expect(value(create(input(patch as Partial<MetricInputV1>))).inputHash).not.toBe(
    value(create()).inputHash,
  );
});

it.each([
  { kind: "PAID_REVENUE", subject: { kind: "STORE" } },
  { kind: "GMV", subject: { kind: "SKU", externalSkuId: "sku-a" } },
  { kind: "GMV", subject: { kind: "CAMPAIGN", externalCampaignId: "campaign-a" } },
] as const)("hashes metric kind and subject %#", (context) => {
  const changed = value(hasher.create({ input: input(), ...context }));
  expect(changed.inputHash).not.toBe(value(create()).inputHash);
  expect(changed.evidenceIds.some((id) => value(create()).evidenceIds.includes(id))).toBe(false);
});

it("ignores fact, item, issue, coverage and collection ordering", () => {
  const fact = payment();
  const stock = inventory();
  const issues = ["INVENTORY_STALE", "SOURCE_TIME_MISSING"] as const;
  const source = { ...stock.data.source, quality: { state: "PARTIAL" as const, issues } };
  const stocks = [
    { ...stock, data: { ...stock.data, source } },
    { ...stock, sourceVersion: "v2" },
  ];
  const coverage = proofInput().metricCoverage[0]!;
  const data = input({
    paymentFacts: [fact],
    inventoryFacts: stocks,
    metricCoverage: [coverage, { ...coverage, coverageBasisPoints: 5000 }],
  });
  const reordered = {
    ...data,
    paymentFacts: [{ ...fact, data: { ...fact.data, items: [...fact.data.items].reverse() } }],
    inventoryFacts: [
      { ...stock, sourceVersion: "v2" },
      {
        ...stock,
        data: {
          ...stock.data,
          source: { ...source, quality: { ...source.quality, issues: [...issues].reverse() } },
        },
      },
    ],
    metricCoverage: data.metricCoverage
      .map((proof) => ({ ...proof, collections: [...proof.collections].reverse() }))
      .reverse(),
  };
  expect(value(create(reordered))).toEqual(value(create(data)));
  expect(value(hasher.verify({ descriptor: value(create(data)), input: reordered }))).toEqual(
    value(create(data)),
  );
});

it.each([
  "sourceVersion",
  "providerVersion",
  "coverage",
  "status",
  "amount",
  "sourceEvidence",
  "quality",
])("hashes factual %s changes", (field) => {
  const stock = inventory();
  const data = proofInput();
  const changed =
    field === "sourceVersion"
      ? { ...stock, sourceVersion: "new" }
      : field === "sourceEvidence"
        ? { ...stock, evidenceIds: ["inventory-new"] }
        : field === "providerVersion"
          ? {
              ...stock,
              data: { ...stock.data, source: { ...stock.data.source, version: "provider-v2" } },
            }
          : field === "quality"
            ? {
                ...stock,
                data: {
                  ...stock.data,
                  source: {
                    ...stock.data.source,
                    quality: { state: "PARTIAL" as const, issues: ["INVENTORY_STALE" as const] },
                  },
                },
              }
            : { ...stock, data: { ...stock.data, available: 3 } };
  const modified =
    field === "coverage"
      ? {
          ...data,
          metricCoverage: data.metricCoverage.map((proof) => ({
            ...proof,
            coverageBasisPoints: 5000,
          })),
        }
      : field === "status"
        ? { ...data, status: "ESTIMATED" as const }
        : { ...data, inventoryFacts: [changed] };
  expect(value(create(modified)).inputHash).not.toBe(value(create(data)).inputHash);
});

it("includes measured coverage and source evidence in the whole logical identity", () => {
  const fact = campaign();
  const first = value(create(input({ campaignFacts: [fact] })));
  expect(first.evidenceIds).toHaveLength(4);
  const changed = {
    ...fact,
    measuredCoverage: { ...fact.measuredCoverage, coverageBasisPoints: 10000 },
  };
  expect(value(create(input({ campaignFacts: [changed] }))).inputHash).not.toBe(first.inputHash);
  const reordered = { ...fact, evidenceIds: [...fact.evidenceIds].reverse() };
  expect(value(create(input({ campaignFacts: [reordered] })))).toEqual(first);
});

it("distinguishes null and zero while normalizing negative zero", () => {
  const fact = extension();
  const withValue = (quarantine: number | null) =>
    input({ inventoryExtensions: [{ ...fact, data: { ...fact.data, quarantine } }] });
  expect(value(create(withValue(null))).inputHash).not.toBe(value(create(withValue(0))).inputHash);
  expect(value(create(withValue(-0)))).toEqual(value(create(withValue(0))));
});

it.each(["inputRevision", "evidenceIds", "externalSkuId", "sourceVersion"])(
  "preserves timestamp-shaped %s as identifiers",
  (key) => {
    const data = (id: string) =>
      key === "inputRevision"
        ? input({ inputRevision: id })
        : key === "evidenceIds"
          ? input({ evidenceIds: [id] })
          : key === "sourceVersion"
            ? input({ inventoryFacts: [{ ...inventory(), sourceVersion: id }] })
            : input({
                inventoryFacts: [
                  { ...inventory(), data: { ...inventory().data, externalSkuId: id } },
                ],
              });
    expect(value(create(data("2026-10-01T00:00:00Z"))).inputHash).not.toBe(
      value(create(data("2026-10-01T00:00:00.000Z"))).inputHash,
    );
  },
);

it("uses JSON escaping to keep delimiter-like and Unicode identifiers distinct", () => {
  const first = value(create(input({ inputRevision: 'a:"b\\c', evidenceIds: ["雪:d"] })));
  const second = value(create(input({ inputRevision: 'a:"b', evidenceIds: ["c\\雪:d"] })));
  expect(first.inputHash).not.toBe(second.inputHash);
});
