import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSyncDatabase,
  connectSyncWorker,
  createSyncDatabase,
  createSyncGrant,
  syncScope,
} from "../helpers/sync-host-fixture.mjs";

const streams = ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"];
const firstSince = "2026-01-01T00:00:00.000Z";
const firstUntil = "2026-01-02T00:00:00.000Z";

test("generic sync host persists scoped fixed-window jobs under restricted worker login", async (t) => {
  const database = await createSyncDatabase();
  try {
    await t.test("migration creates forced RLS tables and a non-login worker group", () =>
      assertRlsContract(database.admin),
    );
    await createSyncGrant(database.admin, syncScope(), "sync-grant-a");
    await createSyncGrant(database.admin, syncScope("b"), "sync-grant-b", "sync_foreign_login");
    await t.test("worker sees only its operator grant and cannot elevate", () =>
      assertGrantIdentity(database.url),
    );
    await t.test("grant provisioning requires an exact active VIEWER workspace scope", () =>
      assertInvalidGrantDenied(database.admin),
    );
    await t.test("worker claims one stream job and expired takeover preserves its cursor", () =>
      assertLeaseRecovery(database),
    );
    await t.test("stream set and fixed window identity are constrained", () =>
      assertWindowContract(database),
    );
    await t.test("current membership, connection and grant revoke access to old jobs", () =>
      assertCurrentAuthority(database),
    );
  } finally {
    await closeSyncDatabase(database);
  }
});

async function assertRlsContract(admin) {
  const relations = await admin.query(
    "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.oid IN ('sync_host.\"WorkerGrant\"'::regclass,'sync_host.\"Job\"'::regclass) ORDER BY c.relname",
  );
  assert.deepEqual(relations.rows, [
    { relname: "Job", relrowsecurity: true, relforcerowsecurity: true },
    { relname: "WorkerGrant", relrowsecurity: true, relforcerowsecurity: true },
  ]);
  const role = await admin.query(
    "SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='shopmate_sync_worker'",
  );
  assert.deepEqual(role.rows[0], { rolcanlogin: false, rolsuper: false, rolbypassrls: false });
  assert.equal(await admin.query("SELECT has_table_privilege('shopmate_sync_worker','sync_host.\"Job\"','UPDATE') AS can_update").then((r) => r.rows[0].can_update), true);
  assert.equal(await admin.query("SELECT has_column_privilege('shopmate_sync_worker','sync_host.\"Job\"','cursor','UPDATE') AS can_update").then((r) => r.rows[0].can_update), false);
}

async function assertGrantIdentity(url) {
  const worker = await connectSyncWorker(url);
  const foreign = await connectSyncWorker(url, "sync_foreign_login", "sync-grant-b");
  try {
    assert.equal((await worker.query("SELECT session_user=current_user AS exact_login")).rows[0].exact_login, true);
    assert.deepEqual((await worker.query('SELECT id FROM sync_host."WorkerGrant"')).rows, [{ id: "sync-grant-a" }]);
    assert.deepEqual((await foreign.query('SELECT id FROM sync_host."WorkerGrant"')).rows, [{ id: "sync-grant-b" }]);
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-b',false)");
    assert.equal((await worker.query('SELECT id FROM sync_host."WorkerGrant"')).rowCount, 0);
  } finally {
    await worker.end();
    await foreign.end();
  }
}

async function assertInvalidGrantDenied(admin) {
  await assert.rejects(
    createSyncGrant(admin, syncScope(), "sync-grant-owner", "sync_worker_login", "source-human"),
    (error) => error.code === "23514",
  );
  const mismatch = { ...syncScope(), externalStoreId: "mock/store.b" };
  await assert.rejects(
    createSyncGrant(admin, mismatch, "sync-grant-mismatch"),
    (error) => error.code === "23514",
  );
}

async function assertLeaseRecovery(database) {
  const scope = syncScope();
  const first = await connectSyncWorker(database.url);
  const second = await connectSyncWorker(database.url);
  try {
    await insertJob(first, "sync-job-a", scope, "PRODUCTS");
    const claimed = await claimJob(first, "sync-job-a", "worker-attempt-1");
    assert.equal(claimed.fence, 1);
    assert.equal((await claimJob(second, "sync-job-a", "worker-attempt-2")).id, undefined);
    await database.admin.query(
      'UPDATE sync_host."Job" SET cursor=$1::jsonb,"leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$2',
      ['{"page":"next"}', "sync-job-a"],
    );
  } finally {
    await first.end();
    await second.end();
  }
  const restarted = await connectSyncWorker(database.url);
  try {
    const recovered = await claimJob(restarted, "sync-job-a", "worker-after-restart");
    assert.equal(recovered.fence, 2);
    assert.equal(recovered.cursor.page, "next");
    assert.equal(recovered.leaseOwner, "worker-after-restart");
    await assert.rejects(
      restarted.query('UPDATE sync_host."Job" SET cursor=NULL WHERE id=$1', ["sync-job-a"]),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      restarted.query('UPDATE sync_host."Job" SET "successfulThrough"=$1 WHERE id=$2', [firstUntil, "sync-job-a"]),
      (error) => error.code === "42501",
    );
  } finally {
    await restarted.end();
  }
}

async function assertWindowContract(database) {
  const worker = await connectSyncWorker(database.url);
  try {
    for (const stream of streams) await insertJob(worker, `job-${stream.toLowerCase()}`, syncScope(), stream);
    assert.equal((await worker.query('SELECT id FROM sync_host."Job"')).rowCount, streams.length);
    await assert.rejects(
      insertJob(worker, "job-invalid-window", syncScope(), "ORDERS", "2026-01-01T00:00:01.000Z"),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      insertJob(worker, "job-too-wide", syncScope(), "ORDERS", firstSince, "2026-03-01T00:00:00.000Z"),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      worker.query('UPDATE sync_host."Job" SET since=$1 WHERE id=$2', [firstUntil, "job-orders"]),
      (error) => error.code === "42501",
    );
  } finally {
    await worker.end();
  }
}

async function assertCurrentAuthority(database) {
  const worker = await connectSyncWorker(database.url);
  try {
    await insertJob(worker, "sync-job-current", syncScope(), "ORDERS");
    await database.admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "INACTIVE",
      "source-worker",
    ]);
    assert.equal((await worker.query('SELECT id FROM sync_host."Job" WHERE id=$1', ["sync-job-current"])).rowCount, 0);
    await database.admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "ACTIVE",
      "source-worker",
    ]);
    await database.admin.query('UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
      syncScope().connectionId,
    ]);
    assert.equal((await worker.query('SELECT id FROM sync_host."Job" WHERE id=$1', ["sync-job-current"])).rowCount, 0);
    const stored = await database.admin.query('SELECT status,fence FROM sync_host."Job" WHERE id=$1', ["sync-job-current"]);
    assert.deepEqual(stored.rows[0], { status: "READY", fence: 0 });
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', ["REVOKED", "sync-grant-a"]);
    assert.equal((await worker.query('SELECT id FROM sync_host."Job" WHERE id=$1', ["sync-job-current"])).rowCount, 0);
  } finally {
    await worker.end();
  }
}

async function insertJob(client, id, scope, stream, since = firstSince, until = firstUntil) {
  const result = await client.query(
    'INSERT INTO sync_host."Job" (id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,status,fence',
    [id, "sync-grant-a", scope.organizationId, scope.workspaceId, scope.storeId, scope.connectionId, scope.externalStoreId, scope.provider, scope.generation, stream, since, until],
  );
  return result.rows[0];
}

async function claimJob(client, id, owner) {
  const result = await client.query(
    `UPDATE sync_host."Job" SET status='RUNNING',fence=fence+1,"leaseOwner"=$1,"leaseUntil"=clock_timestamp()+interval '2 minutes'
     WHERE id=$2 AND (status IN ('READY','FAILED') OR status='RUNNING' AND "leaseUntil"<=clock_timestamp())
     RETURNING id,status,fence,"leaseOwner","leaseUntil",cursor`,
    [owner, id],
  );
  return result.rows[0] ?? {};
}
