import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readTransaction } from "../dist/src/mock-platform/read-transaction.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function rollbackFixture() {
  const rollingBack = deferred(),
    rollback = deferred(),
    cancellation = deferred();
  const releases = [],
    client = new EventEmitter();
  client.query = async (sql) => {
    if (sql === "ROLLBACK") {
      rollingBack.resolve();
      await rollback.promise;
    }
    return { rowCount: 1, rows: [{ safe: true }] };
  };
  client.release = (destroy) => {
    releases.push(destroy);
  };
  const pool = {
    async connect() {
      return client;
    },
    async cancelRead() {
      await cancellation.promise;
    },
  };
  return { rollingBack, rollback, cancellation, releases, pool, client };
}
function failedRead(pool, control) {
  return readTransaction(
    pool,
    async () => {
      throw new Error("private SQL failure");
    },
    undefined,
    control,
  );
}
for (const mode of ["abort", "deadline"]) {
  test(`${mode} during rollback holds checkout until cancellation drains and destroys it once`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const state = rollbackFixture(),
      controller = new globalThis.AbortController();
    const pending = failedRead(state.pool, {
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + 100).toISOString(),
    });
    const code = mode === "abort" ? "SOURCE_ABORTED" : "SOURCE_DEADLINE";
    const rejected = assert.rejects(pending, { code, message: code });
    await state.rollingBack.promise;
    if (mode === "abort") controller.abort();
    else t.mock.timers.tick(100);
    state.rollback.resolve();
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    try {
      assert.deepEqual(
        state.releases,
        [],
        "primary client must remain checked out while cancellation targets its PID",
      );
    } finally {
      state.cancellation.resolve();
      await rejected;
    }
    assert.deepEqual(state.releases, [true]);
    assert.equal(state.client.listenerCount("error"), 0);
  });
}
