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
  installControlBarrier,
  controlBarrierWitness,
  prepareRaw,
  rawStatement,
  assertRawDenial,
  proveRawCandidate,
  noMutationMarker,
  cleanupSchedule,
  assertNoResidue,
} from "../helpers/mock-source-control-race-fixture.mjs";

let server, admin, worker, reader, barrier, repo;
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
  await grantControl(admin, "source_control_login");
  worker = await login(url.toString(), "source_worker_login");
  reader = await login(url.toString(), "source_read_login");
  barrier = await login(url.toString(), url.username);
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
    await cleanupSchedule(worker, barrier, admin, changed);
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

async function controlFirst(t, kind, entrypoint) {
  const context = await freshAppend(
    admin,
    worker,
    `reverse-${kind}-${entrypoint.replaceAll(" ", "-")}`,
  );
  const event = eventFor(context);
  if (entrypoint === "PUBLISH UPDATE") await seal(worker, context, [event]);
  await assertAuthorized(worker, context);
  const before = await fullSnapshot(admin, context);
  let changed, pending;
  try {
    await proveRawCandidate(worker, context, entrypoint, event);
    assert.deepEqual(await fullSnapshot(admin, context), before);
    await installControlBarrier(admin, barrier);
    changed = outcome(changeControl(repo, context, kind));
    const witness = await controlBarrierWitness(admin, barrier, context);
    assert.deepEqual(await fullSnapshot(admin, context), before);
    await prepareRaw(worker, context, entrypoint, event);
    pending = outcome(rawStatement(worker, context, entrypoint, event));
    const waiting = await exactLock(admin, context, CONTROL, false, worker.processID);
    await noMutationMarker(admin, worker);
    assert.equal(waiting.login, "source_worker_login");
    assert.equal(witness.held.login, "source_control_login");
    t.diagnostic(
      JSON.stringify({ schedule: `control-first-${entrypoint}-${kind}`, ...witness, waiting }),
    );
    await barrier.query("COMMIT");
    assert.equal((await changed).result?.status, "WRITTEN");
    assertRawDenial(await pending, entrypoint);
    await noMutationMarker(admin, worker);
    await worker.query("ROLLBACK");
    await assertControlFirst(context, before, kind);
  } finally {
    await cleanupSchedule(worker, barrier, admin, changed, pending, true);
  }
}

async function assertControlFirst(context, before, kind) {
  const afterControl = await fullSnapshot(admin, context);
  assertControlChanged(before, afterControl, kind);
  assert.deepEqual(sourceState(afterControl), sourceState(before));
  assert.equal(afterControl.jobs[0].state, "BUILDING");
  assert.equal(afterControl.jobs[0].certificateHash, null);
  assert.equal((await certificates(reader, context)).rowCount, 0);
  assert.equal((await visibleVersions(reader, context)).rowCount, 0);
}

for (const kind of ["reset", "disconnect"])
  for (const entrypoint of ["event VALUES", "APPEND UPDATE", "PUBLISH UPDATE"])
    test(
      `control-first actual ${kind} denies pre-wait ${entrypoint} with fresh SM001`,
      { timeout: 20000 },
      (t) => controlFirst(t, kind, entrypoint),
    );

test("control race fixtures restore hooks, transactions and restricted roles", () =>
  assertNoResidue(admin, worker, barrier));
