import { MockConfigSchema } from "./mock-config.js";
export const config = MockConfigSchema.parse({
  binding: {
    organizationId: "o",
    workspaceId: "w",
    storeId: "s",
    connectionId: "c",
    externalStoreId: "m",
  },
  seed: 980,
  profile: "problematic",
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 12,
  productCount: 2,
  variantsPerProduct: 2,
  dailyOrders: 15,
  refundBps: 5000,
});
