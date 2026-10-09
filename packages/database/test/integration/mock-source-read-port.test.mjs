import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(await port.read(request, options()), null);
  const surrogate = { ...request, entityKey: ["PRODUCT", "\ud800"] };
  assert.equal(await port.read(surrogate, options()), null);
  await publishReadProducts(context, state, []);
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

test("broker deadline cancels real source lock waits and returns a usable pool", async () => {
  const state = await preparedAppend(context);
  await publishReadProducts(context, state);
  const port = ports.bind(readerActor, state.scope);
  const request = requestFor(state.lease.targetTime);
  await context.rawAdmin.query("BEGIN");
  try {
    await context.rawAdmin.query("SELECT demo.lock_source_control($1)", [state.scope.sessionId]);
    const started = Date.now();
    await assert.rejects(
      port.read(request, { deadlineAt: new Date(started + 200).toISOString() }),
      { code: "SOURCE_DEADLINE" },
    );
    assert.ok(Date.now() - started < 2500);
  } finally {
    await context.rawAdmin.query("ROLLBACK");
  }
  assert.equal((await port.read(request, options())).items.length, 1);
});
