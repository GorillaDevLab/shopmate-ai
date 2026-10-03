import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource, sourceFixtures, scopeFor, loginUrl,
} from "../helpers/mock-platform-fixture.mjs";

test("mandatory session CONTROL protocol uses actual restricted logins", async (t) => {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  const clients = [];
  let admin;
  try {
    await operator.connect();
    await operator.query('CREATE DATABASE "shopmate_tenant_test_control"');
    const url = new URL(server.url);
    url.pathname = "/shopmate_tenant_test_control";
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    await migrateSource(admin);
    await sourceFixtures(admin);
    for (const name of ["source_worker_login", "source_read_login"] ) {
      const client = new pg.Client({ connectionString: loginUrl(url.toString(), name) });
      await client.connect();
      clients.push(client);
    }
    const [worker, reader] = clients;
    await t.test("helper exists and rejects absent, malformed, isolation and multiple keys", async () => {
      assert.equal((await admin.query("SELECT to_regprocedure('demo.lock_source_control(text)') AS helper")).rows[0].helper,
        "demo.lock_source_control(text)");
      for (const id of [null, "", "bad scope", "x".repeat(129)])
        await assert.rejects(worker.query("SELECT demo.lock_source_control($1)", [id]), (e) => e.code === "SM002");
      await worker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await assert.rejects(worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]), (e) => e.code === "SM002");
      await worker.query("ROLLBACK");
      await worker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
      await worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
      const locks = (await admin.query("SELECT classid,objid,objsubid,mode FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [worker.processID])).rows;
      assert.equal(locks.length, 1);
      assert.equal(Number(locks[0].classid), 1397575508);
      assert.equal(locks[0].objsubid, 2);
      assert.equal(locks[0].mode, "ExclusiveLock");
      await assert.rejects(worker.query("SELECT demo.lock_source_control($1)", [scopeFor("b").sessionId]), (e) => e.code === "SM002");
      await worker.query("ROLLBACK");
      assert.equal((await admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [worker.processID])).rowCount, 0);
      await reader.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
    });
  } finally {
    for (const client of clients) await client.end();
    if (admin) await admin.end();
    await operator.end();
    await server.stop();
  }
});
