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
function arrayWithInheritedAccessor(key) {
  const reads = { count: 0 };
  const value = [];
  Object.setPrototypeOf(
    value,
    Object.create(Array.prototype, {
      [key]: {
        get() {
          reads.count += 1;
          return Array.prototype[key];
        },
      },
    }),
  );
  return { value, reads };
}

test("pure publication boundary is implemented", () =>
  assert.equal(typeof codec?.validateChunk, "function"));
test("custom events array rejects inherited iterator before access", () => {
  const { value, reads } = arrayWithInheritedAccessor(Symbol.iterator);
  inputError(() => codec.validateChunk(chunk(value), scope));
  assert.equal(reads.count, 0);
});
test("array subclasses are rejected", () => {
  class EventList extends Array {}
  inputError(() => codec.validateChunk(chunk(new EventList()), scope));
});

test("nested product SKU array rejects inherited map before access", () => {
  const { value, reads } = arrayWithInheritedAccessor("map");
  const product = event("PRODUCT");
  product.after.skus = value;
  inputError(() => codec.validateSnapshotEvent(product, scope));
  assert.equal(reads.count, 0);
});

test("nested quality issues array rejects inherited every before access", () => {
  const { value, reads } = arrayWithInheritedAccessor("every");
  const store = event("STORE");
  store.after.source.quality.issues = value;
  inputError(() => codec.validateSnapshotEvent(store, scope));
  assert.equal(reads.count, 0);
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
function assertQualityException(kind, change, issue) {
  const value = mutate(kind, change);
  inputError(() => codec.validateSnapshotEvent(value, scope));
  value.after.source.quality = { state: "PARTIAL", issues: [issue] };
  assert.doesNotThrow(() => codec.validateSnapshotEvent(value, scope));
  assert.deepEqual(records[schemas[kind]].parse(value.after), value.after);
}
test("matching partial quality issues allow documented null fields", () => {
  assertQualityException("STORE", (r) => (r.category = null), "CATEGORY_MISSING");
  assertQualityException("PRODUCT", (r) => (r.skus[0].costPriceMinor = null), "COST_MISSING");
  assertQualityException(
    "ORDER",
    (r) => Object.assign(r, { paidMinor: null, paidAt: null }),
    "PAYMENT_UNKNOWN",
  );
  assertQualityException("ORDER", (r) => (r.refundedMinor = null), "REFUND_UNKNOWN");
  assertQualityException("INVENTORY", (r) => (r.available = null), "INVENTORY_UNKNOWN");
  assertQualityException("MARKETING", (r) => (r.clicks = null), "MARKETING_UNKNOWN");
  assertQualityException(
    "REFUND",
    (r) => Object.assign(r, { succeededMinor: null, succeededAt: null }),
    "REFUND_UNKNOWN",
  );
});
test("quality state requires a unique known nonempty matching issue", () => {
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
const invalidFinancialEvents = [
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
test("financial arithmetic, timing, enums and nested identities are enforced", () => {
  for (const value of invalidFinancialEvents)
    inputError(() => codec.validateSnapshotEvent(value, scope));
});
test("inconsistent order and refund status may carry the matching partial issue", () => {
  for (const kind of ["ORDER", "REFUND"]) {
    const value = mutate(kind, (r) => {
      r.status = kind === "ORDER" ? "PENDING_PAYMENT" : "REQUESTED";
      r.source.quality = { state: "PARTIAL", issues: ["SOURCE_INCONSISTENT"] };
    });
    assert.doesNotThrow(() => codec.validateSnapshotEvent(value, scope));
    assert.deepEqual(records[schemas[kind]].parse(value.after), value.after);
  }
});
function hostileValueCases(reads) {
  const getter = event("STORE");
  Object.defineProperty(getter.after, "name", {
    enumerable: true,
    get() {
      reads.count++;
      return "name";
    },
  });
  const serializer = event("STORE");
  serializer.after.toJSON = () => {
    reads.count++;
    return {};
  };
  const cyclic = event("STORE");
  cyclic.after.self = cyclic.after;
  const symbol = event("STORE");
  symbol.after[Symbol("private")] = true;
  return [
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
}
test("hostile object values reject without executing getter or serializer", () => {
  const reads = { count: 0 };
  for (const value of hostileValueCases(reads))
    inputError(() => codec.validateSnapshotEvent(value, scope));
  assert.equal(reads.count, 0);
});
test("chunks reject duplicate and inverted event tuples", () => {
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
});
function depthLimitedEvent() {
  const depth = event("STORE");
  let nested = depth.after;
  for (let i = 0; i < 13; i++) {
    nested.deep = {};
    nested = nested.deep;
  }
  return depth;
}
function nodeLimitedEvent() {
  const nodes = event("STORE");
  nodes.after.nodes = Array.from({ length: 500 }, () => Array.from({ length: 41 }, () => 0));
  return nodes;
}
function byteLimitedEvent() {
  const bytes = event("STORE");
  bytes.after.name = "x".repeat(256 * 1024);
  return bytes;
}
function oversizedProductChunk() {
  const largeProduct = event("PRODUCT");
  largeProduct.after.skus = Array.from({ length: 500 }, (_, i) => ({
    ...largeProduct.after.skus[0],
    externalSkuId: `sku${i}`,
    attributes: Array.from({ length: 30 }, (_, j) => ({
      name: `attribute${j}`,
      value: "x".repeat(200),
    })),
  }));
  return chunk(Array.from({ length: 100 }, (_, i) => ({ ...largeProduct, ordinal: String(i) })));
}
test("events reject data depth, node, byte and array count excess", () => {
  for (const value of [
    depthLimitedEvent(),
    nodeLimitedEvent(),
    byteLimitedEvent(),
    mutate("PRODUCT", (r) => {
      r.skus = Array(501).fill(r.skus[0]);
    }),
  ])
    inputError(() => codec.validateSnapshotEvent(value, scope));
  inputError(() => codec.validateChunk(oversizedProductChunk(), scope));
});
const checkpointFixture = {
  codec: "source-checkpoint-v1",
  chunkIndex: "0",
  highEventSeq: "0",
  processedThrough: time,
  lastEvent: null,
  sealed: false,
};
const leaseFixture = {
  scope,
  revision: "1",
  fence: "1",
  ownerId: "123e4567-e89b-42d3-a456-426614174000",
};
const publicationFixture = {
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
function buildLeaseFixture() {
  return {
    ...leaseFixture,
    targetClockRevision: 0,
    targetTime: time,
    baseRevision: "0",
    baseHighEventSeq: "0",
    checkpoint: checkpointFixture,
    checkpointHash: hash,
    leaseUntil: time,
  };
}
test("valid checkpoint, lease, publication and publish input pass", () => {
  assert.doesNotThrow(() => codec.validateLeaseRef(leaseFixture));
  assert.doesNotThrow(() => codec.validateCheckpoint(checkpointFixture));
  assert.doesNotThrow(() => codec.validateBuildLease(buildLeaseFixture()));
  assert.doesNotThrow(() => codec.validatePublication(publicationFixture));
  assert.doesNotThrow(() =>
    codec.validatePublishInput({ expectedBaseRevision: "0", checkpointHash: hash }),
  );
});
test("lease references reject invalid revisions, fences, owners and extra keys", () => {
  for (const value of [
    { ...leaseFixture, revision: "0" },
    { ...leaseFixture, fence: "0" },
    { ...leaseFixture, ownerId: "owner" },
    { ...leaseFixture, extra: true },
  ])
    inputError(() => codec.validateLeaseRef(value));
});
test("publication rejects inconsistent stored sequence, counts and fields", () => {
  for (const value of [
    { ...publicationFixture, highEventSeq: "7" },
    { ...publicationFixture, versionCount: "5" },
    { ...publicationFixture, processedThrough: "2024-02-28T00:00:00.000Z" },
    { ...publicationFixture, certificateHash: "bad" },
    { ...publicationFixture, checkpoint: checkpointFixture },
  ])
    assert.throws(() => codec.validatePublication(value), { code: "SOURCE_INTEGRITY" });
});
test("checkpoint rejects invalid event ordering data", () => {
  assert.throws(
    () =>
      codec.validateCheckpoint({
        ...checkpointFixture,
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
const numericFieldPaths = {
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
  MARKETING: ["impressions", "clicks", "attributedOrders", "spendMinor", "attributedRevenueMinor"],
};
test("amount and quantity fields reject invalid numeric values", () => {
  for (const [kind, paths] of Object.entries(numericFieldPaths)) {
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
});
test("financial sums accept safe maximum and reject duplicate lines", () => {
  const max = event("ORDER");
  const item = max.after.items[0];
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
const storedCheckpointFixture = {
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
const storedLeaseFixture = {
  ...leaseFixture,
  targetClockRevision: 0,
  targetTime: time,
  baseRevision: "0",
  baseHighEventSeq: "0",
  checkpoint: storedCheckpointFixture,
  checkpointHash: hash,
  leaseUntil: time,
};
test("stored checkpoint accepts max ordinal and rejects malformed fields", () => {
  assert.doesNotThrow(() => codec.validateCheckpoint(storedCheckpointFixture));
  for (const patch of [
    { chunkIndex: "01" },
    { highEventSeq: "9223372036854775808" },
    { codec: "source-checkpoint-v2" },
    { extra: true },
    {
      lastEvent: {
        ...storedCheckpointFixture.lastEvent,
        occurredAt: "2024-03-01T00:00:00.000Z",
      },
    },
  ])
    assert.throws(() => codec.validateCheckpoint({ ...storedCheckpointFixture, ...patch }), {
      code: "SOURCE_INTEGRITY",
    });
});
test("stored build lease rejects invalid bounds and checkpoint mismatch", () => {
  for (const patch of [
    { targetClockRevision: 2147483648 },
    { baseRevision: "1" },
    { checkpointHash: "A".repeat(64) },
    { leaseUntil: "0000-01-01T00:00:00.000Z" },
    { baseHighEventSeq: "2" },
  ])
    assert.throws(() => codec.validateBuildLease({ ...storedLeaseFixture, ...patch }), {
      code: "SOURCE_INTEGRITY",
    });
});
test("stored publish input rejects malformed and unknown fields", () => {
  for (const input of [
    null,
    { expectedBaseRevision: "01", checkpointHash: hash },
    { expectedBaseRevision: "0", checkpointHash: hash, certificate: {} },
  ])
    inputError(() => codec.validatePublishInput(input));
});
test("stored checkpoint rejects hostile accessor without executing it", () => {
  let calls = 0;
  const hostile = { ...storedCheckpointFixture };
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
