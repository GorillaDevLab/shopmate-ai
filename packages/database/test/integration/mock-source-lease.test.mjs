import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  loginUrl,
  grantSource,
} from "../helpers/mock-platform-fixture.mjs";
import { beginWorker, waitLock, operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import {
  claimSql,
  updateSql,
  scopeValues,
  sqlError,
  leaseOf,
  renewValues,
  sourceTransaction,
  newScope,
  claim,
  change,
  jobFor,
} from "../helpers/mock-source-lease-fixture.mjs";

let server, admin, worker, worker2, reader, foreign, barrier, app;
const clients = [];
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
  await admin.query('CREATE DATABASE "shopmate_tenant_test_sourcelease"');
  url.pathname = "/shopmate_tenant_test_sourcelease";
  admin = await login(url.toString(), url.username);
  await migrateSource(admin);
  await sourceFixtures(admin);
  worker = await login(url.toString(), "source_worker_login");
  worker2 = await login(url.toString(), "source_worker_login");
  reader = await login(url.toString(), "source_read_login");
  foreign = await login(url.toString(), "source_foreign_login");
  barrier = await login(url.toString(), url.username);
  app = await login(url.toString(), "source_app_login");
});
after(async () => {
  for (const client of clients.reverse()) await client.end();
  if (server) {
    const cleanup = new pg.Client({ connectionString: server.url });
    await cleanup.connect();
    try {
      await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_sourcelease"');
    } finally {
      await cleanup.end();
    }
  }
  if (server) await server.stop();
});
async function fresh(suffix) {
  const context = await newScope(admin, worker, suffix);
  const job = (await claim(worker, context)).rows[0];
  return { ...context, job };
}
async function readerScope(context, action) {
  await reader.query("BEGIN");
  try {
    await reader.query(
      "SELECT set_config('app.user_id','source-human',true),set_config('app.merchant_id','source-merchant-a',true)",
    );
    return await action();
  } finally {
    await reader.query("ROLLBACK");
  }
}

test("three source tables exist with FORCE RLS and immutable full-scope parent foreign keys", async () => {
  const rows = (
    await admin.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mock_platform' AND relname=ANY($1)",
      [["BuildJob", "SourceEvent", "EntityVersion"]],
    )
  ).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  const fks = (
    await admin.query(
      "SELECT conname,confdeltype,confupdtype,cardinality(conkey) AS width FROM pg_constraint WHERE connamespace='mock_platform'::regnamespace AND contype='f' AND conrelid=ANY($1::regclass[])",
      [
        [
          'mock_platform."BuildJob"',
          'mock_platform."SourceEvent"',
          'mock_platform."EntityVersion"',
        ],
      ],
    )
  ).rows;
  assert.equal(fks.length, 5);
  assert.ok(
    fks.every((row) => row.width >= 7 && row.confdeltype === "r" && row.confupdtype === "a"),
  );
});
test("claim derives frozen target, initial checkpoint, counts, grant and 30-second lease", async () => {
  const context = await fresh("initial");
  const job = context.job;
  assert.equal(job.revision, "1");
  assert.equal(job.fence, "1");
  assert.equal(job.targetClockRevision, 0);
  assert.equal(job.state, "BUILDING");
  assert.equal(job.leaseGrantId, context.grant);
  assert.match(job.leaseOwner, /^[a-f0-9-]{36}$/u);
  assert.equal(job.baseRevision, "0");
  assert.equal(job.baseHighEventSeq, "0");
  assert.equal(job.highEventSeq, "0");
  assert.equal(job.eventCount, "0");
  assert.equal(job.versionCount, "0");
  assert.equal(job.publishedAt, null);
  assert.equal(job.certificateHash, null);
  assert.deepEqual(job.checkpoint, {
    codec: "source-checkpoint-v1",
    chunkIndex: "0",
    highEventSeq: "0",
    processedThrough: "2025-12-31T16:00:00.000Z",
    lastEvent: null,
    sealed: false,
  });
  assert.ok(job.leaseUntil - job.createdAt >= 29999 && job.leaseUntil - job.createdAt <= 30001);
  const expected = (
    await worker.query(
      "SELECT mock_platform.hash_jsonb(jsonb_build_object('codec','source-checkpoint-hash-v1','scope',$1::jsonb,'revision','1','checkpoint',$2::jsonb)) AS hash",
      [JSON.stringify(context.scope), JSON.stringify(job.checkpoint)],
    )
  ).rows[0].hash;
  assert.equal(job.checkpointHash, expected);
});
test("active competing claim is empty BUSY and cannot allocate another revision", async () => {
  const context = await fresh("busy");
  assert.equal((await claim(worker, context)).rowCount, 0);
  assert.equal(
    (await change(worker, context, context.job, "CLAIM", { owner: randomUUID() })).rowCount,
    0,
  );
  assert.deepEqual(await jobFor(admin, context), context.job);
});
test("uninitialized claim returns no job", async () => {
  const context = await newScope(admin, worker, "uninitialized", false);
  assert.equal((await claim(worker, context)).rowCount, 0);
});
test("claim before the runtime opening returns IDLE without a job", async () => {
  const context = await newScope(admin, worker, "idle", true, "new");
  assert.equal((await claim(worker, context)).rowCount, 0);
  assert.equal(
    (
      await admin.query('SELECT 1 FROM mock_platform."BuildJob" WHERE "sessionId"=$1', [
        context.scope.sessionId,
      ])
    ).rowCount,
    0,
  );
});
test("renew preserves every field except expiry and mutation transaction", async () => {
  const context = await fresh("renew");
  const renewed = (await change(worker, context, context.job, "RENEW")).rows[0];
  assert.ok(renewed.leaseUntil >= context.job.leaseUntil);
  assert.notEqual(renewed.mutationXid, context.job.mutationXid);
  const { leaseUntil: oldExpiry, mutationXid: oldXid, ...old } = context.job;
  const { leaseUntil: newExpiry, mutationXid: newXid, ...next } = renewed;
  assert.deepEqual(next, old);
  assert.ok(oldExpiry && newExpiry && oldXid && newXid);
});
test("FAIL preserves progress and immediate takeover increments fence", async () => {
  const context = await fresh("failure");
  const failed = (
    await change(worker, context, context.job, "FAIL", { state: "FAILED", failure: "INTERRUPTED" })
  ).rows[0];
  assert.equal(failed.failureCode, "INTERRUPTED");
  assert.deepEqual(failed.checkpoint, context.job.checkpoint);
  const owner = randomUUID();
  const next = (await change(worker, context, failed, "CLAIM", { owner, state: "BUILDING" }))
    .rows[0];
  assert.equal(next.fence, "2");
  assert.equal(next.revision, "1");
  assert.equal(next.leaseOwner, owner);
  assert.equal(next.failureCode, null);
  assert.deepEqual(next.checkpoint, failed.checkpoint);
  assert.equal(next.checkpointHash, failed.checkpointHash);
  await assert.rejects(
    change(worker, context, next, "RENEW", { lease: leaseOf(context.job) }),
    sqlError("SM003"),
  );
});
test("CLAIM takeover rejects a NULL state proposal and preserves the failed job", async () => {
  const context = await fresh("null-claim");
  const failed = (
    await change(worker, context, context.job, "FAIL", {
      state: "FAILED",
      failure: "INTERRUPTED",
    })
  ).rows[0];
  await assert.rejects(
    change(worker, context, failed, "CLAIM", { state: null, owner: randomUUID() }),
    sqlError("SM004"),
  );
  assert.deepEqual(await jobFor(admin, context), failed);
});
test("FAIL rejects a NULL state proposal and preserves the active job", async () => {
  const context = await fresh("null-fail");
  await assert.rejects(
    change(worker, context, context.job, "FAIL", { state: null, failure: "INTERRUPTED" }),
    sqlError("SM004"),
  );
  assert.deepEqual(await jobFor(admin, context), context.job);
});
for (const owner of [
  "BAD",
  randomUUID().toUpperCase(),
  "00000000-0000-1000-8000-000000000000",
  "00000000-0000-4000-7000-000000000000",
])
  test(`claim rejects noncanonical owner ${owner.slice(0, 8)}`, async () => {
    const context = await newScope(admin, worker, `owner-${randomUUID().slice(0, 8)}`);
    await assert.rejects(claim(worker, context, owner), sqlError("SM005"));
  });
for (const op of ["APPEND", "PUBLISH", "BOGUS"])
  test(`${op} cannot mutate a job in lease foundation`, async () => {
    const context = await fresh(`closed-${op.toLowerCase()}`);
    await assert.rejects(
      change(worker, context, context.job, op, { state: "PUBLISHED" }),
      sqlError("SM002"),
    );
    assert.deepEqual(await jobFor(admin, context), context.job);
  });
test("one job mutation per transaction rolls back the first renewal", async () => {
  const context = await fresh("mutation");
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "RENEW",
      async () => {
        const values = [context.job.sessionId, 0, "1", context.job.leaseOwner, "BUILDING", null];
        await worker.query(updateSql, values);
        await worker.query(updateSql, values);
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM005"),
  );
  assert.deepEqual(await jobFor(admin, context), context.job);
});
for (const [name, options] of [
  ["owner", { owner: randomUUID() }],
  ["state", { state: "FAILED" }],
  ["failure", { failure: "GENERATOR_INVALID" }],
])
  test(`renew rejects changing ${name}`, async () => {
    const context = await fresh(`illegal-${name}`);
    await assert.rejects(change(worker, context, context.job, "RENEW", options), sqlError("SM004"));
  });
for (const lease of [
  null,
  {},
  { revision: "01", fence: "1", ownerId: randomUUID() },
  { revision: "1", fence: "0", ownerId: randomUUID() },
  { revision: "1", fence: "1", ownerId: randomUUID(), extra: true },
])
  test(`invalid lease reference ${JSON.stringify(lease)} fails before casting`, async () => {
    const context = await fresh(`ref-${randomUUID().slice(0, 8)}`);
    await assert.rejects(
      change(worker, context, context.job, "RENEW", { lease }),
      sqlError("SM005"),
    );
  });
test("foreign actual login cannot borrow worker grant", async () => {
  const context = await fresh("foreign");
  await assert.rejects(claim(foreign, context), sqlError("SM001"));
});
test("full binding mismatch fails fresh guard", async () => {
  const context = await newScope(admin, worker, "binding");
  const wrong = { ...context, scope: { ...context.scope, externalStoreId: "other" } };
  await assert.rejects(claim(worker, wrong), sqlError("SM001"));
});
test("undeclared session and repeatable-read INSERT fail statement CONTROL", async () => {
  const context = await newScope(admin, worker, "protocol");
  await assert.rejects(
    worker.query(claimSql, [...scopeValues(context.scope), randomUUID()]),
    sqlError("SM002"),
  );
  await worker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await worker.query(
      "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id',$3,true),set_config('demo.control_session_id',$4,true)",
      ["source-worker", "source-merchant-a", context.grant, context.scope.sessionId],
    );
    await assert.rejects(
      worker.query(claimSql, [...scopeValues(context.scope), randomUUID()]),
      sqlError("SM002"),
    );
  } finally {
    await worker.query("ROLLBACK");
  }
});
test("reader hides staged jobs and versions and cannot select private columns", async () => {
  const context = await fresh("reader");
  await readerScope(context, async () => {
    assert.equal(
      (await reader.query('SELECT revision,state FROM mock_platform."BuildJob"')).rowCount,
      0,
    );
    assert.equal((await reader.query('SELECT * FROM mock_platform."EntityVersion"')).rowCount, 0);
  });
  for (const sql of [
    'SELECT * FROM mock_platform."BuildJob"',
    'SELECT checkpoint FROM mock_platform."BuildJob"',
    'SELECT * FROM mock_platform."SourceEvent"',
  ])
    await assert.rejects(reader.query(sql), sqlError("42501"));
});
for (const table of ["BuildJob", "SourceEvent", "EntityVersion"])
  test(`${table} app and reader have no writes; worker has no destructive rights`, async () => {
    await assert.rejects(app.query(`SELECT * FROM mock_platform."${table}"`), sqlError("42501"));
    for (const login of ["source_read_login", "source_worker_login"]) {
      const rights = (
        await admin.query(
          "SELECT has_table_privilege($1,$2,'DELETE') AS del,has_table_privilege($1,$2,'TRUNCATE') AS trunc,has_table_privilege($1,$2,'TRIGGER') AS trigger",
          [login, `mock_platform."${table}"`],
        )
      ).rows[0];
      assert.deepEqual(rights, { del: false, trunc: false, trigger: false });
    }
  });
test("worker input columns exclude derived values and existing auth/control mutation rights", async () => {
  for (const [table, column] of [
    ["BuildJob", "revision"],
    ["BuildJob", "mutationXid"],
    ["SourceEvent", "eventSeq"],
    ["EntityVersion", "payload"],
  ])
    assert.equal(
      (
        await admin.query(
          "SELECT has_column_privilege('source_worker_login',$1,$2,'INSERT') AS allowed",
          [`mock_platform."${table}"`, column],
        )
      ).rows[0].allowed,
      false,
    );
  for (const table of [
    'mock_platform."Runtime"',
    'demo."MockWorkerGrant"',
    'demo."DemoCommerceSession"',
    'public."OrganizationMember"',
    'public."WorkspaceMember"',
    'public."TenantBootstrapEnvironment"',
  ])
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege('source_worker_login',$1,'UPDATE') AS allowed",
          [table],
        )
      ).rows[0].allowed,
      false,
    );
});
test("fact INSERT is unconditionally fail-closed even for zero candidates", async () => {
  const context = await fresh("facts");
  for (const table of ["SourceEvent", "EntityVersion"])
    await assert.rejects(
      sourceTransaction(
        worker,
        context.scope,
        "APPEND",
        () =>
          worker.query(`INSERT INTO mock_platform."${table}" ("sessionId") SELECT $1 WHERE false`, [
            context.scope.sessionId,
          ]),
        leaseOf(context.job),
        context.grant,
      ),
      sqlError("SM002"),
    );
});
test("statement CONTROL locks before candidate/unique work on INSERT and zero-row UPDATE", async () => {
  const context = await fresh("ordering");
  for (const sql of [
    claimSql,
    'UPDATE mock_platform."BuildJob" SET "leaseOwner"="leaseOwner" WHERE false',
  ]) {
    await barrier.query("BEGIN");
    await barrier.query("SELECT demo.lock_source_control($1)", [context.scope.sessionId]);
    await beginWorker(worker, context.scope, context.grant);
    await worker.query("SELECT set_config('mock.source_op','CLAIM',true)");
    const pending = worker.query(
      sql,
      sql === claimSql ? [...scopeValues(context.scope), randomUUID()] : [],
    );
    try {
      await waitLock(admin, 1397575508, false, worker.processID);
      await barrier.query("COMMIT");
      await pending;
    } finally {
      await barrier.query("ROLLBACK");
      await worker.query("ROLLBACK");
    }
  }
});
test("fresh post-lock authorization sees revoked grant after outer INSERT snapshot", async () => {
  const context = await newScope(admin, worker, "fresh");
  await barrier.query("BEGIN");
  await barrier.query("SELECT demo.lock_source_control($1)", [context.scope.sessionId]);
  await beginWorker(worker, context.scope, context.grant);
  await worker.query("SELECT set_config('mock.source_op','CLAIM',true)");
  const pending = worker.query(claimSql, [...scopeValues(context.scope), randomUUID()]);
  const rejected = assert.rejects(pending, sqlError("SM001"));
  try {
    await waitLock(admin, 1397575508, false, worker.processID);
    await barrier.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      context.grant,
    ]);
    await barrier.query("COMMIT");
    await rejected;
  } finally {
    await barrier.query("ROLLBACK");
    await worker.query("ROLLBACK");
  }
  assert.equal(
    (
      await admin.query('SELECT 1 FROM mock_platform."BuildJob" WHERE "sessionId"=$1', [
        context.scope.sessionId,
      ])
    ).rowCount,
    0,
  );
});
test("different valid grant needs takeover before renewing and then owns the lease", async () => {
  const context = await fresh("grant-transfer");
  await grantSource(admin, context.scope, "lease-grant-replacement");
  const replacement = { ...context, grant: "lease-grant-replacement" };
  await assert.rejects(change(worker, replacement, context.job, "RENEW"), sqlError("SM003"));
  const failed = (
    await change(worker, context, context.job, "FAIL", {
      state: "FAILED",
      failure: "GENERATOR_INVALID",
    })
  ).rows[0];
  const taken = (
    await change(worker, replacement, failed, "CLAIM", { state: "BUILDING", owner: randomUUID() })
  ).rows[0];
  assert.equal(taken.leaseGrantId, replacement.grant);
  assert.equal(taken.fence, "2");
  assert.deepEqual(taken.checkpoint, context.job.checkpoint);
  await assert.rejects(change(worker, context, taken, "RENEW"), sqlError("SM003"));
  assert.equal((await change(worker, replacement, taken, "RENEW")).rowCount, 1);
});
test("claim freezes target while authorized CONTROL advances the business clock", async () => {
  const context = await fresh("frozen");
  await operatorControl(
    admin,
    'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1::timestamp,"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$2',
    ["2026-01-01T16:00:00.000Z", context.scope.sessionId],
    context.scope,
  );
  assert.deepEqual(await jobFor(admin, context), context.job);
  assert.equal((await claim(worker, context)).rowCount, 0);
});
test("wall lease expiry at deferred COMMIT rolls back renewal; expired takeover preserves job", async () => {
  const context = await fresh("expiry");
  await assert.rejects(
    sourceTransaction(
      worker,
      context.scope,
      "RENEW",
      async () => {
        await worker.query(updateSql, [
          context.job.sessionId,
          0,
          "1",
          context.job.leaseOwner,
          "BUILDING",
          null,
        ]);
        await worker.query("SELECT pg_sleep(30.05)");
      },
      leaseOf(context.job),
      context.grant,
    ),
    sqlError("SM003"),
  );
  assert.deepEqual(await jobFor(admin, context), context.job);
  await assert.rejects(change(worker, context, context.job, "RENEW"), sqlError("SM003"));
  await assert.rejects(
    change(worker, context, context.job, "FAIL", { state: "FAILED", failure: "INTERRUPTED" }),
    sqlError("SM003"),
  );
  const taken = (await change(worker, context, context.job, "CLAIM", { owner: randomUUID() }))
    .rows[0];
  assert.equal(taken.fence, "2");
  assert.equal(taken.revision, "1");
  assert.deepEqual(taken.checkpoint, context.job.checkpoint);
});
test("accidental fact mutation privileges do not defeat immutable statement guards", async () => {
  await admin.query(
    'GRANT UPDATE,DELETE,TRUNCATE ON mock_platform."SourceEvent",mock_platform."EntityVersion" TO source_worker_login',
  );
  try {
    for (const table of ["SourceEvent", "EntityVersion"])
      for (const sql of [
        `UPDATE mock_platform."${table}" SET kind=kind`,
        `DELETE FROM mock_platform."${table}"`,
      ])
        await assert.rejects(worker.query(sql), sqlError("SM005"));
    await assert.rejects(
      worker.query('TRUNCATE mock_platform."SourceEvent",mock_platform."EntityVersion"'),
      sqlError("SM005"),
    );
  } finally {
    await admin.query(
      'REVOKE UPDATE,DELETE,TRUNCATE ON mock_platform."SourceEvent",mock_platform."EntityVersion" FROM source_worker_login',
    );
  }
});
test("new guards remain fixed-path invoker and PUBLIC cannot execute them", async () => {
  const names = [
    "source_scope",
    "source_conflict",
    "require_source_scope",
    "require_lease_statement",
    "deny_source_fact_insert",
    "deny_source_mutation",
    "require_lease_owner",
    "require_live_lease",
    "initial_job",
    "guard_job_insert",
    "transition_job",
    "guard_job_update",
    "check_final_job_lease",
  ];
  const rows = (
    await admin.query(
      "SELECT p.proname,p.prosecdef,p.proconfig,has_function_privilege('public',p.oid,'EXECUTE') AS public_exec FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mock_platform' AND p.proname=ANY($1)",
      [names],
    )
  ).rows;
  assert.equal(rows.length, names.length);
  assert.ok(
    rows.every(
      (row) =>
        !row.prosecdef && !row.public_exec && row.proconfig.includes("search_path=pg_catalog"),
    ),
  );
});
test("concurrent FAILED takeover has one winner and one BUSY without another revision", async () => {
  const context = await fresh("concurrent");
  const failed = (
    await change(worker, context, context.job, "FAIL", { state: "FAILED", failure: "INTERRUPTED" })
  ).rows[0];
  const results = await Promise.all([
    change(worker, context, failed, "CLAIM", { owner: randomUUID(), state: "BUILDING" }),
    change(worker2, context, failed, "CLAIM", { owner: randomUUID(), state: "BUILDING" }),
  ]);
  assert.deepEqual(results.map((result) => result.rowCount).sort(), [0, 1]);
  const final = await jobFor(admin, context);
  assert.equal(final.fence, "2");
  assert.equal(final.revision, "1");
  assert.deepEqual(final.checkpoint, context.job.checkpoint);
});
test("fresh deferred authorization failure rolls back successful renewal without AUTH barrier", async () => {
  const context = await fresh("deferred-denied");
  try {
    await assert.rejects(
      sourceTransaction(
        worker,
        context.scope,
        "RENEW",
        async () => {
          assert.equal((await worker.query(updateSql, renewValues(context.job))).rowCount, 1);
          await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
            "REVOKED",
            context.grant,
          ]);
        },
        leaseOf(context.job),
        context.grant,
      ),
      sqlError("SM001"),
    );
    assert.deepEqual(await jobFor(admin, context), context.job);
  } finally {
    await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      context.grant,
    ]);
  }
});
test("source workers cannot row-lock Runtime, authorization or CONTROL rows", async () => {
  for (const table of [
    'mock_platform."Runtime"',
    'demo."MockWorkerGrant"',
    'demo."DemoCommerceSession"',
    'public."OrganizationMember"',
    'public."WorkspaceMember"',
    'public."TenantBootstrapEnvironment"',
  ])
    await assert.rejects(worker.query(`SELECT 1 FROM ${table} FOR UPDATE`), sqlError("42501"));
});
