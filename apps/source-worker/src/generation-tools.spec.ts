import { expect, it } from "vitest";
import { generationTools } from "./generation-tools.js";

const config = {
  binding: {
    organizationId: "o",
    workspaceId: "w",
    storeId: "s",
    connectionId: "c",
    externalStoreId: "m",
  },
  profile: "mature",
  seed: 42,
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 12,
  productCount: 2,
  variantsPerProduct: 2,
  dailyOrders: 15,
};
it("hydrates sparse old orders even when they have no event in the first resumed day", () => {
  const keys = generationTools.hydrationKeys(config, "2026-01-05T16:00:00.000Z");
  expect(keys).toContainEqual(["ORDER", "m:order:1:0"]);
  expect(keys).not.toContainEqual(["ORDER", "m:order:6:0"]);
  expect(keys.filter((key) => key[0] === "INVENTORY")).toHaveLength(4);
  expect(keys.filter((key) => key[0] === "MARKETING")).toContainEqual([
    "MARKETING",
    "m:campaign:5",
    "2026-01-06",
  ]);
});
it("replays the entire opening timestamp without allocating database source versions", () => {
  const generator = generationTools.create(
    { ...config, productCount: 100, variantsPerProduct: 3 },
    { ORDER: [], INVENTORY: [], MARKETING: [] },
    "2025-12-31T16:00:00.000Z",
  );
  const groups = [...generator.window("2025-12-31T15:59:59.999Z", "2025-12-31T16:00:00.000Z")];
  expect(groups).toHaveLength(1);
  expect(groups[0]!.events).toHaveLength(401);
  expect(groups[0]!.events.every((event) => event.after.source.version === null)).toBe(true);
});
