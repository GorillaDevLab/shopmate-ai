import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { transaction } from "../dist/src/mock-platform/transaction.js";

const rawFailure = Object.assign(new Error("private socket or database detail"), {
  code: "SM003",
  detail: "private detail",
  hint: "private hint",
  query: "private query",
  schema: "private schema",
  table: "private table",
  constraint: "private constraint",
});

// Control EventEmitter callback ordering, not a physical PostgreSQL/socket schedule.
class LifecycleClient extends EventEmitter {
  queries = [];
  releases = [];
  constructor(options) {
    super();
    this.options = options;
  }
  async query(sql, values) {
    this.queries.push(sql);
    if (sql.includes("pg_has_role")) {
      assert.equal(values[0], "shopmate_mock_source_worker");
      assert.equal(values[2], "shopmate_mock_source_reader");
      return { rowCount: 1, rows: [{ safe: this.options.safe !== false }] };
    }
    if (sql === this.options.emitDuring) {
      await Promise.resolve();
      this.emit("error", rawFailure);
    }
    if (sql === this.options.rejectDuring) throw rawFailure;
    return { rowCount: 0, rows: [] };
  }
  release(discard) {
    this.releases.push({ discard, errorListeners: this.listenerCount("error") });
  }
}

function fixture(options = {}) {
  const client = new LifecycleClient(options);
  const calls = { connects: 0, actions: 0 };
  const pool = {
    async connect() {
      calls.connects++;
      return client;
    },
  };
  const run = (result, rollback = false, failure) =>
    transaction(
      pool,
      "worker",
      async () => {
        calls.actions++;
        if (failure) throw failure;
        return result;
      },
      () => rollback,
      ["DENIED", "FENCED"],
    );
  return { client, calls, run };
}

function storageError(error) {
  assert.equal(error.name, "SourceStorageError");
  assert.equal(error.code, "SOURCE_STORAGE");
  assert.equal(error.message, "SOURCE_STORAGE");
  assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
  for (const key of ["cause", "detail", "hint", "query", "schema", "table", "constraint"])
    assert.equal(key in error, false);
  assert.equal(error.stack.includes(rawFailure.message), false);
  return true;
}

function lifecycle(f, finalQueries, discard) {
  assert.deepEqual(f.calls, { connects: 1, actions: 1 });
  assert.equal(f.client.queries.filter((sql) => sql.startsWith("BEGIN")).length, 1);
  assert.deepEqual(
    f.client.queries.filter((sql) => sql === "COMMIT" || sql === "ROLLBACK"),
    finalQueries,
  );
  assert.deepEqual(f.client.releases, [{ discard, errorListeners: 0 }]);
  assert.equal(f.client.listenerCount("error"), 0);
}

for (const status of ["CLAIMED", "RENEWED", "FAILED"])
  test(`client error before resolved COMMIT rejects ${status} without replay or extra rollback`, async () => {
    const f = fixture({ emitDuring: "COMMIT" });
    await assert.rejects(f.run({ status }), storageError);
    lifecycle(f, ["COMMIT"], true);
  });

for (const status of ["DENIED", "FENCED"])
  test(`client error before resolved result-directed ROLLBACK rejects ${status} without replay`, async () => {
    const f = fixture({ emitDuring: "ROLLBACK" });
    await assert.rejects(f.run({ status }, true), storageError);
    lifecycle(f, ["ROLLBACK"], true);
  });

for (const [status, rollback, finalQuery] of [
  ["RENEWED", false, "COMMIT"],
  ["DENIED", true, "ROLLBACK"],
])
  test(`normal ${finalQuery} returns ${status} and releases reusable client`, async () => {
    const f = fixture();
    const result = { status };
    assert.equal(await f.run(result, rollback), result);
    lifecycle(f, [finalQuery], false);
  });

test("failed rollback overrides an otherwise allowed FENCED action error", async () => {
  const f = fixture({ rejectDuring: "ROLLBACK" });
  await assert.rejects(f.run(undefined, false, rawFailure), storageError);
  lifecycle(f, ["ROLLBACK"], true);
});

test("successful rollback preserves allowed FENCED action error mapping", async () => {
  const f = fixture();
  await assert.rejects(f.run(undefined, false, rawFailure), (error) => {
    assert.equal(error.name, "SourceDomainFailure");
    assert.equal(error.status, "FENCED");
    assert.equal(error.message, "FENCED");
    assert.equal("cause" in error, false);
    return true;
  });
  lifecycle(f, ["ROLLBACK"], false);
});

test("client error during exception rollback overrides allowed FENCED mapping", async () => {
  const f = fixture({ emitDuring: "ROLLBACK" });
  await assert.rejects(f.run(undefined, false, rawFailure), storageError);
  lifecycle(f, ["ROLLBACK"], true);
});

test("unsafe credentials still prevent transaction and action execution", async () => {
  const f = fixture({ safe: false });
  await assert.rejects(f.run({ status: "RENEWED" }), { code: "SOURCE_CREDENTIALS" });
  assert.deepEqual(f.calls, { connects: 1, actions: 0 });
  assert.equal(f.client.queries.length, 1);
  assert.deepEqual(f.client.releases, [{ discard: false, errorListeners: 0 }]);
});
