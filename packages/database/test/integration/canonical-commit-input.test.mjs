import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { migrateSource } from "../helpers/mock-platform-fixture.mjs";
import { syncScope } from "../helpers/sync-host-fixture.mjs";
import { canonicalRecord as record } from "../helpers/canonical-page-fixture.mjs";

const streams = ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"];
let server, admin;
test.before(async () => {
  server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  try {
    await operator.query('CREATE DATABASE "shopmate_tenant_test_canonicalinput"');
  } finally {
    await operator.end();
  }
  const parsed = new URL(server.url);
  parsed.pathname = "/shopmate_tenant_test_canonicalinput";
  admin = new pg.Client({ connectionString: parsed.toString() });
  await admin.connect();
  await migrateSource(admin);
});
test.after(async () => {
  await admin?.end();
  await server?.stop();
});
test("SQL validators match all four strict DTOs, safe amounts, Unicode budgets and closed lines", async () => {
  const scope = { id: "00000000-0000-0000-0000-000000000001", ...syncScope() };
  const normalize = async (stream, item) =>
    (
      await admin.query(
        'SELECT sync_host.normalize_canonical($1::jsonb,$2,jsonb_populate_record(NULL::commerce."SourceScope",$3::jsonb)) value',
        [JSON.stringify(item), stream, JSON.stringify(scope)],
      )
    ).rows[0].value;
  for (const stream of streams) {
    assert.deepEqual(await normalize(stream, record(stream)), record(stream));
    await assert.rejects(normalize(stream, { ...record(stream), extra: 1 }), { code: "23514" });
    const bad = record(stream);
    const key = {
      ORDERS: "grossMinor",
      REFUNDS: "requestedMinor",
      INVENTORY: "available",
      MARKETING: "clicks",
    }[stream];
    bad[key] = "1";
    await assert.rejects(normalize(stream, bad), { code: "23514" });
    bad[key] = 9007199254740992;
    await assert.rejects(normalize(stream, bad), { code: "23514" });
  }
  const unicode = record("REFUNDS");
  unicode.externalRefundId = "😀".repeat(128);
  await normalize("REFUNDS", unicode);
  unicode.externalRefundId += "x";
  await assert.rejects(normalize("REFUNDS", unicode), { code: "23514" });
  const badOrder = record("ORDERS");
  badOrder.items.push(structuredClone(badOrder.items[0]));
  await assert.rejects(normalize("ORDERS", badOrder), { code: "23514" });
});
test("generic admission ignores product-only resource fields and bounds stored envelope timestamps", async () => {
  const job = {
    stream: "INVENTORY",
    externalStoreId: syncScope().externalStoreId,
    until: "2026-01-02T00:00:00Z",
  };
  const admit = (page) =>
    admin.query(
      'SELECT sync_host.canonical_page_input($1::jsonb,jsonb_populate_record(NULL::sync_host."Job",$2::jsonb))',
      [JSON.stringify(page), JSON.stringify(job)],
    );
  const page = {
    items: [{ ...record("INVENTORY"), skus: Array(5001).fill(null) }],
    nextCursor: null,
    observedAt: "2026-01-02T00:00:00Z",
    sourceWatermark: null,
  };
  await admit(page);
  await assert.rejects(admit({ ...page, observedAt: "0000-01-01T00:00:00Z" }), { code: "23514" });
});
