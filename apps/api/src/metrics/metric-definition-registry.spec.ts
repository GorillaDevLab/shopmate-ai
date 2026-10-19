import { expect, it } from "vitest";
import type { MetricCalculator, MetricResult } from "@shopmate/contracts";
import { createMetricDefinitionRegistry } from "./metric-definition-registry.js";

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
