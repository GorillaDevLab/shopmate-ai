import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import * as source from "@shopmate/database/mock-platform";
import { buildSource } from "../dist/build.js";
import { generationTools } from "../dist/generation-tools.js";
import { createSourceGroupGenerator } from "@shopmate/api/mock-generator";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../../../packages/database/test/helpers/mock-source-lease-port-fixture.mjs";
import {
  scopeFor,
  configFor,
  hashConfig,
  readerActor,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";

function expected(config, until) {
  const generator = createSourceGroupGenerator(config),
    latest = new Map(),
    history = new Map();
  let after = new Date(Date.parse(config.historyStart) - 1).toISOString(),
    count = 0,
    tick = 1;
  while (after < until) {
    // Marketing observes window ends. Compare a continuous generator at the same
    // clock ticks with the persisted host, which reconstructs state between ticks.
    const end = new Date(
      Math.min(Date.parse(config.historyStart) + tick++ * 21_600_000, Date.parse(until)),
    ).toISOString();
    for (const group of generator.window(after, end))
      for (const event of group.events) {
        count++;
        latest.set(JSON.stringify(source.eventTuple(event).entityKey), event.after);
        const position = JSON.stringify(source.eventTuple(event));
        assert.equal(history.has(position), false);
        history.set(position, event.after);
      }
    after = end;
  }
  return { latest, history, count };
}
async function assertHistory(context, scope, oracle) {
  const rows = await context.admin.query(
    'SELECT kind,mock_platform.canonical_utc("occurredAt") AS "occurredAt",ordinal::text,payload FROM mock_platform."SourceEvent" WHERE "sessionId"=$1 AND generation=$2 ORDER BY "eventSeq"',
    [scope.sessionId, scope.generation],
  );
  assert.equal(rows.rowCount, oracle.history.size);
  for (const row of rows.rows) {
    const after = { ...row.payload, source: { ...row.payload.source, version: null } };
    const position = JSON.stringify(
      source.eventTuple({
        kind: row.kind,
        occurredAt: row.occurredAt,
        ordinal: row.ordinal,
        after,
      }),
    );
    assert.deepEqual(after, oracle.history.get(position));
    assert.equal(oracle.history.delete(position), true);
  }
  assert.equal(oracle.history.size, 0);
}
async function buildPrefixes(context, scope, config, until) {
  const work = { actor: { grantId: "source-grant-a" }, scope };
  let through = config.historyStart,
    revision = 0;
  for (let slice = 0; slice < (config.days + 5) * 4; slice++) {
    const result = await buildSource(context.worker, work, generationTools);
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.publication.baseRevision, String(revision));
    assert.equal(
      result.publication.targetTime,
      new Date(Math.min(Date.parse(through) + 21_600_000, Date.parse(until))).toISOString(),
    );
    through = result.publication.targetTime;
    revision++;
    if (slice % 4 === 3) process.stdout.write(`Published ${revision} slices through ${through}\n`);
    if (through === until) break;
  }
  assert.equal(through, until);
  assert.equal((await buildSource(context.worker, work, generationTools)).status, "IDLE");
}
async function assertFacts(context, scope, config, until) {
  const oracle = expected(config, until),
    reader = source.createMockSourceReader(context.env);
  try {
    const certificate = await reader.findPublication(readerActor, scope);
    assert.equal(certificate.targetTime, until);
    assert.equal(certificate.highEventSeq, String(oracle.count));
  } finally {
    await reader.close();
  }
  await assertHistory(context, scope, oracle);
  const facts = await context.admin.query(
    'SELECT DISTINCT ON (kind,"entityKey" COLLATE "C") "entityKey",payload FROM mock_platform."EntityVersion" WHERE "sessionId"=$1 AND generation=$2 ORDER BY kind,"entityKey" COLLATE "C","eventSeq" DESC',
    [scope.sessionId, scope.generation],
  );
  assert.equal(facts.rowCount, oracle.latest.size);
  for (const row of facts.rows)
    assert.deepEqual(
      { ...row.payload, source: { ...row.payload.source, version: null } },
      oracle.latest.get(JSON.stringify(JSON.parse(row.entityKey))),
    );
}
test("high-load five-day history and settlement publish every prefix without duplicate or missing facts", async () => {
  const context = await leasePortDatabase(source, "history"),
    scope = scopeFor();
  const config = configFor(scope, "mature", 5);
  const until = new Date(
    Date.parse(config.historyStart) + (config.days + 5) * 86_400_000,
  ).toISOString();
  try {
    await context.admin.query(
      'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2,"clockNow"=$3 WHERE id=$4',
      [config, hashConfig(config), until, scope.sessionId],
    );
    await buildPrefixes(context, scope, config, until);
    await assertFacts(context, scope, config, until);
  } finally {
    await closeLeasePortDatabase(context);
  }
});
