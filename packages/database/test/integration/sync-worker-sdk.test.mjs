import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { SyncWorkerPorts } from "../../dist/src/sync-host/index.js";
import { loginUrl } from "../helpers/mock-platform-fixture.mjs";
import { createSyncDatabase, closeSyncDatabase, createSyncGrant, syncScope } from "../helpers/sync-host-fixture.mjs";
let database;
const until = "2026-01-02T00:00:00.000Z";
const page = () => ({ items: [], nextCursor: null, observedAt: until, sourceWatermark: null });
test.before(async () => {
 database = await createSyncDatabase("worker");
 await createSyncGrant(database.admin, syncScope(), "sync-grant-a");
});
test.after(async () => { if (database) await closeSyncDatabase(database); });
test("worker fixtures own sibling databases and preserve a populated supplied database", async () => {
  const previous = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = database.url;
  let sibling;
  try {
    sibling = await createSyncDatabase("worker");
    assert.notEqual(sibling.url, database.url);
    const name = sibling.ownedDatabase;
    await closeSyncDatabase(sibling); sibling = null;
    assert.equal((await database.admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount, 0);
    assert.equal((await database.admin.query('SELECT 1 FROM sync_host."WorkerGrant" WHERE id=\'sync-grant-a\'')).rowCount, 1);
  } finally {
    if (sibling) await closeSyncDatabase(sibling);
    if (previous === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previous;
  }
});
test("SDK keeps fetch outside SQL transactions and refuses application operator connections", async () => {
  const previous = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
  let ports;
  try {
    ports = await SyncWorkerPorts.connect({ principalUserId: "source-worker", grantId: "sync-grant-a" });
    const job = await ports.createWindow("INVENTORY", until);
    let calls = 0;
    const done = await ports.run(job, async ({ limit, cursor }) => {
      assert.equal(limit, 200); assert.equal(cursor, null); calls++;
      const state = await database.admin.query("SELECT state FROM pg_stat_activity WHERE application_name='shopmate-sync-worker'");
      assert.equal(state.rows[0].state, "idle");
      return { ...page(), observedAt: until };
    });
    assert.equal(done.status, "SUCCEEDED"); assert.equal(calls, 1);
    process.env.SYNC_WORKER_DATABASE_URL = database.url;
    await assert.rejects(SyncWorkerPorts.connect({ principalUserId: "source-worker", grantId: "sync-grant-a" }), /SYNC_WORKER_CONNECTION_FAILED/u);
  } finally {
    await ports?.close();
    if (previous === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
    else process.env.SYNC_WORKER_DATABASE_URL = previous;
  }
});
test("bounded connector retries persist a fixed failure and resume on the same pinned client", async () => {
  const previous = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
  let ports;
  try {
    ports = await SyncWorkerPorts.connect({ principalUserId: "source-worker", grantId: "sync-grant-a" });
    const job = await ports.createWindow("PRODUCTS", until);
    let attempts = 0;
    await assert.rejects(ports.run(job, async () => { attempts++; throw new Error("provider secret detail"); }), /^Error: SYNC_CONNECTOR_FAILED$/u);
    assert.equal(attempts, 3);
    const failed = await ports.createWindow("PRODUCTS", until);
    assert.equal(failed.status, "FAILED");
    const resumed = await ports.run(failed, async () => ({ ...page(), nextCursor: "next" }), 1);
    assert.equal(resumed.pageCount, 1);
    const done = await ports.run(resumed, async () => page());
    assert.equal(done.status, "SUCCEEDED");
    assert.equal(done.pageCount, 2);
  } finally {
    await ports?.close();
    if (previous === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
    else process.env.SYNC_WORKER_DATABASE_URL = previous;
  }
});
