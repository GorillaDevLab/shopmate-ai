import { describe, expect, it } from "vitest";
import { MockConfigSchema, DAY_MS, type MockConfig } from "./mock-config.js";
import { config } from "./mock-source-group.fixture.js";
import { createScenarioConfig } from "./mock-scenario-plans.js";
import { generateMockSource } from "./mock-source.js";
const baselineConfig = MockConfigSchema.parse({
  ...config,
  profile: "mature",
  days: 90,
  productCount: 4,
  variantsPerProduct: 1,
  dailyOrders: 100,
  refundBps: 150,
  growthBps: 0,
});
const end = new Date(Date.parse(baselineConfig.historyStart) + 85 * DAY_MS).toISOString();
const baseline = generateMockSource(baselineConfig, end);
const windowOrders = (snapshot: typeof baseline) =>
  snapshot.orders.filter(
    (o) =>
      Date.parse(o.orderedAt) >= Date.parse(baselineConfig.historyStart) + 56 * DAY_MS &&
      Date.parse(o.orderedAt) < Date.parse(baselineConfig.historyStart) + 80 * DAY_MS,
  );
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const revenue = (snapshot: typeof baseline) => sum(windowOrders(snapshot).map((o) => o.paidMinor!));
const profit = (snapshot: typeof baseline) => {
  const orders = windowOrders(snapshot),
    ids = new Set(orders.filter((o) => o.paidMinor! > 0).map((o) => o.externalOrderId));
  const costs = snapshot.economics.filter((e) => ids.has(e.externalOrderId));
  return (
    revenue(snapshot) -
    sum(orders.map((o) => o.refundedMinor!)) -
    sum(
      costs.map(
        (e) => e.costMinor! + e.fulfillmentShippingMinor + e.platformFeeMinor + e.paymentFeeMinor,
      ),
    ) -
    sum(
      snapshot.marketing
        .filter(
          (m) =>
            Number(m.externalCampaignId.split(":").at(-1)) >= 56 &&
            Number(m.externalCampaignId.split(":").at(-1)) < 80,
        )
        .map((m) => m.spendMinor!),
    )
  );
};
const target = (snapshot: typeof baseline, index = 0) =>
  windowOrders(snapshot).filter((o) => o.items[0]!.externalSkuId.includes(`:product:${index}:`));
const available = (snapshot: typeof baseline, index = 0) =>
  snapshot.inventory.find((i) => i.externalSkuId.includes(`:product:${index}:`))!.available!;
const observations: Record<string, (actual: typeof baseline, planned: MockConfig) => void> = {
  SCENARIO_001: (actual, planned) => {
    void planned;
    expect(target(actual).length).toBeLessThan(target(baseline).length);
  },
  SCENARIO_002: (actual, planned) => {
    void planned;
    expect(actual.refunds.length).toBeGreaterThan(baseline.refunds.length);
  },
  SCENARIO_003: (actual, planned) => {
    void planned;
    expect(revenue(actual)).toBeGreaterThan(revenue(baseline));
    expect(profit(actual)).toBeLessThan(profit(baseline));
    expect(sum(actual.marketing.map((m) => m.spendMinor!))).toBeGreaterThan(
      sum(baseline.marketing.map((m) => m.spendMinor!)),
    );
  },
  SCENARIO_004: (actual, planned) => {
    void planned;
    expect(sum(actual.marketing.map((m) => m.spendMinor!))).toBeGreaterThan(
      sum(baseline.marketing.map((m) => m.spendMinor!)),
    );
    expect(
      sum(actual.marketing.map((m) => m.attributedRevenueMinor!)) /
        sum(actual.marketing.map((m) => m.spendMinor!)),
    ).toBeLessThan(
      sum(baseline.marketing.map((m) => m.attributedRevenueMinor!)) /
        sum(baseline.marketing.map((m) => m.spendMinor!)),
    );
  },
  SCENARIO_005: (actual, planned) => {
    void planned;
    expect(target(actual).length).toBeLessThan(target(baseline).length);
    expect(target(actual)[0]!.items[0]!.unitPriceMinor).toBeGreaterThan(
      target(baseline)[0]!.items[0]!.unitPriceMinor,
    );
  },
  SCENARIO_006: (actual, planned) => {
    void planned;
    expect(available(actual)).toBeGreaterThan(available(baseline));
    expect(target(actual).length).toBeLessThan(target(baseline).length);
  },
  SCENARIO_007: (actual, planned) => {
    void planned;
    expect(
      actual.ledger.find(
        (e) =>
          e.kind === "RESTOCK" &&
          e.externalSkuId.includes(":product:0:") &&
          e.at === new Date(Date.parse(baselineConfig.historyStart) + 61 * DAY_MS).toISOString(),
      ),
    ).toBeDefined();
  },
  SCENARIO_008: (actual, planned) => {
    void planned;
    expect(target(actual, 1).length).toBeGreaterThan(target(baseline, 1).length);
    expect(actual.catalog[1]!.launchAt).toBe(
      new Date(Date.parse(baselineConfig.historyStart) + 56 * DAY_MS).toISOString(),
    );
  },
  SCENARIO_009: (actual, planned) => {
    void planned;
    expect(planned.scenarioPlan!.delivery.kind).toBe("INTERRUPT");
    expect(actual.orders).toEqual(baseline.orders);
  },
  SCENARIO_010: (actual, planned) => {
    void planned;
    expect(planned.scenarioPlan!.delivery.kind).toBe("REPLAY_SAVED_PAGE");
    expect(actual.orders).toEqual(baseline.orders);
  },
  SCENARIO_011: (actual, planned) => {
    void planned;
    expect(target(actual)[0]!.discountMinor).toBeGreaterThan(target(baseline)[0]!.discountMinor);
  },
  SCENARIO_012: (actual, planned) => {
    void planned;
    expect(target(actual).filter((o) => o.status === "CANCELLED").length).toBeGreaterThan(
      target(baseline).filter((o) => o.status === "CANCELLED").length,
    );
  },
  SCENARIO_013: (actual, planned) => {
    void planned;
    expect(actual.orders).toEqual(baseline.orders);
  },
  SCENARIO_014: (actual, planned) => {
    void planned;
    expect(actual.orders.length).toBeLessThan(120);
    expect(actual.catalog[0]!.product.skus[0]!.costPriceMinor).toBeNull();
    expect(actual.economics.some((row) => row.costMinor === null)).toBe(true);
  },
  SCENARIO_015: (actual, planned) => {
    void planned;
    expect(actual.refunds.length).toBeGreaterThan(baseline.refunds.length);
    expect(target(actual).length).toBeLessThan(target(baseline).length);
  },
};
describe("all fifteen scenario raw commerce facts", () => {
  it.each(Array.from({ length: 15 }, (_, i) => `SCENARIO_${String(i + 1).padStart(3, "0")}`))(
    "%s observes deterministic facts without conclusions",
    (id) => {
      const planned = createScenarioConfig(baselineConfig, id, 56, 80);
      const actual = generateMockSource(planned, end);
      expect(generateMockSource(planned, end).datasetHash).toBe(actual.datasetHash);
      expect(
        actual.inventory.every(
          (i) => i.onHand! >= i.reserved! && i.available === i.onHand! - i.reserved!,
        ),
      ).toBe(true);
      observations[id]!(actual, planned);
      if (!["SCENARIO_008", "SCENARIO_014"].includes(id)) {
        const before = (snapshot: typeof baseline) =>
          snapshot.orders.filter(
            (o) => Date.parse(o.orderedAt) < Date.parse(baselineConfig.historyStart) + 56 * DAY_MS,
          );
        expect(before(actual)).toEqual(before(baseline));
      }
      if (!["SCENARIO_003", "SCENARIO_004", "SCENARIO_014", "SCENARIO_015"].includes(id))
        expect(target(actual, 3)).toEqual(target(baseline, 3));
    },
  );
});
