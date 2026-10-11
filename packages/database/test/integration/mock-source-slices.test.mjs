import assert from "node:assert/strict";
import { test } from "node:test";
import * as source from "../../dist/src/mock-platform/index.js";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { scopeFor } from "../helpers/mock-platform-fixture.mjs";
import { chunkFor } from "../helpers/mock-source-append-port-fixture.mjs";
const scope = scopeFor(),
  actor = { grantId: "source-grant-a" };
const start = "2025-12-31T16:00:00.000Z",
  end = "2026-01-01T06:00:00.000Z";
async function advance(context, until) {
  await context.admin.query(
    'UPDATE demo."DemoCommerceSession" SET "clockNow"=$1,"clockRevision"="clockRevision"+1,revision=revision+1 WHERE id=$2',
    [until, scope.sessionId],
  );
}
async function recover(context, lease) {
  assert.equal((await context.worker.fail(actor, lease, "INTERRUPTED")).status, "FAILED");
  const resumed = await context.worker.claimSlice(actor, scope);
  assert.equal(resumed.status, "CLAIMED");
  assert.equal(resumed.lease.targetTime, lease.targetTime);
  assert.deepEqual(resumed.lease.checkpoint, lease.checkpoint);
  assert.equal(resumed.lease.revision, lease.revision);
  assert.equal((await context.worker.renew(actor, lease)).status, "FENCED");
  return resumed.lease;
}
async function seal(context, lease) {
  const appended = await context.worker.appendChunk(
    actor,
    lease,
    chunkFor({ scope, lease }, [], true),
  );
  assert.equal(appended.status, "COMMITTED");
  return { ...lease, checkpoint: appended.checkpoint, checkpointHash: appended.checkpointHash };
}
async function publish(context, lease) {
  const result = await context.worker.publish(actor, lease, {
    expectedBaseRevision: lease.baseRevision,
    checkpointHash: lease.checkpointHash,
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.publication.targetTime, lease.targetTime);
}
async function continuousPrefixes(context) {
  let previous = start,
    clockRevision;
  for (let index = 0; index < 3; index++) {
    const claimed = await context.worker.claimSlice(actor, scope);
    assert.equal(claimed.status, "CLAIMED");
    let lease = claimed.lease;
    assert.equal(
      lease.targetTime,
      new Date(Math.min(Date.parse(previous) + 21_600_000, Date.parse(end))).toISOString(),
    );
    assert.equal(lease.checkpoint.processedThrough, previous);
    clockRevision ??= lease.targetClockRevision;
    assert.equal(lease.targetClockRevision, clockRevision);
    assert.equal(lease.baseRevision, String(index));
    lease = await seal(context, lease);
    if (index === 0) lease = await recover(context, lease);
    await publish(context, lease);
    previous = lease.targetTime;
  }
  assert.equal(previous, end);
}
async function legacyAndDenial(context) {
  assert.deepEqual(await context.worker.claimSlice(actor, scope), { status: "IDLE" });
  assert.deepEqual(await context.worker.claimSlice({ grantId: "source-grant-b" }, scope), {
    status: "DENIED",
  });
  await advance(context, "2026-01-03T16:00:00.000Z");
  const legacy = await context.worker.claim(actor, scope);
  assert.equal(legacy.status, "CLAIMED");
  assert.equal(legacy.lease.targetTime, "2026-01-03T16:00:00.000Z");
  const resumed = await recover(context, legacy.lease);
  assert.equal(resumed.targetTime, legacy.lease.targetTime);
  await context.admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
    "REVOKED",
    actor.grantId,
  ]);
  assert.deepEqual(await context.worker.claimSlice(actor, scope), { status: "DENIED" });
}
test("bounded claims publish continuous prefixes at one clock revision and preserve takeover", async () => {
  const context = await leasePortDatabase(source, "slices");
  try {
    await context.worker.initializeGeneration(actor, scope);
    await advance(context, end);
    await continuousPrefixes(context);
    await legacyAndDenial(context);
  } finally {
    await closeLeasePortDatabase(context);
  }
});
