import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  EventAppendEvidenceRequestSchema,
  TENANT_ROLE_PERMISSIONS,
  createEventFingerprint,
} from "@shopmate/contracts";
import { createEventDecisionPool, createEventRepository } from "../../dist/src/index.js";
import {
  database,
  migrate,
  seedBinding,
  members,
  binding,
  context,
} from "./notification-outbox-fixture.mjs";
import { prepareEventDecisionRuntime } from "./tenant-api-fixture.mjs";

export { binding };
export const actor = {
  userId: "owner",
  merchantId: "note-merchant-a",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "OWNER",
  permissions: TENANT_ROLE_PERMISSIONS.OWNER,
};
export const instant = "2026-11-03T00:00:00.000Z";
export function appendRequest(version = 1, expectedRevision = null) {
  const evidence = evidenceFor(version);
  return EventAppendEvidenceRequestSchema.parse({
    actor,
    binding,
    expectedRevision,
    candidate: {
      schemaVersion: 1,
      fingerprint: createEventFingerprint(evidence),
      severityFloor: "HIGH",
      rulePolicyVersion: "event-policy-v1",
      evidence,
    },
    reference: referenceFor(version, evidence),
  });
}
function referenceFor(version, evidence) {
  return {
    schemaVersion: 1,
    id: `evidence-${version}`,
    version: `v${version}`,
    hash: `hash-${version}`,
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: "metrics-v1",
    baselineVersion: null,
  };
}
const period = {
  periodStart: "2026-11-02T00:00:00.000Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
};
function sourceFor(version, observedAt) {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: "test-only-source",
    version: `v${version}`,
    hash: `source-hash-${version}`,
    binding,
    definitionVersion: "metrics-v1",
    period,
    observedAt,
    measure: null,
  };
}
function evidenceFor(version) {
  const observedAt = new Date(Date.parse(instant) + version * 1000).toISOString();
  return {
    schemaVersion: 1,
    binding,
    ...period,
    observedAt,
    sourceWatermark: observedAt,
    dataStatus: "VERIFIED",
    sampleSize: 100,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    sourceReferences: [sourceFor(version, observedAt)],
    facts: {
      lastSuccessAt: instant,
      lagSeconds: version,
      typedErrorCode: "TIMEOUT",
      affectedResourceKind: "ORDERS",
    },
  };
}
export async function fixture(action) {
  await database(async (state) => {
    await migrate(state.admin);
    await seedBinding(state.admin);
    await members(state.admin);
    const pool = createEventDecisionPool(await prepareEventDecisionRuntime(state.url.toString()));
    const sessions = [];
    try {
      for (let i = 0; i < 2; i++) sessions.push(await pool.connect());
      await action({ ...state, sessions });
    } finally {
      for (const client of sessions) client.release();
      await pool.end();
    }
  });
}
export async function transaction(client, action) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SELECT set_config('statement_timeout',$1,true)", ["10000"]);
    await context(client);
    const result = await action(
      createEventRepository({ actor, client, now: () => "2026-11-03T01:00:00.000Z" }),
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function waitForLock(admin, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [
      pid,
    ]);
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await delay(5);
  }
  assert.fail("Second restricted session never overlapped while waiting on a real PostgreSQL lock");
}
export async function durable(admin) {
  return (
    await admin.query(`SELECT (SELECT count(*)::int FROM events WHERE state <> 'RESOLVED') AS active,
    (SELECT count(*)::int FROM event_evidence) AS evidence,
    (SELECT max(revision)::int FROM events) AS revision`)
  ).rows[0];
}
export function unwrap(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
export { database as childDatabase, migrate };
export { tenantEnvironment } from "../../../../scripts/test-tenant-database.mjs";
async function identitiesFor(left, right) {
  const sql =
    "SELECT pg_backend_pid() AS pid,current_user AS name,session_user AS login,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS unsafe";
  const identities = [await left.query(sql), await right.query(sql)];
  assert.equal(new Set(identities.map((r) => r.rows[0].pid)).size, 2);
  assert.ok(
    identities.every(
      (r) =>
        r.rows[0].name === "shopmate_event_decision_api" &&
        r.rows[0].login === r.rows[0].name &&
        !r.rows[0].unsafe,
    ),
  );
  return identities;
}
function observe(operation) {
  return Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
}
export async function overlapAtBarrier({ entered, release, first, second, waitForOverlap }) {
  const firstResult = observe(first);
  let secondResult;
  let lockResult;
  let left;
  let right;
  try {
    const barrier = await Promise.race([
      entered.then((value) => ({ reached: true, value })),
      firstResult.then(() => ({ reached: false })),
    ]);
    if (barrier.reached) {
      secondResult = observe(second);
      lockResult = await observe(() => waitForOverlap(barrier.value));
    }
  } finally {
    release();
    [left, right] = await Promise.all([firstResult, secondResult]);
  }
  if (left.status === "rejected") throw left.reason;
  if (!right) throw new Error("First operation completed before reaching the overlap barrier");
  if (right.status === "rejected") throw right.reason;
  if (lockResult.status === "rejected") throw lockResult.reason;
  return [left.value, right.value];
}
export async function overlap(state, firstWork, secondWork) {
  const [left, right] = state.sessions;
  const entered = deferred(),
    release = deferred();
  const identities = await identitiesFor(left, right);
  return overlapAtBarrier({
    entered: entered.promise,
    release: release.resolve,
    first: () =>
      transaction(left, async (repository) => {
        const result = await firstWork(repository, left);
        entered.resolve();
        await release.promise;
        return result;
      }),
    second: () => transaction(right, (repository) => secondWork(repository, right)),
    waitForOverlap: () => waitForLock(state.admin, identities[1].rows[0].pid),
  });
}
