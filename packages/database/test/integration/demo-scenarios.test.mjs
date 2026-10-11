import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import process from "node:process";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  scopeFor,
  configFor,
  hashConfig,
  loginUrl,
  sourceEnv,
  readerActor,
} from "../helpers/mock-platform-fixture.mjs";
import { grantControl } from "../helpers/mock-source-control-fixture.mjs";
import {
  createMockSourceWorker,
  createMockSourceReader,
} from "../../dist/src/mock-platform/index.js";
let server,
  operator,
  admin,
  repo,
  worker,
  reader,
  created = false,
  baseline,
  lease;
const scope = scopeFor(),
  actor = readerActor;
const dbName = "shopmate_tenant_test_scenariomanagement";
before(async () => {
  server = await isolatedPostgres();
  operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  await operator.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  const url = new URL(server.url);
  url.pathname = `/${dbName}`;
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await migrateSource(admin);
  await sourceFixtures(admin);
  await grantControl(admin, "shopmate_scenario_test");
  await admin.query(
    'GRANT SELECT,INSERT ON demo."DemoScenarioRun",demo."DemoScenarioRunAudit" TO shopmate_scenario_test',
  );
  await admin.query(
    "GRANT EXECUTE ON FUNCTION demo.has_scenario_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO shopmate_scenario_test",
  );
  process.env.DATABASE_URL = loginUrl(url.toString(), "shopmate_scenario_test");
  repo = await import("../../dist/src/index.js");
  worker = createMockSourceWorker(sourceEnv(url.toString()));
  reader = createMockSourceReader(sourceEnv(url.toString()));
  await worker.initializeGeneration({ grantId: "source-grant-a" }, scope);
  lease = (await worker.claim({ grantId: "source-grant-a" }, scope)).lease;
  baseline = (
    await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
      scope.sessionId,
    ])
  ).rows;
});
after(async () => {
  await worker?.close();
  await reader?.close();
  await repo?.disconnectPrismaClient();
  await admin?.end();
  if (created) await operator.query(`DROP DATABASE "${dbName}"`);
  await operator?.end();
  await server?.stop();
});
function input(revision = 0, generation = 0, id = "SCENARIO_009") {
  const config = configFor(scope);
  config.scenarioPlan = {
    version: "mock-scenario-v1",
    scenarioId: id,
    externalStoreId: scope.externalStoreId,
    startDay: 3,
    endDay: 9,
    mutations: [],
    campaignSpendBps: 10000,
    campaignConversionBps: 10000,
    delivery:
      id === "SCENARIO_009"
        ? { kind: "INTERRUPT", durationMs: 3600000 }
        : id === "SCENARIO_010"
          ? { kind: "REPLAY_SAVED_PAGE", repetitions: 1 }
          : { kind: "NORMAL" },
  };
  return {
    runId: `run-${generation + 1}`,
    confirmSessionId: scope.sessionId,
    expectedRevision: revision,
    expectedGeneration: generation,
    config,
    configHash: hashConfig(config),
    generatorVersion: "mock-source-v2",
    clockNow: new Date(config.historyStart),
  };
}
test("rejects a business clock beyond the configured settlement budget", async () => {
  const future = { ...input(), clockNow: new Date("2026-02-05T16:00:00.000Z") };
  assert.equal((await repo.loadDemoScenario(actor, scope.storeId, future)).status, "CONFLICT");
});
test("scenario load atomically advances generation and persists immutable audit after restart", async () => {
  const started = Date.now();
  const loaded = await repo.loadDemoScenario(actor, scope.storeId, input());
  assert.equal(loaded.status, "WRITTEN");
  assert.equal(loaded.view.generation, 1);
  assert.equal(loaded.view.revision, 1);
  assert.equal(loaded.view.runs[0].plan.scenarioId, "SCENARIO_009");
  assert.equal(loaded.view.runs[0].businessClock, input().clockNow.toISOString());
  assert.ok(Date.parse(loaded.view.runs[0].loadedAt) >= started - 1000);
  assert.ok(Date.parse(loaded.view.runs[0].loadedAt) <= Date.now() + 1000);
  await repo.disconnectPrismaClient();
  assert.deepEqual(await repo.findDemoScenarios(actor, scope.storeId), loaded.view);
  assert.deepEqual(
    (
      await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
        scope.sessionId,
      ])
    ).rows,
    baseline,
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM demo."DemoScenarioRunAudit"')).rows[0].n,
    1,
  );
  assert.equal(
    (
      await worker.appendChunk({ grantId: "source-grant-a" }, lease, {
        expectedCheckpointHash: lease.checkpointHash,
        next: { processedThrough: lease.targetTime, sealed: true },
        events: [],
      })
    ).status,
    "DENIED",
  );
  assert.equal(await reader.findGeneration(actor, scope), null);
});
test("stale generation, confirmation, foreign plan and inactive authority cannot write", async () => {
  for (const change of [
    { expectedGeneration: 0 },
    { expectedRevision: 0 },
    { confirmSessionId: "other" },
  ])
    assert.equal(
      (await repo.loadDemoScenario(actor, scope.storeId, { ...input(1, 1), ...change })).status,
      "CONFLICT",
    );
  const foreign = input(1, 1);
  foreign.config.scenarioPlan.externalStoreId = "foreign";
  foreign.configHash = hashConfig(foreign.config);
  assert.equal((await repo.loadDemoScenario(actor, scope.storeId, foreign)).status, "CONFLICT");
  assert.equal(
    (
      await repo.loadDemoScenario(
        { ...actor, merchantId: "source-merchant-b" },
        scope.storeId,
        input(1, 1),
      )
    ).status,
    "NOT_FOUND",
  );
  assert.equal(
    (await repo.loadDemoScenario({ ...actor, userId: "source-viewer" }, scope.storeId, input(1, 1)))
      .status,
    "NOT_FOUND",
  );
  await admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    actor.userId,
  ]);
  assert.equal(await repo.findDemoScenarios(actor, scope.storeId), null);
  assert.equal(
    (await repo.loadDemoScenario(actor, scope.storeId, input(1, 1))).status,
    "NOT_FOUND",
  );
  await admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "ACTIVE",
    actor.userId,
  ]);
  await admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["PRODUCTION"]);
  assert.equal(await repo.findDemoScenarios(actor, scope.storeId), null);
  assert.equal(
    (await repo.loadDemoScenario(actor, scope.storeId, input(1, 1))).status,
    "NOT_FOUND",
  );
  await admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  assert.equal((await repo.findDemoScenarios(actor, scope.storeId)).runs.length, 1);
});
test("concurrent loads have one winner and all fifteen frozen plans persist by generation", async () => {
  const results = await Promise.all([
    repo.loadDemoScenario(actor, scope.storeId, input(1, 1)),
    repo.loadDemoScenario(actor, scope.storeId, { ...input(1, 1), runId: "concurrent-other" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["CONFLICT", "WRITTEN"]);
  let view = await repo.findDemoScenarios(actor, scope.storeId);
  for (let n = 1; n <= 15; n++) {
    const id = `SCENARIO_${String(n).padStart(3, "0")}`;
    const loaded = await repo.loadDemoScenario(
      actor,
      scope.storeId,
      input(view.revision, view.generation, id),
    );
    assert.equal(loaded.status, "WRITTEN");
    view = loaded.view;
    assert.equal(view.runs[0].plan.scenarioId, id);
    assert.equal(view.runs[0].status, "ACTIVE");
    assert.ok(view.runs.slice(1).every((run) => run.status === "SUPERSEDED"));
  }
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM demo."DemoScenarioRunAudit"')).rows[0].n,
    17,
  );
});
test("missing audit rolls back generation, configuration and run insertion", async () => {
  const before = await repo.findDemoSession(actor, scope.storeId);
  await admin.query(
    `CREATE FUNCTION demo.suppress_scenario_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  await admin.query(
    'CREATE TRIGGER suppress_scenario_audit BEFORE INSERT ON demo."DemoScenarioRunAudit" FOR EACH ROW EXECUTE FUNCTION demo.suppress_scenario_audit()',
  );
  try {
    const loaded = await repo.loadDemoScenario(
      actor,
      scope.storeId,
      input(before.revision, before.generation),
    );
    assert.equal(loaded.status, "CONFLICT");
    assert.deepEqual(await repo.findDemoSession(actor, scope.storeId), before);
    assert.equal((await repo.findDemoScenarios(actor, scope.storeId)).runs.length, 17);
  } finally {
    await admin.query('DROP TRIGGER suppress_scenario_audit ON demo."DemoScenarioRunAudit"');
    await admin.query("DROP FUNCTION demo.suppress_scenario_audit()");
  }
});
test("advance preserves the frozen run and history reads remain bounded", async () => {
  let view = await repo.findDemoScenarios(actor, scope.storeId);
  const frozen = view.runs[0];
  const advanced = await repo.advanceDemoSession(actor, scope.storeId, {
    expectedRevision: view.revision,
    durationMs: 3600000,
  });
  assert.equal(advanced.status, "WRITTEN");
  view = await repo.findDemoScenarios(actor, scope.storeId);
  assert.deepEqual(view.runs[0], frozen);
  assert.equal(view.generation, frozen.generation);
  for (let n = 0; n < 5; n++) {
    const loaded = await repo.loadDemoScenario(
      actor,
      scope.storeId,
      input(view.revision, view.generation),
    );
    assert.equal(loaded.status, "WRITTEN");
    view = loaded.view;
  }
  assert.equal(view.runs.length, 20);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM demo."DemoScenarioRun"')).rows[0].n,
    22,
  );
});
test("source roles cannot manage runs and direct audit forgery is rejected", async () => {
  for (const role of ["source_worker_login", "source_read_login"])
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'demo.\"DemoScenarioRun\"','INSERT') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  await assert.rejects(
    admin.query(`INSERT INTO demo."DemoScenarioRunAudit" ("runId","organizationId","workspaceId","storeId","sessionId","actorUserId",snapshot)
    SELECT "runId","organizationId","workspaceId","storeId","sessionId","actorUserId",snapshot FROM demo."DemoScenarioRunAudit" LIMIT 1`),
    { code: "23514" },
  );
  await assert.rejects(admin.query('DELETE FROM demo."DemoScenarioRunAudit"'), { code: "23514" });
});
test("source worker cannot load even with accidental table grants and a human identity", async () => {
  await admin.query(
    'GRANT SELECT,INSERT ON demo."DemoScenarioRun",demo."DemoScenarioRunAudit" TO source_worker_login',
  );
  await admin.query(
    "GRANT EXECUTE ON FUNCTION demo.has_scenario_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO source_worker_login",
  );
  const url = new URL(process.env.DATABASE_URL);
  url.username = "source_worker_login";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true)", [actor.userId]);
    await client.query("SELECT demo.lock_source_control($1)", [scope.sessionId]);
    await assert.rejects(
      client.query(
        `INSERT INTO demo."DemoScenarioRun" (id,"organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"loadedRevision","configHash",config,"businessClock","actorUserId")
      SELECT 'accidental-worker',s."organizationId",s."workspaceId",s."storeId",s.id,s."connectionId",s."externalStoreId",c.generation,s.revision,s."configHash",s.config,s."clockNow",$2
      FROM demo."DemoCommerceSession" s JOIN public."PlatformConnection" c ON c.id=s."connectionId" WHERE s.id=$1`,
        [scope.sessionId, actor.userId],
      ),
      { code: "SM001" },
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
    await admin.query(
      'REVOKE SELECT,INSERT ON demo."DemoScenarioRun",demo."DemoScenarioRunAudit" FROM source_worker_login',
    );
    await admin.query(
      "REVOKE EXECUTE ON FUNCTION demo.has_scenario_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) FROM source_worker_login",
    );
  }
});
test("SQL independently rejects a future business clock even after a raw session update", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.user_id',$1,true)", [actor.userId]);
    await client.query("SELECT demo.lock_source_control($1)", [scope.sessionId]);
    await client.query('UPDATE demo."DemoCommerceSession" SET "clockNow"=$1 WHERE id=$2', [
      "9999-01-01T00:00:00Z",
      scope.sessionId,
    ]);
    await assert.rejects(
      client.query(
        `INSERT INTO demo."DemoScenarioRun" (id,"organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"loadedRevision","configHash",config,"businessClock","actorUserId")
      SELECT 'raw-future',s."organizationId",s."workspaceId",s."storeId",s.id,s."connectionId",s."externalStoreId",c.generation,s.revision,s."configHash",s.config,s."clockNow",$2
      FROM demo."DemoCommerceSession" s JOIN public."PlatformConnection" c ON c.id=s."connectionId" WHERE s.id=$1`,
        [scope.sessionId, actor.userId],
      ),
      { code: "23514" },
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
test("run history remains immutable and observes reset/disconnect generation fencing", async () => {
  await assert.rejects(
    admin.query('UPDATE demo."DemoScenarioRun" SET "configHash"=$1', ["f".repeat(64)]),
    { code: "23514" },
  );
  const before = await repo.findDemoSession(actor, scope.storeId),
    config = configFor(scope);
  assert.equal(
    (
      await repo.resetDemoSession(actor, scope.storeId, {
        expectedRevision: before.revision,
        config,
        configHash: hashConfig(config),
        generatorVersion: "mock-source-v1",
        clockNow: new Date(config.historyStart),
      })
    ).status,
    "WRITTEN",
  );
  let view = await repo.findDemoScenarios(actor, scope.storeId);
  assert.ok(view.runs.every((run) => run.status === "SUPERSEDED"));
  const loaded = await repo.loadDemoScenario(
    actor,
    scope.storeId,
    input(view.revision, view.generation),
  );
  assert.equal(loaded.status, "WRITTEN");
  view = loaded.view;
  assert.equal(
    (await repo.disconnectDemoSession(actor, scope.storeId, view.revision)).status,
    "WRITTEN",
  );
  view = await repo.findDemoScenarios(actor, scope.storeId);
  assert.equal(view.runs[0].status, "DISCONNECTED");
  assert.equal(
    (await repo.disconnectDemoSession(actor, scope.storeId, view.revision)).status,
    "WRITTEN",
  );
  view = await repo.findDemoScenarios(actor, scope.storeId);
  assert.equal(view.runs[0].status, "DISCONNECTED");
  assert.ok(view.runs.slice(1).every((run) => run.status === "SUPERSEDED"));
  assert.equal(
    (await repo.loadDemoScenario(actor, scope.storeId, input(view.revision, view.generation)))
      .status,
    "CONFLICT",
  );
});
