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
  nextFor,
} from "../helpers/mock-source-append-fixture.mjs";
import { seal, publishSettings, updatePublish } from "../helpers/mock-source-publish-fixture.mjs";
import {
  CONTROL,
  beginOperation,
  assertAuthorized,
  proveRawCandidate,
  prepareRaw,
  fullSnapshot,
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
