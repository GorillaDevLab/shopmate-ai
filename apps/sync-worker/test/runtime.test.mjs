import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SyncWorkerPorts } from "@shopmate/database/sync-host";
import { createMockSourceWorker } from "@shopmate/database/mock-platform";
import { createMockSourceReadPorts } from "@shopmate/database/mock-platform-read";
import { SyncCommerce, SyncCoordinator, SyncPageRunner, projectSyncWork } from "../dist/index.js";
import {
  decodeCompactLatest,
  encodeCompactLatest,
} from "../../../packages/database/dist/src/mock-platform/latest-cursor-codec.js";
import {
  createSyncDatabase,
  closeSyncDatabase,
  createSyncGrant,
} from "../../../packages/database/test/helpers/sync-host-fixture.mjs";
import { preparedAppend } from "../../../packages/database/test/helpers/mock-source-append-port-fixture.mjs";
import { eventFor } from "../../../packages/database/test/helpers/mock-source-append-fixture.mjs";
import { maintenanceClient } from "../../../packages/database/test/helpers/mock-source-control-fixture.mjs";
import {
  sourceEnv,
  loginUrl,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";

let database, context, sources, host, savedUrl;
const until = "2026-01-02T00:00:00.000Z";
const options = () => ({
  requestId: "runtime-pg",
  deadlineAt: new Date(Date.now() + 25_000).toISOString(),
});
test.before(async () => {
  database = await createSyncDatabase("worker");
  const env = { ...sourceEnv(database.url), MOCK_SOURCE_CURSOR_KEY: "k".repeat(32) };
  context = {
    env,
    admin: maintenanceClient(database.admin, "source-human"),
    worker: createMockSourceWorker(env),
  };
  sources = createMockSourceReadPorts(env);
  savedUrl = process.env.SYNC_WORKER_DATABASE_URL;
  process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
});
test.after(async () => {
  await host?.close();
  await sources?.close();
  await context?.worker.close();
  if (savedUrl === undefined) delete process.env.SYNC_WORKER_DATABASE_URL;
  else process.env.SYNC_WORKER_DATABASE_URL = savedUrl;
  if (database) await closeSyncDatabase(database);
});

function productEvents(state, count) {
  return Array.from({ length: count }, (_, index) => {
    const id = `runtime-${String(index).padStart(4, "0")}`;
    return eventFor(
      { scope: state.scope, job: { targetTime: until } },
      "PRODUCT",
      "0",
      until,
      (record) => {
        record.externalProductId = id;
        record.skus[0].externalProductId = id;
        record.skus[0].externalSkuId = `sku-${id}`;
      },
    );
  });
}
async function publishProducts(state, count) {
  const events = productEvents(state, count);
  let checkpointHash = state.lease.checkpointHash;
  for (let offset = 0; offset < events.length; offset += 100) {
    const appended = await context.worker.appendChunk(state.actor, state.lease, {
      expectedCheckpointHash: checkpointHash,
      next: { processedThrough: until, sealed: offset + 100 >= events.length },
      events: events.slice(offset, offset + 100),
    });
    assert.equal(appended.status, "COMMITTED");
    checkpointHash = appended.checkpointHash;
  }
  const published = await context.worker.publish(state.actor, state.lease, {
    expectedBaseRevision: state.lease.baseRevision,
    checkpointHash,
  });
  assert.equal(published.status, "PUBLISHED");
}

async function connectRuntime(grant) {
  host = await SyncWorkerPorts.connectGrant(grant);
  const opened = await new SyncCommerce(host, sources).open(options());
  assert.equal(opened.ok, true);
  assert.ok(opened.data);
  return opened.data;
}
async function preparedRuntime(count = 1) {
  await host?.close();
  host = undefined;
  const state = await preparedAppend(context, undefined, until);
  await publishProducts(state, count);
  const grant = `runtime-${state.scope.sessionId}`;
  await createSyncGrant(database.admin, state.scope, grant);
  return { state, grant, opened: await connectRuntime(grant) };
}
async function latestJob(opened, stream) {
  const projected = projectSyncWork(await host.listWork(), opened.bootstrap);
  return projected.jobs.find((job) => job.stream === stream);
}
async function savedCounts(scope, jobId) {
  const row = await database.admin.query(
    `SELECT (SELECT count(*)::int FROM commerce."ProductListing" WHERE "storeId"=$1) AS products,
     (SELECT count(*)::int FROM sync_host."PageReceipt" WHERE "jobId"=$2) AS receipts,
     (SELECT "pageCount" FROM sync_host."Job" WHERE id=$2) AS pages`,
    [scope.storeId, jobId],
  );
  return row.rows[0];
}

async function resumedRun(grant, job, cursor) {
  await host.close();
  host = undefined;
  // Fixture-only expiry changes no cursor, receipt, business facts or production lease duration.
  await database.admin.query(
    'UPDATE sync_host."Job" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [job.id],
  );
  const restarted = await connectRuntime(grant);
  const persisted = await latestJob(restarted, "PRODUCTS");
  assert.equal(persisted.cursor, cursor);
  return new SyncPageRunner(host, restarted.connector, restarted.bootstrap.runtimeOpening).run(
    persisted,
  );
}

function expiredContinuation(connector) {
  return {
    binding: connector.binding,
    async listProducts(query, call) {
      const result = await connector.listProducts(query, call);
      assert.equal(result.ok, true);
      assert.ok(result.data.nextCursor);
      const key = context.env.MOCK_SOURCE_CURSOR_KEY;
      const state = decodeCompactLatest(key, result.data.nextCursor, Date.now());
      const oldNow = Date.now() - 20 * 60_000;
      // Test-only issuance changes expiry alone; binding/query/certificate/last witness are authentic.
      const nextCursor = encodeCompactLatest(key, { ...state, e: oldNow + 60_000 }, oldNow);
      assert.throws(() => decodeCompactLatest(key, nextCursor, Date.now()), {
        code: "SOURCE_INPUT",
      });
      return { ok: true, data: { ...result.data, nextCursor } };
    },
  };
}

test("a page-limited durable run restarts with an expired persisted continuation without duplicate facts or cursor gaps", async () => {
  const { state, grant, opened } = await preparedRuntime(201);
  const job = await host.createWindow("PRODUCTS", until);
  const runner = new SyncPageRunner(
    host,
    expiredContinuation(opened.connector),
    opened.bootstrap.runtimeOpening,
  );
  const first = await runner.run(job, { maxPages: 1 });
  assert.equal(first.reason, "PAGE_LIMIT");
  assert.equal(first.job.status, "RUNNING");
  assert.ok(first.job.cursor);
  const firstCounts = await savedCounts(state.scope, job.id);
  // Source pages also obey a serialized payload cap, independently of the requested item limit.
  assert.ok(firstCounts.products > 0 && firstCounts.products < 201);
  assert.equal(firstCounts.receipts, 1);
  assert.equal(firstCounts.pages, 1);
  const resumed = await resumedRun(grant, job, first.job.cursor);
  assert.equal(resumed.reason, "SUCCEEDED");
  assert.equal(resumed.job.successfulThrough, until);
  const completed = await savedCounts(state.scope, job.id);
  assert.equal(completed.products, 201);
  assert.ok(completed.receipts > 1);
  assert.equal(completed.pages, completed.receipts);
});

test("terminal commit acknowledgment loss leaves exactly one canonical receipt and restart observes completion", async () => {
  const { state, opened } = await preparedRuntime();
  const job = await host.createWindow("PRODUCTS", until);
  const transport = {
    claim: (value) => host.claim(value),
    renew: (value) => host.renew(value),
    fail: (value) => host.fail(value),
    async commitPage(...args) {
      await host.commitPage(...args);
      throw new Error("TEST_COMMIT_ACK_LOST");
    },
  };
  await assert.rejects(
    new SyncPageRunner(transport, opened.connector, opened.bootstrap.runtimeOpening).run(job),
    /TEST_COMMIT_ACK_LOST/u,
  );
  assert.deepEqual(await savedCounts(state.scope, job.id), { products: 1, receipts: 1, pages: 1 });
  const persisted = await latestJob(opened, "PRODUCTS");
  assert.equal(persisted.status, "SUCCEEDED");
  const result = await new SyncPageRunner(
    host,
    opened.connector,
    opened.bootstrap.runtimeOpening,
  ).run(persisted);
  assert.equal(result.reason, "SUCCEEDED");
  assert.deepEqual(await savedCounts(state.scope, job.id), { products: 1, receipts: 1, pages: 1 });
});

test("all remaining real connector streams commit certified empty coverage through the common target", async () => {
  const { opened } = await preparedRuntime();
  const runner = new SyncPageRunner(host, opened.connector, opened.bootstrap.runtimeOpening);
  for (const stream of ["ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]) {
    const job = await host.createWindow(stream, until);
    const result = await runner.run(job);
    assert.equal(result.reason, "SUCCEEDED");
    assert.equal(result.job.successfulThrough, until);
    assert.equal(result.job.sourceWatermark, until);
    assert.equal(result.job.pageCount, 1);
  }
});

test("current membership revocation after a real fetch prevents the atomic page commit", async () => {
  const { state, opened } = await preparedRuntime();
  const job = await host.createWindow("PRODUCTS", until);
  const membershipSql =
    'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3';
  const connector = {
    binding: opened.connector.binding,
    async listProducts(query, call) {
      const result = await opened.connector.listProducts(query, call);
      assert.equal(result.ok, true);
      await database.admin.query(membershipSql, [
        "INACTIVE",
        state.scope.organizationId,
        "source-worker",
      ]);
      return result;
    },
  };
  try {
    await assert.rejects(
      new SyncPageRunner(host, connector, opened.bootstrap.runtimeOpening).run(job),
      /SYNC_WORKER_OPERATION_FAILED/u,
    );
    assert.deepEqual(await savedCounts(state.scope, job.id), {
      products: 0,
      receipts: 0,
      pages: 0,
    });
  } finally {
    await database.admin.query(membershipSql, [
      "ACTIVE",
      state.scope.organizationId,
      "source-worker",
    ]);
  }
});

test("stop after a real source fetch preserves the live job without committing or marking failure", async () => {
  const { state, opened } = await preparedRuntime();
  const job = await host.createWindow("PRODUCTS", until);
  const controller = new AbortController();
  const connector = {
    binding: opened.connector.binding,
    async listProducts(query, call) {
      const result = await opened.connector.listProducts(query, call);
      assert.equal(result.ok, true);
      controller.abort();
      return result;
    },
  };
  const result = await new SyncPageRunner(host, connector, opened.bootstrap.runtimeOpening).run(
    job,
    { signal: controller.signal },
  );
  assert.equal(result.reason, "STOPPED");
  assert.equal((await latestJob(opened, "PRODUCTS")).status, "RUNNING");
  assert.deepEqual(await savedCounts(state.scope, job.id), { products: 0, receipts: 0, pages: 0 });
});

test("the real coordinator shares a target, resumes its pinned lease and waits only after all five streams finish", async () => {
  const { state } = await preparedRuntime(201);
  const coordinator = new SyncCoordinator(host, sources);
  const first = await coordinator.pass({ maxPages: 1 });
  assert.equal(first.status, "PROGRESSED");
  assert.equal(first.created.length, 5);
  assert.deepEqual(new Set(first.created.map((job) => job.until)), new Set([until]));
  const product = first.outcomes.find((result) => result.job.stream === "PRODUCTS");
  assert.equal(product.reason, "PAGE_LIMIT");
  assert.equal(first.outcomes.filter((result) => result.reason === "SUCCEEDED").length, 4);
  const second = await coordinator.pass();
  assert.equal(second.status, "PROGRESSED");
  assert.equal(second.created.length, 0);
  assert.equal(second.outcomes.length, 1);
  assert.equal(second.outcomes[0].reason, "SUCCEEDED");
  const counts = await savedCounts(state.scope, product.job.id);
  assert.equal(counts.products, 201);
  assert.equal(counts.receipts, counts.pages);
  assert.equal((await coordinator.pass()).reason, "CAUGHT_UP");
});

test("the built CLI runs a real grant-only pass and reports only committed jobs", async () => {
  const { state, grant } = await preparedRuntime();
  await host.close();
  host = undefined;
  const result = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--once"],
    {
      windowsHide: true,
      timeout: 30000,
      env: {
        ...process.env,
        ...context.env,
        APP_ENV: "demo",
        ENABLE_DEMO_MODE: "true",
        SYNC_WORKER_GRANT_ID: grant,
      },
    },
  );
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "PROGRESSED",
    created: 5,
    outcomes: 5,
    succeeded: 5,
  });
  const jobs = await database.admin.query(
    'SELECT id,status FROM sync_host."Job" WHERE "grantId"=$1',
    [grant],
  );
  assert.equal(jobs.rowCount, 5);
  assert.ok(jobs.rows.every((job) => job.status === "SUCCEEDED"));
  const products = await database.admin.query(
    'SELECT count(*)::int AS count FROM commerce."ProductListing" WHERE "storeId"=$1',
    [state.scope.storeId],
  );
  assert.equal(products.rows[0].count, 1);
});
