import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSyncDatabase,
  closeSyncDatabase,
  createSyncGrant,
  connectSyncWorker,
  syncScope,
} from "../helpers/sync-host-fixture.mjs";
import { sourceEnv, scopeFor } from "../helpers/mock-platform-fixture.mjs";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import { createMockSourceWorker } from "../../dist/src/mock-platform/index.js";

let database, worker;
const bootstrap = async (client, grant = "bootstrap-a") =>
  (await client.query("SELECT sync_host.runtime_bootstrap($1) AS result", [grant])).rows[0].result;
test.before(async () => {
  database = await createSyncDatabase("worker");
  await createSyncGrant(database.admin, syncScope(), "bootstrap-a");
  await createSyncGrant(database.admin, syncScope("b"), "bootstrap-b", "sync_foreign_login");
  worker = await connectSyncWorker(database.url, "sync_worker_login", "bootstrap-a");
});
test.after(async () => {
  await worker?.end();
  if (database) await closeSyncDatabase(database);
});

test("bootstrap derives its exact current identity and configured state without caller identity", async () => {
  await worker.query(
    "SELECT set_config('app.user_id',$1,false),set_config('sync.grant_id',$2,false)",
    ["forged", "bootstrap-b"],
  );
  const result = await bootstrap(worker);
  assert.equal(result.principalUserId, "source-worker");
  assert.equal(result.merchantId, "source-merchant-a");
  assert.deepEqual(result.scope, scopeFor());
  assert.equal(result.businessNow, "2025-12-31T16:00:00.000Z");
  assert.equal(result.initialSince, "2026-01-01T00:00:00.000Z");
  assert.equal(result.runtimeOpening, null);
  assert.equal(result.state, "WAITING_RUNTIME");
  assert.deepEqual(
    result.config,
    (
      await database.admin.query('SELECT config FROM demo."DemoCommerceSession" WHERE id=$1', [
        scopeFor().sessionId,
      ])
    ).rows[0].config,
  );
});

test("bootstrap finds the actual frozen runtime and current business clock", async () => {
  const source = createMockSourceWorker(sourceEnv(database.url));
  try {
    assert.equal(
      (await source.initializeGeneration({ grantId: "source-grant-a" }, scopeFor())).status,
      "CREATED",
    );
  } finally {
    await source.close();
  }
  await operatorControl(
    database.admin,
    'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$2',
    ["2026-01-02T16:00:00.000Z", scopeFor().sessionId],
  );
  const result = await bootstrap(worker);
  assert.equal(result.state, "READY");
  assert.equal(result.runtimeOpening, "2025-12-31T16:00:00.000Z");
  assert.equal(result.businessNow, "2026-01-02T16:00:00.000Z");
  assert.equal(result.clockRevision, 1);
});

test("unknown, foreign and malformed grant identifiers reveal no bootstrap", async () => {
  for (const id of ["absent", "bootstrap-b", "", "a".repeat(129), "bootstrap-a' OR true --", null])
    assert.equal(await bootstrap(worker, id), null);
  assert.equal(await bootstrap(database.admin), null);
  await worker.query("SET ROLE shopmate_sync_worker");
  try {
    assert.equal(await bootstrap(worker), null);
  } finally {
    await worker.query("RESET ROLE");
  }
});

test("bootstrap rechecks live membership and production marker", async () => {
  await database.admin.query(
    'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
    ["INACTIVE", syncScope().organizationId, "source-worker"],
  );
  try {
    assert.equal(await bootstrap(worker), null);
  } finally {
    await database.admin.query(
      'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
      ["ACTIVE", syncScope().organizationId, "source-worker"],
    );
  }
  await database.admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', [
    "PRODUCTION",
  ]);
  try {
    assert.equal(await bootstrap(worker), null);
  } finally {
    await database.admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  }
});

async function waitForControlLock(pid) {
  for (let count = 0; count < 50; count++) {
    const result = await database.admin.query(
      "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
      [pid],
    );
    if (result.rowCount) return;
    await delay(20);
  }
  assert.fail("bootstrap must actually wait on the control lock");
}

test("bootstrap rereads grant authority after a real control lock wait", async () => {
  const pid = (await worker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await database.admin.query("BEGIN");
  let waiting;
  try {
    await database.admin.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
    waiting = bootstrap(worker).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await waitForControlLock(pid);
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      "bootstrap-a",
    ]);
    await database.admin.query("COMMIT");
    assert.deepEqual(await waiting, { result: null });
  } finally {
    await database.admin.query("ROLLBACK");
    if (waiting) await waiting;
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "bootstrap-a",
    ]);
  }
  assert.equal((await bootstrap(worker)).state, "READY");
});

test("the private descriptor is not callable and bootstrap does not establish a forged grant", async () => {
  await assert.rejects(worker.query("SELECT sync_host.bootstrap_descriptor($1)", ["bootstrap-a"]), {
    code: "42501",
  });
  const settings = (
    await worker.query(
      "SELECT current_setting('app.user_id') AS principal,current_setting('sync.grant_id') AS grant",
    )
  ).rows[0];
  await bootstrap(worker);
  assert.deepEqual(
    (
      await worker.query(
        "SELECT current_setting('app.user_id') AS principal,current_setting('sync.grant_id') AS grant",
      )
    ).rows[0],
    settings,
  );
});

test("bootstrap exposes no broad table permissions and fences reset generations", async () => {
  const permissions = await database.admin.query(
    "SELECT has_table_privilege('sync_worker_login','demo.\"DemoCommerceSession\"','SELECT') AS session_read, has_table_privilege('sync_worker_login','mock_platform.\"Runtime\"','SELECT') AS runtime_read",
  );
  assert.deepEqual(permissions.rows[0], { session_read: false, runtime_read: false });
  await operatorControl(
    database.admin,
    'UPDATE public."PlatformConnection" SET generation=generation+1 WHERE id=$1',
    [scopeFor().connectionId],
  );
  assert.equal(await bootstrap(worker), null);
});
