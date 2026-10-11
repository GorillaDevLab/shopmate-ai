import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { URL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  sourceFixtures,
  scopeFor,
  configFor,
  hashConfig,
  sourceEnv,
  readerActor,
  loginUrl,
} from "../helpers/mock-platform-fixture.mjs";
import { beginWorker, operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import {
  createMockSourceWorker,
  createMockSourceReader,
} from "../../dist/src/mock-platform/index.js";
let server, admin, worker, reader, operator, rawWorker, suiteUrl;
const migrationRoot = new URL("../../prisma/migrations/", import.meta.url);
const scenarioMigration = "20261009050000_mock_scenario_version";
async function migrateBeforeScenario() {
  const names = (await readdir(migrationRoot)).filter((name) => /^\d{14}_/u.test(name)).sort();
  for (const name of names.filter((name) => name < scenarioMigration))
    await admin.query(await readFile(new URL(`${name}/migration.sql`, migrationRoot), "utf8"));
}
before(async () => {
  server = await isolatedPostgres();
  operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  await operator.query('CREATE DATABASE "shopmate_tenant_test_scenario"');
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_scenario";
  suiteUrl = url.toString();
  admin = new pg.Client({ connectionString: suiteUrl });
  await admin.connect();
  await migrateBeforeScenario();
  await sourceFixtures(admin);
  worker = createMockSourceWorker(sourceEnv(suiteUrl));
  reader = createMockSourceReader(sourceEnv(suiteUrl));
  rawWorker = new pg.Client({ connectionString: loginUrl(suiteUrl, "source_worker_login") });
  await rawWorker.connect();
});
after(async () => {
  await worker?.close();
  await reader?.close();
  await rawWorker?.end();
  await admin?.end();
  if (operator) {
    await operator.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_scenario"');
    await operator.end();
  }
  await server?.stop();
});
async function configure(scope, config, version) {
  await operatorControl(
    admin,
    'UPDATE demo."DemoCommerceSession" SET config=$2::jsonb,"configHash"=$3,"generatorVersion"=$4 WHERE id=$1',
    [scope.sessionId, JSON.stringify(config), hashConfig(config), version],
    scope,
  );
}
function planFor(scope) {
  return {
    version: "mock-scenario-v1",
    scenarioId: "SCENARIO_009",
    externalStoreId: scope.externalStoreId,
    startDay: 3,
    endDay: 9,
    mutations: [],
    campaignSpendBps: 10000,
    campaignConversionBps: 10000,
    delivery: { kind: "INTERRUPT", durationMs: 3600000 },
  };
}
async function publishEmpty(actor, scope) {
  const claimed = await worker.claim(actor, scope);
  assert.equal(claimed.status, "CLAIMED");
  const lease = claimed.lease;
  const appended = await worker.appendChunk(actor, lease, {
    expectedCheckpointHash: lease.checkpointHash,
    next: { processedThrough: lease.targetTime, sealed: true },
    events: [],
  });
  assert.equal(appended.status, "COMMITTED");
  const publication = await worker.publish(actor, lease, {
    expectedBaseRevision: lease.baseRevision,
    checkpointHash: appended.checkpointHash,
  });
  assert.equal(publication.status, "PUBLISHED");
  return publication;
}
async function migrateRetainingV1() {
  const frozen = await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
    scopeFor().sessionId,
  ]);
  await admin.query(
    await readFile(new URL(`${scenarioMigration}/migration.sql`, migrationRoot), "utf8"),
  );
  assert.deepEqual(
    (
      await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
        scopeFor().sessionId,
      ])
    ).rows,
    frozen.rows,
  );
}
test("migrated v1 stays frozen while owned v2 initializes, claims, publishes and reads", async () => {
  const baseline = await worker.initializeGeneration({ grantId: "source-grant-a" }, scopeFor());
  assert.equal(baseline.status, "CREATED");
  assert.equal(baseline.generation.generatorVersion, "mock-source-v1");
  await migrateRetainingV1();
  const scope = scopeFor("a2"),
    config = configFor(scope);
  config.scenarioPlan = planFor(scope);
  await configure(scope, config, "mock-source-v2");
  const actor = { grantId: "source-grant-a2" };
  const initialized = await worker.initializeGeneration(actor, scope);
  assert.equal(initialized.status, "CREATED");
  assert.equal(initialized.generation.generatorVersion, "mock-source-v2");
  const publication = await publishEmpty(actor, scope);
  assert.equal(publication.publication.generatorVersion, "mock-source-v2");
  assert.equal(
    (await reader.findPublication(readerActor, scope)).generatorVersion,
    "mock-source-v2",
  );
  assert.equal(
    (await reader.findGeneration(readerActor, scopeFor())).generatorVersion,
    "mock-source-v1",
  );
});
test("v2 rejects absent or foreign plans before runtime rows are accepted", async () => {
  const scope = scopeFor("b"),
    config = configFor(scope);
  await configure(scope, config, "mock-source-v2");
  await assert.rejects(worker.initializeGeneration({ grantId: "source-grant-b" }, scope), {
    code: "SOURCE_INTEGRITY",
  });
  config.scenarioPlan = { ...planFor(scope), externalStoreId: "foreign" };
  await configure(scope, config, "mock-source-v2");
  await assert.rejects(worker.initializeGeneration({ grantId: "source-grant-b" }, scope), {
    code: "SOURCE_INTEGRITY",
  });
  config.scenarioPlan = planFor(scope);
  await configure(scope, config, "mock-source-v1");
  await assert.rejects(worker.initializeGeneration({ grantId: "source-grant-b" }, scope), {
    code: "SOURCE_INTEGRITY",
  });
  const rows = await admin.query(
    'SELECT count(*)::int AS count FROM mock_platform."Runtime" WHERE "sessionId"=$1',
    [scope.sessionId],
  );
  assert.equal(rows.rows[0].count, 0);
});
async function rawRuntimeInsert(scope, sql, values) {
  await beginWorker(rawWorker, scope, "source-grant-b");
  try {
    await rawWorker.query("SELECT demo.lock_source_control($1)", [scope.sessionId]);
    return await rawWorker.query(sql, values);
  } finally {
    await rawWorker.query("ROLLBACK");
  }
}
test("migrated Runtime guard rejects raw incompatible version and plan rows", async () => {
  const scope = scopeFor("b"),
    config = configFor(scope);
  const insert = `INSERT INTO mock_platform."Runtime" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","sourceConfig","configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd")
    SELECT id,0,"organizationId","workspaceId","storeId","connectionId","externalStoreId",config,"configHash","generatorVersion",'mock-runtime-v2',$2::timestamp,$3::timestamp FROM demo."DemoCommerceSession" WHERE id=$1`;
  for (const [version, scenarioPlan] of [
    ["mock-source-v2", undefined],
    ["mock-source-v2", { ...planFor(scope), externalStoreId: "foreign" }],
    ["mock-source-v1", planFor(scope)],
  ]) {
    const input = scenarioPlan ? { ...config, scenarioPlan } : config;
    await configure(scope, input, version);
    await assert.rejects(
      rawRuntimeInsert(scope, insert, [
        scope.sessionId,
        config.historyStart,
        "2026-01-30T16:00:00.000Z",
      ]),
      { code: "23514" },
    );
  }
});
