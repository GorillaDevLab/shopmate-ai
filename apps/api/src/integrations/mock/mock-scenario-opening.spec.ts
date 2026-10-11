import { expect, it } from "vitest";
import { config } from "./mock-source-group.fixture.js";
import { MockConfigSchema, openingTime } from "./mock-config.js";
import { createScenarioConfig } from "./mock-scenario-plans.js";
import { generateMockSource } from "./mock-source.js";
it("keeps every new-store commerce collection empty before its fourteen-day opening", () => {
  const base = MockConfigSchema.parse({
    ...config,
    days: 30,
    productCount: 4,
    variantsPerProduct: 1,
  });
  const planned = createScenarioConfig(base, "SCENARIO_014");
  const before = new Date(openingTime(planned) - 1).toISOString();
  const snapshot = generateMockSource(planned, before);
  expect(snapshot.store).toBeNull();
  for (const key of [
    "catalog",
    "inventory",
    "orders",
    "economics",
    "refunds",
    "ledger",
    "marketing",
  ] as const)
    expect(snapshot[key]).toEqual([]);
  expect(
    generateMockSource(planned, new Date(openingTime(planned)).toISOString()).catalog,
  ).toHaveLength(4);
});
