import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { SyncWorkerPorts } from "@shopmate/database/sync-host";
import { createMockSourceWorker } from "@shopmate/database/mock-platform";
import { createMockSourceReadPorts } from "@shopmate/database/mock-platform-read";
import { SyncCommerce } from "../dist/commerce.js";
import {
  createSyncDatabase,
  closeSyncDatabase,
  createSyncGrant,
} from "../../../packages/database/test/helpers/sync-host-fixture.mjs";
import { preparedAppend } from "../../../packages/database/test/helpers/mock-source-append-port-fixture.mjs";
import {
  publishReadProducts,
  advanceReadPublication,
} from "../../../packages/database/test/helpers/mock-source-read-port-fixture.mjs";
import { maintenanceClient } from "../../../packages/database/test/helpers/mock-source-control-fixture.mjs";
import {
  sourceEnv,
  loginUrl,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";

let database, context, sources, host, savedUrl;
const options = () => ({
  requestId: "commerce-pg",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
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

async function openedProducts() {
  const state = await preparedAppend(context);
  const publication = await publishReadProducts(context, state);
  await createSyncGrant(database.admin, state.scope, "commerce-grant");
  host = await SyncWorkerPorts.connectGrant("commerce-grant");
  const opened = await new SyncCommerce(host, sources).open(options());
  assert.equal(opened.ok, true);
  assert.ok(opened.data);
  assert.deepEqual(opened.data.bootstrap.scope, state.scope);
  return {
    state,
    publication,
    connector: opened.data.connector,
    opening: opened.data.bootstrap.runtimeOpening,
  };
}

async function assertOtherStreams(connector, until, opening) {
  const query = { until, limit: 1 };
  for (const read of [
    () => connector.listOrders(query, options()),
    () => connector.listRefunds(query, options()),
    () => connector.getInventory(query, options()),
    () => connector.getMarketingMetrics({ ...query, since: opening }, options()),
  ]) {
    const result = await read();
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.items, []);
    assert.equal(result.data.nextCursor, null);
    assert.equal(result.data.sourceWatermark, until);
  }
}

async function assertCurrentRevocation(connector, query, scope) {
  const sql = 'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3';
  await database.admin.query(sql, ["INACTIVE", scope.organizationId, "source-worker"]);
  try {
    assert.equal((await connector.listProducts(query, options())).error.code, "PERMISSION_DENIED");
  } finally {
    await database.admin.query(sql, ["ACTIVE", scope.organizationId, "source-worker"]);
  }
}

test("checked bootstrap composes a restricted real connector whose continuation stays on its original cutoff", async () => {
  const { state, publication, connector, opening } = await openedProducts();
  const query = { until: publication.targetTime, limit: 1 };
  const first = await connector.listProducts(query, options());
  assert.equal(first.ok, true);
  assert.equal(first.data.items[0].externalProductId, "a");
  assert.ok(first.data.nextCursor);
  const future = new Date(Date.parse(publication.targetTime) + 60_000).toISOString();
  await advanceReadPublication(context, state, future);
  await publishReadProducts(context, state, ["c-new"]);
  await assertOtherStreams(connector, future, opening);
  const second = await connector.listProducts(
    { ...query, cursor: first.data.nextCursor },
    options(),
  );
  assert.equal(second.ok, true);
  assert.deepEqual(
    second.data.items.map((item) => item.externalProductId),
    ["b"],
  );
  assert.equal(second.data.sourceWatermark, publication.targetTime);
  assert.equal(second.data.observedAt, future);
  assert.equal(second.data.nextCursor, null);
  await assertCurrentRevocation(connector, query, state.scope);
});
