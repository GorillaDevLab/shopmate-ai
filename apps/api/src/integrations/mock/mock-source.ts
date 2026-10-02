import { createHash } from "node:crypto";
import {
  ConnectorInventorySchema,
  ConnectorOrderSchema,
  ConnectorStoreSchema,
  ConnectorTimestampSchema,
  type ConnectorInventory,
} from "@shopmate/contracts";
import { generateCatalog, sourceAt, type CatalogEntry } from "./mock-catalog.js";
import {
  DAY_MS,
  GENERATOR_VERSION,
  MockConfigSchema,
  openingTime,
  type MockConfig,
} from "./mock-config.js";
import { generateTimeline } from "./mock-history.js";
import { generateMarketing } from "./mock-marketing.js";
import { replayTimeline } from "./mock-replay.js";
import type { MockSnapshot, ReplayState } from "./mock-types.js";

function inventoryRows(
  config: MockConfig,
  catalog: readonly CatalogEntry[],
  state: ReplayState,
): ConnectorInventory[] {
  return catalog.flatMap((entry) =>
    entry.product.skus.map((sku) => {
      const balance = state.balances.get(sku.externalSkuId)!;
      return ConnectorInventorySchema.parse({
        externalStoreId: config.binding.externalStoreId,
        externalSkuId: sku.externalSkuId,
        externalLocationId: `${config.binding.externalStoreId}:warehouse:0`,
        source: sourceAt(balance.updatedAt),
        onHand: balance.onHand,
        reserved: balance.reserved,
        available: balance.onHand - balance.reserved,
        safetyStock: entry.safetyStock,
        leadTimeDays: entry.leadTimeDays,
      });
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Offline fixture construction only; this never replaces a running adapter's mutable source state. */
export function generateMockSource(input: unknown, asOf: unknown): MockSnapshot {
  const config = MockConfigSchema.parse(input);
  const observedAt = ConnectorTimestampSchema.parse(
    new Date(ConnectorTimestampSchema.parse(asOf)).toISOString(),
  );
  const until = Math.min(
    Date.parse(observedAt),
    Date.parse(config.historyStart) + config.days * DAY_MS,
  );
  const opened = until >= openingTime(config);
  const catalog = opened ? generateCatalog(config) : [];
  const state = replayTimeline(
    config,
    opened ? generateTimeline(config, catalog, Date.parse(observedAt)) : [],
  );
  const store = opened ? storeRow(config) : null;
  const payload = {
    generatorVersion: GENERATOR_VERSION,
    binding: config.binding,
    observedAt,
    historyUntil: new Date(until).toISOString(),
    store,
    catalog,
    orders: Array.from(state.orders.values(), (order) => ConnectorOrderSchema.parse(order)),
    economics: Array.from(state.economics.values()),
    refunds: state.refunds,
    inventory: inventoryRows(config, catalog, state),
    ledger: state.ledger,
    marketing: generateMarketing(config, state, until),
  };
  const datasetHash = createHash("sha256")
    .update(JSON.stringify({ config, payload }))
    .digest("hex");
  return deepFreeze({ ...payload, datasetHash });
}

function storeRow(config: MockConfig) {
  return ConnectorStoreSchema.parse({
    externalStoreId: config.binding.externalStoreId,
    source: sourceAt(new Date(openingTime(config)).toISOString()),
    name: `演示店铺 ${config.profile}`,
    category: "3C配件",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  });
}
