import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  loginUrl,
  scopeFor,
} from "../helpers/mock-platform-fixture.mjs";
import {
  codecTime,
  codecRecords,
  codecRecord,
  codecSchemas,
  partial,
} from "../helpers/mock-source-codec-fixture.mjs";
import { compareEventTuples } from "../../dist/src/mock-platform/record-codec.js";
import { validateSnapshotEvent } from "../../dist/src/mock-platform/publication-validation.js";
import * as schemas from "../../../contracts/dist/commerce/connector-data.schema.js";

let server, operator, admin, worker, reader, app;
const clients = [];
async function login(url, name) {
  const client = new pg.Client({ connectionString: loginUrl(url, name) });
  await client.connect();
  clients.push(client);
  return client;
}
before(async () => {
  server = await isolatedPostgres();
  operator = await login(server.url, new URL(server.url).username);
  await operator.query('CREATE DATABASE "shopmate_tenant_test_publicationcodec"');
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_publicationcodec";
  admin = await login(url.toString(), url.username);
  await migrateSource(admin);
  await sourceFixtures(admin);
  worker = await login(url.toString(), "source_worker_login");
  reader = await login(url.toString(), "source_read_login");
  app = await login(url.toString(), "source_app_login");
});
after(async () => {
  for (const client of clients.reverse()) await client.end();
  if (operator) {
    const cleanup = new pg.Client({ connectionString: server.url });
    await cleanup.connect();
    try {
      await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_publicationcodec"');
    } finally {
      await cleanup.end();
    }
  }
  if (server) await server.stop();
});
async function validate(
  kind,
  record = codecRecord(kind),
  external = scopeFor().externalStoreId,
  at = codecTime,
) {
  return worker.query("SELECT mock_platform.require_record($1,$2::jsonb,$3,$4)", [
    kind,
    JSON.stringify(record),
    external,
    at,
  ]);
}
const integrity = (error) => error.code === "SM005" && error.message === "Invalid source integrity";
function rejected(name, kind, change) {
  test(name, async () => {
    const record = codecRecord(kind, change);
    assert.throws(
      () =>
        validateSnapshotEvent(
          { kind, occurredAt: codecTime, ordinal: "0", after: record },
          scopeFor(),
        ),
      { code: "SOURCE_INPUT" },
    );
    await assert.rejects(validate(kind, record), integrity);
  });
}
test("codec functions use actual restricted invoker login and fixed search path", async () => {
  assert.deepEqual(
    (await worker.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user"))
      .rows[0],
    { rolsuper: false, rolbypassrls: false },
  );
  const result = await admin.query(
    "SELECT p.proname,p.prosecdef,p.proconfig,p.provolatile,has_function_privilege('public',p.oid,'EXECUTE') AS public_exec FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mock_platform' AND p.proname='require_record'",
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].prosecdef, false);
  assert.deepEqual(result.rows[0].proconfig, ["search_path=pg_catalog"]);
  assert.equal(result.rows[0].public_exec, false);
});
for (const kind of Object.keys(codecRecords)) {
  test(`${kind} complete record conforms to Connector and direct SQL`, async () => {
    const value = codecRecord(kind);
    assert.ok(schemas[codecSchemas[kind]].safeParse(value).success);
    await validate(kind, value);
  });
  rejected(`${kind} rejects unknown fields`, kind, (r) => {
    r.oracle = "hidden";
  });
  rejected(`${kind} rejects missing source fields`, kind, (r) => {
    delete r.source.updatedAt;
  });
  rejected(`${kind} rejects mismatched store`, kind, (r) => {
    r.externalStoreId = "other";
  });
}
const invalidRecords = [
  [
    "store missing category quality",
    "STORE",
    (r) => {
      r.category = null;
    },
  ],
  [
    "product duplicate sku",
    "PRODUCT",
    (r) => {
      r.skus.push(globalThis.structuredClone(r.skus[0]));
    },
  ],
  [
    "product mismatched parent",
    "PRODUCT",
    (r) => {
      r.skus[0].externalProductId = "other";
    },
  ],
  [
    "product cost issue required",
    "PRODUCT",
    (r) => {
      r.skus[0].costPriceMinor = null;
    },
  ],
  [
    "duplicate attribute names",
    "PRODUCT",
    (r) => {
      r.skus[0].attributes.push({ name: "颜色", value: "蓝" });
    },
  ],
  [
    "order duplicate lines",
    "ORDER",
    (r) => {
      r.items.push(globalThis.structuredClone(r.items[0]));
    },
  ],
  [
    "order unsafe product",
    "ORDER",
    (r) => {
      r.items[0].quantity = 9007199254740991;
    },
  ],
  [
    "order wrong line equation",
    "ORDER",
    (r) => {
      r.items[0].netMinor = 1;
    },
  ],
  [
    "order wrong totals",
    "ORDER",
    (r) => {
      r.grossMinor = 1;
    },
  ],
  [
    "order refund above paid",
    "ORDER",
    (r) => {
      r.refundedMinor = 196;
    },
  ],
  [
    "order settled contradiction",
    "ORDER",
    (r) => {
      r.paidMinor = 1;
    },
  ],
  [
    "order paid before ordered",
    "ORDER",
    (r) => {
      r.paidAt = "2024-02-28T00:00:00.000Z";
    },
  ],
  [
    "order missing payment issue",
    "ORDER",
    (r) => {
      r.paidMinor = null;
    },
  ],
  [
    "order missing refund issue",
    "ORDER",
    (r) => {
      r.refundedMinor = null;
    },
  ],
  [
    "refund exceeds request",
    "REFUND",
    (r) => {
      r.succeededMinor = 11;
    },
  ],
  [
    "refund backwards time",
    "REFUND",
    (r) => {
      r.succeededAt = "2024-02-28T00:00:00.000Z";
    },
  ],
  [
    "refund missing success fields",
    "REFUND",
    (r) => {
      r.succeededMinor = null;
    },
  ],
  [
    "refund wrong pending state",
    "REFUND",
    (r) => {
      r.status = "PROCESSING";
    },
  ],
  [
    "inventory overflow",
    "INVENTORY",
    (r) => {
      r.available = 9007199254740991;
      r.reserved = 1;
      r.onHand = 9007199254740991;
    },
  ],
  [
    "inventory missing issue",
    "INVENTORY",
    (r) => {
      r.available = null;
    },
  ],
  [
    "inventory lead bound",
    "INVENTORY",
    (r) => {
      r.leadTimeDays = 366;
    },
  ],
  [
    "marketing null issue",
    "MARKETING",
    (r) => {
      r.clicks = null;
    },
  ],
  [
    "marketing invalid date",
    "MARKETING",
    (r) => {
      r.date = "2025-02-29";
    },
  ],
  [
    "currency fixed",
    "STORE",
    (r) => {
      r.currency = "USD";
    },
  ],
  [
    "timezone fixed",
    "STORE",
    (r) => {
      r.timeZone = "UTC";
    },
  ],
  [
    "text NFC required",
    "STORE",
    (r) => {
      r.name = "e\u0301";
    },
  ],
  [
    "text CR forbidden",
    "STORE",
    (r) => {
      r.name = "first\r\nsecond";
    },
  ],
  [
    "unsafe amount",
    "PRODUCT",
    (r) => {
      r.skus[0].salePriceMinor = 9007199254740992;
    },
  ],
  [
    "decimal amount",
    "PRODUCT",
    (r) => {
      r.skus[0].salePriceMinor = 1.5;
    },
  ],
  [
    "quality duplicate issues",
    "STORE",
    (r) => {
      partial(r, ["CATEGORY_MISSING", "CATEGORY_MISSING"]);
    },
  ],
  [
    "quality unknown issue",
    "STORE",
    (r) => {
      partial(r, ["PRIVATE"]);
    },
  ],
  [
    "quality complete with issue",
    "STORE",
    (r) => {
      r.source.quality.issues = ["COST_MISSING"];
    },
  ],
  [
    "input version nonnull",
    "STORE",
    (r) => {
      r.source.version = "forged";
    },
  ],
  [
    "source time mismatch",
    "STORE",
    (r) => {
      r.source.updatedAt = "2024-02-28T00:00:00.000Z";
    },
  ],
  [
    "label bytes bound",
    "STORE",
    (r) => {
      r.name = "商".repeat(67);
    },
  ],
  [
    "generated ID byte bound",
    "PRODUCT",
    (r) => {
      r.externalProductId = "商".repeat(67);
    },
  ],
  [
    "SKU array over 500",
    "PRODUCT",
    (r) => {
      r.skus = Array.from({ length: 501 }, (_, i) => ({ ...r.skus[0], externalSkuId: String(i) }));
    },
  ],
  [
    "attributes over 30",
    "PRODUCT",
    (r) => {
      r.skus[0].attributes = Array.from({ length: 31 }, (_, i) => ({
        name: String(i),
        value: "x",
      }));
    },
  ],
];
for (const [name, kind, change] of invalidRecords) rejected(name, kind, change);
const validPartial = [
  [
    "STORE",
    (r) => {
      r.category = null;
      partial(r, ["CATEGORY_MISSING"]);
    },
  ],
  [
    "PRODUCT",
    (r) => {
      r.category = null;
      r.skus[0].costPriceMinor = null;
      partial(r, ["CATEGORY_MISSING", "COST_MISSING"]);
    },
  ],
  [
    "ORDER",
    (r) => {
      r.paidMinor = null;
      r.paidAt = null;
      r.refundedMinor = null;
      partial(r, ["PAYMENT_UNKNOWN", "REFUND_UNKNOWN"]);
    },
  ],
  [
    "ORDER",
    (r) => {
      r.status = "PENDING_PAYMENT";
      partial(r, ["SOURCE_INCONSISTENT"]);
    },
  ],
  [
    "REFUND",
    (r) => {
      r.succeededMinor = null;
      r.succeededAt = null;
      partial(r, ["REFUND_UNKNOWN"]);
    },
  ],
  [
    "REFUND",
    (r) => {
      r.status = "PROCESSING";
      partial(r, ["SOURCE_INCONSISTENT"]);
    },
  ],
  [
    "INVENTORY",
    (r) => {
      r.available = null;
      partial(r, ["INVENTORY_UNKNOWN"]);
    },
  ],
  [
    "MARKETING",
    (r) => {
      r.clicks = null;
      partial(r, ["MARKETING_UNKNOWN"]);
    },
  ],
];
for (const [index, [kind, change]] of validPartial.entries())
  test(`partial contract ${index} preserves supported null or inconsistency`, async () => {
    const value = codecRecord(kind, change);
    assert.ok(schemas[codecSchemas[kind]].safeParse(value).success);
    await validate(kind, value);
  });
test("safe monetary maximum uses exact arithmetic", async () => {
  const record = codecRecord("ORDER", (r) => {
    Object.assign(r.items[0], {
      quantity: 1,
      unitPriceMinor: 9007199254740991,
      grossMinor: 9007199254740991,
      discountMinor: 0,
      netMinor: 9007199254740991,
    });
    Object.assign(r, {
      grossMinor: 9007199254740991,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: 9007199254740991,
      paidMinor: 9007199254740991,
    });
  });
  await validate("ORDER", record);
});
for (const namespace of ["商".repeat(200), "e\u0301".repeat(100), "😀".repeat(100)])
  test(`SQL retains ${Buffer.byteLength(namespace)} byte valid store namespace`, async () => {
    for (const kind of Object.keys(codecRecords)) {
      const record = codecRecord(kind, (r) => {
        r.externalStoreId = namespace;
      });
      await validate(kind, record, namespace);
    }
    const key = (
      await worker.query("SELECT mock_platform.entity_key($1,$2::jsonb) AS key", [
        "STORE",
        JSON.stringify({ externalStoreId: namespace }),
      ])
    ).rows[0].key;
    assert.deepEqual(JSON.parse(key), ["STORE", namespace]);
  });
for (const namespace of [
  "商".repeat(201),
  "😀".repeat(101),
  " a",
  "a\u00a0",
  "\ufeffa",
  "a\u200b",
  "a\u202e",
])
  test("SQL rejects invalid store namespace " + JSON.stringify(namespace.slice(0, 5)), async () => {
    const record = codecRecord("STORE", (r) => {
      r.externalStoreId = namespace;
    });
    await assert.rejects(validate("STORE", record, namespace), integrity);
  });
test("NFC spelling cannot match a distinct NFD namespace", async () => {
  const record = codecRecord("STORE", (r) => {
    r.externalStoreId = "e\u0301";
  });
  await assert.rejects(validate("STORE", record, "é"), integrity);
});
for (const at of [
  "0000-01-01T00:00:00.000Z",
  "2025-02-29T00:00:00.000Z",
  "2024-02-30T00:00:00.000Z",
  "2024-01-01T24:00:00.000Z",
  "2024-01-01T00:00:60.000Z",
  "2024-01-01T00:00:00Z",
  "2024-01-01T00:00:00.000+00:00",
  "infinity",
])
  test("UTC rejects " + at, async () => {
    assert.equal(
      (await worker.query("SELECT mock_platform.valid_utc($1) AS valid", [at])).rows[0].valid,
      false,
    );
  });
for (const at of ["0001-01-01T00:00:00.000Z", codecTime, "9999-12-31T23:59:59.999Z"])
  test("UTC accepts " + at, async () => {
    assert.equal(
      (await worker.query("SELECT mock_platform.valid_utc($1) AS valid", [at])).rows[0].valid,
      true,
    );
    assert.equal(
      (await worker.query("SELECT mock_platform.canonical_utc($1::timestamp) AS value", [at]))
        .rows[0].value,
      at,
    );
  });
for (const [value, valid] of [
  ["0", true],
  ["9223372036854775807", true],
  ["9223372036854775808", false],
  ["01", false],
  ["-1", false],
  ["1.0", false],
  ["1e2", false],
  ["", false],
])
  test("canonical UInt " + JSON.stringify(value), async () => {
    assert.equal(
      (await worker.query("SELECT mock_platform.valid_uint($1) AS valid", [value])).rows[0].valid,
      valid,
    );
    if (!valid)
      await assert.rejects(
        worker.query("SELECT mock_platform.source_uint($1)", [value]),
        integrity,
      );
  });
test("canonical UInt increment fails without wrap at maximum", async () => {
  assert.equal(
    (await worker.query("SELECT mock_platform.increment_uint($1) AS value", ["0"])).rows[0].value,
    "1",
  );
  await assert.rejects(
    worker.query("SELECT mock_platform.increment_uint($1)", ["9223372036854775807"]),
    integrity,
  );
});
async function bounds(value, maxBytes = 262144, maxNodes = 20000, maxDepth = 12) {
  return worker.query("SELECT mock_platform.require_data_bounds($1::jsonb,$2,$3,$4)", [
    JSON.stringify(value),
    maxBytes,
    maxNodes,
    maxDepth,
  ]);
}
test("bounds rejects bytes before traversing payload", async () => {
  await assert.rejects(bounds({ text: "x".repeat(262144) }), integrity);
});
test("bounds counts root at depth zero", async () => {
  await bounds({ a: { b: 1 } }, 100, 10, 2);
  await assert.rejects(bounds({ a: { b: { c: 1 } } }, 100, 10, 2), integrity);
});
test("bounds counts nodes independently of bytes", async () => {
  await bounds([1, 2], 100, 3);
  await assert.rejects(bounds([1, 2], 100, 2), integrity);
});
test("bounds caps nested arrays at 500", async () => {
  await bounds({ a: Array(500).fill(0) });
  await assert.rejects(bounds({ a: Array(501).fill(0) }), integrity);
});
test("bounds rejects unsafe generic JSON numbers", async () => {
  await assert.rejects(bounds({ a: 9007199254740992 }), integrity);
});
test("database hash uses fixed JSONB text recipe and detects changed envelope", async () => {
  const results = await worker.query(
    "SELECT mock_platform.hash_jsonb($1::jsonb) AS a,mock_platform.hash_jsonb($2::jsonb) AS b,mock_platform.hash_jsonb($3::jsonb) AS c",
    ['{"b":2,"a":1}', '{"a":1,"b":2}', '{"a":1,"b":3}'],
  );
  assert.equal(results.rows[0].a, createHash("sha256").update('{"a": 1, "b": 2}').digest("hex"));
  assert.equal(results.rows[0].a, results.rows[0].b);
  assert.notEqual(results.rows[0].a, results.rows[0].c);
});
test("all helper functions deny PUBLIC, reader, app and preserve invoker boundary", async () => {
  const rows = (
    await admin.query(
      "SELECT p.oid,p.proname,p.prosecdef,p.proconfig,has_function_privilege('public',p.oid,'EXECUTE') AS public_exec FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mock_platform' AND p.proname NOT IN ('has_current_access','has_worker_access','preserve_runtime','validate_runtime_insert','validate_control_runtime_insert')",
    )
  ).rows;
  assert.ok(rows.length > 10);
  assert.ok(
    rows.every(
      (r) => !r.prosecdef && !r.public_exec && r.proconfig.includes("search_path=pg_catalog"),
    ),
  );
  for (const client of [reader, app])
    await assert.rejects(
      client.query("SELECT mock_platform.hash_jsonb('{}'::jsonb)"),
      (e) => e.code === "42501",
    );
});
const keyVectors = [
  'quote"',
  "back\\slash",
  "slash/",
  "商",
  "e\u0301",
  "é",
  "a\u2028internal",
  "a\u2029b",
  "\ue000",
  "😀",
];
test("entity key JSONB text and C ordering conform to closed TS helper", async () => {
  const tuples = keyVectors.map((id) => ({
    kind: "PRODUCT",
    occurredAt: codecTime,
    entityKey: ["PRODUCT", id],
    ordinal: "9223372036854775807",
  }));
  for (const tuple of tuples) {
    const result = await worker.query("SELECT mock_platform.entity_key($1,$2::jsonb) AS key", [
      "PRODUCT",
      JSON.stringify({ externalProductId: tuple.entityKey[1] }),
    ]);
    assert.equal(
      result.rows[0].key,
      `[${tuple.entityKey.map((v) => JSON.stringify(v)).join(", ")}]`,
    );
  }
  for (const a of tuples)
    for (const b of tuples) {
      const result = await worker.query(
        "SELECT mock_platform.compare_event_tuples($1::jsonb,$2::jsonb) AS order",
        [JSON.stringify(a), JSON.stringify(b)],
      );
      assert.equal(Math.sign(result.rows[0].order), Math.sign(compareEventTuples(a, b)));
    }
});
test("composite keys and phase ranks preserve fixed mapping", async () => {
  const result = await worker.query(
    "SELECT mock_platform.entity_key($1,$2::jsonb) AS key,mock_platform.phase_rank($1) AS phase",
    ["INVENTORY", JSON.stringify(codecRecord("INVENTORY"))],
  );
  assert.deepEqual(result.rows[0], { key: '["INVENTORY", "sku", "location"]', phase: 40 });
  await assert.rejects(worker.query("SELECT mock_platform.phase_rank($1)", ["PRIVATE"]), integrity);
});
for (const [name, kind, change] of [
  [
    "store numeric external identity",
    "STORE",
    (r) => {
      r.externalStoreId = 1;
    },
  ],
  [
    "store numeric name",
    "STORE",
    (r) => {
      r.name = 1;
    },
  ],
  [
    "product numeric id",
    "PRODUCT",
    (r) => {
      r.externalProductId = 1;
    },
  ],
  [
    "amount object type",
    "PRODUCT",
    (r) => {
      r.skus[0].salePriceMinor = { value: 1 };
    },
  ],
  [
    "lead object type",
    "INVENTORY",
    (r) => {
      r.leadTimeDays = { value: 1 };
    },
  ],
  [
    "line quantity object type",
    "ORDER",
    (r) => {
      r.items[0].quantity = { value: 1 };
    },
  ],
  [
    "quality unknown key",
    "STORE",
    (r) => {
      r.source.quality.private = 1;
    },
  ],
  [
    "source unknown key",
    "STORE",
    (r) => {
      r.source.private = 1;
    },
  ],
  [
    "sku unknown key",
    "PRODUCT",
    (r) => {
      r.skus[0].private = 1;
    },
  ],
  [
    "attribute unknown key",
    "PRODUCT",
    (r) => {
      r.skus[0].attributes[0].private = 1;
    },
  ],
  [
    "line unknown key",
    "ORDER",
    (r) => {
      r.items[0].private = 1;
    },
  ],
  [
    "empty SKU list",
    "PRODUCT",
    (r) => {
      r.skus = [];
    },
  ],
  [
    "empty order lines",
    "ORDER",
    (r) => {
      r.items = [];
    },
  ],
  [
    "null source object",
    "STORE",
    (r) => {
      r.source = null;
    },
  ],
  [
    "null quality object",
    "STORE",
    (r) => {
      r.source.quality = null;
    },
  ],
  [
    "nonarray issue list",
    "STORE",
    (r) => {
      r.source.quality.issues = {};
    },
  ],
  [
    "negative amount",
    "PRODUCT",
    (r) => {
      r.skus[0].salePriceMinor = -1;
    },
  ],
  [
    "nonpositive order quantity",
    "ORDER",
    (r) => {
      r.items[0].quantity = 0;
    },
  ],
  [
    "unsafe cumulative sum",
    "ORDER",
    (r) => {
      Object.assign(r.items[0], {
        quantity: 1,
        unitPriceMinor: 9007199254740991,
        grossMinor: 9007199254740991,
        discountMinor: 0,
        netMinor: 9007199254740991,
      });
      r.items.push({ ...r.items[0], externalLineId: "second" });
    },
  ],
])
  rejected(name, kind, change);
test("default bounds reject depth 13 and accept depth 12", async () => {
  let value = 0;
  for (let depth = 0; depth < 12; depth += 1) value = { value };
  await bounds(value);
  await assert.rejects(bounds({ value }), integrity);
});
test("default bounds enforce 20000 nodes with each array under 500", async () => {
  await bounds(Array.from({ length: 39 }, () => Array(500).fill(0)));
  await assert.rejects(bounds(Array.from({ length: 40 }, () => Array(500).fill(0))), integrity);
});
test("byte budget permits its exact JSONB representation and rejects next byte", async () => {
  await bounds({ a: 1 }, 8);
  await assert.rejects(bounds({ a: 1 }, 7), integrity);
});
test("UTC wall serialization is independent of login timezone", async () => {
  assert.equal((await worker.query("SHOW timezone")).rows[0].TimeZone, "Pacific/Auckland");
  const value = (
    await worker.query("SELECT mock_platform.canonical_utc($1::timestamptz) AS value", [codecTime])
  ).rows[0].value;
  assert.equal(value, codecTime);
});
test("noncanonical timestamp precision and infinity cannot serialize", async () => {
  for (const value of ["2024-01-01T00:00:00.0001Z", "infinity", "-infinity"])
    await assert.rejects(
      worker.query("SELECT mock_platform.canonical_utc($1::timestamp)", [value]),
      integrity,
    );
});
async function tupleOrder(first, second) {
  const result = await worker.query(
    "SELECT mock_platform.compare_event_tuples($1::jsonb,$2::jsonb) AS ordering",
    [JSON.stringify(first), JSON.stringify(second)],
  );
  return result.rows[0].ordering;
}
test("tuple chronology compares timestamp then phase then key then bigint ordinal", async () => {
  const first = {
    kind: "STORE",
    occurredAt: codecTime,
    entityKey: ["STORE", scopeFor().externalStoreId],
    ordinal: "9",
  };
  const later = { ...first, ordinal: "10" };
  assert.equal(await tupleOrder(first, later), -1);
  const product = {
    kind: "PRODUCT",
    occurredAt: codecTime,
    entityKey: ["PRODUCT", "a"],
    ordinal: "0",
  };
  assert.equal(await tupleOrder(first, product), -1);
  const earlier = { ...product, occurredAt: "2024-02-28T23:59:59.999Z" };
  assert.equal(await tupleOrder(first, earlier), 1);
});
