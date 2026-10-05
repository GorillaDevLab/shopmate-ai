import assert from "node:assert/strict";
import { beginWorker, waitLock } from "./mock-source-control-fixture.mjs";
import { leaseOf, scopeValues } from "./mock-source-lease-fixture.mjs";
import {
  appendSettings,
  insertEvent,
  insertVersion,
  updateAppend,
  nextFor,
  snapshot,
} from "./mock-source-append-fixture.mjs";
import { publishSettings, updatePublish } from "./mock-source-publish-fixture.mjs";
import { configFor, hashConfig } from "./mock-platform-fixture.mjs";

export const CONTROL = 1397575508;
export const MUTATION = 1397575509;
export const BARRIER = 77224499;
export const outcome = (pending) =>
  pending.then(
    (result) => ({ result }),
    (error) => ({ error }),
  );

export async function beginOperation(worker, context, op) {
  await beginWorker(worker, context.scope, context.grant);
  await worker.query("SET LOCAL statement_timeout='10s'");
  await worker.query(
    "SELECT set_config('mock.source_op',$1,true),set_config('mock.source_lease',$2,true)",
    [op, JSON.stringify(leaseOf(context.job))],
  );
}

export async function assertAuthorized(worker, context) {
  await beginOperation(worker, context, "APPEND");
  try {
    const result = await worker.query(
      "SELECT mock_platform.has_worker_access($3,$4,$5,$1,$6,$7,$2) AS allowed, session_user AS login",
      scopeValues(context.scope),
    );
    assert.deepEqual(result.rows, [{ allowed: true, login: "source_worker_login" }]);
    const job = (
      await worker.query('SELECT * FROM mock_platform."BuildJob" WHERE "sessionId"=$1', [
        context.scope.sessionId,
      ])
    ).rows[0];
    assert.ok(job);
    assert.equal(job.leaseGrantId, context.grant);
    assert.deepEqual(leaseOf(job), leaseOf(context.job));
    assert.ok(job.leaseUntil.getTime() > Date.now());
    await worker.query("COMMIT");
  } finally {
    await worker.query("ROLLBACK");
  }
}

export async function mutateSource(worker, context, op, event) {
  await beginOperation(worker, context, op);
  if (op === "PUBLISH") {
    await publishSettings(worker, context.job);
    return updatePublish(worker, context);
  }
  const next = nextFor(context.job);
  await appendSettings(worker, context.job, [event], next);
  const inserted = await insertEvent(worker, context, event);
  assert.equal(inserted.rowCount, 1);
  assert.equal((await insertVersion(worker, context, inserted.rows[0].eventSeq)).rowCount, 1);
  return updateAppend(worker, context, next);
}

export async function fullSnapshot(admin, context) {
  const source = await snapshot(admin, context);
  const result = await admin.query(
    `SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY generation),'[]'::jsonb) FROM mock_platform."Runtime" r WHERE "sessionId"=$1) AS runtimes,
    (SELECT to_jsonb(c) FROM public."PlatformConnection" c WHERE id=$2) AS connection,
    (SELECT to_jsonb(s) FROM demo."DemoCommerceSession" s WHERE id=$1) AS session,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM demo."DemoControlAudit" a WHERE "sessionId"=$1) AS audit,
    (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY id),'[]'::jsonb) FROM demo."MockWorkerGrant" g WHERE "sessionId"=$1) AS grants`,
    [context.scope.sessionId, context.scope.connectionId],
  );
  return { ...source, ...result.rows[0] };
}

export function sourceState(state) {
  return {
    runtimes: state.runtimes,
    jobs: state.jobs,
    events: state.events,
    versions: state.versions,
  };
}

export async function exactLock(admin, context, namespace, granted, pid) {
  await waitLock(admin, namespace, granted, pid);
  const key =
    namespace === MUTATION
      ? String(pid)
      : (
          await admin.query("SELECT hashtext($1)::bigint & 4294967295::bigint AS key", [
            context.scope.sessionId,
          ])
        ).rows[0].key;
  const locks = (
    await admin.query(
      `SELECT l.pid,l.classid::text AS namespace,l.objid::text AS key,l.objsubid,l.mode,l.granted,a.usename AS login
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.pid=$1 AND l.locktype='advisory' AND l.classid=$2::oid AND l.objsubid=2`,
      [pid, namespace],
    )
  ).rows;
  assert.deepEqual(locks, [
    {
      pid,
      namespace: String(namespace),
      key,
      objsubid: 2,
      mode: "ExclusiveLock",
      granted,
      login: namespace === MUTATION ? "source_worker_login" : locks[0]?.login,
    },
  ]);
  return locks[0];
}

export async function controlWait(admin, context) {
  const rows = await waitLock(admin, CONTROL, false);
  const ids = rows.map((row) => row.pid);
  const controls = (
    await admin.query(
      "SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND usename='source_control_login'",
      [ids],
    )
  ).rows;
  assert.equal(controls.length, 1);
  return exactLock(admin, context, CONTROL, false, controls[0].pid);
}

export async function changeControl(repo, context, kind) {
  const actor = {
    userId: "source-human",
    merchantId: context.scope.organizationId.replace("legacy-org-", ""),
  };
  const current = await repo.findDemoSession(actor, context.scope.storeId);
  assert.ok(current);
  const config = configFor(context.scope);
  return kind === "reset"
    ? repo.resetDemoSession(actor, context.scope.storeId, {
        expectedRevision: current.revision,
        config,
        configHash: hashConfig(config),
        generatorVersion: "mock-source-v1",
        clockNow: new Date(config.historyStart),
      })
    : repo.disconnectDemoSession(actor, context.scope.storeId, current.revision);
}

export function assertControlChanged(before, after, kind) {
  assert.equal(after.connection.generation, before.connection.generation + 1);
  assert.equal(after.connection.status, kind === "reset" ? "ACTIVE" : "DISCONNECTED");
  assert.equal(after.session.revision, before.session.revision + 1);
  assert.equal(
    after.session.clockRevision,
    before.session.clockRevision + (kind === "reset" ? 1 : 0),
  );
  assert.equal(after.audit.length, before.audit.length + 1);
  assert.equal(after.audit.at(-1).kind, kind.toUpperCase());
  assert.deepEqual(after.grants, before.grants);
}

export async function oldOperation(worker, context, op, event) {
  await beginOperation(worker, context, op);
  try {
    if (op === "APPEND") {
      await appendSettings(worker, context.job, [event], nextFor(context.job));
      await assert.rejects(insertEvent(worker, context, event), (error) => error.code === "SM001");
    } else {
      await publishSettings(worker, context.job);
      // Fresh outer snapshots filter unauthorized rows before the row guard runs.
      assert.equal((await updatePublish(worker, context)).rowCount, 0);
    }
  } finally {
    await worker.query("ROLLBACK");
  }
}

export async function installControlBarrier(admin, barrier) {
  // AFTER UPDATE proves the connection change exists uncommitted before the worker starts.
  await admin.query(`CREATE FUNCTION demo.test_publication_control_barrier() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
      IF NEW.generation IS DISTINCT FROM OLD.generation+1 THEN
        RAISE EXCEPTION 'Control race fixture did not change generation';
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(77224499,1);
      RETURN NEW;
    END $$`);
  await admin.query(`CREATE TRIGGER test_publication_control_barrier AFTER UPDATE
    ON public."PlatformConnection" FOR EACH ROW EXECUTE FUNCTION demo.test_publication_control_barrier()`);
  await barrier.query("BEGIN");
  await barrier.query("SELECT pg_advisory_xact_lock($1,1)", [BARRIER]);
}

export async function removeControlBarrier(admin) {
  await admin.query(
    'DROP TRIGGER IF EXISTS test_publication_control_barrier ON public."PlatformConnection"',
  );
  await admin.query("DROP FUNCTION IF EXISTS demo.test_publication_control_barrier()");
}

export async function controlBarrierWitness(admin, barrier, context) {
  const rows = await waitLock(admin, BARRIER, false);
  assert.equal(rows.length, 1);
  const pid = rows[0].pid;
  const locks = (
    await admin.query(
      `SELECT l.pid,l.classid::text AS namespace,l.objid::text AS key,l.objsubid,l.mode,l.granted,a.usename AS login
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.classid=$1::oid AND l.objsubid=2 ORDER BY l.granted DESC`,
      [BARRIER],
    )
  ).rows;
  assert.equal(locks.length, 2);
  assert.deepEqual(locks, [
    {
      pid: barrier.processID,
      namespace: String(BARRIER),
      key: "1",
      objsubid: 2,
      mode: "ExclusiveLock",
      granted: true,
      login: barrier.user,
    },
    {
      pid,
      namespace: String(BARRIER),
      key: "1",
      objsubid: 2,
      mode: "ExclusiveLock",
      granted: false,
      login: "source_control_login",
    },
  ]);
  const held = await exactLock(admin, context, CONTROL, true, pid);
  return { barrier: locks, held };
}

export async function prepareRaw(worker, context, entrypoint, event) {
  const op = entrypoint === "PUBLISH UPDATE" ? "PUBLISH" : "APPEND";
  await beginOperation(worker, context, op);
  if (op === "PUBLISH") await publishSettings(worker, context.job);
  else
    await appendSettings(
      worker,
      context.job,
      entrypoint === "event VALUES" ? [event] : [],
      nextFor(context.job, entrypoint === "APPEND UPDATE"),
    );
}

export function rawStatement(worker, context, entrypoint, event) {
  if (entrypoint === "event VALUES") return insertEvent(worker, context, event);
  if (entrypoint === "APPEND UPDATE")
    return updateAppend(worker, context, nextFor(context.job, true));
  return updatePublish(worker, context);
}

export function assertRawDenial(settled, entrypoint) {
  assert.ok(settled.error, `Pre-wait ${entrypoint} must reach the fresh row authorization guard`);
  assert.equal(settled.error.code, "SM001");
  assert.equal(settled.error.message, "Source control access denied");
  assert.equal(settled.error.detail, undefined);
  assert.equal(settled.error.hint, undefined);
  assert.match(settled.error.where, /require_source_scope\(jsonb\)/u);
  assert.match(
    settled.error.where,
    entrypoint === "event VALUES" ? /pending_job\(jsonb,bigint\)/u : /guard_job_update\(\)/u,
  );
}

export async function proveRawCandidate(worker, context, entrypoint, event) {
  // A successful physical proof before rollback rules out malformed proposals as the race's cause.
  try {
    await prepareRaw(worker, context, entrypoint, event);
    const result = await rawStatement(worker, context, entrypoint, event);
    assert.equal(result.rowCount, 1);
    if (entrypoint === "event VALUES") {
      assert.equal((await insertVersion(worker, context, result.rows[0].eventSeq)).rowCount, 1);
      assert.equal((await updateAppend(worker, context, nextFor(context.job))).rowCount, 1);
    }
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally {
    await worker.query("ROLLBACK");
  }
}

export async function noMutationMarker(admin, worker) {
  const rows = await admin.query(
    "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=$2::oid AND objsubid=2",
    [worker.processID, MUTATION],
  );
  assert.equal(rows.rowCount, 0);
}

export async function cleanupSchedule(worker, barrier, admin, changed, pending, hooked) {
  // Queue worker rollback as well as releasing the barrier, so either schedule unwinds on failure.
  const results = await Promise.allSettled([
    worker.query("ROLLBACK"),
    barrier.query("ROLLBACK"),
    changed,
    pending,
  ]);
  if (hooked) results.push(...(await Promise.allSettled([removeControlBarrier(admin)])));
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Control race cleanup failed");
}

export async function assertNoResidue(admin, worker, barrier) {
  const hooks = await admin.query(
    "SELECT 1 FROM pg_proc WHERE proname='test_publication_control_barrier' UNION ALL SELECT 1 FROM pg_trigger WHERE tgname='test_publication_control_barrier'",
  );
  assert.equal(hooks.rowCount, 0);
  const locks = await admin.query(
    "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE locktype='advisory' AND classid=ANY($1::oid[]) AND objsubid=2 AND (l.pid=ANY($2::integer[]) OR a.usename='source_control_login')",
    [
      [CONTROL, MUTATION, BARRIER],
      [worker.processID, barrier.processID],
    ],
  );
  assert.equal(locks.rowCount, 0);
  const roles = await admin.query(
    "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname",
    [["source_worker_login", "source_read_login", "source_control_login"]],
  );
  assert.equal(roles.rowCount, 3);
  for (const role of roles.rows) {
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
  }
}
