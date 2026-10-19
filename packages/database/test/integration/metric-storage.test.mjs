import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";

if (!process.env.TEST_DATABASE_URL) throw new Error("Metric storage requires runner TEST_DATABASE_URL");
const serverUrl = requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
const migrationRoot = new URL("../../prisma/migrations/", import.meta.url);

async function withDatabase(action) {
  const operator = new pg.Client({ connectionString: serverUrl });
  await operator.connect();
  // Identifiers cannot bind; this disposable name is generated locally and validated.
  const name = `shopmate_tenant_test_${randomBytes(8).toString("hex")}`;
  assert.match(name, /^[a-z0-9_]+$/u);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  let client;
  try {
    await operator.query(`CREATE DATABASE "${name}"`);
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await action(client, url.toString());
  } finally {
    if (client) await client.end();
    await operator.query(`DROP DATABASE IF EXISTS "${name}"`);
    await operator.end();
  }
}

async function migrate(client) {
  for (const name of (await readdir(migrationRoot)).filter((v) => /^\d{14}_/u.test(v)).sort())
    await client.query(await readFile(new URL(`${name}/migration.sql`, migrationRoot), "utf8"));
}

test("metric history has dedicated scoped definition and snapshot relations", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    const result = await client.query("SELECT to_regclass('public.metric_definitions') AS definitions,to_regclass('public.metric_snapshots') AS snapshots");
    assert.equal(result.rows[0].definitions, "metric_definitions");
    assert.equal(result.rows[0].snapshots, "metric_snapshots");
  });
});
