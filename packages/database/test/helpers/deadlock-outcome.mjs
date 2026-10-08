import assert from "node:assert/strict";

export async function settleDeadlock(control, mutation, rollbackVictim) {
  const pending = [
    control.then((result) => ({ index: 0, ...result })),
    mutation.then((result) => ({ index: 1, ...result })),
  ];
  // PostgreSQL can release victim locks before delivering its error to the client.
  const first = await Promise.race(pending);
  const otherIndex = 1 - first.index;
  const victim = first.error ? first : await pending[otherIndex];
  assert.equal(victim.error?.code, "40P01");
  await rollbackVictim(victim.index);
  const survivor = first.error ? await pending[otherIndex] : first;
  assert.ifError(survivor.error);
  return { victim: victim.index, code: victim.error.code, survivor: survivor.result };
}
