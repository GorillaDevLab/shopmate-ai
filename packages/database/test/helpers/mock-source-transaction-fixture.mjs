import assert from "node:assert/strict";
import { createSourceSession, grantSource, scopeFor } from "./mock-platform-fixture.mjs";
import { beginWorker, rawInsert, rawValues } from "./mock-source-control-fixture.mjs";
import {
  claimSql,
  scopeValues,
  sourceTransaction,
  leaseOf,
  updateSql,
  renewValues,
} from "./mock-source-lease-fixture.mjs";

export const MUTATION = 1397575509;
export const owners = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
export function integrityError(error) {
  assert.equal(error.code, "SM005");
  assert.equal(error.message, "Invalid source integrity");
  assert.equal(error.detail, undefined);
  assert.equal(error.hint, undefined);
  return true;
}
export async function collisionPair(admin, worker, offset = 0) {
  const collision = (
    await admin.query(
      "SELECT array_agg(id ORDER BY id) AS ids FROM (SELECT 'collision-'||n AS id,hashtext('collision-'||n) AS hash FROM generate_series(1,300000) n) keys GROUP BY hash HAVING count(*)>1 ORDER BY hash LIMIT 1 OFFSET $1",
      [offset],
    )
  ).rows[0];
  assert.ok(collision, "finite deterministic fixture must find a genuine collision");
  const contexts = [];
  for (const [index, sessionId] of collision.ids.slice(0, 2).entries()) {
    const context = await collisionContext(admin, sessionId, index, offset);
    await sourceTransaction(
      worker,
      context.scope,
      "CLAIM",
      async () => {
        await settings(worker, context);
        return worker.query(rawInsert, rawValues(context.scope));
      },
      null,
      context.grant,
    );
    contexts.push(context);
  }
  const proof = (
    await admin.query(
      "SELECT hashtext($1)=hashtext($2) AS equal",
      contexts.map((c) => c.scope.sessionId),
    )
  ).rows[0];
  assert.equal(proof.equal, true);
  assert.notEqual(contexts[0].scope.sessionId, contexts[1].scope.sessionId);
  return contexts;
}
async function collisionContext(admin, sessionId, index, offset) {
  const scope = {
    ...scopeFor(index === 0 ? "a" : "b"),
    sessionId,
    storeId: `fence-store-${offset}-${index}`,
    connectionId: `fence-connection-${offset}-${index}`,
  };
  const grant = `fence-grant-${offset}-${index}`,
    principal = index === 0 ? "source-worker" : "source-viewer";
  await createSourceSession(admin, scope);
  await grantSource(admin, scope, grant);
  await admin.query('UPDATE demo."MockWorkerGrant" SET "principalUserId"=$2 WHERE id=$1', [
    grant,
    principal,
  ]);
  return { scope, grant, principal, owner: owners[index] };
}
export async function settings(client, context, op = "CLAIM", job = null) {
  await client.query(
    "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id',$3,true),set_config('demo.control_session_id',$4,true),set_config('mock.scope',$5,true),set_config('mock.source_op',$6,true),set_config('mock.source_lease',$7,true)",
    [
      context.principal,
      context.scope.organizationId.replace("legacy-org-", ""),
      context.grant,
      context.scope.sessionId,
      JSON.stringify(context.scope),
      op,
      JSON.stringify(job ? leaseOf(job) : null),
    ],
  );
  const access = (
    await client.query(
      "SELECT mock_platform.has_worker_access($3,$4,$5,$1,$6,$7,$2) AS allowed",
      scopeValues(context.scope),
    )
  ).rows[0];
  assert.equal(access.allowed, true, "both switched scopes must be genuinely authorized");
}
export async function start(client, context, op = "CLAIM", job = null) {
  await beginWorker(client, context.scope, context.grant);
  await settings(client, context, op, job);
}
export async function mutate(client, context, job = null) {
  const result = job
    ? await client.query(updateSql, renewValues(job))
    : await client.query(claimSql, [...scopeValues(context.scope), context.owner]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}
export async function jobsText(admin, contexts) {
  return (
    await admin.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(j)||jsonb_build_object(
        'createdAt',mock_platform.canonical_utc(j."createdAt"),
        'leaseUntil',mock_platform.canonical_utc(j."leaseUntil"),
        'publishedAt',CASE WHEN j."publishedAt" IS NULL THEN NULL ELSE mock_platform.canonical_utc(j."publishedAt") END)
        ORDER BY "sessionId",generation,revision),'[]'::jsonb)::text AS jobs
        FROM mock_platform."BuildJob" j WHERE "sessionId"=ANY($1::text[])`,
      [contexts.map((c) => c.scope.sessionId)],
    )
  ).rows[0].jobs;
}
export async function beginClaims(client, pair) {
  await start(client, pair[0]);
  await mutate(client, pair[0]);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await settings(client, pair[1]);
}
export async function committedClaims(client, contexts) {
  for (const context of contexts) {
    await start(client, context);
    try {
      context.job = await mutate(client, context);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}
export async function markers(admin, client, objsubid = 2) {
  return (
    await admin.query(
      "SELECT objid,mode,granted FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND classid=$2::oid AND objsubid=$3 ORDER BY objid,mode",
      [client.processID, MUTATION, objsubid],
    )
  ).rows;
}
export async function assertMarker(admin, client) {
  assert.deepEqual(await markers(admin, client), [
    { objid: client.processID, mode: "ExclusiveLock", granted: true },
  ]);
}
export async function cleanup(client) {
  await client.query("ROLLBACK");
  await client.query("SELECT pg_advisory_unlock_all()");
}
export async function suppression(admin, operation, action) {
  assert.ok(["INSERT", "UPDATE"].includes(operation));
  await admin.query(`CREATE FUNCTION mock_platform.test_fence_suppress() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN
      IF NEW."sessionId"=current_setting('mock.test_suppress_session',true) THEN RETURN NULL; END IF;
      RETURN NEW;
    END $$`);
  try {
    await admin.query(
      `CREATE TRIGGER zzz_test_fence_suppress BEFORE ${operation} ON mock_platform."BuildJob" FOR EACH ROW EXECUTE FUNCTION mock_platform.test_fence_suppress()`,
    );
    await action();
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS zzz_test_fence_suppress ON mock_platform."BuildJob"');
    await admin.query("DROP FUNCTION mock_platform.test_fence_suppress()");
  }
}
export async function conflictHook(admin, action) {
  // The normal CLAIM guard suppresses existing open jobs before unique conflict resolution.
  // This isolated operator hook supplies the existing full row without changing worker rights.
  await admin.query(`CREATE FUNCTION mock_platform.test_fence_conflict() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN
      SELECT j.* INTO NEW FROM mock_platform."BuildJob" j WHERE j."sessionId"=NEW."sessionId" AND j.generation=NEW.generation;
      RETURN NEW;
    END $$`);
  try {
    await admin.query('ALTER TABLE mock_platform."BuildJob" DISABLE TRIGGER source_job_insert');
    await admin.query(
      'CREATE TRIGGER test_fence_conflict BEFORE INSERT ON mock_platform."BuildJob" FOR EACH ROW EXECUTE FUNCTION mock_platform.test_fence_conflict()',
    );
    await action();
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS test_fence_conflict ON mock_platform."BuildJob"');
    await admin.query('ALTER TABLE mock_platform."BuildJob" ENABLE TRIGGER source_job_insert');
    await admin.query("DROP FUNCTION mock_platform.test_fence_conflict()");
  }
}
