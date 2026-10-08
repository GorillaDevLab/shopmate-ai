import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { settleDeadlock } from "./helpers/deadlock-outcome.mjs";

test("deadlock victim is checked even when the survivor result arrives first", async () => {
  const rollbacks = [];
  const result = await settleDeadlock(
    Promise.resolve({ result: "survivor" }),
    setImmediate().then(() => ({ error: { code: "40P01" } })),
    async (index) => {
      rollbacks.push(index);
    },
  );
  assert.deepEqual(result, { victim: 1, code: "40P01", survivor: "survivor" });
  assert.deepEqual(rollbacks, [1]);
});

test("victim rollback releases a survivor which has not yet settled", async () => {
  let release;
  const survivor = new Promise((resolve) => {
    release = resolve;
  });
  const result = await settleDeadlock(
    Promise.resolve({ error: { code: "40P01" } }),
    survivor,
    async (index) => {
      assert.equal(index, 0);
      release({ result: "survivor" });
    },
  );
  assert.deepEqual(result, { victim: 0, code: "40P01", survivor: "survivor" });
});

test("two successes cannot be accepted as proof of a deadlock", async () => {
  await assert.rejects(
    settleDeadlock(Promise.resolve({ result: "a" }), Promise.resolve({ result: "b" }), async () => {
      assert.fail("No victim should be rolled back");
    }),
    { code: "ERR_ASSERTION" },
  );
});

test("a later non-deadlock error cannot be accepted as a victim", async () => {
  await assert.rejects(
    settleDeadlock(
      Promise.resolve({ result: "survivor" }),
      setImmediate().then(() => ({ error: { code: "57014" } })),
      async () => assert.fail("A query timeout is not a deadlock victim"),
    ),
    { code: "ERR_ASSERTION" },
  );
});
