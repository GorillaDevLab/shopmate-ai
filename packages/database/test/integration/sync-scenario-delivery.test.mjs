import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { SyncWorkerPorts } from "../../dist/src/sync-host/index.js";
import { createMockSourceWorker } from "../../dist/src/mock-platform/index.js";
import {
  createSyncDatabase,
  closeSyncDatabase,
  createSyncGrant,
} from "../helpers/sync-host-fixture.mjs";
import { grantControl } from "../helpers/mock-source-control-fixture.mjs";
import {
  scopeFor,
  configFor,
  hashConfig,
  loginUrl,
  readerActor,
  sourceEnv,
  grantSource,
} from "../helpers/mock-platform-fixture.mjs";
let database, repo, host, source, oldDb, oldWorker;
const scope = scopeFor("a", 1),
  until = "2026-01-02T00:00:00.000Z";
const page = { items: [], nextCursor: null, observedAt: until, sourceWatermark: until };
test.before(async () => {
  database = await createSyncDatabase("worker");
  await grantControl(database.admin, "scenario_delivery_app");
  await database.admin.query(
    'GRANT SELECT,INSERT ON demo."DemoScenarioRun",demo."DemoScenarioRunAudit" TO scenario_delivery_app',
  );
  await database.admin.query(
    "GRANT EXECUTE ON FUNCTION demo.has_scenario_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO scenario_delivery_app",
  );
  oldDb = process.env.DATABASE_URL;
  oldWorker = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.DATABASE_URL = loginUrl(database.url, "scenario_delivery_app");
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
  repo = await import("../../dist/src/index.js");
  const config = configFor(scope);
  config.scenarioPlan = {
    version: "mock-scenario-v1",
    scenarioId: "SCENARIO_010",
    externalStoreId: scope.externalStoreId,
    startDay: 3,
    endDay: 9,
    mutations: [],
    campaignSpendBps: 10000,
    campaignConversionBps: 10000,
    delivery: { kind: "REPLAY_SAVED_PAGE", repetitions: 2 },
  };
  const loaded = await repo.loadDemoScenario(readerActor, scope.storeId, {
    runId: "delivery-run",
    confirmSessionId: scope.sessionId,
    expectedRevision: 0,
    expectedGeneration: 0,
    config,
    configHash: hashConfig(config),
    generatorVersion: "mock-source-v2",
    clockNow: new Date(until),
  });
  assert.equal(loaded.status, "WRITTEN");
  await grantSource(database.admin, scope, "delivery-source");
  source = createMockSourceWorker(sourceEnv(database.url));
  assert.equal(
    (await source.initializeGeneration({ grantId: "delivery-source" }, scope)).status,
    "CREATED",
  );
  await createSyncGrant(database.admin, scope, "delivery-sync");
  host = await SyncWorkerPorts.connectGrant("delivery-sync");
});
test.after(async () => {
  await host?.close();
  await source?.close();
  await repo?.disconnectPrismaClient();
  if (oldDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldDb;
  if (oldWorker === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
  else process.env.SYNC_WORKER_DATABASE_URL = oldWorker;
  if (database) await closeSyncDatabase(database);
});
test("LOAD 010 durably selects the original terminal page and atomically acknowledges exact extra attempts", async () => {
  assert.equal(
    typeof host.commitDeliveryPage,
    "function",
    "scenario saved-page commit port must exist",
  );
  const job = await host.claim(await host.createWindow("PRODUCTS", until));
  const committed = await host.commitDeliveryPage(job, "page-1", null, page);
  assert.equal(committed.status, "SUCCEEDED");
  const pending = await host.pendingDeliveryReplays();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempt, 1);
  assert.equal(pending[0].job.id, job.id);
  const before = (await database.admin.query('SELECT * FROM sync_host."Job" WHERE id=$1', [job.id]))
    .rows;
  await host.replayDelivery(pending[0]);
  await host.replayDelivery(pending[0]); // Lost replay ACK repeats its ordinal without adding another attempt.
  assert.equal((await host.pendingDeliveryReplays())[0].attempt, 2);
  await host.close();
  host = await SyncWorkerPorts.connectGrant("delivery-sync");
  await host.replayDelivery((await host.pendingDeliveryReplays())[0]);
  assert.deepEqual(await host.pendingDeliveryReplays(), []);
  assert.deepEqual(
    (await database.admin.query('SELECT * FROM sync_host."Job" WHERE id=$1', [job.id])).rows,
    before,
  );
  const saved = (await database.admin.query('SELECT * FROM sync_host."ScenarioDelivery"')).rows[0];
  assert.equal(saved.attempts, 2);
  assert.equal(saved.pageBytes, JSON.stringify(page));
  assert.equal(
    (
      await database.admin.query(
        'SELECT count(*)::int n FROM sync_host."PageReceipt" WHERE "jobId"=$1',
        [job.id],
      )
    ).rows[0].n,
    1,
  );
});

async function snapshot(jobId) {
  return (
    await database.admin.query(
      `SELECT to_jsonb(j) AS job,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r."pageId") FROM sync_host."PageReceipt" r WHERE r."jobId"=j.id) receipts,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c."pageId") FROM sync_host."CanonicalPageCommit" c WHERE c."jobId"=j.id) commits,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d."pageId",d.ordinal) FROM sync_host."CanonicalPageDecision" d WHERE d."jobId"=j.id) decisions,
    (SELECT count(*)::int FROM sync_host."CanonicalQuarantine" q WHERE q."jobId"=j.id) quarantines
    FROM sync_host."Job" j WHERE j.id=$1`,
      [jobId],
    )
  ).rows[0];
}
test("saved nonterminal bytes replay only after a later accepted page and retain the latest receipt graph", async () => {
  let job = await host.claim(await host.createWindow("ORDERS", until));
  const original = { ...page, nextCursor: "saved-next" };
  job = await host.commitDeliveryPage(job, "page-1", null, original);
  assert.deepEqual(await host.pendingDeliveryReplays(), []);
  job = await host.commitDeliveryPage(job, "page-2", "saved-next", {
    ...page,
    nextCursor: "later-next",
  });
  const before = await snapshot(job.id),
    pending = (await host.pendingDeliveryReplays())[0];
  assert.equal(pending.job.pageCount, 2);
  await assert.rejects(
    host.replayDelivery({ ...pending, job: { ...pending.job, fence: pending.job.fence - 1 } }),
    /SYNC_WORKER_OPERATION_FAILED/,
  );
  for (const [id, cursor, bytes] of [
    ["changed-page", null, original],
    ["page-1", "changed-cursor", original],
    ["page-1", null, { ...original, observedAt: "2026-01-02T00:00:00.001Z" }],
  ])
    await assert.rejects(host.commitPage(job, id, cursor, bytes), /SYNC_WORKER_OPERATION_FAILED/);
  assert.equal(await host.replayDelivery(pending), "REPLAYED");
  // Lease renewal is permitted; causal progress, decisions and receipt bytes must remain exact.
  const after = await snapshot(job.id);
  delete before.job.leaseUntil;
  delete after.job.leaseUntil;
  assert.deepEqual(after, before);
  const saved = (
    await database.admin.query('SELECT * FROM sync_host."ScenarioDelivery" WHERE "jobId"=$1', [
      job.id,
    ])
  ).rows[0];
  assert.equal(saved.pageBytes, JSON.stringify(original));
  assert.equal(saved.pageId, "page-1");
  assert.equal(saved.expectedCursor, null);
  await host.commitDeliveryPage(job, "page-3", "later-next", page);
  await host.replayDelivery((await host.pendingDeliveryReplays())[0]);
  assert.deepEqual(await host.pendingDeliveryReplays(), []);
});
test("failure before atomic save completes rolls original ingestion and selection back together", async () => {
  const job = await host.claim(await host.createWindow("INVENTORY", until));
  await database.admin.query(
    `CREATE FUNCTION sync_host.test_delivery_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_CRASH'; END $$`,
  );
  await database.admin.query(
    'CREATE TRIGGER test_delivery_crash BEFORE INSERT ON sync_host."ScenarioDelivery" FOR EACH ROW EXECUTE FUNCTION sync_host.test_delivery_crash()',
  );
  const before = await snapshot(job.id);
  try {
    await assert.rejects(
      host.commitDeliveryPage(job, "page-1", null, page),
      /SYNC_WORKER_OPERATION_FAILED/,
    );
  } finally {
    await database.admin.query('DROP TRIGGER test_delivery_crash ON sync_host."ScenarioDelivery"');
    await database.admin.query("DROP FUNCTION sync_host.test_delivery_crash()");
  }
  assert.deepEqual(await snapshot(job.id), before);
  assert.equal(
    (
      await database.admin.query(
        'SELECT count(*)::int n FROM sync_host."ScenarioDelivery" WHERE "jobId"=$1',
        [job.id],
      )
    ).rows[0].n,
    0,
  );
  await host.commitDeliveryPage(job, "page-1", null, page);
  for (let n = 0; n < 2; n++) await host.replayDelivery((await host.pendingDeliveryReplays())[0]);
});
test("lost original ACK and lost replay ACK recover without a source refetch, including older completed windows", async () => {
  const job = await host.claim(await host.createWindow("MARKETING", until));
  await assert.rejects(async () => {
    await host.commitDeliveryPage(job, "page-1", null, page);
    throw new Error("TEST_ACK_LOST");
  }, /TEST_ACK_LOST/);
  const pending = (await host.pendingDeliveryReplays())[0],
    before = await snapshot(job.id);
  await host.close();
  host = await SyncWorkerPorts.connectGrant("delivery-sync");
  // A newer latest job does not hide the durable replay of the older completed job.
  await host.createWindow("MARKETING", "2026-01-02T01:00:00.000Z");
  assert.equal((await host.pendingDeliveryReplays())[0].job.id, job.id);
  await assert.rejects(async () => {
    await host.replayDelivery(pending);
    throw new Error("TEST_ACK_LOST");
  }, /TEST_ACK_LOST/);
  await host.close();
  host = await SyncWorkerPorts.connectGrant("delivery-sync");
  assert.equal(await host.replayDelivery(pending), "ACKNOWLEDGED");
  await host.replayDelivery((await host.pendingDeliveryReplays())[0]);
  assert.deepEqual(await snapshot(job.id), before);
});
test("saved envelopes have no direct role access and are immutable even to accidental operator updates", async () => {
  for (const role of ["sync_worker_login", "source_worker_login", "source_read_login"])
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      assert.equal(
        (
          await database.admin.query(
            "SELECT has_table_privilege($1,'sync_host.\"ScenarioDelivery\"',$2) allowed",
            [role, privilege],
          )
        ).rows[0].allowed,
        false,
      );
  await assert.rejects(
    database.admin.query('UPDATE sync_host."ScenarioDelivery" SET "pageBytes"=$1', [
      JSON.stringify(page),
    ]),
    { code: "23514" },
  );
  await assert.rejects(database.admin.query('DELETE FROM sync_host."ScenarioDelivery"'), {
    code: "23514",
  });
  assert.equal(
    (
      await database.admin.query(
        "SELECT relrowsecurity AND relforcerowsecurity AS protected FROM pg_class WHERE oid='sync_host.\"ScenarioDelivery\"'::regclass",
      )
    ).rows[0].protected,
    true,
  );
});
