import { expect, it } from "vitest";
import * as groups from "./mock-source-groups.js";
import { config } from "./mock-source-group.fixture.js";
import { DAY_MS } from "./mock-config.js";
import { generateMockSource } from "./mock-source.js";
const strip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (key, entry) => (key === "version" ? null : entry)));
it("emits opening baseline, physical sorted owned snapshots and offline final facts", () => {
  expect(groups).toHaveProperty("createSourceGroupGenerator");
  const start = Date.parse(config.historyStart),
    until = new Date(start + DAY_MS / 2).toISOString();
  const generator = groups.createSourceGroupGenerator(config);
  const output = [...generator.window(new Date(start - 1).toISOString(), until)];
  expect(output[0]!.events.map((e) => e.kind)).toEqual([
    "STORE",
    "PRODUCT",
    "PRODUCT",
    "INVENTORY",
    "INVENTORY",
    "INVENTORY",
    "INVENTORY",
  ]);
  const orders = new Map(),
    inventory = new Map(),
    marketing = new Map();
  for (const group of output)
    for (const event of group.events) {
      expect(event.after.source.version).toBeNull();
      expect(Object.isFrozen(event.after.source)).toBe(true);
      if (event.kind === "ORDER") orders.set(event.after.externalOrderId, event.after);
      if (event.kind === "INVENTORY") inventory.set(event.after.externalSkuId, event.after);
      if (event.kind === "MARKETING") marketing.set(event.after.externalCampaignId, event.after);
    }
  const oracle = generateMockSource(config, until);
  expect([...orders.values()]).toEqual(strip(oracle.orders));
  expect(
    [...inventory.values()].sort((a, b) => a.externalSkuId.localeCompare(b.externalSkuId)),
  ).toEqual(
    strip([...oracle.inventory].sort((a, b) => a.externalSkuId.localeCompare(b.externalSkuId))),
  );
  expect([...marketing.values()]).toEqual(strip(oracle.marketing));
});
it("reconstructs complete timestamp groups from strictly earlier owned hydration", () => {
  expect(groups).toHaveProperty("createSourceGroupGenerator");
  const start = Date.parse(config.historyStart),
    end = new Date(start + DAY_MS / 2).toISOString();
  const continuous = groups.createSourceGroupGenerator(config);
  const opening = [
    ...continuous.window(new Date(start - 1).toISOString(), new Date(start).toISOString()),
  ];
  const hydration = continuous.snapshot();
  const rest = [...continuous.window(new Date(start).toISOString(), end)];
  const restart = groups.createSourceGroupGenerator(config, hydration);
  expect([...restart.window(new Date(start).toISOString(), end)]).toEqual(rest);
  expect(opening).toHaveLength(1);
});
it("uses UTF-8 JSONB physical order and stable repeated-key ordinals with bounded groups", () => {
  expect(groups).toHaveProperty("orderSourceGroup");
  const at = config.historyStart;
  const after = (id: string) => ({
    externalStoreId: id,
    source: { version: null, updatedAt: at, quality: { state: "COMPLETE" as const, issues: [] } },
    name: "n",
    category: null,
    currency: "CNY" as const,
    timeZone: "Asia/Shanghai" as const,
  });
  const events = groups.orderSourceGroup([
    { kind: "STORE", occurredAt: at, ordinal: "0", after: after("𐀀") },
    { kind: "STORE", occurredAt: at, ordinal: "0", after: after("") },
    { kind: "STORE", occurredAt: at, ordinal: "0", after: after("") },
  ]);
  expect(events.map((e) => [e.after.externalStoreId, e.ordinal])).toEqual([
    ["", "0"],
    ["", "1"],
    ["𐀀", "0"],
  ]);
  expect(() => groups.orderSourceGroup(Array.from({ length: 16385 }, () => events[0]!))).toThrow(
    /budget/i,
  );
});
it("rejects hydration ahead of its strict window and fresh generators that skip opening", () => {
  const start = Date.parse(config.historyStart),
    at = new Date(start).toISOString();
  expect(() => [
    ...groups.createSourceGroupGenerator(config).window(at, new Date(start + 1000).toISOString()),
  ]).toThrow();
  const initial = groups.createSourceGroupGenerator(config);
  Array.from(initial.window(new Date(start - 1).toISOString(), at));
  const dto = initial.snapshot();
  expect(() => groups.createSourceGroupGenerator(config, { ...dto, through: null })).toThrow();
  expect(() =>
    groups.createSourceGroupGenerator(config, {
      ...dto,
      through: new Date(start - 1).toISOString(),
    }),
  ).toThrow();
});

for (const profile of ["growing", "problematic", "mature", "new"] as const)
  it(`matches ${profile} across daily restart and delayed settlements`, () => {
    const input = { ...config, profile, days: 20 };
    let generator = groups.createSourceGroupGenerator(input);
    const start = Date.parse(config.historyStart),
      orders = new Map(),
      refunds = new Map(),
      inventory = new Map(),
      marketing = new Map();
    let after = new Date(start - 1).toISOString();
    for (let day = 0; day < 25; day++) {
      const until = new Date(start + (day + 1) * DAY_MS - 1).toISOString();
      for (const group of generator.window(after, until))
        for (const event of group.events) {
          if (event.kind === "ORDER") orders.set(event.after.externalOrderId, event.after);
          if (event.kind === "REFUND") refunds.set(event.after.externalRefundId, event.after);
          if (event.kind === "INVENTORY") inventory.set(event.after.externalSkuId, event.after);
          if (event.kind === "MARKETING")
            marketing.set(event.after.externalCampaignId, event.after);
        }
      const dto = generator.snapshot();
      expect(dto.causal.orders.length).toBeLessThanOrEqual(7 * Math.ceil(input.dailyOrders * 1.35));
      expect(dto.marketing.length).toBeLessThanOrEqual(input.days);
      generator = groups.createSourceGroupGenerator(input, dto);
      after = until;
    }
    const oracle = generateMockSource(input, after);
    expect([...orders.values()]).toEqual(strip(oracle.orders));
    expect([...refunds.values()]).toEqual(strip(oracle.refunds));
    expect([...marketing.values()]).toEqual(strip(oracle.marketing));
    expect(
      [...inventory.values()].sort((a, b) => a.externalSkuId.localeCompare(b.externalSkuId)),
    ).toEqual(
      strip([...oracle.inventory].sort((a, b) => a.externalSkuId.localeCompare(b.externalSkuId))),
    );
  });
it("rejects group byte overflow and mixed timestamp inputs", () => {
  const generator = groups.createSourceGroupGenerator(config),
    start = Date.parse(config.historyStart);
  const row = [
    ...generator.window(new Date(start - 1).toISOString(), new Date(start).toISOString()),
  ][0]!.events[0]!;
  expect(() =>
    groups.orderSourceGroup([row, { ...row, occurredAt: new Date(start + 1).toISOString() }]),
  ).toThrow(/Mixed/);
  if (row.kind !== "STORE") throw new Error("Expected opening store");
  const large = { ...row, after: { ...row.after, name: "a".repeat(1024 * 1024) } };
  expect(() => groups.orderSourceGroup(Array.from({ length: 65 }, () => large))).toThrow(
    /byte budget/,
  );
});
it("does not let caller mutation change owned hydration or output", () => {
  const generator = groups.createSourceGroupGenerator(config),
    start = Date.parse(config.historyStart),
    at = new Date(start).toISOString();
  const opening = [...generator.window(new Date(start - 1).toISOString(), at)];
  const dto = structuredClone(generator.snapshot()),
    restart = groups.createSourceGroupGenerator(config, dto);
  Reflect.set(dto.causal.inventory[0]!, "onHand", 0);
  expect(restart.snapshot()).toEqual(generator.snapshot());
  expect(() => {
    Object.defineProperty(opening[0]!.events[0]!.after.source, "version", { value: "changed" });
  }).toThrow();
});

it("replays every mid-T opening effect before an adapter skips its accepted physical prefix", () => {
  const input = { ...config, productCount: 100, variantsPerProduct: 3 };
  const start = Date.parse(config.historyStart),
    at = new Date(start).toISOString(),
    before = new Date(start - 1).toISOString();
  const group = [...groups.createSourceGroupGenerator(input).window(before, at)][0]!;
  const accepted = group.events.slice(0, 100);
  expect(accepted).toHaveLength(100);
  const restart = groups.createSourceGroupGenerator(input, {
    causal: { orders: [], inventory: [] },
    marketing: [],
    through: before,
  });
  const rebuilt = [...restart.window(before, at)][0]!;
  expect(rebuilt).toEqual(group);
  expect(rebuilt.events.slice(accepted.length)).toEqual(group.events.slice(100));
  expect(restart.snapshot().causal.inventory).toHaveLength(300);
});
it("rejects concurrent window consumers and releases abandoned iterator ownership", () => {
  const start = Date.parse(config.historyStart),
    after = new Date(start - 1).toISOString(),
    until = new Date(start + 1000).toISOString();
  const generator = groups.createSourceGroupGenerator(config);
  const first = generator.window(after, until)[Symbol.iterator]();
  expect(first.next().done).toBe(false);
  const second = generator.window(after, until)[Symbol.iterator]();
  expect(() => second.next()).toThrow(/active|concurrent/i);
  first.return?.();
  expect(() => Array.from(generator.window(generator.snapshot().through, until))).not.toThrow();
});
