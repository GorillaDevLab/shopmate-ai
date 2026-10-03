import { vi } from "vitest";
import { type DemoCommerceRepository } from "../../src/demo-commerce/demo-commerce.repository.js";
import { GENERATOR_VERSION, MockConfigSchema } from "../../src/integrations/mock/mock-config.js";
import { createHash } from "node:crypto";
export const actor = { userId: "user-a", merchantId: "merchant-a" };
export const access = {
  ...actor,
  organizationId: "org-a",
  workspaceId: "ws-a",
  storeId: "store-a",
  role: "OWNER" as const,
};
export const command = {
  settings: {
    profile: "mature",
    seed: 42,
    historyStart: "2026-01-01T00:00:00+08:00",
    days: 14,
    dailyOrders: 6,
  },
  observedAt: "2026-01-14T00:00:00Z",
};
export function record() {
  const config = MockConfigSchema.parse({
    ...command.settings,
    binding: {
      organizationId: access.organizationId,
      workspaceId: access.workspaceId,
      storeId: access.storeId,
      connectionId: "conn-a",
      externalStoreId: "mock:store-a",
    },
  });
  return {
    ...access,
    id: "session-a",
    connectionId: "conn-a",
    externalStoreId: "mock:store-a",
    config,
    configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    generatorVersion: GENERATOR_VERSION,
    clockNow: new Date(command.observedAt),
    clockRevision: 0,
    revision: 0,
    generation: 0,
    status: "ACTIVE" as const,
    environmentMarker: "DEMO" as const,
    demoTenant: true as const,
  };
}
export function repository(): DemoCommerceRepository {
  const written = { status: "WRITTEN" as const, record: record() };
  return {
    findDemoStore: vi.fn(async () => access),
    findDemoSession: vi.fn(async () => record()),
    createDemoSession: vi.fn(async () => written),
    advanceDemoSession: vi.fn(async () => written),
    resetDemoSession: vi.fn(async () => written),
    disconnectDemoSession: vi.fn(async () => written),
  };
}
