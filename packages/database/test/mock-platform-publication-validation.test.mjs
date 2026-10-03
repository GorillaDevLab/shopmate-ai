import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

const codec = await import("../dist/src/mock-platform/publication-validation.js").catch(() => null);
const records = await import("../../contracts/dist/commerce/connector-data.schema.js");
const bounds = await import("../dist/src/mock-platform/record-bounds.js");
const tuples = await import("../dist/src/mock-platform/record-codec.js");
const scope = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  sessionId: "session",
  connectionId: "connection",
  externalStoreId: "商店😀",
  generation: 0,
};
const time = "2024-02-29T00:00:00.000Z";
const hash = "a".repeat(64);
const source = () => ({
  version: null,
  updatedAt: time,
  quality: { state: "COMPLETE", issues: [] },
});
const common = () => ({ externalStoreId: scope.externalStoreId, source: source() });
const fixtures = {
  STORE: {
    ...common(),
    name: "商店",
    category: "零售",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  PRODUCT: {
    ...common(),
    externalProductId: "product",
    title: "产品",
    description: "详情\n第二行",
    category: "类别",
    brand: null,
    status: "DELETED",
    skus: [
      {
        externalSkuId: "sku",
        externalProductId: "product",
        attributes: [{ name: "颜色", value: "红" }],
        salePriceMinor: 100,
        costPriceMinor: 50,
        originalPriceMinor: null,
        status: "ACTIVE",
      },
    ],
  },
  ORDER: {
    ...common(),
    externalOrderId: "order",
    status: "PAID",
    orderedAt: time,
    paidAt: time,
    currency: "CNY",
    items: [
      {
        externalLineId: "line",
        externalProductId: "product",
        externalSkuId: "sku",
        quantity: 2,
        unitPriceMinor: 100,
        grossMinor: 200,
        discountMinor: 10,
        netMinor: 190,
      },
    ],
    grossMinor: 200,
    discountMinor: 10,
    shippingMinor: 5,
    payableMinor: 195,
    paidMinor: 195,
    refundedMinor: 0,
  },
  REFUND: {
    ...common(),
    externalRefundId: "refund",
    externalOrderId: "order",
    externalSkuId: null,
    status: "SUCCEEDED",
    requestedMinor: 10,
    succeededMinor: 10,
    requestedAt: time,
    succeededAt: time,
    currency: "CNY",
  },
  INVENTORY: {
    ...common(),
    externalSkuId: "sku",
    externalLocationId: "location",
    available: 8,
    reserved: 2,
    onHand: 10,
    safetyStock: null,
    leadTimeDays: null,
  },
  MARKETING: {
    ...common(),
    externalCampaignId: "campaign",
    date: "2024-02-29",
    impressions: 100,
    clicks: 10,
    attributedOrders: 1,
    spendMinor: 10,
    attributedRevenueMinor: 195,
    currency: "CNY",
  },
};
const schemas = {
  STORE: "ConnectorStoreSchema",
  PRODUCT: "ConnectorProductSchema",
  ORDER: "ConnectorOrderSchema",
  REFUND: "ConnectorRefundSchema",
  INVENTORY: "ConnectorInventorySchema",
  MARKETING: "ConnectorCampaignMetricSchema",
};
const event = (kind, after = fixtures[kind], ordinal = "0") => ({
  kind,
  occurredAt: time,
  ordinal,
  after: globalThis.structuredClone(after),
});
const chunk = (events) => ({
  expectedCheckpointHash: hash,
  next: { processedThrough: time, sealed: false },
  events,
});
const inputError = (run) => assert.throws(run, { code: "SOURCE_INPUT" });
const mutate = (kind, change) => {
  const value = event(kind);
  change(value.after);
  return value;
};

test("pure publication boundary is implemented", () =>
  assert.equal(typeof codec?.validateChunk, "function"));
test("arrays with inherited behavior are rejected before accessors run", () => {
  let getterCalls = 0;
  const customEvents = [];
  Object.setPrototypeOf(
    customEvents,
    Object.create(Array.prototype, {
      [Symbol.iterator]: {
        get() {
          getterCalls += 1;
          return Array.prototype[Symbol.iterator];
        },
      },
    }),
  );
  inputError(() => codec.validateChunk(chunk(customEvents), scope));

  class EventList extends Array {}
  inputError(() => codec.validateChunk(chunk(new EventList()), scope));

  const product = event("PRODUCT");
  Object.setPrototypeOf(
    product.after.skus,
    Object.create(Array.prototype, {
      map: {
        get() {
          getterCalls += 1;
          return Array.prototype.map;
        },
      },
    }),
  );
  inputError(() => codec.validateSnapshotEvent(product, scope));

  const store = event("STORE");
  Object.setPrototypeOf(
    store.after.source.quality.issues,
    Object.create(Array.prototype, {
      every: {
        get() {
          getterCalls += 1;
          return Array.prototype.every;
        },
      },
    }),
  );
  inputError(() => codec.validateSnapshotEvent(store, scope));
  assert.equal(getterCalls, 0);
});
test("six closed record fixtures conform to Connector and source codec", () => {
  for (const [kind, value] of Object.entries(fixtures)) {
    assert.deepEqual(records[schemas[kind]].parse(value), value);
    assert.doesNotThrow(() => codec.validateSnapshotEvent(event(kind), scope));
  }
  assert.doesNotThrow(() =>
    codec.validateChunk(chunk(Object.keys(fixtures).map((kind) => event(kind))), scope),
  );
});
test("canonical UInt and Gregorian UTC reject overflow and rollover", () => {
  for (const value of ["0", "9223372036854775807"]) assert.equal(codec.validateUInt(value), true);
  for (const value of ["9223372036854775808", "01", "-1", 1, "1.0", ""])
    assert.equal(codec.validateUInt(value), false);
  for (const value of [time, "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"])
    assert.equal(codec.validateUtc(value), true);
  for (const value of [
    "2025-02-29T00:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "2024-04-31T00:00:00.000Z",
    "2024-02-29T24:00:00.000Z",
    "2024-02-29T00:00:00Z",
    "2024-02-29T00:00:00.000+00:00",
  ])
    assert.equal(codec.validateUtc(value), false);
  assert.equal(codec.incrementUInt("9223372036854775806"), "9223372036854775807");
  assert.throws(() => codec.incrementUInt("9223372036854775807"), { code: "SOURCE_INTEGRITY" });
});
test("events reject wrong payload, unknown keys, time/version and scope mismatches", () => {
  for (const value of [
    null,
    [],
    { ...event("STORE"), metadata: {} },
    { ...event("STORE"), kind: "ORDER" },
    { ...event("STORE"), ordinal: "01" },
    mutate("STORE", (r) => {
      r.source.version = "caller";
    }),
    mutate("STORE", (r) => {
      r.source.updatedAt = null;
    }),
    mutate("STORE", (r) => {
      r.source.updatedAt = "2024-03-01T00:00:00.000Z";
    }),
    mutate("STORE", (r) => {
      r.externalStoreId = "other";
    }),
    mutate("PRODUCT", (r) => {
      r.skus[0].extra = true;
    }),
  ])
    inputError(() => codec.validateSnapshotEvent(value, scope));
});
test("identity stays exact while generated IDs and normalized text have byte bounds", () => {
  const wide = { ...scope, externalStoreId: "😀".repeat(100) };
  const value = event("STORE");
  value.after.externalStoreId = wide.externalStoreId;
  assert.doesNotThrow(() => codec.validateSnapshotEvent(value, wide));
  for (const text of [" title", "title\r\nline", "e\u0301", "a\u200b", "中".repeat(67), "\ud800"])
    inputError(() =>
      codec.validateSnapshotEvent(
        mutate("PRODUCT", (r) => {
          r.title = text;
        }),
        scope,
      ),
    );
  for (const id of ["😀".repeat(51), " id", "id\n", "id\u200e", "\ud800"])
    inputError(() =>
      codec.validateSnapshotEvent(
        mutate("PRODUCT", (r) => {
          r.externalProductId = id;
          r.skus[0].externalProductId = id;
        }),
        scope,
      ),
    );
  assert.doesNotThrow(() =>
    codec.validateSnapshotEvent(
      mutate("PRODUCT", (r) => {
        r.externalProductId = "e\u0301";
        r.skus[0].externalProductId = "e\u0301";
      }),
      scope,
    ),
  );
});
test("null refinements and quality exceptions mirror the Connector contract", () => {
  const cases = [
    [
      "STORE",
      (r) => {
        r.category = null;
      },
      "CATEGORY_MISSING",
    ],
    [
      "PRODUCT",
      (r) => {
        r.skus[0].costPriceMinor = null;
      },
      "COST_MISSING",
    ],
    [
      "ORDER",
      (r) => {
        r.paidMinor = null;
        r.paidAt = null;
      },
      "PAYMENT_UNKNOWN",
    ],
    [
      "ORDER",
      (r) => {
        r.refundedMinor = null;
      },
      "REFUND_UNKNOWN",
    ],
    [
      "INVENTORY",
      (r) => {
        r.available = null;
      },
      "INVENTORY_UNKNOWN",
    ],
    [
      "MARKETING",
      (r) => {
        r.clicks = null;
      },
      "MARKETING_UNKNOWN",
    ],
    [
      "REFUND",
      (r) => {
        r.succeededMinor = null;
        r.succeededAt = null;
      },
      "REFUND_UNKNOWN",
    ],
  ];
  for (const [kind, change, issue] of cases) {
    const value = mutate(kind, change);
    inputError(() => codec.validateSnapshotEvent(value, scope));
    value.after.source.quality = { state: "PARTIAL", issues: [issue] };
    assert.doesNotThrow(() => codec.validateSnapshotEvent(value, scope));
    assert.deepEqual(records[schemas[kind]].parse(value.after), value.after);
  }
  for (const quality of [
    { state: "PARTIAL", issues: [] },
    { state: "COMPLETE", issues: ["COST_MISSING"] },
    { state: "PARTIAL", issues: ["COST_MISSING", "COST_MISSING"] },
    { state: "PARTIAL", issues: ["ORACLE"] },
  ])
    inputError(() =>
      codec.validateSnapshotEvent(
        mutate("STORE", (r) => {
          r.source.quality = quality;
        }),
        scope,
      ),
    );
});
test("financial arithmetic, timing, enums and nested identities are enforced", () => {
  const invalid = [
    mutate("ORDER", (r) => {
      r.items[0].quantity = Number.MAX_SAFE_INTEGER;
    }),
    mutate("ORDER", (r) => {
      r.shippingMinor = Number.MAX_SAFE_INTEGER;
    }),
    mutate("ORDER", (r) => {
      r.paidMinor = 194;
    }),
    mutate("ORDER", (r) => {
      r.refundedMinor = 196;
    }),
    mutate("ORDER", (r) => {
      r.paidAt = "2024-02-28T00:00:00.000Z";
    }),
    mutate("ORDER", (r) => {
      r.items.push(r.items[0]);
    }),
    mutate("ORDER", (r) => {
      r.items[0].netMinor = 189;
    }),
    mutate("ORDER", (r) => {
      r.status = "PENDING_PAYMENT";
    }),
    mutate("REFUND", (r) => {
      r.status = "REQUESTED";
    }),
    mutate("REFUND", (r) => {
      r.succeededMinor = 11;
    }),
    mutate("REFUND", (r) => {
      r.succeededAt = "2024-02-28T00:00:00.000Z";
    }),
    mutate("INVENTORY", (r) => {
      r.available = 9;
    }),
    mutate("INVENTORY", (r) => {
      r.leadTimeDays = 366;
    }),
    mutate("MARKETING", (r) => {
      r.date = "2025-02-29";
    }),
    mutate("PRODUCT", (r) => {
      r.skus.push(r.skus[0]);
    }),
    mutate("PRODUCT", (r) => {
      r.skus[0].attributes.push(r.skus[0].attributes[0]);
    }),
    mutate("PRODUCT", (r) => {
      r.skus[0].externalProductId = "other";
    }),
    mutate("STORE", (r) => {
      r.currency = "USD";
    }),
  ];
  for (const value of invalid) inputError(() => codec.validateSnapshotEvent(value, scope));
  for (const kind of ["ORDER", "REFUND"]) {
    const value = mutate(kind, (r) => {
      r.status = kind === "ORDER" ? "PENDING_PAYMENT" : "REQUESTED";
      r.source.quality = { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] };
    });
    assert.doesNotThrow(() => codec.validateSnapshotEvent(value, scope));
    assert.deepEqual(records[schemas[kind]].parse(value.after), value.after);
  }
});
test("hostile objects reject without executing accessors or toJSON", () => {
  let calls = 0;
  const getter = event("STORE");
  Object.defineProperty(getter.after, "name", {
    enumerable: true,
    get() {
      calls++;
      return "name";
    },
  });
  const serializer = event("STORE");
  serializer.after.toJSON = () => {
    calls++;
    return {};
  };
  const cyclic = event("STORE");
  cyclic.after.self = cyclic.after;
  const symbol = event("STORE");
  symbol.after[Symbol("private")] = true;
  const values = [
    getter,
    serializer,
    cyclic,
    symbol,
    { ...event("STORE"), after: new Date() },
    mutate("STORE", (r) => {
      r.name = undefined;
    }),
    mutate("STORE", (r) => {
      r.name = NaN;
    }),
    mutate("STORE", (r) => {
      r.name = Infinity;
    }),
    mutate("STORE", (r) => {
      r.name = 9007199254740992;
    }),
  ];
  for (const value of values) inputError(() => codec.validateSnapshotEvent(value, scope));
  assert.equal(calls, 0);
});
test("chunk rejects duplicate tuples, order inversions, and size/node/depth limits", () => {
  inputError(() => codec.validateChunk(chunk([event("STORE"), event("STORE")]), scope));
  inputError(() => codec.validateChunk(chunk([event("PRODUCT"), event("STORE")]), scope));
  inputError(() =>
    codec.validateChunk(
      chunk(Array.from({ length: 101 }, (_, i) => event("STORE", fixtures.STORE, String(i)))),
      scope,
    ),
  );
  assert.doesNotThrow(() =>
    codec.validateChunk(
      chunk([event("STORE", fixtures.STORE, "9"), event("STORE", fixtures.STORE, "10")]),
      scope,
    ),
  );
  const depth = event("STORE");
  let nested = depth.after;
  for (let i = 0; i < 13; i++) {
    nested.deep = {};
    nested = nested.deep;
  }
  const nodes = event("STORE");
  nodes.after.nodes = Array.from({ length: 500 }, () => Array.from({ length: 41 }, () => 0));
  const bytes = event("STORE");
  bytes.after.name = "x".repeat(256 * 1024);
  for (const value of [
    depth,
    nodes,
    bytes,
    mutate("PRODUCT", (r) => {
      r.skus = Array(501).fill(r.skus[0]);
    }),
  ])
    inputError(() => codec.validateSnapshotEvent(value, scope));
  const largeProduct = event("PRODUCT");
  largeProduct.after.skus = Array.from({ length: 500 }, (_, i) => ({
    ...largeProduct.after.skus[0],
    externalSkuId: `sku${i}`,
    attributes: Array.from({ length: 30 }, (_, j) => ({
      name: `attribute${j}`,
      value: "x".repeat(200),
    })),
  }));
  inputError(() =>
    codec.validateChunk(
      chunk(Array.from({ length: 100 }, (_, i) => ({ ...largeProduct, ordinal: String(i) }))),
      scope,
    ),
  );
});
test("checkpoint, lease and publication are exact and stored defects are integrity errors", () => {
  const checkpoint = {
    codec: "source-checkpoint-v1",
    chunkIndex: "0",
    highEventSeq: "0",
    processedThrough: time,
    lastEvent: null,
    sealed: false,
  };
  const lease = {
    scope,
    revision: "1",
    fence: "1",
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
  };
  assert.doesNotThrow(() => codec.validateLeaseRef(lease));
  assert.doesNotThrow(() => codec.validateCheckpoint(checkpoint));
  assert.doesNotThrow(() =>
    codec.validateBuildLease({
      ...lease,
      targetClockRevision: 0,
      targetTime: time,
      baseRevision: "0",
      baseHighEventSeq: "0",
      checkpoint,
      checkpointHash: hash,
      leaseUntil: time,
    }),
  );
  assert.doesNotThrow(() =>
    codec.validatePublishInput({ expectedBaseRevision: "0", checkpointHash: hash }),
  );
  const publication = {
    scope,
    revision: "1",
    targetClockRevision: 0,
    targetTime: time,
    baseRevision: "0",
    baseHighEventSeq: "0",
    highEventSeq: "6",
    eventCount: "6",
    versionCount: "6",
    processedThrough: time,
    generatorVersion: "mock-source-v1",
    runtimeVersion: "mock-runtime-v2",
    codec: "source-snapshot-v1",
    publishedAt: time,
    certificateHash: hash,
  };
  assert.doesNotThrow(() => codec.validatePublication(publication));
  for (const value of [
    { ...lease, revision: "0" },
    { ...lease, fence: "0" },
    { ...lease, ownerId: "owner" },
    { ...lease, extra: true },
  ])
    inputError(() => codec.validateLeaseRef(value));
  for (const value of [
    { ...publication, highEventSeq: "7" },
    { ...publication, versionCount: "5" },
    { ...publication, processedThrough: "2024-02-28T00:00:00.000Z" },
    { ...publication, certificateHash: "bad" },
    { ...publication, checkpoint },
  ])
    assert.throws(() => codec.validatePublication(value), { code: "SOURCE_INTEGRITY" });
  assert.throws(
    () =>
      codec.validateCheckpoint({
        ...checkpoint,
        lastEvent: {
          occurredAt: time,
          kind: "INVENTORY",
          entityKey: ["INVENTORY", "sku"],
          ordinal: "0",
        },
      }),
    { code: "SOURCE_INTEGRITY" },
  );
});
test("proxies cannot execute descriptor or value traps", () => {
  let traps = 0;
  const value = event("STORE");
  value.after = new Proxy(value.after, {
    getPrototypeOf() {
      traps++;
      return Object.prototype;
    },
    ownKeys(target) {
      traps++;
      return Reflect.ownKeys(target);
    },
  });
  inputError(() => codec.validateSnapshotEvent(value, scope));
  assert.equal(traps, 0);
});
test("bounded canonical sizing measures exact UTF-8 bytes, nodes and depth independently", () => {
  const value = { a: ["中", 'quote"\\\n', true, 1] };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  assert.doesNotThrow(() => bounds.validateDataBounds(value, bytes, 6, 2));
  inputError(() => bounds.validateDataBounds(value, bytes - 1, 6, 2));
  inputError(() => bounds.validateDataBounds(value, bytes, 5, 2));
  inputError(() => bounds.validateDataBounds(value, bytes, 6, 1));
  for (const bad of [
    Object.create(null),
    new Map(),
    { missing: undefined },
    Array(2),
    Object.assign([], { extra: true }),
    Object.defineProperty({}, "hidden", { value: 1 }),
  ])
    inputError(() => bounds.validateDataBounds(bad, 4096));
  const shared = { a: { value: 1 } };
  shared.b = shared.a;
  assert.doesNotThrow(() => bounds.validateDataBounds(shared, 4096));
});
test("valid records reach per-payload and aggregate chunk bounds independently", () => {
  const makeProduct = (count, attributes, length) => {
    const result = event("PRODUCT");
    result.after.skus = Array.from({ length: count }, (_, i) => ({
      ...result.after.skus[0],
      externalSkuId: `sku${i}`,
      attributes: Array.from({ length: attributes }, (_, j) => ({
        name: `attribute${j}`,
        value: "x".repeat(length),
      })),
    }));
    return result;
  };
  const sized = makeProduct(100, 5, 200);
  assert.doesNotThrow(() => codec.validateSnapshotEvent(sized, scope));
  inputError(() => codec.validateSnapshotEvent(makeProduct(500, 5, 200), scope));
  inputError(() => codec.validateSnapshotEvent(makeProduct(500, 30, 1), scope));
  inputError(() =>
    codec.validateChunk(
      chunk(Array.from({ length: 20 }, (_, i) => ({ ...sized, ordinal: String(i) }))),
      scope,
    ),
  );
  const full = chunk(
    Array.from({ length: 100 }, (_, i) => event("STORE", fixtures.STORE, String(i))),
  );
  assert.doesNotThrow(() => codec.validateChunk(full, scope));
});
test("tuple derivation respects phase, UTF-8 COLLATE C and numeric ordinals", () => {
  const keys = [
    ["STORE", scope.externalStoreId],
    ["PRODUCT", "product"],
    ["ORDER", "order"],
    ["REFUND", "refund"],
    ["INVENTORY", "sku", "location"],
    ["MARKETING", "campaign", "2024-02-29"],
  ];
  Object.keys(fixtures).forEach((kind, i) =>
    assert.deepEqual(tuples.entityKey(event(kind)), keys[i]),
  );
  const a = { occurredAt: time, kind: "PRODUCT", entityKey: ["PRODUCT", "\ue000"], ordinal: "9" };
  const b = { ...a, entityKey: ["PRODUCT", "😀"], ordinal: "10" };
  assert.ok(tuples.compareEventTuples(a, b) < 0);
  assert.ok(tuples.compareEventTuples(a, { ...a, ordinal: "10" }) < 0);
  assert.equal(tuples.compareEventTuples(a, a), 0);
  assert.ok(tuples.compareEventTuples(a, { ...a, kind: "ORDER", entityKey: ["ORDER", "a"] }) < 0);
});
test("strict field validation rejects missing and unknown keys throughout every record", () => {
  for (const kind of Object.keys(fixtures)) {
    const original = event(kind);
    for (const key of Object.keys(original.after)) {
      const value = event(kind);
      delete value.after[key];
      inputError(() => codec.validateSnapshotEvent(value, scope));
    }
    for (const key of ["source", "source.quality"]) {
      const value = event(kind),
        target = key === "source" ? value.after.source : value.after.source.quality;
      target.privateEconomics = 1;
      inputError(() => codec.validateSnapshotEvent(value, scope));
    }
  }
  for (const value of [
    {
      expectedCheckpointHash: hash,
      next: { processedThrough: time, sealed: false, extra: true },
      events: [],
    },
    { ...chunk([]), manifest: [] },
    { ...chunk([]), expectedCheckpointHash: "bad" },
    { ...chunk([]), next: { processedThrough: time, sealed: "true" } },
    chunk([event("STORE", fixtures.STORE, "9223372036854775808")]),
  ])
    inputError(() => codec.validateChunk(value, scope));
});
test("amount and quantity fields reject fractional, unsafe and nonfinite numbers", () => {
  const fields = {
    PRODUCT: ["skus.0.salePriceMinor", "skus.0.costPriceMinor", "skus.0.originalPriceMinor"],
    ORDER: [
      "items.0.quantity",
      "items.0.unitPriceMinor",
      "items.0.grossMinor",
      "items.0.discountMinor",
      "items.0.netMinor",
      "grossMinor",
      "discountMinor",
      "shippingMinor",
      "payableMinor",
      "paidMinor",
      "refundedMinor",
    ],
    REFUND: ["requestedMinor", "succeededMinor"],
    INVENTORY: ["available", "reserved", "onHand", "safetyStock", "leadTimeDays"],
    MARKETING: [
      "impressions",
      "clicks",
      "attributedOrders",
      "spendMinor",
      "attributedRevenueMinor",
    ],
  };
  for (const [kind, paths] of Object.entries(fields)) {
    for (const path of paths) {
      for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1"]) {
        const value = event(kind),
          parts = path.split("."),
          last = parts.pop();
        const target = parts.reduce((record, key) => record[key], value.after);
        target[last] = amount;
        inputError(() => codec.validateSnapshotEvent(value, scope));
      }
    }
  }
  const max = event("ORDER"),
    item = max.after.items[0];
  item.quantity = 1;
  item.unitPriceMinor = Number.MAX_SAFE_INTEGER;
  item.grossMinor = Number.MAX_SAFE_INTEGER;
  item.discountMinor = 0;
  item.netMinor = Number.MAX_SAFE_INTEGER;
  Object.assign(max.after, {
    grossMinor: Number.MAX_SAFE_INTEGER,
    discountMinor: 0,
    shippingMinor: 0,
    payableMinor: Number.MAX_SAFE_INTEGER,
    paidMinor: Number.MAX_SAFE_INTEGER,
    refundedMinor: 0,
  });
  assert.doesNotThrow(() => codec.validateSnapshotEvent(max, scope));
  max.after.items.push({ ...item, externalLineId: "line2" });
  inputError(() => codec.validateSnapshotEvent(max, scope));
});
test("stored DTOs reject hostile inputs and exact count and checkpoint defects", () => {
  const checkpoint = {
    codec: "source-checkpoint-v1",
    chunkIndex: "0",
    highEventSeq: "1",
    processedThrough: time,
    lastEvent: {
      occurredAt: time,
      kind: "STORE",
      entityKey: ["STORE", scope.externalStoreId],
      ordinal: "9223372036854775807",
    },
    sealed: false,
  };
  assert.doesNotThrow(() => codec.validateCheckpoint(checkpoint));
  for (const patch of [
    { chunkIndex: "01" },
    { highEventSeq: "9223372036854775808" },
    { codec: "source-checkpoint-v2" },
    { extra: true },
    { lastEvent: { ...checkpoint.lastEvent, occurredAt: "2024-03-01T00:00:00.000Z" } },
  ])
    assert.throws(() => codec.validateCheckpoint({ ...checkpoint, ...patch }), {
      code: "SOURCE_INTEGRITY",
    });
  const lease = {
    scope,
    revision: "1",
    fence: "1",
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
    targetClockRevision: 0,
    targetTime: time,
    baseRevision: "0",
    baseHighEventSeq: "0",
    checkpoint,
    checkpointHash: hash,
    leaseUntil: time,
  };
  for (const patch of [
    { targetClockRevision: 2147483648 },
    { baseRevision: "1" },
    { checkpointHash: "A".repeat(64) },
    { leaseUntil: "0000-01-01T00:00:00.000Z" },
    { baseHighEventSeq: "2" },
  ])
    assert.throws(() => codec.validateBuildLease({ ...lease, ...patch }), {
      code: "SOURCE_INTEGRITY",
    });
  for (const input of [
    null,
    { expectedBaseRevision: "01", checkpointHash: hash },
    { expectedBaseRevision: "0", checkpointHash: hash, certificate: {} },
  ])
    inputError(() => codec.validatePublishInput(input));
  let calls = 0;
  const hostile = { ...checkpoint };
  Object.defineProperty(hostile, "sealed", {
    enumerable: true,
    get() {
      calls++;
      return false;
    },
  });
  assert.throws(() => codec.validateCheckpoint(hostile), { code: "SOURCE_INTEGRITY" });
  assert.equal(calls, 0);
});
test("payload structural thresholds accept their exact limits", () => {
  const nodes = Array.from({ length: 40 }, () => Array.from({ length: 499 }, () => 0));
  nodes[0].pop();
  assert.doesNotThrow(() => bounds.validateDataBounds(nodes, 256 * 1024));
  nodes[0].push(0);
  inputError(() => bounds.validateDataBounds(nodes, 256 * 1024));
  const chain = (depth) => {
    let value = 0;
    for (let i = 0; i < depth; i++) value = { child: value };
    return value;
  };
  assert.doesNotThrow(() => bounds.validateDataBounds(chain(12), 256 * 1024));
  inputError(() => bounds.validateDataBounds(chain(13), 256 * 1024));
  assert.doesNotThrow(() => bounds.validateDataBounds("x".repeat(256 * 1024 - 2), 256 * 1024));
  inputError(() => bounds.validateDataBounds("x".repeat(256 * 1024 - 1), 256 * 1024));
  assert.doesNotThrow(() => bounds.validateDataBounds(Array(500).fill(0), 4096));
  inputError(() => bounds.validateDataBounds(Array(501).fill(0), 4096));
});
test("closed array ordering preserves escaped and Unicode identity vectors", () => {
  const ids = ["x", "x/", 'x"', "x\\", "xe\u0301", "xé", "x\u2028z", "x\u2029z", "x\ue000", "x😀"];
  const values = ids.map((id) => {
    const value = mutate("PRODUCT", (record) => {
      record.externalProductId = id;
      record.skus[0].externalProductId = id;
    });
    assert.doesNotThrow(() => codec.validateSnapshotEvent(value, scope));
    assert.deepEqual(tuples.entityKey(value), ["PRODUCT", id]);
    return tuples.eventTuple(value);
  });
  for (let i = 1; i < values.length; i++) {
    assert.ok(tuples.compareEventTuples(values[i - 1], values[i]) < 0);
    assert.ok(tuples.compareEventTuples(values[i], values[i - 1]) > 0);
  }
});
