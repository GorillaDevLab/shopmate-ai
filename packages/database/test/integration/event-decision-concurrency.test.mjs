import assert from "node:assert/strict";
import test from "node:test";
import { decide, evaluationContext } from "../helpers/event-decision-concurrency-winner.mjs";
import {
  fixture,
  appendRequest,
  transaction,
  overlap,
  durable,
  unwrap,
} from "../helpers/event-decision-concurrency-fixture.mjs";

test("ten sequential and overlapping duplicate appends retain one active event and immutable evidence", async () => {
  await fixture(async (state) => {
    const work = (repo) => repo.appendEvidence(appendRequest());
    const results = await overlap(state, work, work);
    const winner = unwrap(results[0]);
    assert.equal(unwrap(results[1]).id, winner.id);
    for (let i = 0; i < 8; i++) {
      const replay = await transaction(state.sessions[i % 2], work);
      assert.equal(unwrap(replay).id, winner.id);
    }
    assert.deepEqual(await durable(state.admin), { active: 1, evidence: 1, revision: 1 });
  });
});

test("an early second operation rejection drains both restricted transactions before fixture teardown", async () => {
  const failure = new Error("Second operation rejected before waiting on a lock");
  let secondFinished = false;
  await fixture(async (state) => {
    const identities = await Promise.all(
      state.sessions.map((client) => client.query("SELECT pg_backend_pid() AS pid")),
    );
    const pids = identities.map(({ rows }) => rows[0].pid);
    const pending = overlap(
      state,
      async (repo) => repo.appendEvidence(appendRequest()),
      async () => {
        secondFinished = true;
        throw failure;
      },
    );
    await assert.rejects(pending, (error) => error === failure);
    const activity = await state.admin.query(
      "SELECT state FROM pg_stat_activity WHERE pid=ANY($1::int[]) ORDER BY pid",
      [pids],
    );
    assert.deepEqual(activity.rows, [{ state: "idle" }, { state: "idle" }]);
    assert.deepEqual(await durable(state.admin), { active: 1, evidence: 1, revision: 1 });
  });
  assert.equal(secondFinished, true);
});

test("stale expected revisions and delayed source evidence cannot replace a newer committed observation", async () => {
  await fixture(async ({ sessions: [left, right], admin }) => {
    const original = appendRequest();
    const first = unwrap(await transaction(left, (repo) => repo.appendEvidence(original)));
    const history = await savedEvidence(admin, original.reference.id);
    assert.deepEqual(history, expectedEvidence(original));

    const next = appendRequest(3, 1);
    const newer = unwrap(await transaction(right, (repo) => repo.appendEvidence(next)));
    const accepted = await savedCurrentEvidence(admin, first.id);
    assert.deepEqual(accepted, expectedEvidence(next));
    assert.equal(newer.id, first.id);
    assert.equal(newer.revision, 2);

    await assertRejectedAppends(left, right);
    assert.deepEqual(await durable(admin), { active: 1, evidence: 2, revision: 2 });
    assert.deepEqual(await savedCurrentEvidence(admin, first.id), accepted);
    assert.deepEqual(await savedEvidence(admin, original.reference.id), history);
  });
});

function expectedEvidence({ reference: { id, version, hash }, candidate: { evidence } }) {
  return { id, version, hash, payload: evidence };
}

async function savedEvidence(admin, id) {
  const result = await admin.query(
    "SELECT id,version,hash,payload FROM event_evidence WHERE id=$1",
    [id],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function savedCurrentEvidence(admin, eventId) {
  const result = await admin.query(
    `SELECT e."currentEvidenceId" AS id,e."currentEvidenceVersion" AS version,
    e."currentEvidenceHash" AS hash,v.payload
    FROM events e JOIN event_evidence v ON v.id=e."currentEvidenceId" WHERE e.id=$1`,
    [eventId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function assertRejectedAppends(left, right) {
  const stale = await transaction(left, (repo) => repo.appendEvidence(appendRequest(4, 1)));
  assert.deepEqual(stale, { ok: false, error: { code: "CONFLICT", evidenceIds: [] } });
  const delayed = await transaction(right, (repo) => repo.appendEvidence(appendRequest(2, 2)));
  assert.deepEqual(delayed, { ok: false, error: { code: "VERSION_MISMATCH", evidenceIds: [] } });
  const reused = globalThis.structuredClone(appendRequest(5, 2));
  reused.candidate.evidence.sourceReferences[0].version = "v1";
  const result = await transaction(left, (repo) => repo.appendEvidence(reused));
  assert.deepEqual(result, { ok: false, error: { code: "VERSION_MISMATCH", evidenceIds: [] } });
}

test("ten same-key decision attempts on overlapping sessions retain exactly one effective winner", async () => {
  await fixture(async (state) => {
    const [left] = state.sessions;
    const event = unwrap(await transaction(left, (repo) => repo.appendEvidence(appendRequest())));
    const context = evaluationContext(event);
    let routed = 0;
    const route = async (run) => {
      routed++;
      return { ok: true, value: run };
    };
    const work = (_repo, client) => decide(client, context, route);
    const results = await overlap(state, work, work);
    for (let i = 0; i < 8; i++)
      results.push(
        await transaction(left, () =>
          decide(left, context, async () => assert.fail("Committed key routed twice")),
        ),
      );
    assert.equal(new Set(results.map((run) => run.id)).size, 1);
    assert.equal(routed, 1);
    assert.deepEqual((await state.admin.query('SELECT "winnerRunId" FROM decision_claims')).rows, [
      { winnerRunId: results[0].id },
    ]);
    const saved = await state.admin.query(
      "SELECT count(*)::int AS count FROM decision_runs WHERE effective IS NOT NULL",
    );
    assert.equal(saved.rows[0].count, 1);
  });
});
