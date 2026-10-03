import { describe, expect, it } from "vitest";
import { MockConfigSchema, DAY_MS } from "./mock-config.js";
import { dailyDemand } from "./mock-history.js";
import { generateMockSource } from "./mock-source.js";

const base = {
  binding: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "mock-a",
  },
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 180,
  productCount: 60,
  variantsPerProduct: 3,
  seed: 42,
};
const end = "2026-06-29T16:00:00Z";

describe("approved mock profiles", () => {
  it("has growing demand and exact weekly mature-store seasonality", () => {
    const growing = MockConfigSchema.parse({ ...base, profile: "growing" });
    const mature = MockConfigSchema.parse({ ...base, profile: "mature" });
    expect(dailyDemand(growing, 175)).toBeGreaterThan(dailyDemand(growing, 0) * 3);
    for (let day = 0; day < 170; day += 1)
      expect(dailyDemand(mature, day)).toBe(dailyDemand(mature, day + 7));
  });

  it("advertising budget affects demand through a bounded conversion model", () => {
    const organic = MockConfigSchema.parse({ ...base, profile: "mature", adSpendMinor: 0 });
    const advertised = MockConfigSchema.parse({
      ...base,
      profile: "mature",
      adSpendMinor: 100_000,
    });
    expect(dailyDemand(advertised, 100)).toBeGreaterThan(dailyDemand(organic, 100));
    expect(dailyDemand(advertised, 100)).toBeLessThanOrEqual(
      Math.ceil(advertised.dailyOrders * 1.35),
    );
  });

  it("problematic profile increases discounts and advertising costs", () => {
    const source = generateMockSource({ ...base, profile: "problematic" }, end);
    const start = Date.parse(base.historyStart);
    const ratios = (from: number, to: number) => {
      const orders = source.orders.filter(
        (order) =>
          order.paidMinor! > 0 &&
          Date.parse(order.orderedAt) >= start + from * DAY_MS &&
          Date.parse(order.orderedAt) < start + to * DAY_MS,
      );
      return (
        orders.reduce((sum, order) => sum + order.discountMinor / order.grossMinor, 0) /
        orders.length
      );
    };
    expect(ratios(150, 175)).toBeGreaterThan(ratios(0, 25) * 2);
    expect(source.marketing[170]!.spendMinor!).toBeGreaterThan(
      source.marketing[0]!.spendMinor! * 2,
    );
    expect(source.orders.length).toBeGreaterThan(10_000);
  }, 20_000);

  it.each(["growing", "mature", "new"])(
    "generates bounded 180-day %s source",
    (profile) => {
      const source = generateMockSource({ ...base, profile }, end);
      expect(source.catalog).toHaveLength(60);
      expect(source.inventory).toHaveLength(180);
      expect(source.orders.length).toBeLessThan(60_000);
      expect(source.historyUntil).toBe("2026-06-29T16:00:00.000Z");
      expect(source.marketing).toHaveLength(profile === "new" ? 14 : 180);
      if (profile === "growing") expect(source.inventory[0]!.available).toBe(0);
    },
    20_000,
  );
});
