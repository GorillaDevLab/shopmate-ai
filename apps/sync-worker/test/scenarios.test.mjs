import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { SyncCoordinator } from "../dist/index.js";
import { sourceFacts, canonicalFacts } from "./profile-fixture.mjs";
import {
  createScenarioFixture,
  closeScenarioFixture,
  prepareScenario,
  publishScenario,
  connectScenario,
  advanceScenario,
} from "./scenario-fixture.mjs";

let fixture;
test.before(async () => {
  fixture = await createScenarioFixture();
});
test.after(async () => {
  if (fixture) await closeScenarioFixture(fixture);
});

async function acceptScenario(id) {
  const started = Date.now();
  const state = await prepareScenario(fixture, id);
  const oracle = await publishScenario(fixture, state);
  const facts = await sourceFacts(fixture.admin, state, oracle);
  // Active interruption/restart boundaries have a separate real pipeline gate.
  if (id === "SCENARIO_009") await advanceScenario(fixture, state, 3600000);
  const host = await connectScenario(fixture, state);
  const coordinator = new SyncCoordinator(host, fixture.sources);
  try {
    const result = await coordinator.pass({ budgetMs: 3600000, maxPages: 1000 });
    assert.equal(result.status, "PROGRESSED");
    assert.equal(result.created.length, 5);
    assert.equal(result.outcomes.length, 5);
    for (const outcome of result.outcomes) {
      assert.equal(outcome.reason, "SUCCEEDED");
      assert.equal(outcome.job.successfulThrough, state.until);
      assert.equal(outcome.job.sourceWatermark, state.until);
    }
    const counts = await canonicalFacts(fixture.admin, state, facts);
    assert.equal((await coordinator.pass()).reason, "CAUGHT_UP");
    process.stdout.write(
      JSON.stringify({
        scenario: id,
        sourceEvents: oracle.eventCount,
        counts,
        elapsedMs: Date.now() - started,
      }) + "\n",
    );
  } finally {
    await host.close();
    fixture.hosts.delete(host);
  }
}

for (let index = 1; index <= 15; index++) {
  const id = `SCENARIO_${String(index).padStart(3, "0")}`;
  test(`${id}: authenticated LOAD, persistent causal source and canonical five-stream sync`, () =>
    acceptScenario(id));
}
