import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import test from "node:test";
import pg from "pg";
import { leasePortDatabase } from "../helpers/mock-source-lease-port-fixture.mjs";
import { preparedAppend } from "../helpers/mock-source-append-port-fixture.mjs";
import { eventFor, snapshot } from "../helpers/mock-source-append-fixture.mjs";
import { scopeFor } from "../helpers/mock-platform-fixture.mjs";
import { beginWorker } from "../helpers/mock-source-control-fixture.mjs";
import { sealedPublication } from "../helpers/mock-source-publish-port-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js");
const signatures = [
  "demo.has_store_access(text,text,text,boolean)",
  "mock_platform.has_current_access(text,text,text,text,text,text,integer)",
  "mock_platform.has_worker_access(text,text,text,text,text,text,integer)",
];
let context, reader;
test.before(async () => {
  context = await leasePortDatabase(source, "authplans");
  reader = new pg.Client({ connectionString: context.env.MOCK_PLATFORM_READ_DATABASE_URL });
  await reader.connect();
});
test.after(async () => {
  await reader.end();
  const database = context.rawAdmin.database;
  await context.worker.close();
  await context.rawWorker.end();
  await context.rawAdmin.end();
  assert.match(database, /^shopmate_tenant_test_[a-z_]+$/u);
  await context.operator.query(`DROP DATABASE "${database}"`);
  await context.operator.end();
  await context.server.stop();
});

async function metadata(signature) {
  return (
    await context.rawAdmin.query(
      `SELECT proowner,proacl,provolatile,prosecdef,
    proconfig,proargnames,prorettype,proparallel,procost,proisstrict,l.lanname,prosrc
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=$1::regprocedure`,
      [signature],
    )
  ).rows[0];
}

async function originalDefinitions() {
  const definitions = [];
  for (const name of [
    "20261003040000_demo_commerce_sessions",
    "20261003050000_mock_source_generation",
  ]) {
    const sql = await readFile(
      new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url),
      "utf8",
    );
    const matches = sql.matchAll(
      /CREATE FUNCTION (?:demo\.has_store_access|mock_platform\.has_current_access|mock_platform\.has_worker_access)\([\s\S]*?\$\$;/gu,
    );
    for (const match of matches)
      definitions.push(match[0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
  }
  assert.equal(definitions.length, 3);
  return definitions;
}

test("cached authorization plans preserve predicates, owner, ACL, volatility and invoker boundaries", async () => {
  for (const signature of signatures) assert.equal((await metadata(signature)).lanname, "plpgsql");
  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20261009070000_source_auth_cached_plans/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const definition of await originalDefinitions()) await context.rawAdmin.query(definition);
  const before = [];
  for (const signature of signatures) before.push(await metadata(signature));
  await context.rawAdmin.query(migration);
  const after = [];
  for (const signature of signatures) after.push(await metadata(signature));
  for (const [index, row] of after.entries()) {
    const { lanname: oldLanguage, prosrc: oldBody, ...oldProperties } = before[index];
    const { lanname, prosrc, ...properties } = row;
    assert.equal(oldLanguage, "sql");
    assert.equal(lanname, "plpgsql");
    assert.deepEqual(properties, oldProperties);
    assert.equal(prosrc.trim(), `BEGIN\n  RETURN (${oldBody.trim()});\nEND`);
    assert.equal(row.provolatile, "s");
    assert.equal(row.prosecdef, false);
  }
});

async function access(client, scope = scopeFor(), worker = true) {
  const functionName = worker ? "has_worker_access" : "has_current_access";
  const values = [
    scope.organizationId,
    scope.workspaceId,
    scope.storeId,
    scope.sessionId,
    scope.connectionId,
    scope.externalStoreId,
    scope.generation,
  ];
  return (
    await client.query(
      `SELECT mock_platform.${functionName}($1,$2,$3,$4,$5,$6,$7) AS allowed`,
      values,
    )
  ).rows[0].allowed;
}

async function warm(client, worker = true) {
  for (let index = 0; index < 12; index++)
    assert.equal(await access(client, scopeFor(), worker), true);
}

test("one warmed worker backend rechecks changed actor, merchant and grant settings", async () => {
  await beginWorker(context.rawWorker);
  try {
    await warm(context.rawWorker);
    for (const [setting, valid, invalid] of [
      ["app.user_id", "source-worker", "source-human"],
      ["app.merchant_id", "source-merchant-a", "source-merchant-b"],
      ["mock.grant_id", "source-grant-a", "source-grant-b"],
    ]) {
      await context.rawWorker.query("SELECT set_config($1,$2,true)", [setting, invalid]);
      assert.equal(await access(context.rawWorker), false);
      await context.rawWorker.query("SELECT set_config($1,$2,true)", [setting, valid]);
      assert.equal(await access(context.rawWorker), true);
    }
  } finally {
    await context.rawWorker.query("ROLLBACK");
  }
});

test("warmed worker sees committed grant and membership revocation in the next statement", async () => {
  await beginWorker(context.rawWorker);
  try {
    await warm(context.rawWorker);
    for (const [table, id, off] of [
      ['demo."MockWorkerGrant"', "source-grant-a", "REVOKED"],
      ['public."OrganizationMember"', "member-a-source-worker", "INACTIVE"],
      ['public."WorkspaceMember"', "assigned-a-source-worker", "INACTIVE"],
    ]) {
      try {
        await context.rawAdmin.query(`UPDATE ${table} SET status=$1 WHERE id=$2`, [off, id]);
        assert.equal(await access(context.rawWorker), false);
      } finally {
        await context.rawAdmin.query(`UPDATE ${table} SET status='ACTIVE' WHERE id=$1`, [id]);
      }
      assert.equal(await access(context.rawWorker), true);
    }
  } finally {
    await context.rawWorker.query("ROLLBACK");
  }
});

test("one warmed restricted reader backend rechecks actor and merchant settings", async () => {
  await reader.query(
    "BEGIN; SELECT set_config('app.user_id','source-human',true),set_config('app.merchant_id','source-merchant-a',true)",
  );
  try {
    await warm(reader, false);
    for (const [setting, valid, invalid] of [
      ["app.user_id", "source-human", "unassigned-user"],
      ["app.merchant_id", "source-merchant-a", "source-merchant-b"],
    ]) {
      await reader.query("SELECT set_config($1,$2,true)", [setting, invalid]);
      assert.equal(await access(reader, scopeFor(), false), false);
      await reader.query("SELECT set_config($1,$2,true)", [setting, valid]);
      assert.equal(await access(reader, scopeFor(), false), true);
    }
  } finally {
    await reader.query("ROLLBACK");
  }
});

test("warmed worker and restricted reader see reset generation immediately", async () => {
  await beginWorker(context.rawWorker);
  await reader.query(
    "BEGIN; SELECT set_config('app.user_id','source-human',true),set_config('app.merchant_id','source-merchant-a',true)",
  );
  try {
    await warm(context.rawWorker);
    await warm(reader, false);
    await context.admin.query('UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
      scopeFor().connectionId,
    ]);
    assert.equal(await access(context.rawWorker), false);
    assert.equal(await access(reader, scopeFor(), false), false);
    assert.equal(await access(context.rawWorker, scopeFor("a", 1)), true);
    assert.equal(await access(reader, scopeFor("a", 1), false), true);
    await assert.rejects(access(reader), { code: "42501" });
  } finally {
    await reader.query("ROLLBACK");
    await context.rawWorker.query("ROLLBACK");
    await context.admin.query('UPDATE "PlatformConnection" SET generation=0 WHERE id=$1', [
      scopeFor().connectionId,
    ]);
  }
});

test("cached plans keep real append and publication inside the unchanged lease", async (t) => {
  const started = performance.now();
  const state = await sealedPublication(context, ["STORE", "PRODUCT", "ORDER"]);
  const appendMs = Math.round(performance.now() - started);
  const publishing = performance.now();
  assert.equal(
    (await context.worker.publish(state.actor, state.lease, state.input)).status,
    "PUBLISHED",
  );
  t.diagnostic(
    `initialize/claim/three-event append ${appendMs} ms; publish ${Math.round(performance.now() - publishing)} ms`,
  );
});

test("maximum 100-event bulk append commits within the unchanged thirty-second lease", async (t) => {
  const state = await preparedAppend(context);
  const input = {
    expectedCheckpointHash: state.lease.checkpointHash,
    next: { processedThrough: state.lease.targetTime, sealed: false },
    events: Array.from({ length: 100 }, (_, index) =>
      eventFor(
        { scope: state.scope, job: { targetTime: state.lease.targetTime } },
        "STORE",
        String(index),
        state.lease.targetTime,
      ),
    ),
  };
  const started = performance.now();
  const committed = await context.worker.appendChunk(state.actor, state.lease, input);
  t.diagnostic(`100-event append: ${Math.round(performance.now() - started)} ms`);
  assert.equal(committed.status, "COMMITTED");
  assert.equal(committed.checkpoint.highEventSeq, "100");
  const facts = await snapshot(context.admin, state);
  assert.equal(facts.events.length, 100);
  assert.equal(facts.versions.length, 100);
});
