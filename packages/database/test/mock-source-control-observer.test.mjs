import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { observeSourceSettings } from "./helpers/mock-source-control-fixture.mjs";

const query = async () => ({ rows: [{ actor: "" }] });
async function observedRollback(t, client) {
  t.mock.method(pg.Pool.prototype, "connect", async () => client);
  const results = await observeSourceSettings(async () => {
    const checkout = await pg.Pool.prototype.connect();
    await checkout.query("ROLLBACK");
  });
  assert.equal(results.length, 1);
}
test("control observer restores inherited query lookup for subsequent prototype spies", async (t) => {
  const prototype = { query },
    client = Object.assign(Object.create(prototype), { processID: 1 });
  await observedRollback(t, client);
  assert.equal(Object.hasOwn(client, "query"), false);
  const replacement = async () => ({ rows: [] });
  prototype.query = replacement;
  assert.equal(client.query, replacement);
});
test("control observer preserves an existing own query descriptor", async (t) => {
  const client = { processID: 2 };
  Object.defineProperty(client, "query", { value: query, writable: true, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(client, "query");
  await observedRollback(t, client);
  assert.deepEqual(Object.getOwnPropertyDescriptor(client, "query"), descriptor);
});
