import { describe, expect, it } from "vitest";
import { generateCatalog } from "./mock-catalog.js";
import { DAY_MS, MockConfigSchema } from "./mock-config.js";
import { generateTimeline, generateTimelineWindow } from "./mock-history.js";

const input = {
  binding: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "mock-a",
  },
  seed: 980,
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 21,
  productCount: 2,
  variantsPerProduct: 2,
  dailyOrders: 20,
};
const iso = (time: number) => new Date(time).toISOString();

describe("bounded causal timeline windows", () => {
  for (const profile of ["growing", "problematic", "mature", "new"] as const) {
    it(`reproduces the full ${profile} timeline across daily windows and settlement tails`, () => {
      const config = MockConfigSchema.parse({ ...input, profile });
      const start = Date.parse(config.historyStart) - 1;
      const until = start + (config.days + 6) * DAY_MS;
      const actual = [];
      for (let after = start; after < until; after += DAY_MS) {
        actual.push(...generateTimelineWindow(config, iso(after), iso(after + DAY_MS)));
      }
      expect(actual).toEqual(generateTimeline(config, generateCatalog(config), until));
    });
  }

  it("includes the upper boundary once and excludes the prior acknowledgement boundary", () => {
    const config = MockConfigSchema.parse({
      ...input,
      profile: "mature",
      days: 2,
      dailyOrders: 300,
    });
    const opening = Date.parse(config.historyStart);
    const first = generateTimelineWindow(config, iso(opening - 1), iso(opening));
    const second = generateTimelineWindow(config, iso(opening), iso(opening + 1000));
    expect(first.some((event) => event.kind === "RESTOCK")).toBe(true);
    expect(first.every((event) => event.at === opening)).toBe(true);
    expect(second.every((event) => event.at > opening)).toBe(true);
    expect([...first, ...second]).toEqual(
      generateTimeline(config, generateCatalog(config), opening + 1000),
    );
  });

  it("rejects malformed, reversed and oversized windows before generating events", () => {
    const config = { ...input, profile: "mature" };
    const start = Date.parse(input.historyStart);
    for (const [after, until] of [
      ["invalid", iso(start)],
      [iso(start), iso(start - 1)],
      [iso(start), iso(start + DAY_MS + 1)],
      [iso(start), iso(start)],
    ])
      expect(() => generateTimelineWindow(config, after, until)).toThrow();
  });
});
