import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { setTimeout } from "node:timers";
import pg from "pg";
import { sourcePool } from "../../dist/src/mock-platform/clients.js";
import { readTransaction } from "../../dist/src/mock-platform/read-transaction.js";
import {
  leasePortDatabase,
  closeLeasePortDatabase,
} from "../helpers/mock-source-lease-port-fixture.mjs";
import { readerActor, scopeFor } from "../helpers/mock-platform-fixture.mjs";
import { beginControl } from "../helpers/mock-source-control-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js");
let context, reader, monitor;
test.before(async () => {
  context = await leasePortDatabase(source, "readcontrol");
  context.env.MOCK_SOURCE_CURSOR_KEY = "k".repeat(32);
  reader = source.createMockSourceReader(context.env);
  const url = new URL(context.env.MOCK_PLATFORM_READ_DATABASE_URL);
  url.username = new URL(context.server.url).username;
  monitor = new pg.Client({ connectionString: url.toString() });
  await monitor.connect();
});
test.after(async () => {
  await reader.close();
  await monitor.end();
  await closeLeasePortDatabase(context);
});
function fixedError(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  };
}
async function waitBackend(predicate) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const rows = (
      await monitor.query(
        "SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE usename='source_read_login' AND datname=current_database()",
      )
    ).rows;
    const found = rows.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected source reader backend state");
}
async function assertGone(pid) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const rows = (await monitor.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).rows;
    if (!rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Canceled SQL backend must terminate");
}
test("pre-aborted reads and expired deadlines fail with fixed codes", async () => {
  const controller = new globalThis.AbortController();
  controller.abort(new Error("secret abort reason"));
  const expired = { deadlineAt: "2020-01-01T00:00:00.000Z" };
  await assert.rejects(
    reader.findGeneration(readerActor, scopeFor(), { signal: controller.signal }),
    fixedError("SOURCE_ABORTED"),
  );
  await assert.rejects(
    reader.findPublication(readerActor, scopeFor(), expired),
    fixedError("SOURCE_DEADLINE"),
  );
  await assert.rejects(
    reader.scanVersions(
      readerActor,
      scopeFor(),
      { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z", limit: 1 },
      expired,
    ),
    fixedError("SOURCE_DEADLINE"),
  );
});
test("read deadline and signal inputs are validated before database access", async () => {
  for (const control of [
    null,
    [],
    { deadlineAt: "2026-02-30T00:00:00.000Z" },
    { deadlineAt: "2026-01-01T00:00:00+00:00" },
    { signal: {} },
    { deadlineAt: new Date() },
  ])
    await assert.rejects(
      reader.findGeneration(readerActor, scopeFor(), control),
      fixedError("SOURCE_INPUT"),
    );
});
test("abort while waiting for control lock terminates backend and reader recovers", async () => {
  const controller = new globalThis.AbortController();
  await beginControl(context.rawAdmin);
  try {
    const pending = reader.findGeneration(readerActor, scopeFor(), { signal: controller.signal });
    const rejected = assert.rejects(pending, fixedError("SOURCE_ABORTED"));
    const backend = await waitBackend((row) => row.wait_event_type === "Lock");
    controller.abort("private reason");
    await rejected;
    await assertGone(backend.pid);
  } finally {
    await context.rawAdmin.query("ROLLBACK");
  }
  assert.equal(await reader.findGeneration(readerActor, scopeFor()), null);
});
test("deadline expires while SQL waits and removes its transaction", async () => {
  await beginControl(context.rawAdmin);
  try {
    const pending = reader.findPublication(readerActor, scopeFor(), {
      deadlineAt: new Date(Date.now() + 800).toISOString(),
    });
    const rejected = assert.rejects(pending, fixedError("SOURCE_DEADLINE"));
    const backend = await waitBackend((row) => row.wait_event_type === "Lock");
    await rejected;
    await assertGone(backend.pid);
  } finally {
    await context.rawAdmin.query("ROLLBACK");
  }
  assert.equal(await reader.findPublication(readerActor, scopeFor()), null);
});
test("abort queued pool acquisition releases late checkout and permits reuse", async () => {
  await beginControl(context.rawAdmin);
  const holder = new globalThis.AbortController(),
    queued = new globalThis.AbortController();
  const first = reader.findGeneration(readerActor, scopeFor(), { signal: holder.signal });
  const firstRejected = assert.rejects(first, fixedError("SOURCE_ABORTED"));
  try {
    await waitBackend((row) => row.wait_event_type === "Lock");
    const second = reader.findGeneration(readerActor, scopeFor(), { signal: queued.signal });
    const secondRejected = assert.rejects(second, fixedError("SOURCE_ABORTED"));
    queued.abort();
    await secondRejected;
    holder.abort();
    await firstRejected;
  } finally {
    holder.abort();
    await context.rawAdmin.query("ROLLBACK");
  }
  assert.equal(await reader.findGeneration(readerActor, scopeFor()), null);
});
function sleepingRead(pool, signal, shortTimeout = false) {
  return readTransaction(
    pool,
    async (client) => {
      if (shortTimeout) await client.query("SET LOCAL statement_timeout='1200ms'");
      await client.query("SELECT pg_advisory_xact_lock(12345,67890)");
      await client.query("SELECT pg_sleep(20)");
    },
    undefined,
    { signal },
  );
}
test("abort running SQL releases held advisory transaction locks and pool recovers", async () => {
  const pool = sourcePool(context.env, "reader"),
    controller = new globalThis.AbortController();
  try {
    const pending = sleepingRead(pool, controller.signal);
    const rejected = assert.rejects(pending, fixedError("SOURCE_ABORTED"));
    const backend = await waitBackend((row) => row.query === "SELECT pg_sleep(20)");
    assert.equal(
      (
        await monitor.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [
          backend.pid,
        ])
      ).rowCount,
      1,
    );
    controller.abort();
    await rejected;
    await assertGone(backend.pid);
    assert.equal(
      (await monitor.query("SELECT 1 FROM pg_locks WHERE pid=$1", [backend.pid])).rowCount,
      0,
    );
    assert.equal(
      await readTransaction(
        pool,
        async (client) => (await client.query("SELECT 1 AS n")).rows[0].n,
      ),
      1,
    );
  } finally {
    controller.abort();
    await pool.end();
  }
});
test("recovered reader rechecks current credentials and actor access", async () => {
  const initialized = await context.worker.initializeGeneration(
    { grantId: "source-grant-a" },
    scopeFor(),
  );
  assert.equal(initialized.status, "CREATED");
  await monitor.query("GRANT shopmate_mock_source_worker TO source_read_login");
  try {
    await assert.rejects(
      reader.findGeneration(readerActor, scopeFor()),
      fixedError("SOURCE_CREDENTIALS"),
    );
  } finally {
    await monitor.query("REVOKE shopmate_mock_source_worker FROM source_read_login");
  }
  assert.equal(
    await reader.findGeneration({ ...readerActor, userId: "source-unassigned" }, scopeFor()),
    null,
  );
  assert.deepEqual(await reader.findGeneration(readerActor, scopeFor()), initialized.generation);
});
test("failed auxiliary cancellation preserves abort and fallback SQL timeout frees backend", async () => {
  const pool = sourcePool(context.env, "reader"),
    controller = new globalThis.AbortController();
  const wrongLogin = new URL(context.env.MOCK_PLATFORM_READ_DATABASE_URL);
  wrongLogin.username = "source_worker_login";
  const cancelPool = sourcePool(
    { ...context.env, MOCK_PLATFORM_READ_DATABASE_URL: wrongLogin.toString() },
    "reader",
  );
  const failingPool = { ...pool, cancelRead: cancelPool.cancelRead };
  try {
    const pending = sleepingRead(failingPool, controller.signal, true);
    const rejected = assert.rejects(pending, fixedError("SOURCE_ABORTED"));
    const backend = await waitBackend((row) => row.query === "SELECT pg_sleep(20)");
    controller.abort();
    await rejected;
    assert.equal(
      (await monitor.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [backend.pid])).rowCount,
      1,
    );
    await assertGone(backend.pid);
    assert.equal(
      (await monitor.query("SELECT 1 FROM pg_locks WHERE pid=$1", [backend.pid])).rowCount,
      0,
    );
    assert.equal(
      await readTransaction(
        pool,
        async (client) => (await client.query("SHOW statement_timeout")).rows[0].statement_timeout,
      ),
      "10s",
    );
  } finally {
    controller.abort();
    await pool.end();
    await cancelPool.end();
  }
});
