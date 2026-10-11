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
function validProduct() {
  return { externalStoreId: syncScope().externalStoreId, externalProductId: "sdk-valid", title: "valid",
    description: null, category: "category", brand: null, status: "DELETED",
    source: { version: "opaque:9", updatedAt: until, quality: { state: "COMPLETE", issues: [] } },
    skus: [{ externalSkuId: "sdk-sku", externalProductId: "sdk-valid", attributes: [], salePriceMinor: 100,
      costPriceMinor: 40, originalPriceMinor: null, status: "INACTIVE" }] };
}
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
    assert.equal("client" in ports, false); assert.equal("rpc" in ports, false);
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
async function assertOwnedQuarantine(ports, stream) {
  const boundary = "2026-01-03T00:00:00.000Z";
  let job = await ports.claim(await ports.createWindow(stream, boundary));
  const good = stream === "PRODUCTS" ? [validProduct()] : [];
  job = await ports.commitPage(job, "nul", null, { ...page(), observedAt: boundary, nextCursor: "next",
    items: [{ externalStoreId: job.externalStoreId, title: "bad\u0000text" }, ...good] });
  assert.equal(job.pageCount, 1); assert.equal(job.cursor, "next");
  job = await ports.commitPage(job, "unsafe", "next", { ...page(), observedAt: boundary,
    items: [{ externalStoreId: job.externalStoreId, amount: Infinity }, ...good] });
  assert.equal(job.pageCount, 2); assert.equal(job.status, "SUCCEEDED");
  const relation = stream === "PRODUCTS" ? "ProductPageCommit" : "CanonicalPageCommit";
  const receipts = (await database.admin.query(`SELECT "quarantinedCount","appliedCount","duplicateCount" FROM sync_host."${relation}" WHERE "jobId"=$1 ORDER BY "pageId"`, [job.id])).rows;
  assert.deepEqual(receipts, [{ quarantinedCount: 1, appliedCount: good.length, duplicateCount: 0 },
    { quarantinedCount: 1, appliedCount: 0, duplicateCount: good.length }]);
}
test("SDK quarantines owned invalid records while admitting valid facts and rejects invalid or foreign scope", async () => {
  const previous = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
  let ports;
  try {
    ports = await SyncWorkerPorts.connect({ principalUserId: "source-worker", grantId: "sync-grant-a" });
    for (const stream of ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"])
      await assertOwnedQuarantine(ports, stream);
    const job = await ports.claim(await ports.createWindow("PRODUCTS", "2026-01-04T00:00:00.000Z"));
    for (const scope of ["foreign", undefined, "bad\u0000scope", "bad\ud800scope", "bad\nscope", "x".repeat(257)]) {
      const items = [{ externalStoreId: scope, title: "bad\u0000text" }, validProduct()];
      await assert.rejects(ports.commitPage(job, "denied", null, { ...page(), observedAt: "2026-01-04T00:00:00.000Z", items }), /SYNC_WORKER_OPERATION_FAILED/u);
    }
    const state = (await database.admin.query('SELECT "pageCount",cursor FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0];
    assert.deepEqual(state, { pageCount: 0, cursor: null });
  } finally {
    await ports?.close();
    if (previous === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
    else process.env.SYNC_WORKER_DATABASE_URL = previous;
  }
});
