import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import process from "node:process";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  loginUrl,
  scopeFor,
} from "../helpers/mock-platform-fixture.mjs";
import { beginWorker, grantControl } from "../helpers/mock-source-control-fixture.mjs";
import { freshAppend, eventFor } from "../helpers/mock-source-append-fixture.mjs";
import { seal } from "../helpers/mock-source-publish-fixture.mjs";
import {
  CONTROL,
  outcome,
  assertAuthorized,
  fullSnapshot,
  sourceState,
  exactLock,
  prepareRaw,
  rawStatement,
  assertRawDenial,
  proveRawCandidate,
  noMutationMarker,
  assertNoResidue,
} from "../helpers/mock-source-control-race-fixture.mjs";

let server, admin, worker, operator;
const clients = [];
const priorUrl = process.env.DATABASE_URL;
pg.types.setTypeParser(1114, (value) => new Date(value + "Z"));

async function login(url, name) {
  const client = new pg.Client({ connectionString: loginUrl(url, name) });
  await client.connect();
  clients.push(client);
  await client.query("SET statement_timeout='10s'");
  return client;
}

before(async () => {
  server = await isolatedPostgres();
  const url = new URL(server.url);
  admin = await login(server.url, url.username);
  await admin.query('CREATE DATABASE "shopmate_tenant_test_authraces"');
  url.pathname = "/shopmate_tenant_test_authraces";
  admin = await login(url.toString(), url.username);
  await migrateSource(admin);
  await sourceFixtures(admin);
  await grantControl(admin, "source_control_login");
  worker = await login(url.toString(), "source_worker_login");
  operator = await login(url.toString(), url.username);
});

after(async () => {
  try {
    const ended = await Promise.allSettled(clients.reverse().map((client) => client.end()));
    if (server) {
      const cleanup = new pg.Client({ connectionString: server.url });
      try {
        await cleanup.connect();
        await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_authraces"');
      } finally {
        await cleanup.end();
        await server.stop();
      }
    }
    const failed = ended.filter((result) => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason));
  } finally {
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
  }
});

const variants = {
  grant: {
    table: 'demo."MockWorkerGrant"',
    key: "id",
    value: (context) => context.grant,
    off: "REVOKED",
  },
  organizationMember: {
    table: 'public."OrganizationMember"',
    key: "id",
    value: () => "member-a-source-worker",
    off: "INACTIVE",
  },
  workspaceMember: {
    table: 'public."WorkspaceMember"',
    key: "id",
    value: () => "assigned-a-source-worker",
    off: "INACTIVE",
  },
  workspace: {
    table: 'public."Workspace"',
    key: "id",
    value: (context) => context.scope.workspaceId,
    off: "SUSPENDED",
  },
  marker: {
    table: 'public."DemoTenant"',
    key: '"organizationId"',
    value: (context) => context.scope.organizationId,
  },
};

async function authRow(client, context, variant) {
  const item = variants[variant];
  const result = await client.query(
    `SELECT to_jsonb(t) AS row FROM ${item.table} t WHERE ${item.key}=$1`,
    [item.value(context)],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0].row;
}

async function changeAuth(client, context, variant) {
  const item = variants[variant];
  const result =
    variant === "marker"
      ? await client.query(`DELETE FROM ${item.table} WHERE ${item.key}=$1`, [item.value(context)])
      : await client.query(`UPDATE ${item.table} SET status=$2 WHERE ${item.key}=$1`, [
          item.value(context),
          item.off,
        ]);
  assert.equal(result.rowCount, 1);
}

async function restoreAuth(context, variant, original) {
  const item = variants[variant];
  if (variant === "marker") {
    await admin.query(
      `INSERT INTO ${item.table} (${item.key}) VALUES ($1) ON CONFLICT DO NOTHING`,
      [item.value(context)],
    );
  } else {
    await admin.query(`UPDATE ${item.table} SET status=$2 WHERE ${item.key}=$1`, [
      item.value(context),
      original.status,
    ]);
  }
  assert.deepEqual(await authRow(admin, context, variant), original);
}

async function assertOtherScope() {
  const scope = scopeFor("b");
  await beginWorker(worker, scope, "source-grant-b");
  try {
    const result = await worker.query(
      "SELECT mock_platform.has_worker_access($3,$4,$5,$1,$6,$7,$2) AS allowed,session_user AS login",
      [
        scope.sessionId,
        scope.generation,
        scope.organizationId,
        scope.workspaceId,
        scope.storeId,
        scope.connectionId,
        scope.externalStoreId,
      ],
    );
    assert.deepEqual(result.rows, [{ allowed: true, login: "source_worker_login" }]);
  } finally {
    await worker.query("ROLLBACK");
  }
}

async function holdControl(context) {
  await operator.query("BEGIN");
  await operator.query("SET LOCAL statement_timeout='5s'");
  await operator.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [
    CONTROL,
    context.scope.sessionId,
  ]);
  return exactLock(admin, context, CONTROL, true, operator.processID);
}

function assertOnlyAuthChanged(before, after, variant, grantId) {
  assert.deepEqual(sourceState(after), sourceState(before));
  assert.deepEqual(after.runtimes, before.runtimes);
  assert.deepEqual(after.connection, before.connection);
  assert.deepEqual(after.session, before.session);
  assert.deepEqual(after.audit, before.audit);
  const grants =
    variant === "grant"
      ? before.grants.map((grant) =>
          grant.id === grantId ? { ...grant, status: "REVOKED" } : grant,
        )
      : before.grants;
  assert.deepEqual(after.grants, grants);
}

async function assertRevoked(context, variant, original) {
  if (variant === "marker") {
    const rows = await admin.query('SELECT 1 FROM "DemoTenant" WHERE "organizationId"=$1', [
      context.scope.organizationId,
    ]);
    assert.equal(rows.rowCount, 0);
  } else {
    assert.deepEqual(await authRow(admin, context, variant), {
      ...original,
      status: variants[variant].off,
    });
  }
}

async function releaseAndRestore(context, variant, original, pending) {
  const settled = await Promise.allSettled([
    worker.query("ROLLBACK"),
    operator.query("ROLLBACK"),
    pending,
  ]);
  await restoreAuth(context, variant, original);
  const failed = settled.filter((result) => result.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      "Authorization race cleanup failed",
    );
}

async function controlWaitLoss(t, variant, entrypoint) {
  const context = await freshAppend(
    admin,
    worker,
    `authwait-${variant.toLowerCase()}-${entrypoint === "PUBLISH UPDATE" ? "pub" : "app"}`,
  );
  const event = eventFor(context);
  if (entrypoint === "PUBLISH UPDATE") await seal(worker, context, [event]);
  await assertAuthorized(worker, context);
  const before = await fullSnapshot(admin, context);
  const original = await authRow(admin, context, variant);
  let pending;
  try {
    await proveRawCandidate(worker, context, entrypoint, event);
    assert.deepEqual(await fullSnapshot(admin, context), before);
    const held = await holdControl(context);
    await changeAuth(operator, context, variant);
    await prepareRaw(worker, context, entrypoint, event);
    pending = outcome(rawStatement(worker, context, entrypoint, event));
    const waiting = await exactLock(admin, context, CONTROL, false, worker.processID);
    await noMutationMarker(admin, worker);
    assert.equal(held.login, operator.user);
    assert.equal(waiting.login, "source_worker_login");
    t.diagnostic(JSON.stringify({ variant, entrypoint, held, waiting }));
    await operator.query("COMMIT");
    assertRawDenial(await pending, entrypoint);
    await noMutationMarker(admin, worker);
    await worker.query("ROLLBACK");
    assertOnlyAuthChanged(before, await fullSnapshot(admin, context), variant, context.grant);
    await assertRevoked(context, variant, original);
    await assertOtherScope();
  } finally {
    await releaseAndRestore(context, variant, original, pending);
  }
  assert.deepEqual(await fullSnapshot(admin, context), before);
}

for (const variant of Object.keys(variants)) {
  for (const entrypoint of ["APPEND UPDATE", "PUBLISH UPDATE"]) {
    test(`CONTROL wait ${entrypoint} observes committed ${variant} loss`, { timeout: 20000 }, (t) =>
      controlWaitLoss(t, variant, entrypoint),
    );
  }
}

test("authorization race fixtures leave no locks, hooks or elevated logins", () =>
  assertNoResidue(admin, worker, operator));
