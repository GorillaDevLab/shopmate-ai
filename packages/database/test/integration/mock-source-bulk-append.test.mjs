import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import {
  preparedAppend,
  sdkAppend,
  unchangedAppend,
} from "../helpers/mock-source-append-port-fixture.mjs";
import { eventFor, snapshot, suppression } from "../helpers/mock-source-append-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js");
let context;
test.before(async () => {
  context = await leasePortDatabase(source, "bulk");
  await context.rawAdmin.query(`
    CREATE TABLE mock_platform.test_append_statements (kind text, rows integer);
    GRANT INSERT ON mock_platform.test_append_statements TO shopmate_mock_source_worker;
    CREATE FUNCTION mock_platform.test_observe_append() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO mock_platform.test_append_statements SELECT TG_TABLE_NAME,count(*) FROM observed;
      RETURN NULL;
    END $$;
    CREATE TRIGGER test_observe_event AFTER INSERT ON mock_platform."SourceEvent"
      REFERENCING NEW TABLE AS observed FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.test_observe_append();
    CREATE TRIGGER test_observe_version AFTER INSERT ON mock_platform."EntityVersion"
      REFERENCING NEW TABLE AS observed FOR EACH STATEMENT EXECUTE FUNCTION mock_platform.test_observe_append();
  `);
});
test.after(async () => closeLeasePortDatabase(context));

function chunk(state, count) {
  return {
    expectedCheckpointHash: state.lease.checkpointHash,
    next: { processedThrough: state.lease.targetTime, sealed: false },
    events: Array.from({ length: count }, (_, index) =>
      eventFor(
        { scope: state.scope, job: { targetTime: state.lease.targetTime } },
        "STORE",
        String(index),
        state.lease.targetTime,
      ),
    ),
  };
}

test("bounded append scans its pending suffix once per table while preserving sequence and replay proofs", async (t) => {
  const state = await preparedAppend(context);
  const input = chunk(state, 20);
  const started = performance.now();
  const committed = await sdkAppend(context, state, input);
  t.diagnostic(`20-event append: ${Math.round(performance.now() - started)} ms`);
  assert.equal(committed.status, "COMMITTED");
  const facts = await snapshot(context.admin, state);
  assert.equal(facts.events.length, 20);
  assert.equal(facts.versions.length, 20);
  for (const [index, event] of facts.events.entries()) {
    assert.equal(event.eventSeq, index + 1);
    assert.equal(event.ordinal, index);
    assert.equal(event.acceptedFence, Number(state.lease.fence));
    assert.deepEqual(event.payload, facts.versions[index].payload);
    assert.equal(facts.versions[index].versionHash, event.manifest[0].versionHash);
  }
  const observed = (
    await context.rawAdmin.query(
      "SELECT kind,rows FROM mock_platform.test_append_statements ORDER BY kind",
    )
  ).rows;
  assert.deepEqual(observed, [
    { kind: "EntityVersion", rows: 20 },
    { kind: "SourceEvent", rows: 20 },
  ]);
  await unchangedAppend(context, state, input, { ...committed, status: "ALREADY_COMMITTED" });
});

for (const table of ["SourceEvent", "EntityVersion"])
  test(`suppressed bulk ${table} row rolls back the complete append`, async () => {
    const state = await preparedAppend(context);
    await suppression(context.rawAdmin, table, () =>
      unchangedAppend(context, state, chunk(state, 3), "SOURCE_INTEGRITY"),
    );
  });
