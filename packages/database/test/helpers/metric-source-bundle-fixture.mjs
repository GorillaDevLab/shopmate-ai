import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalRecord } from "./canonical-page-fixture.mjs";
import { loginUrl, scopeFor, sourceEnv, configFor, hashConfig } from "./mock-platform-fixture.mjs";
import { createMockSourceWorker } from "../../src/mock-platform/index.ts";
import { operatorControl } from "./mock-source-control-fixture.mjs";
import {
  createSyncDatabase,
  closeSyncDatabase,
  connectSyncWorker,
  syncScope,
} from "./sync-host-fixture.mjs";

export const opening = "2025-12-31T16:00:00.000Z";
export const cutoff = "2026-01-02T00:00:00.000Z";
export const window = {
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: cutoff,
  timezone: "Asia/Shanghai",
  currency: "CNY",
};
export const actor = {
  userId: "source-human",
  merchantId: "source-merchant-a",
  organizationId: syncScope().organizationId,
  workspaceId: syncScope().workspaceId,
  role: "OWNER",
  permissions: ["tenant:read"],
};
export const binding = Object.fromEntries(
  Object.entries(syncScope()).filter(([key]) => !["provider", "generation"].includes(key)),
);
export async function createMetricFixture(profile = "mature") {
  const db = await createSyncDatabase("worker");
  try {
    await provisionSourceLogin(db.admin);
    if (profile === "new") await configureNewProfile(db);
    const source = createMockSourceWorker(sourceEnv(db.url));
    try {
      await source.initializeGeneration({ grantId: "source-grant-a" }, scopeFor());
    } finally {
      await source.close();
    }
    await db.admin.query(
      'INSERT INTO sync_host."WorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,"initialSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        "sync-grant-a",
        "sync_worker_login",
        "source-worker",
        ...Object.values(binding),
        "MOCK",
        0,
        profile === "new" ? "2026-01-16T16:00:00.000Z" : opening,
      ],
    );
    const worker = await connectSyncWorker(db.url);
    const pool = new pg.Pool({ connectionString: loginUrl(db.url, "metric_source_login") });
    await advance(db, cutoff);
    return { ...db, worker, pool };
  } catch (error) {
    await closeSyncDatabase(db);
    throw error;
  }
}
export async function provisionSourceLogin(admin) {
  // The mandatory gate shares a cluster, so reuse only an unprivileged fixture login.
  const existing = await admin.query(`
    SELECT login.rolcanlogin AND NOT EXISTS (
      SELECT 1 FROM pg_roles role WHERE pg_has_role(login.oid,role.oid,'MEMBER') AND (
        role.rolsuper OR role.rolbypassrls OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication
        OR role.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','shopmate_sync_worker')
        OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=role.oid)
        OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=role.oid)
        OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=role.oid)
        OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner=role.oid)
        OR has_database_privilege(role.oid,current_database(),'CREATE')
      )
    ) AS safe FROM pg_roles login WHERE login.rolname='metric_source_login'
  `);
  if (existing.rowCount && !existing.rows[0].safe)
    throw new Error("Unsafe metric source fixture login");
  if (!existing.rowCount)
    await admin.query(
      "CREATE ROLE metric_source_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
  await admin.query("GRANT shopmate_metric_source TO metric_source_login");
}
async function configureNewProfile(db) {
  const config = configFor(scopeFor(), "new", 30);
  await operatorControl(
    db.admin,
    'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2,revision=revision+1 WHERE id=$3',
    [config, hashConfig(config), scopeFor().sessionId],
  );
}
export async function closeMetricFixture(db) {
  await db.pool.end();
  await db.worker.end();
  await closeSyncDatabase(db);
}
export async function advance(db, at) {
  await operatorControl(
    db.admin,
    'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1 WHERE id=$2',
    [at, scopeFor().sessionId],
  );
}
export async function startJob(db, stream, until = cutoff) {
  const job = (
    await db.worker.query("SELECT sync_host.create_window($1,$2::timestamp) AS job", [
      stream,
      until,
    ])
  ).rows[0].job;
  return (
    await db.worker.query("SELECT sync_host.control_lease($1,'CLAIM',0,'metric-fixture') AS job", [
      job.id,
    ])
  ).rows[0].job;
}
export async function commitPage(db, job, items, options = {}) {
  const page = {
    items,
    nextCursor: null,
    observedAt: job.until.endsWith("Z") ? job.until : `${job.until}Z`,
    sourceWatermark: cutoff,
    ...options,
  };
  return (
    await db.worker.query("SELECT sync_host.commit_worker_page($1,$2,$3,$4,$5::jsonb) AS result", [
      job.id,
      job.fence,
      options.pageId ?? "one",
      options.expectedCursor ?? null,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(page).filter(([key]) => !["pageId", "expectedCursor"].includes(key)),
        ),
      ),
    ])
  ).rows[0].result;
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
    await sourceIdentity(client);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function sourceIdentity(client) {
  await client.query(
    "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('app.organization_id',$3,true),set_config('app.workspace_id',$4,true)",
    [actor.userId, actor.merchantId, actor.organizationId, actor.workspaceId],
  );
}
export async function waitForSourceInsertLock(db) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await db.admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='metric_source_login' AND wait_event_type='Lock'",
    );
    if (result.rowCount) return;
    await delay(10);
  }
  throw new Error("Concurrent capture did not wait on archive insertion");
}
