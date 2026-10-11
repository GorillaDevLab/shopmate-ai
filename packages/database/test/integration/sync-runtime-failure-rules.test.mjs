import assert from "node:assert/strict";
import test from "node:test";
import {
  createSyncDatabase,
  closeSyncDatabase,
  createSyncGrant,
  connectSyncWorker,
  syncScope,
} from "../helpers/sync-host-fixture.mjs";
import {
  beginControl,
  grantControl,
  operatorControl,
} from "../helpers/mock-source-control-fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { scopeFor, loginUrl } from "../helpers/mock-platform-fixture.mjs";
import pg from "pg";
import process from "node:process";
import { SyncWorkerPorts } from "../../dist/src/sync-host/index.js";

let database, worker, application;
const readRules = async (client, grant = "failure-a") =>
  (await client.query("SELECT sync_host.runtime_failure_rules($1) AS result", [grant])).rows[0]
    .result;
test.before(async () => {
  database = await createSyncDatabase("worker");
  await createSyncGrant(database.admin, syncScope(), "failure-a");
  await createSyncGrant(database.admin, syncScope("b"), "failure-b", "sync_foreign_login");
  worker = await connectSyncWorker(database.url, "sync_worker_login", "failure-a");
  await grantControl(database.admin, "source_app_login");
  await database.admin.query(
    'GRANT SELECT,INSERT,UPDATE ON demo."DemoFailureRule" TO source_app_login',
  );
  await database.admin.query(
    'GRANT SELECT,INSERT ON demo."DemoFailureRuleAudit" TO source_app_login',
  );
  await database.admin.query(
    'GRANT USAGE ON SEQUENCE demo."DemoFailureRuleAudit_id_seq" TO source_app_login',
  );
  await database.admin.query(
    "GRANT EXECUTE ON FUNCTION demo.has_failure_rule_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO source_app_login",
  );
  application = new pg.Client({ connectionString: loginUrl(database.url, "source_app_login") });
  await application.connect();
});
test.after(async () => {
  await worker?.end();
  await application?.end();
  if (database) await closeSyncDatabase(database);
});

async function createRule(id, priority, scope = scopeFor()) {
  await beginControl(application, scope.sessionId);
  try {
    await application.query(
      'UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=$1',
      [scope.sessionId],
    );
    await application.query(
      `INSERT INTO demo."DemoFailureRule"
      (id,"organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,
       priority,"startsAt","endsAt",methods,"effectKind","effectCode","retryAfterMs","createdRevision")
      SELECT $1,s."organizationId",s."workspaceId",s."storeId",s.id,s."connectionId",s."externalStoreId",c.generation,
       $2,s."clockNow",s."clockNow"+interval '1 day',ARRAY['listOrders'],'FAIL','RATE_LIMIT',1000,s.revision
      FROM demo."DemoCommerceSession" s JOIN public."PlatformConnection" c ON c.id=s."connectionId" WHERE s.id=$3`,
      [id, priority, scope.sessionId],
    );
    await application.query("COMMIT");
  } catch (error) {
    await application.query("ROLLBACK");
    throw error;
  }
}

test("grant-derived failure rules retain their exact binding and priority order", async () => {
  await createRule("rule-low", 1);
  await createRule("rule-high", 9);
  await createRule("foreign-rule", 99, scopeFor("b"));
  await worker.query(
    "SELECT set_config('app.user_id',$1,false),set_config('sync.grant_id',$2,false)",
    ["forged", "failure-b"],
  );
  const result = await readRules(worker);
  assert.deepEqual(result.context.scope, scopeFor());
  assert.equal(result.context.grantId, "failure-a");
  assert.equal(result.context.principalUserId, "source-worker");
  assert.equal(result.context.sessionRevision, 2);
  assert.deepEqual(
    result.rules.map((rule) => rule.id),
    ["rule-high", "rule-low"],
  );
  assert.deepEqual(result.rules[0].effect, {
    kind: "FAIL",
    code: "RATE_LIMIT",
    retryAfterMs: 1000,
  });
});

test("unknown, foreign and malformed grants or operator credentials reveal no rules", async () => {
  for (const grant of ["absent", "failure-b", null, "", "failure-a' OR true --"])
    assert.equal(await readRules(worker, grant), null);
  assert.equal(await readRules(database.admin), null);
  await worker.query("SET ROLE shopmate_sync_worker");
  try {
    assert.equal(await readRules(worker), null);
  } finally {
    await worker.query("RESET ROLE");
  }
});

test("current membership revocation hides persisted failure rules", async () => {
  await database.admin.query(
    'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
    ["INACTIVE", scopeFor().organizationId, "source-worker"],
  );
  try {
    assert.equal(await readRules(worker), null);
  } finally {
    await database.admin.query(
      'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
      ["ACTIVE", scopeFor().organizationId, "source-worker"],
    );
  }
});

test("the failure-rule RPC grants no direct table access or rule writes", async () => {
  const permissions = await database.admin.query(
    "SELECT has_table_privilege('sync_worker_login','demo.\"DemoFailureRule\"','SELECT') AS can_read,has_table_privilege('sync_worker_login','demo.\"DemoFailureRule\"','UPDATE') AS can_write",
  );
  assert.deepEqual(permissions.rows[0], { can_read: false, can_write: false });
  await assert.rejects(worker.query('SELECT * FROM demo."DemoFailureRule"'), { code: "42501" });
});

test("SDK derives the rule context on its pinned login and returns null after grant revocation", async () => {
  const previous = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
  let ports;
  try {
    ports = await SyncWorkerPorts.connectGrant("failure-a");
    const view = await ports.runtimeFailureRules();
    assert.equal(view.context.grantId, "failure-a");
    assert.deepEqual(
      view.rules.map((rule) => rule.id),
      ["rule-high", "rule-low"],
    );
    assert.ok(Object.isFrozen(view.rules[0].methods));
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      "failure-a",
    ]);
    assert.equal(await ports.runtimeFailureRules(), null);
  } finally {
    await ports?.close();
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "failure-a",
    ]);
    if (previous === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
    else process.env.SYNC_WORKER_DATABASE_URL = previous;
  }
});

async function waitForControl(pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (
      (
        await database.admin.query(
          "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
          [pid],
        )
      ).rowCount
    )
      return;
    await delay(10);
  }
  assert.fail("Expected failure read to wait for the real source control lock");
}

test("failure discovery rechecks grant authority after an actual control-lock wait", async () => {
  const pid = (await worker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await beginControl(application);
  const pending = readRules(worker);
  try {
    await waitForControl(pid);
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      "failure-a",
    ]);
    await application.query("COMMIT");
    assert.equal(await pending, null);
  } finally {
    await application.query("ROLLBACK");
    await pending;
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "failure-a",
    ]);
  }
});

test("production marker hides rules and restoring DEMO resumes the current view", async () => {
  await database.admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', [
    "PRODUCTION",
  ]);
  try {
    assert.equal(await readRules(worker), null);
  } finally {
    await database.admin.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  }
  assert.equal((await readRules(worker)).rules.length, 2);
});

test("removed and expired rules disappear without mutating retained rule facts", async () => {
  await beginControl(application);
  try {
    await application.query(
      'UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=$1',
      [scopeFor().sessionId],
    );
    await application.query(
      'UPDATE demo."DemoFailureRule" SET "removedRevision"=(SELECT revision FROM demo."DemoCommerceSession" WHERE id=$1) WHERE "sessionId"=$1 AND id=$2',
      [scopeFor().sessionId, "rule-high"],
    );
    await application.query("COMMIT");
  } catch (error) {
    await application.query("ROLLBACK");
    throw error;
  }
  assert.deepEqual(
    (await readRules(worker)).rules.map((rule) => rule.id),
    ["rule-low"],
  );
  await operatorControl(
    application,
    'UPDATE demo."DemoCommerceSession" SET "clockNow"="clockNow"+interval \'1 day\',"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$1',
    [scopeFor().sessionId],
  );
  assert.deepEqual((await readRules(worker)).rules, []);
  assert.equal(
    (
      await database.admin.query(
        'SELECT count(*)::integer AS count FROM demo."DemoFailureRule" WHERE "sessionId"=$1',
        [scopeFor().sessionId],
      )
    ).rows[0].count,
    2,
  );
});

test("generation replacement fences the old sync grant's failure metadata", async () => {
  await operatorControl(
    application,
    'UPDATE "PlatformConnection" SET generation=generation+1 WHERE id=$1',
    [scopeFor().connectionId],
  );
  assert.equal(await readRules(worker), null);
});
