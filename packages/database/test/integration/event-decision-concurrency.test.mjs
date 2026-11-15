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

test("stale expected revisions and delayed source evidence cannot replace a newer committed observation", async () => {
  await fixture(async ({ sessions: [left, right], admin }) => {
    const first = unwrap(await transaction(left, (repo) => repo.appendEvidence(appendRequest())));
    const newer = unwrap(
      await transaction(right, (repo) => repo.appendEvidence(appendRequest(3, 1))),
    );
    assert.equal(newer.id, first.id);
    assert.equal(newer.revision, 2);
    const stale = await transaction(left, (repo) => repo.appendEvidence(appendRequest(4, 1)));
    assert.deepEqual(stale, { ok: false, error: { code: "CONFLICT", evidenceIds: [] } });
    const delayed = await transaction(right, (repo) => repo.appendEvidence(appendRequest(2, 2)));
    assert.deepEqual(delayed, { ok: false, error: { code: "VERSION_MISMATCH", evidenceIds: [] } });
    await immutableSourceCase(left, admin, first);
    assert.deepEqual(await durable(admin), { active: 1, evidence: 2, revision: 2 });
    const saved = await admin.query(
      'SELECT "currentEvidenceId","currentEvidenceVersion" FROM events WHERE id=$1',
      [first.id],
    );
    assert.deepEqual(saved.rows, [
      { currentEvidenceId: "evidence-3", currentEvidenceVersion: "v3" },
    ]);
  });
});

async function immutableSourceCase(client, admin, event) {
  const original = await admin.query("SELECT payload FROM event_evidence WHERE id=$1", [
    event.currentEvidence.id,
  ]);
  const reused = globalThis.structuredClone(appendRequest(5, 2));
  reused.candidate.evidence.sourceReferences[0].version = "v1";
  const result = await transaction(client, (repo) => repo.appendEvidence(reused));
  assert.deepEqual(result, { ok: false, error: { code: "VERSION_MISMATCH", evidenceIds: [] } });
  assert.deepEqual(
    (
      await admin.query("SELECT payload FROM event_evidence WHERE id=$1", [
        event.currentEvidence.id,
      ])
    ).rows,
    original.rows,
  );
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
