import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { SyncWorkerPorts } from "../../dist/src/sync-host/index.js";
import { createMockSourceWorker } from "../../dist/src/mock-platform/index.js";
import {
  createSyncDatabase,
  closeSyncDatabase,
  createSyncGrant,
  syncScope,
} from "../helpers/sync-host-fixture.mjs";
import { sourceEnv, scopeFor, loginUrl } from "../helpers/mock-platform-fixture.mjs";
let database;
test.before(async () => {
  database = await createSyncDatabase("worker");
  await createSyncGrant(database.admin, syncScope(), "bootstrap-a");
  const source = createMockSourceWorker(sourceEnv(database.url));
  try {
    assert.equal(
      (await source.initializeGeneration({ grantId: "source-grant-a" }, scopeFor())).status,
      "CREATED",
    );
  } finally {
    await source.close();
  }
});
test.after(async () => {
  if (database) await closeSyncDatabase(database);
});

test("grant-only SDK refuses foreign grants and application operator credentials", async () => {
  const previous = process.env.SYNC_WORKER_DATABASE_URL;
  try {
    await createSyncGrant(database.admin, syncScope("b"), "bootstrap-b", "sync_foreign_login");
    process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
    for (const id of ["absent", "bootstrap-b"])
      await assert.rejects(SyncWorkerPorts.connectGrant(id), /SYNC_WORKER_CONNECTION_FAILED/u);
    process.env.SYNC_WORKER_DATABASE_URL = database.url;
    await assert.rejects(
      SyncWorkerPorts.connectGrant("bootstrap-a"),
      /SYNC_WORKER_CONNECTION_FAILED/u,
    );
  } finally {
    if (previous === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
    else process.env.SYNC_WORKER_DATABASE_URL = previous;
  }
});
test("SDK connects with only a grant id and recomputes current authority on the pinned backend", async () => {
  const previous = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
  let ports;
  try {
    ports = await SyncWorkerPorts.connectGrant("bootstrap-a");
    const context = await ports.runtimeBootstrap();
    assert.equal(context.principalUserId, "source-worker");
    assert.deepEqual(context.scope, scopeFor());
    assert.ok(Object.isFrozen(context.scope));
    assert.ok(Object.isFrozen(context.config.binding));
    assert.ok(await ports.listWork());
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "REVOKED",
      "bootstrap-a",
    ]);
    assert.equal(await ports.runtimeBootstrap(), null);
    await assert.rejects(ports.listWork(), /SYNC_WORKER_OPERATION_FAILED/u);
  } finally {
    await ports?.close();
    await database.admin.query('UPDATE sync_host."WorkerGrant" SET status=$1 WHERE id=$2', [
      "ACTIVE",
      "bootstrap-a",
    ]);
    if (previous === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
    else process.env.SYNC_WORKER_DATABASE_URL = previous;
  }
});
