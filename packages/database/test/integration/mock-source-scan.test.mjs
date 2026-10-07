import assert from "node:assert/strict";
import test from "node:test";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { sealedPublication } from "../helpers/mock-source-publish-port-fixture.mjs";
import { readerActor } from "../helpers/mock-platform-fixture.mjs";
import { advance } from "../helpers/mock-source-publish-fixture.mjs";
import { chunkFor } from "../helpers/mock-source-append-port-fixture.mjs";
import { preparedAppend } from "../helpers/mock-source-append-port-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js");
let context;
let reader;
test.before(async () => {
  context = await leasePortDatabase(source, "scan");
  context.env.MOCK_SOURCE_CURSOR_KEY = "k".repeat(32);
  reader = source.createMockSourceReader(context.env);
});
test.after(async () => {
  await reader.close();
  await closeLeasePortDatabase(context);
});

test("published source versions scan in stable key order across reader restarts", async () => {
  const state = await sealedPublication(context, ["STORE", "PRODUCT", "ORDER"]);
  const published = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(published.status, "PUBLISHED");
  const input = { since: state.lease.targetTime, until: state.lease.targetTime, limit: 1 };
  const first = await reader.scanVersions(readerActor, state.scope, input);
  assert.equal(first.publication.certificateHash, published.publication.certificateHash);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  await assert.rejects(
    reader.scanVersions(readerActor, state.scope, {
      ...input,
      kind: "PRODUCT",
      cursor: first.nextCursor,
    }),
    { code: "SOURCE_INPUT" },
  );
  await reader.close();
  reader = source.createMockSourceReader(context.env);
  const second = await reader.scanVersions(readerActor, state.scope, {
    ...input,
    cursor: first.nextCursor,
  });
  const third = await reader.scanVersions(readerActor, state.scope, {
    ...input,
    cursor: second.nextCursor,
  });
  assert.deepEqual(
    [first, second, third].flatMap((page) => page.items.map((item) => item.kind)),
    ["ORDER", "PRODUCT", "STORE"],
  );
  assert.equal(third.nextCursor, null);
  assert.equal((await reader.scanVersions(readerActor, state.scope, input)).items.length, 1);
});

test("published scans restrict kind and entity key before pagination", async () => {
  const state = await sealedPublication(context, ["STORE", "PRODUCT", "ORDER"]);
  await context.worker.publish(state.actor, state.lease, state.input);
  const window = { since: state.lease.targetTime, until: state.lease.targetTime, limit: 1 };
  const product = await reader.scanVersions(readerActor, state.scope, {
    ...window,
    kind: "PRODUCT",
  });
  assert.deepEqual(
    product.items.map((item) => item.kind),
    ["PRODUCT"],
  );
  assert.equal(product.nextCursor, null);
  const exact = await reader.scanVersions(readerActor, state.scope, {
    ...window,
    kind: "PRODUCT",
    entityKey: product.items[0].entityKey,
  });
  assert.deepEqual(exact.items, product.items);
  const absent = await reader.scanVersions(readerActor, state.scope, {
    ...window,
    kind: "PRODUCT",
    entityKey: '["PRODUCT","absent"]',
  });
  assert.deepEqual(absent.items, []);
  await assert.rejects(
    reader.scanVersions(readerActor, state.scope, {
      ...window,
      entityKey: product.items[0].entityKey,
    }),
    { code: "SOURCE_INPUT" },
  );
});

test("scan returns no staged facts and an explicit empty published page", async () => {
  const staged = await preparedAppend(context);
  const window = { since: staged.lease.targetTime, until: staged.lease.targetTime, limit: 10 };
  assert.equal(await reader.scanVersions(readerActor, staged.scope, window), null);
  const empty = await sealedPublication(context);
  assert.equal(
    (await context.worker.publish(empty.actor, empty.lease, empty.input)).status,
    "PUBLISHED",
  );
  const page = await reader.scanVersions(readerActor, empty.scope, {
    since: empty.lease.targetTime,
    until: empty.lease.targetTime,
    limit: 10,
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});

async function assertInvalidCursor(state, input, cursor) {
  await assert.rejects(reader.scanVersions(readerActor, state.scope, { ...input, cursor: "" }), {
    code: "SOURCE_INPUT",
  });
  await assert.rejects(
    reader.scanVersions(readerActor, state.scope, {
      ...input,
      since: "2025-12-31T00:00:00.000Z",
      cursor,
    }),
    { code: "SOURCE_INPUT" },
  );
  await assert.rejects(
    reader.scanVersions(
      readerActor,
      { ...state.scope, storeId: "other-store" },
      { ...input, cursor },
    ),
    { code: "SOURCE_INPUT" },
  );
}

test("scan cursor cannot cross tenant, time window or current authorization", async () => {
  const state = await sealedPublication(context, ["STORE", "PRODUCT"]);
  await context.worker.publish(state.actor, state.lease, state.input);
  const input = { since: state.lease.targetTime, until: state.lease.targetTime, limit: 1 };
  const first = await reader.scanVersions(readerActor, state.scope, input);
  assert.ok(first.nextCursor);
  await assertInvalidCursor(state, input, first.nextCursor);
  assert.equal(
    await reader.scanVersions(
      { userId: "unknown", merchantId: readerActor.merchantId },
      state.scope,
      input,
    ),
    null,
  );
  await context.admin.query('UPDATE "PlatformConnection" SET status=$1 WHERE id=$2', [
    "DISCONNECTED",
    state.scope.connectionId,
  ]);
  assert.equal(
    await reader.scanVersions(readerActor, state.scope, { ...input, cursor: first.nextCursor }),
    null,
  );
});

async function stageNextRelease(state, nextTime) {
  await advance(context.admin, state, nextTime);
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  const appended = await context.worker.appendChunk(state.actor, claimed.lease, {
    ...chunkFor({ ...state, lease: claimed.lease }, ["ORDER"], true),
    expectedCheckpointHash: claimed.lease.checkpointHash,
  });
  assert.equal(appended.status, "COMMITTED");
  return { lease: claimed.lease, checkpointHash: appended.checkpointHash };
}

test("pinned scan hides staged and newly published revisions while fresh scans advance", async () => {
  const state = await sealedPublication(context, ["STORE", "PRODUCT"]);
  const firstPublish = await context.worker.publish(state.actor, state.lease, state.input);
  assert.equal(firstPublish.status, "PUBLISHED");
  const initial = { since: state.lease.targetTime, until: state.lease.targetTime, limit: 1 };
  const first = await reader.scanVersions(readerActor, state.scope, initial);
  const nextTime = new Date(Date.parse(state.lease.targetTime) + 60_000).toISOString();
  const next = await stageNextRelease(state, nextTime);
  const pending = await reader.scanVersions(readerActor, state.scope, initial);
  assert.equal(pending.publication.revision, firstPublish.publication.revision);
  assert.equal(pending.items.length, 1);
  const secondPublish = await context.worker.publish(state.actor, next.lease, {
    expectedBaseRevision: next.lease.baseRevision,
    checkpointHash: next.checkpointHash,
  });
  assert.equal(secondPublish.status, "PUBLISHED");
  const resumed = await reader.scanVersions(readerActor, state.scope, {
    ...initial,
    cursor: first.nextCursor,
  });
  assert.equal(resumed.publication.certificateHash, firstPublish.publication.certificateHash);
  assert.deepEqual(
    resumed.items.map((item) => item.kind),
    ["STORE"],
  );
  assert.equal(resumed.nextCursor, null);
  const fresh = await reader.scanVersions(readerActor, state.scope, {
    ...initial,
    until: nextTime,
    limit: 10,
  });
  assert.equal(fresh.publication.certificateHash, secondPublish.publication.certificateHash);
  assert.deepEqual(
    fresh.items.map((item) => item.kind),
    ["ORDER", "PRODUCT", "STORE"],
  );
});
