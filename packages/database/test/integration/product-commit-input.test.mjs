import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { ConnectorProductSchema, ConnectorTimestampSchema } from "../../../contracts/dist/index.js";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { migrateSource } from "../helpers/mock-platform-fixture.mjs";

const at = "2026-01-01T00:00:00.000Z";
const hash = "a".repeat(64);
function product() {
  return {
    externalStoreId: "store/原始",
    externalProductId: "product/a",
    title: " \r\nCafe\u0301\r\n ",
    description: null,
    category: "category",
    brand: null,
    status: "DELETED",
    source: { version: "opaque:009", updatedAt: at, quality: { state: "COMPLETE", issues: [] } },
    skus: [
      {
        externalSkuId: "sku/a",
        externalProductId: "product/a",
        attributes: [],
        salePriceMinor: 9007199254740991,
        costPriceMinor: 0,
        originalPriceMinor: null,
        status: "INACTIVE",
      },
    ],
  };
}
let server, operator, admin;
test.before(async () => {
  server = await isolatedPostgres();
  operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  await operator.query('CREATE DATABASE "shopmate_tenant_test_productinput"');
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_productinput";
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await migrateSource(admin);
});
test.after(async () => {
  await Promise.allSettled([admin?.end(), operator?.end()]);
  await server?.stop();
});
async function normalize(input) {
  return (
    await admin.query("SELECT sync_host.normalize_product($1::jsonb,$2) AS value", [
      JSON.stringify(input),
      "store/原始",
    ])
  ).rows[0].value;
}
test("normalizes exactly the product contract without losing deleted or nullable facts", async () => {
  const input = product();
  assert.deepEqual(await normalize(input), ConnectorProductSchema.parse(input));
  input.category = null;
  input.source.updatedAt = null;
  input.skus[0].costPriceMinor = null;
  input.source.quality = {
    state: "PARTIAL",
    issues: ["COST_MISSING", "CATEGORY_MISSING", "SOURCE_TIME_MISSING"],
  };
  assert.deepEqual(await normalize(input), ConnectorProductSchema.parse(input));
});
test("rejects incorrect JSON types, missing/unknown keys and product invariant failures", async () => {
  const candidates = [null, [], { ...product(), extra: true }];
  for (const mutate of [
    (p) => delete p.brand,
    (p) => (p.title = 12),
    (p) => (p.skus[0].salePriceMinor = "100"),
    (p) => (p.skus[0].salePriceMinor = 1.1),
    (p) => (p.skus[0].salePriceMinor = 9007199254740992),
    (p) => (p.skus[0].salePriceMinor = -1),
    (p) => (p.skus[0].extra = true),
    (p) => (p.skus[0].externalProductId = "other"),
    (p) => p.skus.push({ ...p.skus[0] }),
    (p) => (p.skus = []),
    (p) => (p.category = null),
    (p) => (p.source.updatedAt = null),
    (p) => (p.skus[0].costPriceMinor = null),
    (p) => (p.source.quality = { state: "COMPLETE", issues: ["COST_MISSING"] }),
    (p) => (p.source.quality = { state: "PARTIAL", issues: ["UNKNOWN"] }),
    (p) => (p.externalProductId = " hidden\u200b"),
    (p) => (p.title = "😀".repeat(101)),
    (p) =>
      (p.skus[0].attributes = [
        { name: "a", value: "v" },
        { name: " a ", value: "v" },
      ]),
  ]) {
    const value = product();
    mutate(value);
    candidates.push(value);
  }
  for (const value of candidates) {
    assert.equal(ConnectorProductSchema.safeParse(value).success, false);
    await assert.rejects(normalize(value), { code: "23514" });
  }
});
test("validates calendar and offsets then truncates fractions before PostgreSQL can round", async () => {
  for (const value of [
    at,
    "2026-01-01T08:00:00+08:00",
    "2026-01-01T00:00Z",
    "2026-01-01T00:00:00.00099999Z",
    "2026-01-01T00:00:00.123999999-23:59",
    "0000-02-29T00:00:00Z",
    "9999-12-31T23:59:59.999999999Z",
  ]) {
    assert.equal(ConnectorTimestampSchema.safeParse(value).success, true);
    const row = (
      await admin.query(
        "SELECT (extract(epoch FROM sync_host.product_time($1))*1000)::numeric AS ms",
        [value],
      )
    ).rows[0];
    assert.equal(Number(row.ms), Date.parse(value));
  }
  for (const value of [
    null,
    "2026-02-30T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
    "infinity",
    "2026-01-01T00:00:00",
  ]) {
    await assert.rejects(admin.query("SELECT sync_host.product_time($1)", [value]), {
      code: "23514",
    });
  }
});
test("payload hash canonicalizes unordered snapshot fields but includes quality and facts", async () => {
  const a = product();
  a.skus[0].attributes = [
    { name: "b", value: "2" },
    { name: "a", value: "1" },
  ];
  a.skus.push({ ...a.skus[0], externalSkuId: "sku/b" });
  const b = globalThis.structuredClone(a);
  b.skus.reverse();
  b.skus.forEach((sku) => sku.attributes.reverse());
  b.source.version = "different";
  b.source.updatedAt = "2026-02-01T00:00:00Z";
  async function payload(input) {
    return (
      await admin.query(
        "SELECT sync_host.product_payload_hash(sync_host.normalize_product($1::jsonb,$2)) AS hash",
        [JSON.stringify(input), "store/原始"],
      )
    ).rows[0].hash;
  }
  assert.equal(await payload(a), await payload(b));
  b.title = "different";
  assert.notEqual(await payload(a), await payload(b));
});
test("minor amount lexical scale does not change canonical payload identity", async () => {
  const input = product();
  input.skus[0].salePriceMinor = 100;
  const plain = JSON.stringify(input);
  const scaled = plain.replace('"salePriceMinor":100', '"salePriceMinor":100.000');
  const row = (
    await admin.query(
      `SELECT
    sync_host.product_payload_hash(sync_host.normalize_product($1::jsonb,$3)) AS plain,
    sync_host.product_payload_hash(sync_host.normalize_product($2::jsonb,$3)) AS scaled`,
      [plain, scaled, "store/原始"],
    )
  ).rows[0];
  assert.equal(row.plain, row.scaled);
});
test("source order mirrors timestamp, missing time and opaque version equality rules", async () => {
  const current = { version: "opaque:99", updatedAt: at, payloadHash: hash };
  const cases = [
    [null, current, "APPLY"],
    [current, { ...current, updatedAt: "2026-01-01T00:00:00.001Z", version: "opaque:1" }, "APPLY"],
    [
      current,
      { ...current, updatedAt: "2025-12-31T23:59:59.999Z", version: "opaque:999" },
      "STALE",
    ],
    [current, { ...current, updatedAt: "2026-01-01T08:00:00.00099999+08:00" }, "DUPLICATE"],
    [current, { ...current, version: "opaque:100" }, "CONFLICT"],
    [current, { ...current, payloadHash: "b".repeat(64) }, "CONFLICT"],
    [{ ...current, updatedAt: null }, { ...current, updatedAt: null }, "DUPLICATE"],
    [{ ...current, updatedAt: null }, current, "CONFLICT"],
    [current, { ...current, updatedAt: null }, "CONFLICT"],
  ];
  for (const [before, after, expected] of cases) {
    const row = (
      await admin.query("SELECT sync_host.product_source_order($1::jsonb,$2::jsonb) AS value", [
        JSON.stringify(before),
        JSON.stringify(after),
      ])
    ).rows[0];
    assert.equal(row.value, expected);
  }
  await assert.rejects(
    admin.query("SELECT sync_host.product_source_order($1::jsonb,$2::jsonb)", [
      JSON.stringify(current),
      JSON.stringify({ ...current, payloadHash: "bad" }),
    ]),
    { code: "23514" },
  );
});
test("internal pure helpers are not callable through worker or reader grants", async () => {
  const roles = ["shopmate_sync_worker", "shopmate_commerce_reader"];
  const rows = (
    await admin.query(
      `SELECT p.oid::regprocedure::text AS name,
    has_function_privilege($1,p.oid,'EXECUTE') AS worker,
    has_function_privilege($2,p.oid,'EXECUTE') AS reader
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sync_host' AND (p.proname LIKE 'product_%' OR p.proname='normalize_product')`,
      roles,
    )
  ).rows;
  assert.equal(rows.length, 13);
  assert.ok(rows.every((row) => !row.worker && !row.reader));
});

async function pageInput(value) {
  return (
    await admin.query(
      "SELECT sync_host.product_page_input($1::jsonb,$2,$3::timestamptz) AS value",
      [JSON.stringify(value), "store/原始", at],
    )
  ).rows[0].value;
}
function page(items = [product()]) {
  return { items, nextCursor: null, observedAt: at, sourceWatermark: null };
}
test("page admission is strict and budget rejection is whole-page and explicit", async () => {
  assert.deepEqual(await pageInput(page([])), page([]));
  assert.deepEqual(await pageInput(page()), page());
  for (const value of [
    { ...page(), extra: true },
    { ...page(), items: {} },
    { ...page(), nextCursor: " cursor " },
    { ...page(), observedAt: 123 },
    { ...page(), sourceWatermark: "2026-01-02T00:00:00Z" },
    page([{ ...product(), externalStoreId: "foreign" }]),
    page([{}]),
    page(Array.from({ length: 201 }, () => product())),
  ])
    await assert.rejects(pageInput(value), { code: "23514" });
  const largeProduct = product();
  largeProduct.skus = Array.from({ length: 500 }, (_, n) => ({
    ...product().skus[0],
    externalSkuId: `sku/${n}`,
    attributes: Array.from({ length: 30 }, (_, a) => ({
      name: `${a}`.padEnd(100, "界"),
      value: "界".repeat(200),
    })),
  }));
  largeProduct.description = "界".repeat(5000);
  assert.equal(ConnectorProductSchema.safeParse(largeProduct).success, true);
  assert.deepEqual(await pageInput(page([largeProduct])), page([largeProduct]));
  await assert.rejects(pageInput(page([largeProduct, largeProduct])), {
    code: "23514",
    message: "PAGE_TOO_LARGE",
  });
  const manySkus = Array.from({ length: 11 }, (_, n) => ({
    ...product(),
    externalProductId: `p/${n}`,
    skus: Array.from({ length: 500 }, (_, s) => ({
      ...product().skus[0],
      externalProductId: `p/${n}`,
      externalSkuId: `${n}/${s}`,
    })),
  }));
  await assert.rejects(pageInput(page(manySkus)), { code: "23514", message: "PAGE_TOO_LARGE" });
});
test("page hash binds complete input and scope while preserving exact replay identity", async () => {
  async function identity(job, input) {
    return (
      await admin.query("SELECT sync_host.product_page_hash($1::jsonb,$2,$3::jsonb) AS hash", [
        JSON.stringify(job),
        null,
        JSON.stringify(input),
      ])
    ).rows[0].hash;
  }
  const job = {
    id: "job",
    organizationId: "org",
    workspaceId: "ws",
    storeId: "store",
    connectionId: "conn",
    externalStoreId: "store/原始",
    provider: "MOCK",
    generation: 0,
    since: at,
    until: at,
  };
  const first = await identity(job, page());
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, await identity({ until: at, ...job }, page()));
  assert.equal(first, await identity({ ...job, fence: 99, status: "RUNNING" }, page()));
  for (const changed of [
    { ...job, generation: 1 },
    { ...job, workspaceId: "other" },
    { ...job, id: "other" },
    { ...job, provider: "OTHER" },
  ])
    assert.notEqual(first, await identity(changed, page()));
  assert.notEqual(first, await identity(job, { ...page(), observedAt: "2026-01-01T00:00:00Z" }));
  assert.notEqual(first, await identity(job, page([{ ...product(), title: "other" }])));
});
