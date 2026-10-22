import pg from "pg";
import { canonicalRecord } from "./canonical-page-fixture.mjs";
import { loginUrl, scopeFor } from "./mock-platform-fixture.mjs";
import { operatorControl } from "./mock-source-control-fixture.mjs";
import { createSyncDatabase, closeSyncDatabase, connectSyncWorker, syncScope } from "./sync-host-fixture.mjs";

export const opening = "2025-12-31T16:00:00.000Z";
export const cutoff = "2026-01-02T00:00:00.000Z";
export const window = { periodStart: "2026-01-01T00:00:00.000Z", periodEnd: cutoff, timezone: "Asia/Shanghai", currency: "CNY" };
export const actor = { userId: "source-human", merchantId: "source-merchant-a", organizationId: syncScope().organizationId, workspaceId: syncScope().workspaceId, role: "OWNER", permissions: ["tenant:read"] };
export const binding = Object.fromEntries(Object.entries(syncScope()).filter(([key]) => !["provider", "generation"].includes(key)));
export async function createMetricFixture() {
  const db = await createSyncDatabase("worker");
  try {
    await db.admin.query("CREATE ROLE metric_source_login LOGIN NOSUPERUSER NOBYPASSRLS");
    await db.admin.query("GRANT shopmate_metric_source TO metric_source_login");
    await db.admin.query('INSERT INTO sync_host."WorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,"initialSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', ["sync-grant-a", "sync_worker_login", "source-worker", ...Object.values(binding), "MOCK", 0, opening]);
    const worker = await connectSyncWorker(db.url);
    const pool = new pg.Pool({ connectionString: loginUrl(db.url, "metric_source_login") });
    await advance(db, cutoff);
    return { ...db, worker, pool };
  } catch (error) { await closeSyncDatabase(db); throw error; }
}
export async function closeMetricFixture(db) {
  await db.pool.end();
  await db.worker.end();
  await closeSyncDatabase(db);
}
export async function advance(db, at) {
  await operatorControl(db.admin, 'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1 WHERE id=$2', [at, scopeFor().sessionId]);
}
export async function startJob(db, stream, until = cutoff) {
  const job = (await db.worker.query("SELECT sync_host.create_window($1,$2::timestamp) AS job", [stream, until])).rows[0].job;
  return (await db.worker.query("SELECT sync_host.control_lease($1,'CLAIM',0,'metric-fixture') AS job", [job.id])).rows[0].job;
}
export async function commitPage(db, job, items, options = {}) {
  const page = { items, nextCursor: null, observedAt: job.until.endsWith("Z") ? job.until : `${job.until}Z`, sourceWatermark: cutoff, ...options };
  return (await db.worker.query("SELECT sync_host.commit_worker_page($1,$2,$3,$4,$5::jsonb) AS result", [job.id, job.fence, options.pageId ?? "one", options.expectedCursor ?? null, JSON.stringify(Object.fromEntries(Object.entries(page).filter(([key]) => !["pageId", "expectedCursor"].includes(key))))])).rows[0].result;
}
export async function seedFacts(db) {
  for (const stream of ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
    const record = canonicalRecord(stream);
    if (stream === "REFUNDS") record.externalOrderId = "one";
    await commitPage(db, await startJob(db, stream), [record]);
  }
}
export async function sourceSql(db, sql, values = []) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('app.organization_id',$3,true),set_config('app.workspace_id',$4,true)", [actor.userId, actor.merchantId, actor.organizationId, actor.workspaceId]);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
