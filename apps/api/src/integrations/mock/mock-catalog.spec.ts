import { ConnectorProductSchema } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";
import { generateCatalog } from "./mock-catalog.js";
import { MockConfigSchema, profileDefaults } from "./mock-config.js";

export const sourceConfig = {
  binding: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "mock-a",
  },
  seed: 42,
  profile: "growing",
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 180,
  productCount: 60,
  variantsPerProduct: 3,
} as const;

describe("mock configuration and catalog", () => {
  it("generates the approved catalog scale with valid connector DTOs", () => {
    const config = MockConfigSchema.parse(sourceConfig);
    const catalog = generateCatalog(config);
    expect(catalog).toHaveLength(60);
    expect(catalog.flatMap((item) => item.product.skus)).toHaveLength(180);
    for (const item of catalog) {
      expect(ConnectorProductSchema.safeParse(item.product).success).toBe(true);
      expect(item.product.externalStoreId).toBe("mock-a");
      expect(item.weightGrams).toBeGreaterThan(0);
    }
  });

  it("uses reproducible independent catalog streams", () => {
    const first = generateCatalog(MockConfigSchema.parse(sourceConfig));
    expect(generateCatalog(MockConfigSchema.parse(sourceConfig))).toEqual(first);
    expect(generateCatalog(MockConfigSchema.parse({ ...sourceConfig, seed: 43 }))).not.toEqual(
      first,
    );
    const larger = generateCatalog(
      MockConfigSchema.parse({ ...sourceConfig, productCount: 70, dailyOrders: 200 }),
    );
    expect(larger.slice(0, 60)).toEqual(first);
  });

  it("keeps unknown new-store costs null and flagged", () => {
    const catalog = generateCatalog(MockConfigSchema.parse({ ...sourceConfig, profile: "new" }));
    expect(catalog[0]!.product.skus[0]!.costPriceMinor).toBeNull();
    expect(catalog[0]!.product.source.quality.issues).toContain("COST_MISSING");
    expect(catalog[0]!.launchAt).toBe("2026-06-15T16:00:00.000Z");
  });

  it("contains all four explicit profiles", () => {
    expect(Object.keys(profileDefaults)).toEqual(["growing", "problematic", "mature", "new"]);
    expect(profileDefaults.new.dailyOrders).toBeLessThanOrEqual(10);
  });

  it.each([
    { seed: -1 },
    { seed: 0.5 },
    { days: 366 },
    { days: 0 },
    { productCount: 101 },
    { variantsPerProduct: 4 },
    { dailyOrders: 301 },
    { profile: "unknown" },
    { historyStart: "2026-01-01T00:00:00Z" },
    { historyStart: "2026-02-30T00:00:00+08:00" },
    { secret: "should-not-enter-source" },
    { binding: { ...sourceConfig.binding, organizationId: "" } },
  ])("rejects invalid config %j", (change) => {
    expect(MockConfigSchema.safeParse({ ...sourceConfig, ...change }).success).toBe(false);
  });
});
