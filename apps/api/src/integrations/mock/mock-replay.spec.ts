import { expect, it } from "vitest";
import * as replay from "./mock-replay.js";
import { MockConfigSchema } from "./mock-config.js";
import { generateCatalog } from "./mock-catalog.js";
import { generateTimeline } from "./mock-history.js";
import type { ReplayState } from "./mock-types.js";

it("exposes the same single transition used by offline replay", () => {
  expect(replay).toHaveProperty("applyTimelineEvent");
  const config = MockConfigSchema.parse({
    binding: {
      organizationId: "o",
      workspaceId: "w",
      storeId: "s",
      connectionId: "c",
      externalStoreId: "m",
    },
    seed: 1,
    profile: "mature",
    historyStart: "2026-01-01T00:00:00+08:00",
    days: 1,
    productCount: 1,
  });
  const timeline = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + 6 * 86400000,
  );
  const state: ReplayState = {
    orders: new Map(),
    economics: new Map(),
    balances: new Map(),
    refunds: [],
    ledger: [],
  };
  for (const event of timeline) replay.applyTimelineEvent(config, state, event);
  expect(state).toEqual(replay.replayTimeline(config, timeline));
});

it("shares the existing timeline comparator including same-time kind and key ordering", async () => {
  const history = await import("./mock-history.js");
  expect(history).toHaveProperty("compareTimelineEvents");
  const left = { at: 0, kind: "RESTOCK" as const, skuId: "a", stock: 0 };
  expect(history.compareTimelineEvents(left, { ...left, skuId: "b" })).toBeLessThan(0);
  expect(history.compareTimelineEvents(left, { ...left, at: 1 })).toBeLessThan(0);
});
