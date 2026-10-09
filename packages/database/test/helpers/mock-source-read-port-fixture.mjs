import assert from "node:assert/strict";
import { eventFor } from "./mock-source-append-fixture.mjs";
import { advance } from "./mock-source-publish-fixture.mjs";

export async function publishReadProducts(context, state, ids = ["a", "b"]) {
  const at = state.lease.targetTime;
  const events = ids.map((id) =>
    eventFor({ scope: state.scope, job: { targetTime: at } }, "PRODUCT", "0", at, (record) => {
      record.externalProductId = id;
      record.skus[0].externalProductId = id;
      record.title = "Persisted product";
      record.skus[0].costPriceMinor = null;
      record.source.quality = { state: "PARTIAL", issues: ["COST_MISSING"] };
    }),
  );
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  state.lease = renewed.lease;
  const appended = await context.worker.appendChunk(state.actor, state.lease, {
    expectedCheckpointHash: state.lease.checkpointHash,
    next: { processedThrough: at, sealed: true },
    events,
  });
  assert.equal(appended.status, "COMMITTED");
  const published = await context.worker.publish(state.actor, state.lease, {
    expectedBaseRevision: state.lease.baseRevision,
    checkpointHash: appended.checkpointHash,
  });
  assert.equal(published.status, "PUBLISHED");
  return published.publication;
}

export async function advanceReadPublication(context, state, target) {
  await advance(context.admin, state, target);
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  state.lease = claimed.lease;
}
