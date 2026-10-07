import assert from "node:assert/strict";
import test from "node:test";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";
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
    await t.test("dangerous owner membership denies provisioning and current access", () =>
      assertDangerousRoleDenied(database),
    );
    await t.test("worker claims one stream job and expired takeover preserves its cursor", () =>
      assertLeaseRecovery(database),
    );
    await t.test("stream set and fixed window identity are constrained", () =>
      assertWindowContract(database),
    );
    await t.test("lease renewal and failure use current fences and DB wall time", () =>
      assertLeaseTransitions(database),
    );
    await t.test("completed windows continue without a gap", () => assertContinuity(database));
    await t.test("current membership, connection and grant revoke access to old jobs", () =>
      assertCurrentAuthority(database),
    );
    await t.test("generation reset starts a new window and fences old mutations", () =>
      assertGenerationReset(database),
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
  assert.equal(
    await admin
      .query(
        "SELECT has_column_privilege('shopmate_sync_worker','sync_host.\"Job\"','status','UPDATE') AS can_update",
      )
      .then((r) => r.rows[0].can_update),
    true,
  );
  assert.equal(
    await admin
      .query(
        "SELECT has_column_privilege('shopmate_sync_worker','sync_host.\"Job\"','cursor','UPDATE') AS can_update",
      )
      .then((r) => r.rows[0].can_update),
    false,
  );
}

async function assertGrantIdentity(url) {
  const worker = await connectSyncWorker(url);
  const foreign = await connectSyncWorker(url, "sync_foreign_login", "sync-grant-b");
  try {
    assert.equal(
      (await worker.query("SELECT session_user=current_user AS exact_login")).rows[0].exact_login,
      true,
    );
    assert.deepEqual((await worker.query('SELECT id FROM sync_host."WorkerGrant"')).rows, [
      { id: "sync-grant-a" },
    ]);
    assert.deepEqual((await foreign.query('SELECT id FROM sync_host."WorkerGrant"')).rows, [
      { id: "sync-grant-b" },
    ]);
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-b',false)");
    assert.equal((await worker.query('SELECT id FROM sync_host."WorkerGrant"')).rowCount, 0);
    await worker.query("SET ROLE shopmate_sync_worker");
    await worker.query("SELECT set_config('sync.grant_id','sync-grant-a',false)");
    assert.equal((await worker.query('SELECT id FROM sync_host."WorkerGrant"')).rowCount, 0);
  } finally {
    await worker.end();
    await foreign.end();
  }
}

async function assertLeaseTransitions(database) {
  const worker = await connectSyncWorker(database.url);
  try {
    const claimed = await claimJob(worker, "job-inventory", "inventory-owner");
    assert.equal(claimed.fence, 1);
    await assertPeerLeaseDenied(database.url, claimed.id);
    await assert.rejects(
      worker.query('UPDATE sync_host."Job" SET status=$1 WHERE id=$2', ["SUCCEEDED", claimed.id]),
      (e) => e.code === "23514",
    );
    const renewed = await worker.query(
      'UPDATE sync_host."Job" SET "leaseUntil"=$1 WHERE id=$2 AND fence=$3 RETURNING EXTRACT(EPOCH FROM "leaseUntil"-clock_timestamp()) AS seconds',
      ["2099-01-01", claimed.id, 1],
    );
    assert.ok(Number(renewed.rows[0].seconds) > 119 && Number(renewed.rows[0].seconds) <= 120);
    assert.equal(
      (
        await worker.query(
          'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp() WHERE id=$1 AND fence=$2',
          [claimed.id, 0],
        )
      ).rowCount,
      0,
    );
    await worker.query(
      'UPDATE sync_host."Job" SET status=$1,"failureCode"=$2 WHERE id=$3 AND fence=$4',
      ["FAILED", "READ_TIMEOUT", claimed.id, 1],
    );
    const failed = (
      await worker.query(
        'SELECT status,"leaseOwner","leaseUntil" FROM sync_host."Job" WHERE id=$1',
        [claimed.id],
      )
    ).rows[0];
    assert.deepEqual(failed, { status: "FAILED", leaseOwner: null, leaseUntil: null });
    const retry = await worker.query(
      'UPDATE sync_host."Job" SET status=$1,fence=fence+1,"leaseOwner"=$2,"failureCode"=NULL WHERE id=$3 RETURNING fence',
      ["RUNNING", "inventory-retry", claimed.id],
    );
    assert.equal(retry.rows[0].fence, 2);
  } finally {
    await worker.end();
  }
}

async function assertPeerLeaseDenied(url, id) {
  const peer = await connectSyncWorker(url);
  try {
    await assert.rejects(
      peer.query(
        'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp() WHERE id=$1 AND fence=$2',
        [id, 1],
      ),
      (e) => e.code === "23514",
    );
    await assert.rejects(
      peer.query('UPDATE sync_host."Job" SET status=$1,"failureCode"=$2 WHERE id=$3 AND fence=$4', [
        "FAILED",
        "READ_TIMEOUT",
        id,
        1,
      ]),
      (e) => e.code === "23514",
    );
  } finally {
    await peer.end();
  }
}

async function assertDangerousRoleDenied(database) {
  await database.admin.query("CREATE ROLE sync_object_owner NOLOGIN NOSUPERUSER NOBYPASSRLS");
  await database.admin.query("CREATE TABLE sync_host.owner_probe (id integer)");
  await database.admin.query("ALTER TABLE sync_host.owner_probe OWNER TO sync_object_owner");
  await database.admin.query("GRANT sync_object_owner TO sync_worker_login");
  const worker = await connectSyncWorker(database.url);
  try {
    await assert.rejects(
      createSyncGrant(database.admin, syncScope(), "unsafe-owner-grant"),
      (e) => e.code === "23514",
    );
    assert.equal((await worker.query('SELECT id FROM sync_host."WorkerGrant"')).rowCount, 0);
    await assert.rejects(
      insertJob(worker, "unsafe-owner-job", syncScope(), "PRODUCTS"),
      (e) => e.code === "42501",
    );
  } finally {
    await worker.end();
    await database.admin.query("REVOKE sync_object_owner FROM sync_worker_login");
    await database.admin.query("DROP TABLE sync_host.owner_probe");
    await database.admin.query("DROP ROLE sync_object_owner");
  }
}

async function assertContinuity(database) {
  const worker = await connectSyncWorker(database.url);
  try {
    await assert.rejects(
      insertJob(worker, "duplicate-open", syncScope(), "MARKETING"),
      (e) => e.code === "23505",
    );
    await assert.rejects(
      insertJob(worker, "invalid-stream", syncScope(), "PAYMENTS"),
      (e) => e.code === "23514",
    );
    // Operator completion stands in for the later atomic page-ingest capability.
    await database.admin.query(
      'UPDATE sync_host."Job" SET status=$1,"successfulThrough"=until WHERE id=$2',
      ["SUCCEEDED", "job-marketing"],
    );
    await assert.rejects(
      insertJob(
        worker,
        "gap-window",
        syncScope(),
        "MARKETING",
        "2026-01-02T00:00:01.000Z",
        "2026-01-03",
      ),
      (e) => e.code === "23514",
    );
    await insertJob(
      worker,
      "continuous-window",
      syncScope(),
      "MARKETING",
      firstUntil,
      "2026-01-03",
    );
    assert.equal(
      (
        await worker.query('SELECT since=$1::timestamp AS exact FROM sync_host."Job" WHERE id=$2', [
          firstUntil,
          "continuous-window",
        ])
      ).rows[0].exact,
      true,
    );
  } finally {
    await worker.end();
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
      restarted.query('UPDATE sync_host."Job" SET "successfulThrough"=$1 WHERE id=$2', [
        firstUntil,
        "sync-job-a",
      ]),
      (error) => error.code === "42501",
    );
  } finally {
    await restarted.end();
  }
}

async function assertWindowContract(database) {
  const worker = await connectSyncWorker(database.url);
  try {
    for (const stream of streams.filter((value) => value !== "PRODUCTS"))
      await insertJob(worker, `job-${stream.toLowerCase()}`, syncScope(), stream);
    assert.equal((await worker.query('SELECT id FROM sync_host."Job"')).rowCount, streams.length);
    await assert.rejects(
      insertJob(worker, "job-invalid-window", syncScope(), "ORDERS", "2026-01-01T00:00:01.000Z"),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      insertJob(
        worker,
        "job-too-wide",
        syncScope(),
        "ORDERS",
        firstSince,
        "2026-03-01T00:00:00.000Z",
      ),
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
    const jobId = "job-orders";
    await database.admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "INACTIVE",
      "source-worker",
    ]);
    assert.equal(
      (await worker.query('SELECT id FROM sync_host."Job" WHERE id=$1', [jobId])).rowCount,
      0,
    );
    await database.admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "ACTIVE",
      "source-worker",
    ]);
    await operatorControl(
      database.admin,
      'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1',
      [syncScope().connectionId],
    );
    assert.equal(
      (await worker.query('SELECT id FROM sync_host."Job" WHERE id=$1', [jobId])).rowCount,
      0,
    );
    const stored = await database.admin.query(
      'SELECT status,fence FROM sync_host."Job" WHERE id=$1',
      [jobId],
    );
    assert.deepEqual(stored.rows[0], { status: "READY", fence: 0 });
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      "sync-grant-a",
    ]);
    assert.equal(
      (await worker.query('SELECT id FROM sync_host."Job" WHERE id=$1', [jobId])).rowCount,
      0,
    );
  } finally {
    await worker.end();
  }
}

async function assertGenerationReset(database) {
  await createSyncGrant(database.admin, syncScope("a", 1), "sync-grant-new");
  const worker = await connectSyncWorker(database.url, "sync_worker_login", "sync-grant-new");
  try {
    assert.equal(
      (
        await worker.query('UPDATE sync_host."Job" SET status=$1 WHERE id=$2', [
          "FAILED",
          "sync-job-a",
        ])
      ).rowCount,
      0,
    );
    const scope = syncScope("a", 1);
    await worker.query(
      'INSERT INTO sync_host."Job" (id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        "generation-one-job",
        "sync-grant-new",
        scope.organizationId,
        scope.workspaceId,
        scope.storeId,
        scope.connectionId,
        scope.externalStoreId,
        scope.provider,
        1,
        "PRODUCTS",
        firstSince,
        firstUntil,
      ],
    );
    assert.deepEqual((await worker.query('SELECT id FROM sync_host."Job"')).rows, [
      { id: "generation-one-job" },
    ]);
  } finally {
    await worker.end();
  }
}

async function insertJob(client, id, scope, stream, since = firstSince, until = firstUntil) {
  const result = await client.query(
    'INSERT INTO sync_host."Job" (id,"grantId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,stream,since,until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,status,fence',
    [
      id,
      "sync-grant-a",
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      scope.provider,
      scope.generation,
      stream,
      since,
      until,
    ],
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
