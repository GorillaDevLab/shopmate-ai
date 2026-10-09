import { describe, expect, it } from "vitest";
import * as reducerModule from "./mock-causal-reducer.js";
import { MockConfigSchema, DAY_MS } from "./mock-config.js";
import { generateCatalog } from "./mock-catalog.js";
import { generateTimeline, type TimelineEvent } from "./mock-history.js";
import { replayTimeline } from "./mock-replay.js";

const input = {
  binding: {
    organizationId: "o",
    workspaceId: "w",
    storeId: "s",
    connectionId: "c",
    externalStoreId: "m",
  },
  seed: 980,
  historyStart: "2026-01-01T00:00:00+08:00",
  days: 12,
  productCount: 2,
  variantsPerProduct: 2,
  dailyOrders: 15,
};
const configFor = (profile: "growing" | "problematic" | "mature" | "new") =>
  MockConfigSchema.parse({ ...input, profile });
const stripVersion = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (key, entry) => (key === "version" ? null : entry)));

for (const profile of ["growing", "problematic", "mature", "new"] as const) {
  it(`matches ${profile} offline effects through restarted bounded state`, () => {
    expect(reducerModule).toHaveProperty("createCausalReducer");
    const config = configFor(profile);
    const timeline = generateTimeline(
      config,
      generateCatalog(config),
      Date.parse(config.historyStart) + 18 * DAY_MS,
    );
    let reducer = reducerModule.createCausalReducer(config);
    const effects = [];
    const orderEffects = new Map();
    const inventoryEffects = new Map();
    const refunds = [];
    for (const [index, event] of timeline.entries()) {
      const mutations = reducer.apply(event);
      for (const mutation of mutations) {
        effects.push(mutation);
        if (mutation.kind === "ORDER")
          orderEffects.set(mutation.after.externalOrderId, mutation.after);
        if (mutation.kind === "INVENTORY")
          inventoryEffects.set(mutation.after.externalSkuId, mutation.after);
        if (mutation.kind === "REFUND") refunds.push(mutation.after);
      }
      if (index % 37 === 0) reducer = reducerModule.createCausalReducer(config, reducer.snapshot());
    }
    const oracle = replayTimeline(config, timeline);
    expect([...orderEffects.values()]).toEqual(stripVersion([...oracle.orders.values()]));
    expect(refunds).toEqual(stripVersion(oracle.refunds));
    for (const row of inventoryEffects.values()) {
      expect(row.onHand).toBe(oracle.balances.get(row.externalSkuId)!.onHand);
      expect(row.available).toBe(row.onHand - row.reserved);
    }
    const continuous = reducerModule.createCausalReducer(config);
    expect(timeline.flatMap((event) => continuous.apply(event))).toEqual(effects);
    expect(continuous.snapshot()).toEqual(reducer.snapshot());
  });
}

describe("causal validation and ownership", () => {
  const config = configFor("mature");
  const start = Date.parse(config.historyStart);
  const timeline = generateTimeline(config, generateCatalog(config), start + 18 * DAY_MS);
  const generated = timeline.find((event) => event.kind === "RESERVE")!;
  const reserve: TimelineEvent = {
    ...generated,
    candidate: { ...generated.candidate!, cancel: false, refund: true, returnGoods: true },
  };
  const opening = timeline.filter((event) => event.kind === "RESTOCK" && event.at === start);
  it("keeps orphan lost demand absent and rejects unknown inventory", () => {
    const reducer = reducerModule.createCausalReducer(config);
    expect(reducer.apply(reserve)).toEqual([]);
    expect(reducer.apply({ ...reserve, kind: "PAY", at: reserve.at + 300000 })).toEqual([]);
    expect(() =>
      reducer.apply({ kind: "RESTOCK", at: reserve.at + 2, skuId: "foreign", stock: 1 }),
    ).toThrow();
    expect(reducer.snapshot().orders).toEqual([]);
    expect(reducer.snapshot().inventory).toEqual([]);
  });
  it("owns hydrated and returned rows and rejects reversed events atomically", () => {
    const reducer = reducerModule.createCausalReducer(config);
    opening.forEach((event) => reducer.apply(event));
    const effects = reducer.apply(reserve);
    const snapshot = reducer.snapshot();
    const restarted = reducerModule.createCausalReducer(config, snapshot);
    expect(Object.isFrozen(effects[0]!.after)).toBe(true);
    expect(() => reducer.apply(opening[0]!)).toThrow();
    expect(reducer.snapshot()).toEqual(snapshot);
    expect(restarted.snapshot()).toEqual(snapshot);
    expect(effects.every((effect) => effect.after.source.version === null)).toBe(true);
    expect(() =>
      reducerModule.createCausalReducer(config, {
        ...snapshot,
        orders: [...snapshot.orders, ...snapshot.orders],
      }),
    ).toThrow();
  });
  it("retains orders at the five day return boundary and prunes strictly later", () => {
    const reducer = reducerModule.createCausalReducer(config);
    opening.forEach((event) => reducer.apply(event));
    reducer.apply(reserve);
    reducer.apply({ ...reserve, kind: "PAY", at: reserve.at + 300000 });
    reducer.apply({ ...reserve, kind: "SHIP", at: reserve.at + DAY_MS });
    reducer.apply({
      ...reserve,
      kind: "REFUND",
      at: reserve.at + 3 * DAY_MS,
      candidate: { ...reserve.candidate!, partialRefund: false },
    });
    const returned = reducer.apply({
      ...reserve,
      kind: "RETURN",
      at: reserve.at + 5 * DAY_MS,
      candidate: { ...reserve.candidate!, partialRefund: false },
    });
    expect(returned.map((row) => row.kind)).toEqual(["ORDER", "INVENTORY"]);
    expect(reducer.snapshot().orders).toHaveLength(1);
    reducer.apply({ ...opening[0]!, at: reserve.at + 5 * DAY_MS + 1 });
    expect(reducer.snapshot().orders).toHaveLength(0);
  });
  it("updates partial return source without inventory and rejects invalid causal payment", () => {
    const reducer = reducerModule.createCausalReducer(config);
    opening.forEach((event) => reducer.apply(event));
    reducer.apply(reserve);
    const before = reducer.snapshot();
    expect(() => reducer.apply({ ...reserve, kind: "SHIP", at: reserve.at + DAY_MS })).toThrow();
    expect(reducer.snapshot()).toEqual(before);
    reducer.apply({ ...reserve, kind: "PAY", at: reserve.at + 300000 });
    reducer.apply({ ...reserve, kind: "SHIP", at: reserve.at + DAY_MS });
    reducer.apply({
      ...reserve,
      kind: "REFUND",
      at: reserve.at + 3 * DAY_MS,
      candidate: { ...reserve.candidate!, partialRefund: true },
    });
    expect(
      reducer
        .apply({
          ...reserve,
          kind: "RETURN",
          at: reserve.at + 5 * DAY_MS,
          candidate: { ...reserve.candidate!, partialRefund: true },
        })
        .map((row) => row.kind),
    ).toEqual(["ORDER"]);
  });
});

it("rejects unknown quantities, inconsistent order facts and unproven resume positions", () => {
  const config = configFor("mature");
  const timeline = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + DAY_MS,
  );
  const reducer = reducerModule.createCausalReducer(config);
  for (const event of timeline) reducer.apply(event);
  const snapshot = reducer.snapshot();
  const balance = snapshot.inventory[0]!;
  const order = snapshot.orders[0]!;
  for (const initial of [
    { ...snapshot, inventory: [{ ...balance, onHand: null }] },
    { ...snapshot, inventory: [{ ...balance, safetyStock: 999 }] },
    { ...snapshot, orders: [{ ...order, payableMinor: order.payableMinor! + 1 }] },
    { ...snapshot, orders: [{ ...order, source: { ...order.source, updatedAt: null } }] },
    { ...snapshot, lastEvent: { at: 0, kind: "RETURN", key: "foreign" } },
    { ...snapshot, refunds: [] },
  ])
    expect(() => reducerModule.createCausalReducer(config, initial)).toThrow();
});

it("accepts the supported pre-1970 calendar and rejects forged lifecycle events", () => {
  const historical = MockConfigSchema.parse({
    ...input,
    profile: "mature",
    historyStart: "1900-01-01T00:00:00+08:00",
  });
  const events = generateTimeline(
    historical,
    generateCatalog(historical),
    Date.parse(historical.historyStart) + 6 * DAY_MS,
  );
  const oldReducer = reducerModule.createCausalReducer(historical);
  expect(() => events.forEach((event) => oldReducer.apply(event))).not.toThrow();
  expect(() => reducerModule.createCausalReducer(historical, oldReducer.snapshot())).not.toThrow();
  const config = configFor("mature");
  const reserve = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + DAY_MS,
  ).find((event) => event.kind === "RESERVE")!;
  const reducer = reducerModule.createCausalReducer(config);
  expect(() => reducer.apply({ ...reserve, kind: "PAY", at: reserve.at + 1 })).toThrow();
  expect(() =>
    reducer.apply({
      ...reserve,
      kind: "PAY",
      at: reserve.at + 300000,
      candidate: { ...reserve.candidate!, cancel: true },
    }),
  ).toThrow();
  expect(() =>
    reducer.apply({
      ...reserve,
      kind: "REFUND",
      at: reserve.at + 3 * DAY_MS,
      candidate: { ...reserve.candidate!, cancel: false, refund: false },
    }),
  ).toThrow();
});

it("rejects future accepted state without a checkpoint and leaves it intact", () => {
  const config = configFor("mature");
  const events = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + DAY_MS,
  );
  const reducer = reducerModule.createCausalReducer(config);
  const opening = events.find((event) => event.kind === "RESTOCK")!;
  reducer.apply(opening);
  const snapshot = structuredClone(reducer.snapshot());
  const future = {
    ...snapshot,
    lastEvent: null,
    inventory: snapshot.inventory.map((row) => ({
      ...row,
      source: { ...row.source, updatedAt: new Date(opening.at + 1).toISOString() },
    })),
  };
  const restarted = reducerModule.createCausalReducer(config, future);
  const before = restarted.snapshot();
  expect(() => restarted.apply(opening)).toThrow("ahead");
  expect(restarted.snapshot()).toEqual(before);
});

it("accepts database versions but owns caller rows, and enforces active order and balance budgets", async () => {
  const { newOrder } = await import("./mock-order.js");
  const config = MockConfigSchema.parse({ ...input, profile: "mature", dailyOrders: 1 });
  const events = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + 2 * DAY_MS,
  );
  const reserve = events.find((event) => event.kind === "RESERVE")!;
  const opening = events.filter((event) => event.kind === "RESTOCK");
  const reducer = reducerModule.createCausalReducer(config);
  opening.forEach((event) => reducer.apply(event));
  const hydrated = structuredClone(reducer.snapshot());
  const versioned = {
    ...hydrated,
    lastEvent: null,
    inventory: hydrated.inventory.map((row) => ({
      ...row,
      source: { ...row.source, version: "42" },
    })),
  };
  const restored = reducerModule.createCausalReducer(config, versioned);
  versioned.inventory[0]!.source.version = "43";
  expect(restored.snapshot().inventory[0]!.source.version).toBe("42");
  const rows = Array.from({ length: 14 }, (_, index) => {
    const candidate = { ...reserve.candidate!, id: `m:order:fixture:${index}` };
    return newOrder(config, candidate);
  });
  expect(() =>
    reducerModule.createCausalReducer(config, {
      orders: [...rows, newOrder(config, reserve.candidate!)],
      inventory: [],
    }),
  ).toThrow();
  const full = reducerModule.createCausalReducer(config, {
    orders: rows,
    inventory: hydrated.inventory,
  });
  const before = full.snapshot();
  expect(() => full.apply(reserve)).toThrow("budget");
  expect(full.snapshot()).toEqual(before);
  expect(() =>
    reducerModule.createCausalReducer(config, {
      orders: [],
      inventory: [...hydrated.inventory, ...hydrated.inventory],
    }),
  ).toThrow();
});

it("rejects noncanonical hydrated timestamps and a return that changes refund semantics", () => {
  const config = configFor("mature");
  const events = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + DAY_MS,
  );
  const reducer = reducerModule.createCausalReducer(config);
  events.filter((event) => event.kind === "RESTOCK").forEach((event) => reducer.apply(event));
  const snapshot = reducer.snapshot();
  expect(() =>
    reducerModule.createCausalReducer(config, {
      ...snapshot,
      inventory: snapshot.inventory.map((row) => ({
        ...row,
        source: { ...row.source, updatedAt: "2026-01-01T00:00:00+08:00" },
      })),
    }),
  ).toThrow();
  const raw = events.find((event) => event.kind === "RESERVE")!;
  const candidate = {
    ...raw.candidate!,
    cancel: false,
    refund: true,
    returnGoods: true,
    partialRefund: true,
  };
  for (const [kind, offset] of [
    ["RESERVE", 0],
    ["PAY", 300000],
    ["SHIP", DAY_MS],
    ["REFUND", 3 * DAY_MS],
  ] as const)
    reducer.apply({ kind, at: candidate.at + offset, candidate });
  const before = reducer.snapshot();
  expect(() =>
    reducer.apply({
      kind: "RETURN",
      at: candidate.at + 5 * DAY_MS,
      candidate: { ...candidate, partialRefund: false },
    }),
  ).toThrow();
  expect(reducer.snapshot()).toEqual(before);
});

it("rejects contract-valid explicitly unknown facts instead of fabricating zeroes", async () => {
  const { ConnectorInventorySchema, ConnectorOrderSchema } = await import("@shopmate/contracts");
  const config = configFor("mature");
  const events = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + DAY_MS,
  );
  const reducer = reducerModule.createCausalReducer(config);
  events.forEach((event) => reducer.apply(event));
  const snapshot = reducer.snapshot();
  const row = snapshot.orders[0]!;
  const unknownOrder = ConnectorOrderSchema.parse({
    ...row,
    paidMinor: null,
    refundedMinor: null,
    source: {
      ...row.source,
      updatedAt: null,
      quality: {
        state: "PARTIAL",
        issues: ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN", "SOURCE_TIME_MISSING"],
      },
    },
  });
  const unknownInventory = ConnectorInventorySchema.parse({
    ...snapshot.inventory[0]!,
    onHand: null,
    reserved: null,
    available: null,
    source: {
      ...snapshot.inventory[0]!.source,
      quality: { state: "PARTIAL", issues: ["INVENTORY_UNKNOWN"] },
    },
  });
  expect(() =>
    reducerModule.createCausalReducer(config, { orders: [unknownOrder], inventory: [] }),
  ).toThrow();
  expect(() =>
    reducerModule.createCausalReducer(config, { orders: [], inventory: [unknownInventory] }),
  ).toThrow();
});

it("conserves a cancelled reservation and leaves insufficient-stock demand absent", () => {
  const config = configFor("mature");
  const event = generateTimeline(
    config,
    generateCatalog(config),
    Date.parse(config.historyStart) + DAY_MS,
  ).find((row) => row.kind === "RESERVE")!;
  const candidate = { ...event.candidate!, id: "m:order:a", quantity: 2, cancel: true };
  const reducer = reducerModule.createCausalReducer(config);
  reducer.apply({
    kind: "RESTOCK",
    at: candidate.at,
    skuId: candidate.sku.externalSkuId,
    stock: 2,
  });
  expect(
    reducer.apply({ kind: "RESERVE", at: candidate.at, candidate }).map((row) => row.kind),
  ).toEqual(["ORDER", "INVENTORY"]);
  const stockout = { ...candidate, id: "m:order:z" };
  expect(reducer.apply({ kind: "RESERVE", at: stockout.at, candidate: stockout })).toEqual([]);
  const cancelled = reducer.apply({ kind: "CANCEL", at: candidate.at + 1800000, candidate });
  expect(cancelled.map((row) => row.kind)).toEqual(["ORDER", "INVENTORY"]);
  const inventory = reducer.snapshot().inventory[0]!;
  expect(inventory.onHand).toBe(2);
  expect(inventory.reserved).toBe(0);
  expect(inventory.available).toBe(2);
  expect(reducer.snapshot().orders.map((row) => row.status)).toEqual(["CANCELLED"]);
});
