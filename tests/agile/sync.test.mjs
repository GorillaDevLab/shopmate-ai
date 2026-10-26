import assert from "node:assert/strict";
import test from "node:test";

import { reconcileWithConflictRetry } from "../../scripts/agile/sync.mjs";

function scripted(statuses) {
  const calls = { run: 0, sleeps: [] };
  return {
    calls,
    run: async () => ({ status: statuses[calls.run++] }),
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
  };
}

test("a concurrent edit is retried from a fresh snapshot until it applies", async () => {
  const fake = scripted(["conflict", "applied"]);
  const result = await reconcileWithConflictRetry(fake);
  assert.equal(result.status, "applied");
  assert.equal(result.attempts, 2);
  assert.deepEqual(fake.calls.sleeps, [5_000]);
});

test("persistent conflicts stop after the attempt limit with growing back-off", async () => {
  const fake = scripted(["conflict", "conflict", "conflict", "applied"]);
  const result = await reconcileWithConflictRetry(fake);
  assert.equal(result.status, "conflict");
  assert.equal(result.attempts, 3);
  assert.equal(fake.calls.run, 3);
  assert.deepEqual(fake.calls.sleeps, [5_000, 15_000]);
});

test("partial writes and other outcomes are never retried", async () => {
  for (const status of ["partial-failure", "setup-required", "applied", "dry-run"]) {
    const fake = scripted([status, "applied"]);
    const result = await reconcileWithConflictRetry(fake);
    assert.equal(result.status, status);
    assert.equal(fake.calls.run, 1);
    assert.deepEqual(fake.calls.sleeps, []);
  }
});

test("errors such as ambiguous stages propagate without a retry", async () => {
  let runs = 0;
  await assert.rejects(
    reconcileWithConflictRetry({
      run: async () => {
        runs += 1;
        throw new Error("ambiguous active stages for P04-001");
      },
      sleep: async () => {},
    }),
    /ambiguous active stages/u,
  );
  assert.equal(runs, 1);
});
