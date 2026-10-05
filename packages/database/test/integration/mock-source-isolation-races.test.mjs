import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isolationHarness,
  contextFor,
  snapshots,
  rollbackAll,
  assertReset,
} from "../helpers/mock-source-isolation-fixture.mjs";
import {
  eventFor,
  appendSettings,
  insertEvent,
  snapshot,
  nextFor,
} from "../helpers/mock-source-append-fixture.mjs";
import {
  seal,
  publish,
  publishSettings,
  updatePublish,
  certificateColumns,
} from "../helpers/mock-source-publish-fixture.mjs";
import {
  CONTROL,
  MUTATION,
  beginOperation,
  assertAuthorized,
  proveRawCandidate,
  prepareRaw,
  rawStatement,
  mutateSource,
  fullSnapshot,
  exactLock,
  outcome,
  noMutationMarker,
} from "../helpers/mock-source-control-race-fixture.mjs";

const state = isolationHarness();
async function validCandidate(context, op) {
  await assertAuthorized(state.worker, context);
  const before = await fullSnapshot(state.admin, context);
  await proveRawCandidate(
    state.worker,
    context,
    op === "APPEND" ? "event VALUES" : "PUBLISH UPDATE",
    eventFor(context),
  );
  assert.deepEqual(await fullSnapshot(state.admin, context), before);
}
async function prepared(suffix, op, key = "a", overrides = {}) {
  const context = await contextFor(state, suffix, key, overrides);
  if (op === "PUBLISH") await seal(state.worker, context, [eventFor(context)]);
  await validCandidate(context, op);
  return context;
}
async function deniedTarget(origin, target, op, setting, value) {
  await beginOperation(state.worker, target, op);
  try {
    await state.worker.query("SELECT set_config($1,$2,true)", [setting, value]);
    if (op === "APPEND") {
      await appendSettings(state.worker, target.job, [eventFor(target)], nextFor(target.job));
      await assert.rejects(
        insertEvent(state.worker, target, eventFor(target)),
        (error) => error.code === "SM001",
      );
    } else {
      await publishSettings(state.worker, target.job);
      assert.equal((await updatePublish(state.worker, target)).rowCount, 0);
    }
  } finally {
    await state.worker.query("ROLLBACK");
  }
  await assertReset(state.worker);
  await assertAuthorized(state.worker, origin);
}
for (const op of ["APPEND", "PUBLISH"])
  for (const key of ["a", "b"])
    test(`${op} rejects another ${key === "a" ? "same-organization store" : "organization"} grant and merchant context`, async () => {
      const origin = await prepared(`origin-${op}-${key}`, op);
      const target = await prepared(`target-${op}-${key}`, op, key);
      const before = await snapshots(state, [origin, target]);
      try {
        await deniedTarget(origin, target, op, "mock.grant_id", origin.grant);
        await deniedTarget(origin, target, op, "app.user_id", "source-viewer");
        await deniedTarget(
          origin,
          target,
          op,
          "app.merchant_id",
          `source-merchant-${key === "a" ? "b" : "a"}`,
        );
        assert.equal(await snapshots(state, [origin, target]), before);
      } finally {
        await rollbackAll(state);
      }
    });

for (const field of [
  "organizationId",
  "workspaceId",
  "storeId",
  "sessionId",
  "connectionId",
  "externalStoreId",
  "generation",
])
  test(`APPEND denies substituted ${field} before staging with a valid original lease`, async () => {
    const context = await prepared(`binding-${field}`, "APPEND");
    const unrelated = await prepared(`unrelated-${field}`, "APPEND", "b");
    const before = await snapshots(state, [context, unrelated]);
    const changed = {
      ...context,
      scope: { ...context.scope, [field]: field === "generation" ? 1 : unrelated.scope[field] },
    };
    try {
      await prepareRaw(state.worker, context, "event VALUES", eventFor(context));
      // Session substitution must declare the target CONTROL before testing full-scope authorization.
      await state.worker.query("SELECT set_config('demo.control_session_id',$1,true)", [
        changed.scope.sessionId,
      ]);
      await assert.rejects(
        insertEvent(state.worker, changed, eventFor(context)),
        (error) => error.code === "SM001",
      );
    } finally {
      await rollbackAll(state);
    }
    assert.equal(await snapshots(state, [context, unrelated]), before);
  });
async function readerRows(
  context,
  actor = "source-human",
  merchant = context.scope.organizationId.replace("legacy-org-", ""),
) {
  await state.reader.query("BEGIN");
  try {
    await state.reader.query(
      "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true)",
      [actor, merchant],
    );
    const certs = await state.reader.query(
      `SELECT ${certificateColumns} FROM mock_platform."BuildJob" WHERE "sessionId"=$1`,
      [context.scope.sessionId],
    );
    const versions = await state.reader.query(
      'SELECT * FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 ORDER BY "eventSeq"',
      [context.scope.sessionId],
    );
    return { certs: certs.rows, versions: versions.rows };
  } finally {
    await state.reader.query("ROLLBACK");
    await assertReset(state.reader);
  }
}
async function complete(worker, context, op) {
  const result = await mutateSource(worker, context, op, eventFor(context));
  assert.equal(result.rowCount, 1);
  context.job = result.rows[0];
  await worker.query("COMMIT");
  await assertReset(worker);
}
test("one restricted backend reuses A B denied malformed A through APPEND and PUBLISH", async () => {
  const a = await prepared("reuse-a", "APPEND"),
    b = await prepared("reuse-b", "APPEND", "b");
  const pid = state.worker.processID;
  try {
    await complete(state.worker, a, "APPEND");
    await complete(state.worker, b, "APPEND");
    const stable = await snapshots(state, [a, b]);
    await deniedTarget(a, b, "APPEND", "mock.grant_id", a.grant);
    await prepareRaw(state.worker, a, "APPEND UPDATE", eventFor(a));
    await state.worker.query("SELECT set_config('mock.source_lease','{',true)");
    await assert.rejects(
      rawStatement(state.worker, a, "APPEND UPDATE"),
      (error) => error.code === "SM005",
    );
    await state.worker.query("ROLLBACK");
    assert.equal(await snapshots(state, [a, b]), stable);
    await seal(state.worker, a);
    await seal(state.worker, b);
    await complete(state.worker, b, "PUBLISH");
    await deniedTarget(b, a, "PUBLISH", "mock.grant_id", b.grant);
    await complete(state.worker, a, "PUBLISH");
    assert.equal(state.worker.processID, pid);
    assert.equal((await readerRows(a)).versions.length, 1);
    assert.equal((await readerRows(b)).versions.length, 1);
    assert.equal((await readerRows(a, "unknown")).certs.length, 0);
    assert.equal((await readerRows(b, "source-human", "source-merchant-a")).certs.length, 0);
    assert.equal((await readerRows(a)).certs.length, 1);
  } finally {
    await rollbackAll(state);
  }
});
test("published reader enforces workspace assignment with exact A B denied A actor reuse", async () => {
  await state.admin.query(
    'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
    ["iso-assigned-worker", "legacy-org-source-merchant-a", "source-unassigned", "source-worker"],
  );
  const assigned = await prepared("reader-assigned", "PUBLISH");
  const hidden = await prepared("reader-unassigned", "PUBLISH", "a", {
    workspaceId: "source-unassigned",
  });
  const foreign = await prepared("reader-foreign", "PUBLISH", "b");
  try {
    for (const context of [assigned, hidden, foreign]) await publish(state.worker, context);
    const before = await snapshots(state, [assigned, hidden, foreign]);
    assert.equal((await readerRows(assigned, "source-viewer")).versions.length, 1);
    assert.equal((await readerRows(foreign, "source-viewer")).versions.length, 1);
    assert.deepEqual(await readerRows(hidden, "source-viewer"), { certs: [], versions: [] });
    assert.deepEqual(await readerRows(foreign, "source-human", "source-merchant-a"), {
      certs: [],
      versions: [],
    });
    assert.equal((await readerRows(hidden)).versions.length, 1);
    assert.equal((await readerRows(assigned, "source-viewer")).certs.length, 1);
    assert.equal(await snapshots(state, [assigned, hidden, foreign]), before);
  } finally {
    await rollbackAll(state);
  }
});
async function concurrentPair(op, collision) {
  let ids = [];
  if (collision) {
    const result = await state.admin.query(
      "SELECT array_agg(id ORDER BY id) AS ids FROM (SELECT 'iso-collision-'||n AS id,hashtext('iso-collision-'||n) AS hash FROM generate_series(1,300000) n) k GROUP BY hash HAVING count(*)>1 ORDER BY hash LIMIT 1 OFFSET $1",
      [op === "APPEND" ? 0 : 1],
    );
    assert.ok(result.rows[0]);
    ids = result.rows[0].ids;
  }
  const pair = [];
  for (const [index, key] of ["a", "b"].entries())
    pair.push(
      await prepared(
        `parallel-${op}-${collision}-${key}`,
        op,
        key,
        ids.length ? { sessionId: ids[index] } : {},
      ),
    );
  const hashes = await state.admin.query(
    "SELECT hashtext($1)=hashtext($2) AS equal",
    pair.map((context) => context.scope.sessionId),
  );
  assert.equal(hashes.rows[0].equal, collision);
  return pair;
}
async function stagedMutation(worker, context, op, foreign) {
  const result = await mutateSource(worker, context, op, eventFor(context));
  assert.equal(result.rowCount, 1);
  if (foreign)
    assert.deepEqual(await snapshot(worker, foreign), { jobs: [], events: [], versions: [] });
  return snapshot(worker, context);
}
async function assertCommitted(context, staged, before, op) {
  const after = await fullSnapshot(state.admin, context);
  assert.deepEqual(after, { ...before, ...staged });
  for (const key of ["runtimes", "session", "connection", "audit", "grants"])
    assert.deepEqual(after[key], before[key]);
  assert.equal(after.events.length, 1);
  assert.equal(after.versions.length, 1);
  assert.equal(after.jobs[0].state, op === "PUBLISH" ? "PUBLISHED" : "BUILDING");
  const visible = await readerRows(context);
  assert.equal(visible.certs.length, op === "PUBLISH" ? 1 : 0);
  assert.equal(visible.versions.length, op === "PUBLISH" ? 1 : 0);
  for (const row of [...visible.certs, ...visible.versions])
    for (const [key, value] of Object.entries(context.scope)) assert.equal(row[key], value);
  assert.deepEqual(
    await readerRows(
      context,
      "source-human",
      context.scope.organizationId.endsWith("a") ? "source-merchant-b" : "source-merchant-a",
    ),
    { certs: [], versions: [] },
  );
}
async function concurrency(t, op, collision) {
  const pair = await concurrentPair(op, collision),
    [a, b] = pair;
  const before = [await fullSnapshot(state.admin, a), await fullSnapshot(state.admin, b)];
  let pending;
  try {
    const first = await stagedMutation(state.worker, a, op, b);
    const firstControl = await exactLock(state.admin, a, CONTROL, true, state.worker.processID);
    const firstMarker = await exactLock(state.admin, a, MUTATION, true, state.worker.processID);
    pending = outcome(stagedMutation(state.other, b, op, a));
    if (collision) {
      t.diagnostic(
        JSON.stringify({
          firstControl,
          firstMarker,
          waiting: await exactLock(state.admin, b, CONTROL, false, state.other.processID),
        }),
      );
      await noMutationMarker(state.admin, state.other);
      assert.equal(await snapshots(state, pair), JSON.stringify(before));
      await state.worker.query("COMMIT");
    }
    const second = await pending;
    assert.ifError(second.error);
    const secondControl = await exactLock(state.admin, b, CONTROL, true, state.other.processID);
    const secondMarker = await exactLock(state.admin, b, MUTATION, true, state.other.processID);
    assert.notEqual(firstMarker.key, secondMarker.key);
    t.diagnostic(JSON.stringify({ firstControl, firstMarker, secondControl, secondMarker }));
    if (!collision) await state.worker.query("COMMIT");
    await state.other.query("COMMIT");
    await assertCommitted(a, first, before[0], op);
    await assertCommitted(b, second.result, before[1], op);
  } finally {
    await rollbackAll(state, [pending]);
  }
}
for (const op of ["APPEND", "PUBLISH"])
  for (const collision of [false, true])
    test(
      `${op} distinct actual backends ${collision ? "serialize colliding" : "concurrently hold independent"} CONTROL scopes`,
      { timeout: 25000 },
      (t) => concurrency(t, op, collision),
    );
