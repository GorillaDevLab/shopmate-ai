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

function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected successful metric result");
  return result.value;
}
function calculator(code: "NOT_FOUND" | "SOURCE_UNAVAILABLE"): MetricCalculator {
  return { calculate: () => ({ ok: false, error: { code, evidenceIds: [] } }) };
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
  expect(value(registry.resolve("v1")).calculator.calculate({} as never)).toEqual({
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
