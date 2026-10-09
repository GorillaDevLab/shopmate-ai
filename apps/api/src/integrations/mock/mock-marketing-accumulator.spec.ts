import { expect, it } from "vitest";
import { config } from "./mock-source-group.fixture.js";
import * as module from "./mock-marketing-accumulator.js";
import { DAY_MS } from "./mock-config.js";
import { generateCatalog } from "./mock-catalog.js";
import { generateTimeline } from "./mock-history.js";
import { createCausalReducer } from "./mock-causal-reducer.js";
import { replayTimeline } from "./mock-replay.js";
import { generateMarketing } from "./mock-marketing.js";
const strip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (key, entry) => (key === "version" ? null : entry)));
it("accumulates only accepted PAY and preserves offline refunded revenue and partial-day spend", () => {
  expect(module).toHaveProperty("createMarketingAccumulator");
  const until = Date.parse(config.historyStart) + 10.5 * DAY_MS;
  const timeline = generateTimeline(config, generateCatalog(config), until);
  const reducer = createCausalReducer(config);
  let marketing = module.createMarketingAccumulator(config);
  for (const [i, event] of timeline.entries()) {
    marketing.apply(event, reducer.apply(event));
    if (i % 37 === 0)
      marketing = module.createMarketingAccumulator(
        config,
        marketing.snapshot(new Date(event.at).toISOString()),
      );
  }
  const oracle = replayTimeline(config, timeline);
  const paid = [...oracle.orders.values()];
  expect(paid.some((row) => row.refundedMinor! > 0 && row.refundedMinor! < row.paidMinor!)).toBe(
    true,
  );
  expect(paid.some((row) => row.refundedMinor! > 0 && row.refundedMinor === row.paidMinor)).toBe(
    true,
  );
  const actual = marketing.snapshot(new Date(until).toISOString());
  expect(actual).toEqual(strip(generateMarketing(config, oracle, until)));
  expect(actual.at(-1)!.spendMinor).toBe(
    Math.floor((config.adSpendMinor * (1 + (2 * 10) / (config.days - 1))) / 2),
  );
});
it("rejects foreign, duplicate, unknown and noncanonical hydration and owns records", () => {
  expect(module).toHaveProperty("createMarketingAccumulator");
  const marketing = module.createMarketingAccumulator(config);
  const rows = marketing.snapshot(
    new Date(Date.parse(config.historyStart) + DAY_MS / 2).toISOString(),
  );
  expect(Object.isFrozen(rows[0]!.source)).toBe(true);
  expect(() => module.createMarketingAccumulator(config, [...rows, ...rows])).toThrow();
  expect(() =>
    module.createMarketingAccumulator(config, [{ ...rows[0], attributedOrders: null }]),
  ).toThrow();
  expect(() =>
    module.createMarketingAccumulator(config, [{ ...rows[0], externalStoreId: "foreign" }]),
  ).toThrow();
  expect(() =>
    module.createMarketingAccumulator(config, [
      { ...rows[0], source: { ...rows[0]!.source, updatedAt: "2026-01-01T00:00:00+08:00" } },
    ]),
  ).toThrow();
});
it("rejects partial quality and impossible attributed totals", () => {
  const rows = module
    .createMarketingAccumulator(config)
    .snapshot(new Date(Date.parse(config.historyStart) + DAY_MS / 2).toISOString());
  expect(() =>
    module.createMarketingAccumulator(config, [
      {
        ...rows[0],
        source: {
          ...rows[0]!.source,
          quality: { state: "PARTIAL", issues: ["MARKETING_UNKNOWN"] },
        },
      },
    ]),
  ).toThrow();
  expect(() =>
    module.createMarketingAccumulator(config, [
      { ...rows[0], attributedOrders: 1000000, clicks: 1000000, impressions: 30000000 },
    ]),
  ).toThrow();
});
it("rejects campaign hydration beyond its payment settlement boundary", () => {
  const rows = module
    .createMarketingAccumulator(config)
    .snapshot(new Date(Date.parse(config.historyStart) + DAY_MS).toISOString());
  const future = {
    ...rows[0],
    source: {
      ...rows[0]!.source,
      updatedAt: new Date(Date.parse(config.historyStart) + 2 * DAY_MS).toISOString(),
    },
  };
  expect(() => module.createMarketingAccumulator(config, [future])).toThrow();
});
it("observes at most current and closing day with exact snapshot parity", () => {
  expect(module.createMarketingAccumulator(config)).toHaveProperty("observe");
  const accumulator = module.createMarketingAccumulator(config);
  for (const offset of [DAY_MS / 2, DAY_MS, DAY_MS + 300000, 4 * DAY_MS + 1]) {
    const at = new Date(Date.parse(config.historyStart) + offset).toISOString();
    expect(accumulator.observe(at)).toEqual(
      accumulator.snapshot(at).filter((row) => row.source.updatedAt === at),
    );
    expect(accumulator.observe(at).length).toBeLessThanOrEqual(2);
  }
});
