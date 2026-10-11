import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import { createSyncDatabase, closeSyncDatabase, createSyncGrant, connectSyncWorker, syncScope } from "../helpers/sync-host-fixture.mjs";

let database, worker;
pg.types.setTypeParser(1114, (value) => new Date(`${value}Z`));
const until = "2026-01-02T00:00:00.000Z";
const page = (nextCursor = null, sourceWatermark = null) => ({ items: [], nextCursor, observedAt: until, sourceWatermark });
test.before(async () => {
  database = await createSyncDatabase("worker");
  await createSyncGrant(database.admin, syncScope(), "sync-grant-a");
  worker = await connectSyncWorker(database.url);
});
test.after(async () => { await worker?.end(); if (database) await closeSyncDatabase(database); });
async function window(stream) {
  const result = await worker.query("SELECT sync_host.create_window($1,$2::timestamp) AS job", [stream, until]);
  const job = result.rows[0].job;
  const claim = await worker.query('UPDATE sync_host."Job" SET status=\'RUNNING\',fence=fence+1,"leaseOwner"=\'test\',"failureCode"=NULL WHERE id=$1 RETURNING fence', [job.id]);
  return { ...job, fence: claim.rows[0].fence };
}
async function commit(job, id, cursor, input) {
  return (await worker.query("SELECT sync_host.commit_worker_page($1,$2,$3,$4,$5::jsonb) AS result", [job.id, job.fence, id, cursor, JSON.stringify(input)])).rows[0].result;
}
test("terminal canonical pages complete all streams with unknown freshness and allow contiguous windows", async () => {
  for (const stream of ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
    const job = await window(stream);
    await commit(job, "first", null, page("next", until));
    await commit(job, "last", "next", page());
    const saved = (await worker.query('SELECT * FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0];
    assert.equal(saved.status, "SUCCEEDED");
    assert.equal(saved.successfulThrough, null);
    assert.equal(saved.sourceWatermark, null);
    assert.equal(saved.pageCount, 2);
    assert.equal(saved.receivedThrough.toISOString(), until);
    assert.equal((await commit(job, "last", "next", page())).status, "REPLAYED");
    const next = (await worker.query("SELECT sync_host.create_window($1,$2::timestamp) AS job", [stream, "2026-01-03T00:00:00.000Z"])).rows[0].job;
    assert.match(next.since, /^2026-01-02/u);
  }
});
async function nextJob(stream) {
  const job = (await worker.query('SELECT * FROM sync_host."Job" WHERE stream=$1 AND status=\'READY\'', [stream])).rows[0];
  return (await worker.query("SELECT sync_host.control_lease($1,'CLAIM',0,'test') AS job", [job.id])).rows[0].job;
}
test("cursor loops and lost acknowledgement rollback never advance business progress", async () => {
  const job = await nextJob("PRODUCTS");
  const input = { ...page("a", until), observedAt: "2026-01-03T00:00:00.000Z" };
  await worker.query("BEGIN");
  await commit(job, "one", null, input);
  await worker.query("ROLLBACK");
  assert.equal((await worker.query('SELECT "pageCount" FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0].pageCount, 0);
  await commit(job, "one", null, input);
  assert.equal((await commit(job, "one", null, input)).status, "REPLAYED");
  await commit(job, "two", "a", { ...input, nextCursor: "b" });
  await assert.rejects(commit(job, "three", "b", { ...input, nextCursor: "a" }), /SYNC_RECEIPT_PROOF_INVALID/u);
  const saved = (await worker.query('SELECT "pageCount",cursor FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0];
  assert.deepEqual(saved, { pageCount: 2, cursor: "b" });
  await commit(job, "three", "b", { ...input, nextCursor: null, sourceWatermark: "2026-01-02T12:00:00.000Z" });
  const done = (await worker.query('SELECT "successfulThrough" FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0];
  assert.equal(done.successfulThrough.toISOString(), until);
});
test("staged receipts cannot prove canonical completion", async () => {
  const job = await nextJob("ORDERS");
  await worker.query("SELECT sync_host.stage_page($1,$2,'staged',null,'a',$3::timestamp,$4)", [job.id, job.fence, "2026-01-02T00:00:00.000Z", "a".repeat(64)]);
  await assert.rejects(commit(job, "after", "a", { ...page(), observedAt: "2026-01-03T00:00:00.000Z" }), /UNCOMMITTED_CANONICAL_RECEIPT/u);
  assert.equal((await worker.query('SELECT "pageCount" FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0].pageCount, 0);
});
test("takeover pins the backend and a completed exact replay rechecks current tenant authority", async () => {
  const job = await nextJob("REFUNDS");
  const other = await connectSyncWorker(database.url);
  try {
    await assert.rejects(other.query("SELECT sync_host.control_lease($1,'RENEW',$2,'test')", [job.id, job.fence]), /Stale or unauthorized/u);
    await database.admin.query('UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [job.id]);
    const claimed = (await other.query("SELECT sync_host.control_lease($1,'CLAIM',0,'takeover') AS job", [job.id])).rows[0].job;
    await assert.rejects(commit(job, "terminal", null, page()), /Stale or unauthorized/u);
    const input = { ...page(), observedAt: "2026-01-03T00:00:00.000Z" };
    await other.query("SELECT sync_host.commit_worker_page($1,$2,'terminal',null,$3::jsonb)", [job.id, claimed.fence, JSON.stringify(input)]);
    assert.equal((await commit(claimed, "terminal", null, input)).status, "REPLAYED");
    await createSyncGrant(database.admin, syncScope("b"), "sync-grant-b", "sync_foreign_login");
    const foreign = await connectSyncWorker(database.url, "sync_foreign_login", "sync-grant-b");
    try { await assert.rejects(foreign.query("SELECT sync_host.commit_worker_page($1,$2,'terminal',null,$3::jsonb)", [job.id, claimed.fence, JSON.stringify(input)]), /SYNC_AUTHORITY_DENIED/u); }
    finally { await foreign.end(); }
  } finally { await other.end(); }
});
test("terminal transaction expiry rolls back completion and all canonical receipt progress", async () => {
  const job = await nextJob("MARKETING");
  await database.admin.query('UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()+interval \'1 second\' WHERE id=$1', [job.id]);
  await worker.query("BEGIN");
  await commit(job, "expired", null, { ...page(), observedAt: "2026-01-03T00:00:00.000Z" });
  await worker.query("SELECT pg_sleep(1.1)");
  await assert.rejects(worker.query("COMMIT"), /Stale or unauthorized/u);
  const saved = (await worker.query('SELECT status,"pageCount","receivedThrough" FROM sync_host."Job" WHERE id=$1', [job.id])).rows[0];
  assert.deepEqual(saved, { status: "RUNNING", pageCount: 0, receivedThrough: null });
});
test("generation reset revokes old completed page replay", async () => {
  const job = (await worker.query('SELECT * FROM sync_host."Job" WHERE stream=\'MARKETING\' AND status=\'SUCCEEDED\'')).rows[0];
  await operatorControl(database.admin, 'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [syncScope().connectionId]);
  await assert.rejects(commit(job, "last", "next", page()), /SYNC_AUTHORITY_DENIED/u);
});
