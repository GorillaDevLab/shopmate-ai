import { expect, it } from "vitest";
import { config } from "./mock-source-group.fixture.js";
import { DAY_MS, MockConfigSchema } from "./mock-config.js";
import { createScenarioConfig } from "./mock-scenario-plans.js";
import { generateTimeline } from "./mock-history.js";
import { generateCatalog } from "./mock-catalog.js";
import { createSourceGroupGenerator } from "./mock-source-groups.js";
import { seededInteger } from "./mock-random.js";
const base = MockConfigSchema.parse({
  ...config,
  profile: "mature",
  days: 30,
  productCount: 4,
  variantsPerProduct: 1,
  dailyOrders: 40,
});
const at = (day: number) => new Date(Date.parse(base.historyStart) + day * DAY_MS).toISOString();
function combinedLaunch() {
  const planned = createScenarioConfig(base, "SCENARIO_008", 3, 9);
  const target = {
    ...planned.scenarioPlan!.mutations[0]!,
    priceBps: 15000,
    refundBps: 10000,
    cancelBps: 5000,
  };
  return MockConfigSchema.parse({
    ...planned,
    scenarioPlan: {
      ...planned.scenarioPlan,
      mutations: [
        target,
        {
          ...target,
          skuIndex: 0,
          priceBps: 20000,
          refundBps: 0,
          cancelBps: 10000,
          launchRampDays: 0,
        },
      ],
    },
  });
}
it("applies launch target interventions before producing its full lifecycle", () => {
  const planned = combinedLaunch();
  const events = generateTimeline(planned, generateCatalog(planned), Date.parse(at(14)));
  const baseline = new Map(
    generateTimeline(base, generateCatalog(base), Date.parse(at(14)))
      .filter((event) => event.kind === "RESERVE")
      .map((event) => [event.candidate!.id, event.candidate!]),
  );
  const redirected = events.filter(
    (event) =>
      event.kind === "RESERVE" &&
      event.candidate!.sku.externalSkuId.includes(":product:1:") &&
      baseline.get(event.candidate!.id)!.sku.externalSkuId.includes(":product:0:"),
  );
  expect(redirected.length).toBeGreaterThan(0);
  const targetPrice = generateCatalog(base)[1]!.product.skus[0]!.salePriceMinor!;
  expect(redirected.some((event) => !event.candidate!.cancel)).toBe(true);
  for (const event of redirected) {
    const candidate = event.candidate!;
    expect(candidate.sku.salePriceMinor).toBe(Math.floor(targetPrice * 1.5));
    expect(candidate.refund).toBe(true);
    expect(candidate.cancel).toBe(
      seededInteger(planned.seed, ["scenario", candidate.id, "cancel"], 10000) < 5000,
    );
    const lifecycle = events.filter((entry) => entry.candidate?.id === candidate.id);
    expect(lifecycle.every((entry) => entry.candidate === candidate)).toBe(true);
    expect(lifecycle.map((entry) => entry.kind)).toContain(candidate.cancel ? "CANCEL" : "REFUND");
  }
});
it("restarts combined launch and pricing without a frozen catalog mismatch", () => {
  const combined = combinedLaunch();
  const planned = MockConfigSchema.parse({
      ...combined,
      scenarioPlan: {
        ...combined.scenarioPlan,
        mutations: combined.scenarioPlan!.mutations.slice(0, 1),
      },
    }),
    continuous = createSourceGroupGenerator(planned);
  let restarted = createSourceGroupGenerator(planned),
    after = new Date(Date.parse(base.historyStart) - 1).toISOString();
  for (let day = 0; day <= 14; day++) {
    expect([...restarted.window(after, at(day))]).toEqual([...continuous.window(after, at(day))]);
    expect(restarted.snapshot()).toEqual(continuous.snapshot());
    restarted = createSourceGroupGenerator(planned, restarted.snapshot());
    after = at(day);
  }
});
