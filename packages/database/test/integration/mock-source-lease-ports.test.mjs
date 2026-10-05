import assert from "node:assert/strict";
import test from "node:test";
import { eventFor, append } from "../helpers/mock-source-append-fixture.mjs";
import {
  closeLeasePortDatabase,
  deferredFailure,
  deferredLeaseExpiry,
  waitForLeaseExpiry,
  leasePortDatabase,
  publishForIdle,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { jobFor, newScope } from "../helpers/mock-source-lease-fixture.mjs";
import { scopeFor } from "../helpers/mock-platform-fixture.mjs";
import { fullSnapshot } from "../helpers/mock-source-control-race-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js").catch(() => null);
const actor = (grantId) => ({ grantId });
const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function assertLease(lease, scope) {
  assert.deepEqual(lease.scope, scope);
  assert.match(lease.ownerId, v4);
  assert.match(lease.targetTime, utc);
  assert.match(lease.leaseUntil, utc);
  assert.match(lease.checkpoint.processedThrough, utc);
  for (const value of [
    lease.revision,
    lease.fence,
    lease.baseRevision,
    lease.baseHighEventSeq,
    lease.checkpoint.chunkIndex,
    lease.checkpoint.highEventSeq,
  ])
    assert.match(value, /^(0|[1-9][0-9]{0,18})$/u);
}

async function ensurePrimary(context, state) {
  if (state.lease) return;
  const scope = scopeFor(),
    workerActor = actor("source-grant-a");
  await context.worker.initializeGeneration(workerActor, scope);
  const claimed = await context.worker.claim(workerActor, scope);
  assert.equal(claimed.status, "CLAIMED");
  Object.assign(state, { scope, actor: workerActor, lease: claimed.lease });
}

async function initialClaims(context, state) {
  const scope = scopeFor(),
    workerActor = actor("source-grant-a");
  assert.deepEqual(await context.worker.claim(workerActor, scope), { status: "UNINITIALIZED" });
  assert.equal((await context.worker.initializeGeneration(workerActor, scope)).status, "CREATED");
  const claimed = await context.worker.claim(workerActor, scope);
  assert.equal(claimed.status, "CLAIMED");
  assertLease(claimed.lease, scope);
  assert.deepEqual(await context.worker.claim(workerActor, scope), { status: "BUSY" });
  Object.assign(state, { scope, actor: workerActor, lease: claimed.lease });
}

async function appendOneCanonicalEvent(context, state) {
  const rawJob = await jobFor(context.admin, state);
  const rawContext = { scope: state.scope, grant: state.actor.grantId, job: rawJob };
  const bounds = (
    await context.admin.query(
      `SELECT mock_platform.canonical_utc("processedThrough") AS processed,
        mock_platform.canonical_utc("targetTime") AS target FROM mock_platform."BuildJob"
       WHERE "sessionId"=$1 AND generation=$2`,
      [state.scope.sessionId, state.scope.generation],
    )
  ).rows[0];
  const event = eventFor(rawContext, "STORE", "0", bounds.target);
  assert.ok(event.occurredAt >= bounds.processed);
  await append(context.rawWorker, rawContext, [event], {
    processedThrough: bounds.target,
    sealed: false,
  });
}

async function failureAndTakeover(context, state) {
  await ensurePrimary(context, state);
  await appendOneCanonicalEvent(context, state);
  const before = await fullSnapshot(context.admin, state);
  assert.deepEqual(await context.worker.fail(state.actor, state.lease, "INTERRUPTED"), {
    status: "FAILED",
  });
  const resumed = await context.worker.claim(state.actor, state.scope);
  assert.equal(resumed.status, "CLAIMED");
  assert.equal(resumed.lease.revision, state.lease.revision);
  assert.equal(BigInt(resumed.lease.fence), BigInt(state.lease.fence) + 1n);
  assert.deepEqual(resumed.lease.checkpoint, before.jobs[0].checkpoint);
  const after = await fullSnapshot(context.admin, state);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.versions, before.versions);
  assert.notEqual(resumed.lease.ownerId, state.lease.ownerId);
  assert.deepEqual(await context.worker.renew(state.actor, state.lease), { status: "FENCED" });
  state.lease = resumed.lease;
}

async function preparedLease(context, suffix) {
  const prepared = await newScope(context.admin, context.rawWorker, suffix);
  const workerActor = actor(prepared.grant);
  const claimed = await context.worker.claim(workerActor, prepared.scope);
  assert.equal(claimed.status, "CLAIMED");
  return { scope: prepared.scope, actor: workerActor, lease: claimed.lease };
}

async function actualExpiredTakeover(context) {
  const state = await preparedLease(context, "official-natural-expiry");
  await appendOneCanonicalEvent(context, state);
  const before = await fullSnapshot(context.admin, state);
  assert.equal(before.events.length, 1);
  assert.equal(before.versions.length, 1);
  await waitForLeaseExpiry(context.admin, state.lease);
  assert.deepEqual(await fullSnapshot(context.admin, state), before);
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  assertLease(claimed.lease, state.scope);
  assert.equal(claimed.lease.revision, state.lease.revision);
  assert.equal(BigInt(claimed.lease.fence), BigInt(state.lease.fence) + 1n);
  assert.notEqual(claimed.lease.ownerId, state.lease.ownerId);
  assert.deepEqual(claimed.lease.checkpoint, before.jobs[0].checkpoint);
  const after = await fullSnapshot(context.admin, state);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.versions, before.versions);
  assert.deepEqual(after.runtimes, before.runtimes);
  assert.equal(after.jobs.length, 1);
  assert.deepEqual(await context.worker.renew(state.actor, state.lease), { status: "FENCED" });
  assert.deepEqual(await context.worker.fail(state.actor, state.lease, "INTERRUPTED"), {
    status: "FENCED",
  });
}

async function renewalCases(context, state) {
  await ensurePrimary(context, state);
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  assert.equal(renewed.lease.ownerId, state.lease.ownerId);
  assert.equal(renewed.lease.fence, state.lease.fence);
  const missing = { ...state.lease, revision: String(BigInt(state.lease.revision) + 1n) };
  assert.deepEqual(await context.worker.renew(state.actor, missing), { status: "FENCED" });
  assert.deepEqual(await context.worker.fail(state.actor, missing, "GENERATOR_INVALID"), {
    status: "FENCED",
  });
  state.lease = renewed.lease;
}

async function authorizationCases(context, state) {
  await ensurePrimary(context, state);
  assert.deepEqual(await context.worker.renew(actor("source-grant-b"), state.lease), {
    status: "DENIED",
  });
  await context.admin.query("UPDATE demo.\"MockWorkerGrant\" SET status='REVOKED' WHERE id=$1", [
    state.actor.grantId,
  ]);
  assert.deepEqual(await context.worker.fail(state.actor, state.lease, "INTERRUPTED"), {
    status: "DENIED",
  });
  await context.admin.query("UPDATE demo.\"MockWorkerGrant\" SET status='ACTIVE' WHERE id=$1", [
    state.actor.grantId,
  ]);
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  state.lease = renewed.lease;
}

async function idleClaim(context) {
  const prepared = await newScope(context.admin, context.rawWorker, "official-idle");
  const workerActor = actor(prepared.grant),
    claimed = await context.worker.claim(workerActor, prepared.scope);
  assert.equal(claimed.status, "CLAIMED");
  await publishForIdle(context.admin, prepared.scope);
  assert.deepEqual(await context.worker.claim(workerActor, prepared.scope), { status: "IDLE" });
}

async function concurrentClaim(context) {
  const prepared = await newScope(context.admin, context.rawWorker, "official-contention");
  const contender = source.createMockSourceWorker(context.env);
  try {
    const results = await Promise.all([
      context.worker.claim(actor(prepared.grant), prepared.scope),
      contender.claim(actor(prepared.grant), prepared.scope),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["BUSY", "CLAIMED"]);
  } finally {
    await contender.close();
  }
}

async function mappedCommitFailure(context, state, code, expected) {
  const before = await fullSnapshot(context.admin, state);
  const action = () => context.worker.renew(state.actor, state.lease);
  if (typeof expected === "string")
    await assert.rejects(
      () => deferredFailure(context.admin, code, action),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.message, expected);
        for (const key of ["cause", "detail", "hint", "query", "schema", "table", "constraint"])
          assert.equal(Object.hasOwn(error, key), false);
        return true;
      },
    );
  else assert.deepEqual(await deferredFailure(context.admin, code, action), expected);
  assert.deepEqual(await fullSnapshot(context.admin, state), before);
}

async function deferredFailures(context, state) {
  await ensurePrimary(context, state);
  await mappedCommitFailure(context, state, "SM001", { status: "DENIED" });
  await mappedCommitFailure(context, state, "SM003", { status: "FENCED" });
  await mappedCommitFailure(context, state, "SM004", "SOURCE_STORAGE");
  await mappedCommitFailure(context, state, "SM005", "SOURCE_INTEGRITY");
  for (const code of ["23514", "40P01", "57014", "ZZ999"])
    await mappedCommitFailure(context, state, code, "SOURCE_STORAGE");
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  state.lease = renewed.lease;
}

async function actualDeferredExpiry(context) {
  const state = await preparedLease(context, "official-commit-expiry");
  await appendOneCanonicalEvent(context, state);
  const before = await fullSnapshot(context.admin, state);
  assert.equal(before.events.length, 1);
  assert.equal(before.versions.length, 1);
  const result = await deferredLeaseExpiry(context.admin, () =>
    context.worker.renew(state.actor, state.lease),
  );
  assert.deepEqual(result, { status: "FENCED" });
  assert.deepEqual(await fullSnapshot(context.admin, state), before);
  assert.deepEqual(await context.worker.renew(state.actor, state.lease), { status: "FENCED" });
  const claimed = await context.worker.claim(state.actor, state.scope);
  assert.equal(claimed.status, "CLAIMED");
  assert.deepEqual(claimed.lease.checkpoint, before.jobs[0].checkpoint);
  const renewed = await context.worker.renew(state.actor, claimed.lease);
  assert.equal(renewed.status, "RENEWED");
}

async function storageLifecycle(context, state) {
  await ensurePrimary(context, state);
  await mappedCommitFailure(context, state, "SM002", "SOURCE_STORAGE");
  await context.worker.close();
  context.worker = source.createMockSourceWorker(context.env);
  const renewed = await context.worker.renew(state.actor, state.lease);
  assert.equal(renewed.status, "RENEWED");
  state.lease = renewed.lease;
}

let context;
const state = {};
test.before(async () => {
  assert.ok(source, "source module must build");
  context = await leasePortDatabase(source);
});
test.after(async () => closeLeasePortDatabase(context));
test("claim distinguishes uninitialized and returns a canonical busy lease", () =>
  initialClaims(context, state));
test("fail and takeover preserve a nonempty journal and fence old references", () =>
  failureAndTakeover(context, state));
test("renew uses exact scope and maps accessible missing leases", () =>
  renewalCases(context, state));
test("changed and mismatched grants deny without leaking pooled identity", () =>
  authorizationCases(context, state));
test("claim returns idle after the current clock is published", () => idleClaim(context));
test("concurrent official claims have exactly one winner", () => concurrentClaim(context));
test("deferred commit failures map only after rollback", () => deferredFailures(context, state));
test("storage failure permits close and clean recreation", () => storageLifecycle(context, state));
test(
  "actual expired official claim preserves a nonempty journal and fences old references",
  {
    timeout: 60000,
  },
  () => actualExpiredTakeover(context),
);
test(
  "deferred final live-lease expiry rolls back the official renewal",
  {
    timeout: 60000,
  },
  () => actualDeferredExpiry(context),
);
