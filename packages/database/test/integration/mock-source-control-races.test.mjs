import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import process from "node:process";
import { URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { migrateSource, sourceFixtures, loginUrl } from "../helpers/mock-platform-fixture.mjs";
import { grantControl } from "../helpers/mock-source-control-fixture.mjs";
import { freshAppend, eventFor, snapshot } from "../helpers/mock-source-append-fixture.mjs";
import { seal, certificates, visibleVersions } from "../helpers/mock-source-publish-fixture.mjs";
import {
  CONTROL,
  MUTATION,
  outcome,
  assertAuthorized,
  mutateSource,
  fullSnapshot,
  sourceState,
  exactLock,
  controlWait,
  changeControl,
  assertControlChanged,
  oldOperation,
} from "../helpers/mock-source-control-race-fixture.mjs";

let server, admin, worker, reader, repo;
const previousUrl = process.env.DATABASE_URL;
const clients = [];
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
  await admin.query('CREATE DATABASE "shopmate_tenant_test_controlraces"');
  url.pathname = "/shopmate_tenant_test_controlraces";
  admin = await login(url.toString(), url.username);
  await migrateSource(admin);
  await sourceFixtures(admin);
  await grantControl(admin, "source_control_login");
  worker = await login(url.toString(), "source_worker_login");
  reader = await login(url.toString(), "source_read_login");
  repo = await import("../../dist/src/index.js");
  await repo.disconnectPrismaClient();
  process.env.DATABASE_URL = loginUrl(url.toString(), "source_control_login");
});

after(async () => {
  try {
    if (repo) await repo.disconnectPrismaClient();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    for (const client of clients.reverse()) await client.end();
    if (server) {
      const cleanup = new pg.Client({ connectionString: server.url });
      await cleanup.connect();
      try {
        await cleanup.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_controlraces"');
      } finally {
        await cleanup.end();
        await server.stop();
      }
    }
  }
});

async function workerFirst(t, kind, op) {
  const context = await freshAppend(admin, worker, `first-${kind}-${op}`);
  const event = eventFor(context);
  if (op === "PUBLISH") await seal(worker, context, [event]);
  await assertAuthorized(worker, context);
  const before = await fullSnapshot(admin, context);
  let changed;
  try {
    const mutation = await mutateSource(worker, context, op, event);
    assert.equal(mutation.rowCount, 1);
    const staged = { ...sourceState(before), ...(await snapshot(worker, context)) };
    const held = await exactLock(admin, context, CONTROL, true, worker.processID);
    const marker = await exactLock(admin, context, MUTATION, true, worker.processID);
    changed = outcome(changeControl(repo, context, kind));
    const waiting = await controlWait(admin, context);
    assert.equal(held.login, "source_worker_login");
    assert.equal(waiting.login, "source_control_login");
    assert.notEqual(waiting.pid, held.pid);
    t.diagnostic(JSON.stringify({ schedule: `worker-first-${op}-${kind}`, held, marker, waiting }));
    await worker.query("COMMIT");
    assert.equal((await changed).result?.status, "WRITTEN");
    await assertWorkerFirst(context, before, kind, op, event, staged);
  } finally {
    await worker.query("ROLLBACK");
    if (changed) await changed;
  }
}

async function assertWorkerFirst(context, before, kind, op, event, staged) {
  const afterControl = await fullSnapshot(admin, context);
  assertControlChanged(before, afterControl, kind);
  assert.deepEqual(sourceState(afterControl), staged);
  assert.deepEqual(afterControl.runtimes, before.runtimes);
  assert.equal(afterControl.jobs.length, 1);
  assert.equal(afterControl.events.length, 1);
  assert.equal(afterControl.versions.length, 1);
  assert.equal(afterControl.jobs[0].state, op === "PUBLISH" ? "PUBLISHED" : "BUILDING");
  assert.equal(afterControl.jobs[0].eventCount, 1);
  assert.equal(afterControl.jobs[0].versionCount, 1);
  if (op === "PUBLISH") {
    assert.match(afterControl.jobs[0].certificateHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(afterControl.events, before.events);
    assert.deepEqual(afterControl.versions, before.versions);
  }
  assert.equal((await certificates(reader, context)).rowCount, 0);
  assert.equal((await visibleVersions(reader, context)).rowCount, 0);
  await oldOperation(worker, context, "APPEND", event);
  await oldOperation(worker, context, "PUBLISH", event);
  assert.deepEqual(await fullSnapshot(admin, context), afterControl);
}

for (const kind of ["reset", "disconnect"])
  for (const op of ["APPEND", "PUBLISH"])
    test(
      `worker-first ${op} commits before actual ${kind} and denies old scope`,
      { timeout: 20000 },
      (t) => workerFirst(t, kind, op),
    );
