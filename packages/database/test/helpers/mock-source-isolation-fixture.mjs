import assert from "node:assert/strict";
import { before, after } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  loginUrl,
  scopeFor,
  createSourceSession,
  grantSource,
} from "./mock-platform-fixture.mjs";
import { rawInsert, rawValues } from "./mock-source-control-fixture.mjs";
import { sourceTransaction, claim } from "./mock-source-lease-fixture.mjs";
import { fullSnapshot } from "./mock-source-control-race-fixture.mjs";

export function isolationHarness() {
  const state = { clients: [] };
  before(async () => {
    state.server = await isolatedPostgres();
    const url = new URL(state.server.url);
    const owner = await connect(state, state.server.url, url.username);
    await owner.query('CREATE DATABASE "shopmate_tenant_test_isolationraces"');
    url.pathname = "/shopmate_tenant_test_isolationraces";
    state.admin = await connect(state, url.toString(), url.username);
    await migrateSource(state.admin);
    await sourceFixtures(state.admin);
    state.worker = await connect(state, url.toString(), "source_worker_login");
    state.other = await connect(state, url.toString(), "source_worker_login");
    state.reader = await connect(state, url.toString(), "source_read_login");
  });
  after(() => shutdown(state));
  return state;
}
async function connect(state, url, name) {
  const client = new pg.Client({ connectionString: loginUrl(url, name) });
  await client.connect();
  state.clients.push(client);
  await client.query("SET statement_timeout='10s'");
  return client;
}
async function shutdown(state) {
  const results = await Promise.allSettled(state.clients.reverse().map((client) => client.end()));
  if (state.server) {
    const cleanup = new pg.Client({ connectionString: state.server.url });
    try {
      await cleanup.connect();
      await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_isolationraces"');
    } finally {
      await cleanup.end();
      await state.server.stop();
    }
  }
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason));
}
export async function contextFor(state, suffix, key = "a", overrides = {}) {
  const scope = {
    ...scopeFor(key),
    storeId: `iso-store-${suffix}`,
    sessionId: `iso-session-${suffix}`,
    connectionId: `iso-connection-${suffix}`,
    ...overrides,
  };
  const grant = `iso-grant-${suffix}`;
  await createSourceSession(state.admin, scope);
  await grantSource(state.admin, scope, grant);
  await sourceTransaction(
    state.worker,
    scope,
    "CLAIM",
    () => state.worker.query(rawInsert, rawValues(scope)),
    null,
    grant,
  );
  const context = { scope, grant };
  context.job = (await claim(state.worker, context)).rows[0];
  assert.ok(context.job);
  return context;
}
export async function snapshots(state, contexts) {
  const values = [];
  for (const context of contexts) values.push(await fullSnapshot(state.admin, context));
  return JSON.stringify(values);
}
export async function rollbackAll(state, pending = []) {
  const results = await Promise.allSettled([
    state.worker.query("ROLLBACK"),
    state.other.query("ROLLBACK"),
    state.reader.query("ROLLBACK"),
    ...pending,
  ]);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason));
}
export async function assertReset(client) {
  const result = await client.query(
    "SELECT current_setting('app.user_id',true) AS actor,current_setting('app.merchant_id',true) AS merchant,current_setting('mock.grant_id',true) AS grant,current_setting('demo.control_session_id',true) AS control,current_setting('mock.source_op',true) AS op,current_setting('mock.source_lease',true) AS lease",
  );
  for (const value of Object.values(result.rows[0])) assert.equal(value ?? "", "");
}
pg.types.setTypeParser(1114, (value) => new Date(value + "Z"));
