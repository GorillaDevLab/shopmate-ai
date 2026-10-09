import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { frozenConfiguration } from "../src/mock-platform/configuration.ts";
const binding = {
  organizationId: "o",
  workspaceId: "w",
  storeId: "s",
  connectionId: "c",
  externalStoreId: "m",
};
const scope = { ...binding, sessionId: "session", generation: 0 };
const config = {
  binding,
  seed: 42,
  profile: "mature",
  historyStart: "2026-01-01T16:00:00.000Z",
  days: 14,
  productCount: 2,
  variantsPerProduct: 2,
  dailyOrders: 20,
  growthBps: 0,
  refundBps: 150,
  adSpendMinor: 10000,
};
const scenarioPlan = {
  version: "mock-scenario-v1",
  scenarioId: "SCENARIO_009",
  externalStoreId: "m",
  startDay: 3,
  endDay: 9,
  mutations: [],
  campaignSpendBps: 10000,
  campaignConversionBps: 10000,
  delivery: { kind: "INTERRUPT", durationMs: 3600000 },
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
test("v1 is unchanged and v2 requires a legitimate owned scenario plan", () => {
  const old = frozenConfiguration(config, hash(config), "mock-source-v1", scope);
  const planned = { ...config, scenarioPlan };
  assert.deepEqual(frozenConfiguration(planned, hash(planned), "mock-source-v2", scope), old);
  assert.throws(() => frozenConfiguration(planned, hash(planned), "mock-source-v1", scope));
  assert.throws(() => frozenConfiguration(config, hash(config), "mock-source-v2", scope));
  for (const plan of [
    { ...scenarioPlan, extra: 1 },
    { ...scenarioPlan, externalStoreId: "foreign" },
    { ...scenarioPlan, endDay: 100 },
    { ...scenarioPlan, delivery: { kind: "INTERRUPT", durationMs: 0 } },
  ]) {
    const bad = { ...config, scenarioPlan: plan };
    assert.throws(() => frozenConfiguration(bad, hash(bad), "mock-source-v2", scope));
  }
});
test("jsonb reordered v2 data hashes in schema order", () => {
  const planned = { ...config, scenarioPlan };
  const reordered = Object.fromEntries(Object.entries(planned).reverse());
  reordered.scenarioPlan = Object.fromEntries(Object.entries(scenarioPlan).reverse());
  assert.deepEqual(
    frozenConfiguration(reordered, hash(planned), "mock-source-v2", scope),
    frozenConfiguration(config, hash(config), "mock-source-v1", scope),
  );
});
