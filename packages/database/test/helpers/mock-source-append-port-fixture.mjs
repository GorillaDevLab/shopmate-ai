import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSourceSession, grantSource, scopeFor } from "./mock-platform-fixture.mjs";
import { eventFor } from "./mock-source-append-fixture.mjs";
import { fullSnapshot } from "./mock-source-control-race-fixture.mjs";
import { advance, publish } from "./mock-source-publish-fixture.mjs";

export async function preparedAppend(context, namespace = "mock/store.1", target) {
  const suffix = randomUUID().slice(0, 8);
  const scope = {
    ...scopeFor(),
    storeId: `append-port-store-${suffix}`,
    sessionId: `append-port-session-${suffix}`,
    connectionId: `append-port-connection-${suffix}`,
    externalStoreId: namespace,
  };
  const actor = { grantId: `append-port-grant-${suffix}` };
  await createSourceSession(context.admin, scope);
  await grantSource(context.admin, scope, actor.grantId);
  assert.equal((await context.worker.initializeGeneration(actor, scope)).status, "CREATED");
  if (target) await advance(context.admin, { scope }, target);
  const claimed = await context.worker.claim(actor, scope);
  assert.equal(claimed.status, "CLAIMED");
  return { scope, actor, lease: claimed.lease };
}

export async function rawPublishAppend(context, state) {
  const job = (
    await context.admin.query(
      'SELECT * FROM mock_platform."BuildJob" WHERE "sessionId"=$1 AND revision=$2',
      [state.scope.sessionId, state.lease.revision],
    )
  ).rows[0];
  const result = await publish(context.rawWorker, {
    scope: state.scope,
    grant: state.actor.grantId,
    job,
  });
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

export function chunkFor(state, kinds = ["STORE"], sealed = false) {
  return {
    expectedCheckpointHash: state.lease.checkpointHash,
    next: { processedThrough: state.lease.targetTime, sealed },
    events: kinds.map((kind) =>
      eventFor(
        { scope: state.scope, job: { targetTime: state.lease.targetTime } },
        kind,
        "0",
        state.lease.targetTime,
      ),
    ),
  };
}

export const sdkAppend = (context, state, input, lease = state.lease, actor = state.actor) =>
  context.worker.appendChunk(actor, lease, input);

export async function unchangedAppend(
  context,
  state,
  input,
  expected,
  lease = state.lease,
  actor = state.actor,
) {
  const before = await fullSnapshot(context.admin, state);
  const action = () => sdkAppend(context, state, input, lease, actor);
  if (typeof expected === "string")
    await assert.rejects(action, { code: expected, message: expected });
  else assert.deepEqual(await action(), expected);
  assert.deepEqual(await fullSnapshot(context.admin, state), before);
}

export async function renewAppend(context, state) {
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  state.lease = renewed.lease;
}

export async function simulatedLostAppendAcknowledgment(context, state, input) {
  const committed = await sdkAppend(context, state, input);
  assert.equal(committed.status, "COMMITTED");
  // Test-only caller acknowledgment loss after the real port has actually committed.
  throw new Error("TEST_APPEND_ACKNOWLEDGMENT_LOST");
}
