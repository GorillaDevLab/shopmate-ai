import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { migrateSource, sourceFixtures, loginUrl } from "../helpers/mock-platform-fixture.mjs";
import { waitLock } from "../helpers/mock-source-control-fixture.mjs";
import {
  claimSql,
  scopeValues,
  updateSql,
  renewValues,
  newScope,
} from "../helpers/mock-source-lease-fixture.mjs";
import {
  appendSettings,
  eventFor,
  insertEvent,
  insertVersion,
  nextFor,
  updateAppend,
  snapshot,
} from "../helpers/mock-source-append-fixture.mjs";
import {
  collisionPair,
  integrityError,
  jobsText,
  beginClaims,
  mutate,
  committedClaims,
  start,
  settings,
  MUTATION,
  markers,
  assertMarker,
  cleanup,
  suppression,
  conflictHook,
} from "../helpers/mock-source-transaction-fixture.mjs";

let server, admin, worker, worker2, barrier, pair, leases;
const clients = [];
pg.types.setTypeParser(1114, (value) => new Date(value + "Z"));
async function login(url, name) {
  const client = new pg.Client({ connectionString: loginUrl(url, name) });
  await client.connect();
  clients.push(client);
  return client;
}
before(async () => {
  server = await isolatedPostgres();
  const url = new URL(server.url);
  admin = await login(server.url, url.username);
  await admin.query('CREATE DATABASE "shopmate_tenant_test_sourcetransaction"');
  url.pathname = "/shopmate_tenant_test_sourcetransaction";
  admin = await login(url.toString(), url.username);
  await migrateSource(admin);
  await sourceFixtures(admin);
  worker = await login(url.toString(), "source_worker_login");
  worker2 = await login(url.toString(), "source_worker_login");
  barrier = await login(url.toString(), url.username);
  pair = await collisionPair(admin, worker);
  leases = await collisionPair(admin, worker, 1);
  await committedClaims(worker, leases);
});
test("authorized colliding RENEW scopes roll back both byte-equivalent committed leases", async () => {
  const before = await jobsText(admin, leases);
  try {
    await start(worker, leases[0], "RENEW", leases[0].job);
    await mutate(worker, leases[0], leases[0].job);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await settings(worker, leases[1], "RENEW", leases[1].job);
    await assert.rejects(mutate(worker, leases[1], leases[1].job), integrityError);
  } finally {
    await worker.query("ROLLBACK");
  }
  assert.equal(await jobsText(admin, leases), before);
});
after(async () => {
  for (const client of clients.reverse()) await client.end();
  if (server) {
    const cleanup = new pg.Client({ connectionString: server.url });
    await cleanup.connect();
    try {
      await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_sourcetransaction"');
    } finally {
      await cleanup.end();
    }
    await server.stop();
  }
});

test("authorized colliding CLAIM scopes cannot bypass one mutation with settings and immediate constraints", async () => {
  const before = await jobsText(admin, pair);
  assert.equal(before, "[]");
  try {
    await beginClaims(worker, pair);
    await assert.rejects(mutate(worker, pair[1]), integrityError);
  } finally {
    await worker.query("ROLLBACK");
  }
  assert.equal(await jobsText(admin, pair), before);
});

test("transaction trigger is nondeferrable fixed-path invoker with worker-only execution", async () => {
  const trigger = (
    await admin.query(
      "SELECT tgdeferrable,tginitdeferred,tgtype FROM pg_trigger WHERE tgrelid='mock_platform.\"BuildJob\"'::regclass AND tgname='source_job_0_transaction'",
    )
  ).rows;
  assert.deepEqual(trigger, [{ tgdeferrable: false, tginitdeferred: false, tgtype: 21 }]);
  const fn = (
    await admin.query(
      "SELECT prosecdef,provolatile,proconfig,has_function_privilege('public',oid,'EXECUTE') AS public_exec,has_function_privilege('source_worker_login',oid,'EXECUTE') AS worker_exec,has_function_privilege('source_read_login',oid,'EXECUTE') AS reader_exec FROM pg_proc WHERE oid='mock_platform.guard_job_transaction()'::regprocedure",
    )
  ).rows[0];
  assert.deepEqual(fn, {
    prosecdef: false,
    provolatile: "v",
    proconfig: ["search_path=pg_catalog"],
    public_exec: false,
    worker_exec: true,
    reader_exec: false,
  });
  const login = (
    await worker.query(
      "SELECT session_user,current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.deepEqual(login, {
    session_user: "source_worker_login",
    current_user: "source_worker_login",
    rolsuper: false,
    rolbypassrls: false,
  });
});
test("same-job early xid guard still rejects a second mutation after constraint flushing", async () => {
  try {
    await start(worker, pair[0]);
    const job = await mutate(worker, pair[0]);
    const xid = (await worker.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
    assert.equal(job.mutationXid, xid);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await settings(worker, pair[0], "RENEW", job);
    await assert.rejects(mutate(worker, pair[0], job), integrityError);
  } finally {
    await cleanup(worker);
  }
  assert.equal(await jobsText(admin, pair), "[]");
});

const unlocks = [
  ["exclusive pair", "SELECT pg_advisory_unlock($1::integer,$2::integer) AS removed"],
  ["shared pair", "SELECT pg_advisory_unlock_shared($1::integer,$2::integer) AS removed"],
  ["exclusive bigint", "SELECT pg_advisory_unlock($1::bigint*4294967296+$2) AS removed"],
  ["shared bigint", "SELECT pg_advisory_unlock_shared($1::bigint*4294967296+$2) AS removed"],
];
for (const [name, sql] of unlocks)
  test(`session ${name} unlock cannot erase the transaction marker`, async () => {
    try {
      await beginClaims(worker, pair);
      await assertMarker(admin, worker);
      assert.equal((await worker.query(sql, [MUTATION, worker.processID])).rows[0].removed, false);
      await assertMarker(admin, worker);
      await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
      await assert.rejects(mutate(worker, pair[1]), integrityError);
    } finally {
      await cleanup(worker);
    }
    assert.equal(await jobsText(admin, pair), "[]");
    assert.deepEqual(await markers(admin, worker), []);
  });
test("unlock_all removes session locks but preserves the actual transaction mutation marker", async () => {
  try {
    await worker.query("SELECT pg_advisory_lock(77224498,1)");
    await beginClaims(worker, pair);
    await worker.query("SELECT pg_advisory_unlock_all()");
    await assertMarker(admin, worker);
    assert.equal(
      (
        await admin.query(
          "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=77224498::oid",
          [worker.processID],
        )
      ).rowCount,
      0,
    );
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await assert.rejects(mutate(worker, pair[1]), integrityError);
  } finally {
    await cleanup(worker);
  }
  assert.equal(await jobsText(admin, pair), "[]");
});

const preholds = [
  ["session exclusive", "SELECT pg_advisory_lock($1,$2)", "ExclusiveLock"],
  ["session shared", "SELECT pg_advisory_lock_shared($1,$2)", "ShareLock"],
  ["transaction exclusive", "SELECT pg_advisory_xact_lock($1,$2)", "ExclusiveLock"],
  ["transaction shared", "SELECT pg_advisory_xact_lock_shared($1,$2)", "ShareLock"],
];
for (const [name, sql, mode] of preholds)
  for (const wrong of [false, true])
    test(`${name} prehold at ${wrong ? "wrong" : "actual PID"} objid denies the first mutation`, async () => {
      try {
        await start(worker, pair[0]);
        const key = worker.processID + Number(wrong);
        await worker.query(sql, [MUTATION, key]);
        assert.deepEqual(await markers(admin, worker), [{ objid: key, mode, granted: true }]);
        await assert.rejects(mutate(worker, pair[0]), integrityError);
      } finally {
        await cleanup(worker);
      }
      assert.equal(await jobsText(admin, pair), "[]");
      assert.deepEqual(await markers(admin, worker), []);
    });
for (const [name, sql, mode] of preholds)
  test(`${name} bigint objsubid=1 decoy allows one actual mutation`, async () => {
    try {
      await start(worker, pair[0]);
      const bigintSql = sql.replace("($1,$2)", "($1::bigint*4294967296+$2)");
      await worker.query(bigintSql, [MUTATION, worker.processID]);
      assert.deepEqual(await markers(admin, worker, 1), [
        { objid: worker.processID, mode, granted: true },
      ]);
      await mutate(worker, pair[0]);
      await assertMarker(admin, worker);
      await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
      assert.equal(JSON.parse(await jobsText(worker, pair)).length, 1);
    } finally {
      await cleanup(worker);
    }
    assert.equal(await jobsText(admin, pair), "[]");
    assert.deepEqual(await markers(admin, worker, 1), []);
  });

test("zero-row UPDATE does not consume the first actual mutation slot", async () => {
  const missing = {
    sessionId: pair[0].scope.sessionId,
    generation: 0,
    revision: "1",
    fence: "1",
    leaseOwner: pair[0].owner,
    state: "BUILDING",
  };
  try {
    await start(worker, pair[0], "RENEW", missing);
    assert.equal((await worker.query(updateSql, renewValues(missing))).rowCount, 0);
    assert.deepEqual(await markers(admin, worker), []);
    await settings(worker, pair[1]);
    await mutate(worker, pair[1]);
    await assertMarker(admin, worker);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.equal(JSON.parse(await jobsText(worker, pair)).length, 1);
  } finally {
    await cleanup(worker);
  }
  assert.equal(await jobsText(admin, pair), "[]");
});
test("BEFORE RETURN NULL suppressed INSERT does not consume the marker", async () => {
  await suppression(admin, "INSERT", async () => {
    try {
      await start(worker, pair[0]);
      await worker.query("SELECT set_config('mock.test_suppress_session',$1,true)", [
        pair[0].scope.sessionId,
      ]);
      assert.equal(
        (await worker.query(claimSql, [...scopeValues(pair[0].scope), pair[0].owner])).rowCount,
        0,
      );
      assert.deepEqual(await markers(admin, worker), []);
      await settings(worker, pair[1]);
      await mutate(worker, pair[1]);
      await assertMarker(admin, worker);
      await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
      assert.equal(JSON.parse(await jobsText(worker, pair)).length, 1);
    } finally {
      await cleanup(worker);
    }
  });
  assert.equal(await jobsText(admin, pair), "[]");
});
test("BEFORE RETURN NULL suppressed UPDATE preserves A and allows one B mutation", async () => {
  const before = await jobsText(admin, leases);
  await suppression(admin, "UPDATE", async () => {
    try {
      await start(worker, leases[0], "RENEW", leases[0].job);
      await worker.query("SELECT set_config('mock.test_suppress_session',$1,true)", [
        leases[0].scope.sessionId,
      ]);
      assert.equal((await worker.query(updateSql, renewValues(leases[0].job))).rowCount, 0);
      assert.deepEqual(await markers(admin, worker), []);
      assert.equal(await jobsText(worker, [leases[0]]), await jobsText(admin, [leases[0]]));
      await settings(worker, leases[1], "RENEW", leases[1].job);
      await mutate(worker, leases[1], leases[1].job);
      await assertMarker(admin, worker);
      await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally {
      await cleanup(worker);
    }
  });
  assert.equal(await jobsText(admin, leases), before);
});

const conflictSql = claimSql.replace(
  " RETURNING *",
  ' ON CONFLICT ("sessionId",generation,revision) ',
);
test("ON CONFLICT DO NOTHING consumes no marker before a real B update", async () => {
  const before = await jobsText(admin, leases);
  await conflictHook(admin, async () => {
    try {
      await start(worker, leases[0], "RENEW", leases[0].job);
      const result = await worker.query(conflictSql + "DO NOTHING RETURNING *", [
        ...scopeValues(leases[0].scope),
        leases[0].owner,
      ]);
      assert.equal(result.rowCount, 0);
      assert.deepEqual(await markers(admin, worker), []);
      assert.equal(await jobsText(worker, [leases[0]]), await jobsText(admin, [leases[0]]));
      await settings(worker, leases[1], "RENEW", leases[1].job);
      await mutate(worker, leases[1], leases[1].job);
      await assertMarker(admin, worker);
      await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally {
      await cleanup(worker);
    }
  });
  assert.equal(await jobsText(admin, leases), before);
});
test("actual ON CONFLICT DO UPDATE consumes the slot and rolls back with denied B", async () => {
  const before = await jobsText(admin, leases);
  await conflictHook(admin, async () => {
    try {
      await start(worker, leases[0], "RENEW", leases[0].job);
      const result = await worker.query(
        conflictSql + 'DO UPDATE SET "leaseOwner"=EXCLUDED."leaseOwner" RETURNING *',
        [...scopeValues(leases[0].scope), leases[0].owner],
      );
      assert.equal(result.rowCount, 1);
      assert.notEqual(result.rows[0].mutationXid, leases[0].job.mutationXid);
      await assertMarker(admin, worker);
      await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
      await settings(worker, leases[1], "RENEW", leases[1].job);
      await assert.rejects(mutate(worker, leases[1], leases[1].job), integrityError);
    } finally {
      await cleanup(worker);
    }
  });
  assert.equal(await jobsText(admin, leases), before);
});

test("rollback to a savepoint before A releases its row and marker so B can mutate", async () => {
  try {
    await start(worker, pair[0]);
    await worker.query("SAVEPOINT before_a");
    await mutate(worker, pair[0]);
    await assertMarker(admin, worker);
    assert.equal(JSON.parse(await jobsText(worker, pair)).length, 1);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await worker.query("ROLLBACK TO SAVEPOINT before_a");
    assert.deepEqual(await markers(admin, worker), []);
    assert.equal(await jobsText(worker, pair), "[]");
    await settings(worker, pair[1]);
    await mutate(worker, pair[1]);
    await assertMarker(admin, worker);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.equal(JSON.parse(await jobsText(worker, pair))[0].sessionId, pair[1].scope.sessionId);
  } finally {
    await cleanup(worker);
  }
  assert.equal(await jobsText(admin, pair), "[]");
});
test("rollback of denied B after A does not release A's earlier transaction marker", async () => {
  try {
    await start(worker, pair[0]);
    await mutate(worker, pair[0]);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await worker.query("SAVEPOINT after_a");
    await settings(worker, pair[1]);
    await assert.rejects(mutate(worker, pair[1]), integrityError);
    await worker.query("ROLLBACK TO SAVEPOINT after_a");
    await assertMarker(admin, worker);
    assert.equal(JSON.parse(await jobsText(worker, pair))[0].sessionId, pair[0].scope.sessionId);
    await settings(worker, pair[1]);
    await assert.rejects(mutate(worker, pair[1]), integrityError);
    await worker.query("ROLLBACK TO SAVEPOINT after_a");
    await assertMarker(admin, worker);
    assert.equal(JSON.parse(await jobsText(worker, pair)).length, 1);
  } finally {
    await cleanup(worker);
  }
  assert.equal(await jobsText(admin, pair), "[]");
});
test("another backend holding the victim PID key causes prompt fixed denial without marker wait", async () => {
  try {
    await barrier.query("BEGIN");
    await barrier.query("SELECT pg_advisory_xact_lock($1,$2)", [MUTATION, worker.processID]);
    const held = await waitLock(admin, MUTATION, true, barrier.processID);
    assert.equal(held[0].objid, worker.processID);
    await start(worker, pair[0]);
    await worker.query("SET LOCAL statement_timeout='2s'");
    const started = Date.now();
    await assert.rejects(mutate(worker, pair[0]), integrityError);
    assert.ok(Date.now() - started < 2000, "try-lock denial must precede statement/lock timeout");
    assert.deepEqual(await markers(admin, worker), []);
    assert.equal(
      (await waitLock(admin, MUTATION, true, barrier.processID))[0].objid,
      worker.processID,
    );
  } finally {
    await cleanup(worker);
    await cleanup(barrier);
  }
  assert.equal(await jobsText(admin, pair), "[]");
});
async function distinctContexts(suffix) {
  const contexts = [];
  for (const [index, client] of [worker, worker2].entries()) {
    const context = await newScope(admin, client, `fence-${suffix}-${index}`);
    contexts.push({ ...context, principal: "source-worker", owner: pair[index].owner });
  }
  assert.equal(
    (
      await admin.query(
        "SELECT hashtext($1)<>hashtext($2) AS distinct",
        contexts.map((c) => c.scope.sessionId),
      )
    ).rows[0].distinct,
    true,
  );
  return contexts;
}
test("distinct backend PIDs and noncolliding scopes mutate concurrently without a global marker wait", async () => {
  const contexts = await distinctContexts("concurrent");
  assert.notEqual(worker.processID, worker2.processID);
  try {
    await start(worker, contexts[0]);
    await start(worker2, contexts[1]);
    await worker.query("SET LOCAL statement_timeout='2s'");
    await worker2.query("SET LOCAL statement_timeout='2s'");
    // Both mutations must finish while both transactions still hold their markers.
    const rows = await Promise.all([mutate(worker, contexts[0]), mutate(worker2, contexts[1])]);
    assert.equal(rows.length, 2);
    await assertMarker(admin, worker);
    await assertMarker(admin, worker2);
    await worker.query("COMMIT");
    await worker2.query("COMMIT");
  } finally {
    await cleanup(worker);
    await cleanup(worker2);
  }
  assert.equal(JSON.parse(await jobsText(admin, contexts)).length, 2);
  assert.deepEqual(await markers(admin, worker), []);
  assert.deepEqual(await markers(admin, worker2), []);
});
test("CONTROL still rejects different noncolliding session keys separately", async () => {
  const contexts = await distinctContexts("control");
  try {
    await start(worker, contexts[0]);
    await mutate(worker, contexts[0]);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await settings(worker, contexts[1]);
    await assert.rejects(mutate(worker, contexts[1]), (error) => {
      assert.equal(error.code, "SM002");
      assert.equal(error.message, "Invalid source control protocol");
      assert.equal(error.detail, undefined);
      return true;
    });
  } finally {
    await cleanup(worker);
  }
  assert.equal(await jobsText(admin, contexts), "[]");
});
test("raw complete event/version APPEND permits one job update then rejects a switched second job", async () => {
  const contexts = await collisionPair(admin, worker, 2);
  await committedClaims(worker, contexts);
  const context = contexts[0],
    before = await snapshot(admin, context),
    otherBefore = await snapshot(admin, contexts[1]);
  const event = eventFor(context),
    next = nextFor(context.job);
  try {
    await start(worker, context, "APPEND", context.job);
    await appendSettings(worker, context.job, [event], next);
    const inserted = await insertEvent(worker, context, event);
    assert.equal(inserted.rowCount, 1);
    assert.equal((await insertVersion(worker, context, inserted.rows[0].eventSeq)).rowCount, 1);
    assert.deepEqual(await markers(admin, worker), []);
    const updated = await updateAppend(worker, context, next);
    assert.equal(updated.rowCount, 1);
    assert.equal(updated.rows[0].eventCount, "1");
    assert.equal(updated.rows[0].versionCount, "1");
    await assertMarker(admin, worker);
    await worker.query("SET CONSTRAINTS ALL IMMEDIATE");
    await settings(worker, contexts[1], "RENEW", contexts[1].job);
    await assert.rejects(mutate(worker, contexts[1], contexts[1].job), integrityError);
  } finally {
    await cleanup(worker);
  }
  assert.deepEqual(await snapshot(admin, context), before);
  assert.deepEqual(await snapshot(admin, contexts[1]), otherBefore);
});
test("operator hooks and session locks are restored with worker privileges unchanged", async () => {
  const remaining = await admin.query(
    "SELECT tgname FROM pg_trigger WHERE tgrelid='mock_platform.\"BuildJob\"'::regclass AND NOT tgisinternal AND (tgenabled<>'O' OR tgname LIKE '%test%')",
  );
  assert.equal(remaining.rowCount, 0);
  assert.equal(
    (
      await admin.query(
        "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mock_platform' AND p.proname LIKE 'test_fence_%'",
      )
    ).rowCount,
    0,
  );
  for (const client of [worker, worker2, barrier])
    assert.deepEqual(await markers(admin, client), []);
  const rights = (
    await admin.query(
      "SELECT has_table_privilege('source_worker_login','mock_platform.\"BuildJob\"','INSERT') AS all_insert,has_column_privilege('source_worker_login','mock_platform.\"BuildJob\"','mutationXid','INSERT') AS xid_insert,has_column_privilege('source_worker_login','mock_platform.\"BuildJob\"','mutationXid','UPDATE') AS xid_update",
    )
  ).rows[0];
  assert.deepEqual(rights, { all_insert: false, xid_insert: false, xid_update: false });
});
