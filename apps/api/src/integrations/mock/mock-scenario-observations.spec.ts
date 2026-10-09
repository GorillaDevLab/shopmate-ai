import { describe, expect, it } from "vitest";
import { config } from "./mock-source-group.fixture.js";
import { createScenarioPlan } from "./mock-scenario-plans.js";
import { generateTimelineWindow } from "./mock-history.js";
import { DAY_MS } from "./mock-config.js";
const at = (day: number) => new Date(Date.parse(config.historyStart) + day * DAY_MS).toISOString();
const candidates = (input: unknown, day = 4) =>
  generateTimelineWindow(input, at(day), at(day + 1))
    .filter((e) => e.kind === "RESERVE")
    .map((e) => e.candidate!);
describe("causal scenario observations", () => {
  it("changes targeted prices and demand, preserves independent SKU candidates", () => {
    const altered = { ...config, scenarioPlan: createScenarioPlan(config, "SCENARIO_005", 3, 9) };
    const baseline = candidates(config),
      actual = candidates(altered);
    expect(actual.length).toBeLessThan(baseline.length);
    expect(
      actual
        .filter((c) => c.sku.externalSkuId.endsWith(":product:0:sku:0"))
        .every(
          (c) =>
            c.sku.salePriceMinor >
            baseline.find((b) => b.sku.externalSkuId === c.sku.externalSkuId)!.sku.salePriceMinor,
        ),
    ).toBe(true);
    expect(actual.filter((c) => !c.sku.externalSkuId.endsWith(":product:0:sku:0"))).toEqual(
      baseline.filter((c) => !c.sku.externalSkuId.endsWith(":product:0:sku:0")),
    );
    expect(candidates(altered, 1)).toEqual(candidates(config, 1));
  });
  it.each(["SCENARIO_002", "SCENARIO_011", "SCENARIO_012"])(
    "%s changes only causal candidate inputs",
    (id) => {
      const baseline = candidates(config);
      const actual = candidates({ ...config, scenarioPlan: createScenarioPlan(config, id, 3, 9) });
      expect(actual).not.toEqual(baseline);
      expect(actual.filter((c) => !c.sku.externalSkuId.endsWith(":product:0:sku:0"))).toEqual(
        baseline.filter((c) => !c.sku.externalSkuId.endsWith(":product:0:sku:0")),
      );
    },
  );
});
import { createSourceGroupGenerator } from "./mock-source-groups.js";
it("publishes price edges and restarts across an earlier order price", () => {
  const planned = { ...config, scenarioPlan: createScenarioPlan(config, "SCENARIO_005", 3, 9) };
  let generator = createSourceGroupGenerator(planned);
  let after = new Date(Date.parse(config.historyStart) - 1).toISOString();
  const products = [];
  for (let day = 0; day < 11; day++) {
    const until = day === 0 ? at(0) : at(day);
    const groups = [...generator.window(after, until)];
    products.push(...groups.flatMap((g) => g.events).filter((e) => e.kind === "PRODUCT"));
    generator = createSourceGroupGenerator(planned, generator.snapshot());
    after = until;
  }
  expect(products.some((p) => p.occurredAt === at(3))).toBe(true);
  expect(products.some((p) => p.occurredAt === at(9))).toBe(true);
});
