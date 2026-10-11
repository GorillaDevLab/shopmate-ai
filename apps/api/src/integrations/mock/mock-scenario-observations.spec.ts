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
  it("keeps baseline discounts when a scenario only changes refunds", () => {
    const baseline = new Map(candidates(config).map((candidate) => [candidate.id, candidate]));
    const altered = { ...config, scenarioPlan: createScenarioPlan(config, "SCENARIO_002", 3, 9) };
    const targeted = candidates(altered).filter((c) =>
      c.sku.externalSkuId.endsWith(":product:0:sku:0"),
    );
    expect(targeted.length).toBeGreaterThan(0);
    for (const candidate of targeted)
      expect(candidate.discountBps).toBe(baseline.get(candidate.id)!.discountBps);
  });
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
import { createScenarioConfig } from "./mock-scenario-plans.js";
it.each(Array.from({ length: 15 }, (_, i) => `SCENARIO_${String(i + 1).padStart(3, "0")}`))(
  "%s reproduces bounded timestamp groups after every daily restart",
  (id) => {
    const planned = createScenarioConfig(config, id, 3, 9);
    const continuous = createSourceGroupGenerator(planned);
    let restarted = createSourceGroupGenerator(planned);
    let after = new Date(Date.parse(planned.historyStart) - 1).toISOString();
    for (let day = 0; day <= planned.days + 5; day++) {
      const until = at(day);
      expect([...restarted.window(after, until)]).toEqual([...continuous.window(after, until)]);
      expect(restarted.snapshot()).toEqual(continuous.snapshot());
      restarted = createSourceGroupGenerator(planned, restarted.snapshot());
      after = until;
    }
    if (id === "SCENARIO_014") {
      const opening = [
        ...createSourceGroupGenerator(planned).window(
          new Date(Date.parse(planned.historyStart) - 1).toISOString(),
          planned.historyStart,
        ),
      ];
      const product = opening
        .flatMap((group) => group.events)
        .find((event) => event.kind === "PRODUCT");
      expect(product?.kind === "PRODUCT" && product.after.skus[0]?.costPriceMinor).toBeNull();
      expect(product?.after.source.quality.issues).toContain("COST_MISSING");
    }
  },
);
