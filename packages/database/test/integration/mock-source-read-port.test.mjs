import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import { createMockSourceReadPorts } from "../../dist/src/mock-platform/readonly-index.js";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { preparedAppend } from "../helpers/mock-source-append-port-fixture.mjs";
import { readerActor } from "../helpers/mock-platform-fixture.mjs";
import {
  publishReadProducts,
  advanceReadPublication,
} from "../helpers/mock-source-read-port-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js");
const { createLatestCursor, readLatestCursor } = await import(
  "../../dist/src/mock-platform/latest-cursor.js"
);
let context, ports;
const options = () => ({ deadlineAt: new Date(Date.now() + 5000).toISOString() });
const requestFor = (until) => ({
  kind: "PRODUCT",
  requestedUntil: until,
  businessNow: until,
  limit: 1,
  contextHash: "a".repeat(64),
});

test.before(async () => {
  context = await leasePortDatabase(source, "readport");
  context.env.MOCK_SOURCE_CURSOR_KEY = "k".repeat(32);
  ports = createMockSourceReadPorts(context.env);
});
test.after(async () => {
  await ports.close();
  await closeLeasePortDatabase(context);
});

async function expiredCheckpoint() {
  const state = await preparedAppend(context);
  const original = await publishReadProducts(context, state);
  const request = requestFor(original.targetTime);
  const first = await ports.bind(readerActor, state.scope).read(request, options());
  const input = {
    kind: request.kind,
    limit: request.limit,
    until: original.targetTime,
    contextHash: request.contextHash,
  };
  const oldNow = Date.now() - 20 * 60_000;
  const expired = createLatestCursor(
    context.env.MOCK_SOURCE_CURSOR_KEY,
    state.scope,
    original,
    input,
    first.items[0],
    oldNow + 60_000,
    oldNow,
  );
  return { state, original, request, input, expired };
}

async function assertRecoveryBoundaries(port, resumed, scope) {
  for (const changed of [
    { contextHash: "b".repeat(64) },
    { limit: 2 },
    { businessNow: "2020-01-01T00:00:00.000Z" },
    { cursor: undefined },
  ])
    await assert.rejects(port.refreshCheckpoint({ ...resumed, ...changed }, options()), {
      code: "SOURCE_INPUT",
    });
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(port.refreshCheckpoint(resumed, { signal: controller.signal }), {
    code: "SOURCE_ABORTED",
  });
  await assert.rejects(
    port.refreshCheckpoint(resumed, { deadlineAt: new Date(Date.now() - 1000).toISOString() }),
    { code: "SOURCE_DEADLINE" },
  );
  await context.admin.query(
    'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
    ["INACTIVE", scope.organizationId, readerActor.userId],
  );
  try {
    assert.equal(await port.refreshCheckpoint(resumed, options()), null);
    assert.equal(await port.findPublication(options()), null);
  } finally {
    await context.admin.query(
      'UPDATE "OrganizationMember" SET status=$1 WHERE "organizationId"=$2 AND "userId"=$3',
      ["ACTIVE", scope.organizationId, readerActor.userId],
    );
  }
}

test("generation replacement fences checkpoint recovery even with its valid original MAC", async () => {
  const { state, request, expired } = await expiredCheckpoint();
  const port = ports.bind(readerActor, state.scope);
  await context.rawAdmin.query("BEGIN");
  try {
    await context.rawAdmin.query("SELECT set_config('app.user_id',$1,true)", ["source-human"]);
    await context.rawAdmin.query("SELECT demo.lock_source_control($1)", [state.scope.sessionId]);
    await context.rawAdmin.query(
      'UPDATE public."PlatformConnection" SET generation=generation+1 WHERE id=$1',
      [state.scope.connectionId],
    );
    await context.rawAdmin.query("COMMIT");
  } catch (error) {
    await context.rawAdmin.query("ROLLBACK");
    throw error;
  }
  assert.equal(await port.refreshCheckpoint({ ...request, cursor: expired }, options()), null);
  assert.equal(await port.findPublication(options()), null);
});

test("expired persisted read-port checkpoint resumes the original publication after new releases", async () => {
  const { state, original, request, input, expired } = await expiredCheckpoint();
  const future = new Date(Date.parse(original.targetTime) + 60_000).toISOString();
  await advanceReadPublication(context, state, future);
  await publishReadProducts(context, state, ["c-new"]);
  await ports.close();
  ports = createMockSourceReadPorts(context.env);
  const port = ports.bind(readerActor, state.scope);
  const resumed = { ...request, requestedUntil: future, businessNow: future, cursor: expired };
  await assert.rejects(port.read(resumed, options()), { code: "SOURCE_INPUT" });
  const cursor = await port.refreshCheckpoint(resumed, options());
  assert.equal(
    readLatestCursor(context.env.MOCK_SOURCE_CURSOR_KEY, cursor, state.scope, input)
      .certificateHash,
    original.certificateHash,
  );
  const next = await port.read({ ...resumed, cursor }, options());
  assert.equal(next.publication.certificateHash, original.certificateHash);
  assert.equal(next.effectiveUntil, original.targetTime);
  assert.deepEqual(
    next.items.map((item) => item.payload.externalProductId),
    ["b"],
  );
  await assertRecoveryBoundaries(port, resumed, state.scope);
});

test("read-only broker retains the first cutoff and certificate across restart and later publication", async () => {
  const state = await preparedAppend(context);
  const original = await publishReadProducts(context, state);
  const until = state.lease.targetTime;
  const future = new Date(Date.parse(until) + 60_000).toISOString();
  const request = { ...requestFor(future), businessNow: until };
  const first = await ports.bind(readerActor, state.scope).read(request, options());
  assert.equal(first.effectiveUntil, until);
  assert.equal(first.items[0].payload.title, "Persisted product");
  assert.equal(first.items[0].payload.status, "DELETED");
  assert.equal(first.items[0].payload.skus[0].costPriceMinor, null);
  assert.deepEqual(first.items[0].payload.source.quality, {
    state: "PARTIAL",
    issues: ["COST_MISSING"],
  });
  assert.ok(first.nextCursor.length <= 1024);
  await ports.close();
  ports = createMockSourceReadPorts(context.env);
  await advanceReadPublication(context, state, future);
  await publishReadProducts(context, state, ["c-new"]);
  const resumed = { ...request, cursor: first.nextCursor, businessNow: future };
  const second = await ports.bind(readerActor, state.scope).read(resumed, options());
  assert.equal(second.publication.certificateHash, original.certificateHash);
  assert.equal(second.effectiveUntil, until);
  assert.equal(second.items[0].payload.externalProductId, "b");
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    ports.bind(readerActor, { ...state.scope, connectionId: "other" }).read(resumed, options()),
    { code: "SOURCE_INPUT" },
  );
  await assert.rejects(
    ports
      .bind(readerActor, state.scope)
      .read({ ...resumed, contextHash: "b".repeat(64) }, options()),
    { code: "SOURCE_INPUT" },
  );
});

test("unknown publication and coverage are distinct from an explicitly empty published page", async () => {
  const state = await preparedAppend(context);
  const request = requestFor(state.lease.targetTime);
  const port = ports.bind(readerActor, state.scope);
  assert.equal(await port.findPublication(options()), null);
  assert.equal(await port.read(request, options()), null);
  const surrogate = { ...request, entityKey: ["PRODUCT", "\ud800"] };
  assert.equal(await port.read(surrogate, options()), null);
  const published = await publishReadProducts(context, state, []);
  assert.deepEqual(await port.findPublication(options()), published);
  const empty = await port.read(request, options());
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
  for (const id of ["x".repeat(256), "界".repeat(256), "\ud800"])
    assert.deepEqual(
      (await port.read({ ...request, entityKey: ["PRODUCT", id] }, options())).items,
      [],
    );
  const future = new Date(Date.parse(request.requestedUntil) + 1).toISOString();
  assert.equal(
    await port.read({ ...request, requestedUntil: future, businessNow: future }, options()),
    null,
  );
});

async function assertWaitingRecoveryAbort(port, checkpoint) {
  for (const operation of [
    (control) => port.refreshCheckpoint(checkpoint, control),
    (control) => port.findPublication(control),
  ]) {
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await assert.rejects(operation({ signal: controller.signal }), { code: "SOURCE_ABORTED" });
    } finally {
      clearTimeout(timer);
    }
  }
}

test("broker deadline cancels real source lock waits and returns a usable pool", async () => {
  const state = await preparedAppend(context);
  const publication = await publishReadProducts(context, state);
  const port = ports.bind(readerActor, state.scope);
  const request = requestFor(state.lease.targetTime);
  const page = await port.read(request, options());
  const checkpoint = { ...request, cursor: page.nextCursor };
  await context.rawAdmin.query("BEGIN");
  try {
    await context.rawAdmin.query("SELECT demo.lock_source_control($1)", [state.scope.sessionId]);
    const started = Date.now();
    await assert.rejects(
      port.read(request, { deadlineAt: new Date(started + 200).toISOString() }),
      { code: "SOURCE_DEADLINE" },
    );
    assert.ok(Date.now() - started < 2500);
    await assert.rejects(
      port.findPublication({ deadlineAt: new Date(Date.now() + 200).toISOString() }),
      { code: "SOURCE_DEADLINE" },
    );
    await assert.rejects(
      port.refreshCheckpoint(checkpoint, { deadlineAt: new Date(Date.now() + 200).toISOString() }),
      { code: "SOURCE_DEADLINE" },
    );
    await assertWaitingRecoveryAbort(port, checkpoint);
  } finally {
    await context.rawAdmin.query("ROLLBACK");
  }
  assert.equal((await port.read(request, options())).items.length, 1);
  assert.deepEqual(await port.findPublication(options()), publication);
  assert.equal(
    (
      await port.read(
        { ...checkpoint, cursor: await port.refreshCheckpoint(checkpoint, options()) },
        options(),
      )
    ).publication.certificateHash,
    publication.certificateHash,
  );
});
