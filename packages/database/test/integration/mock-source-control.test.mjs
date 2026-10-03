import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  scopeFor,
  loginUrl,
  sourceEnv,
  readerActor,
  configFor,
  hashConfig,
  createSourceSession,
  grantSource,
} from "../helpers/mock-platform-fixture.mjs";
import {
  beginWorker,
  beginControl,
  grantControl,
  waitLock,
  rawInsert,
  rawValues,
  controlActor,
  observeSourceSettings,
} from "../helpers/mock-source-control-fixture.mjs";

const CONTROL = 1397575508;

test("mandatory session CONTROL protocol uses actual restricted logins", async (t) => {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  const clients = [];
  let admin, sourceWorker, sourceReader, repo;
  try {
    await operator.connect();
    await operator.query('CREATE DATABASE "shopmate_tenant_test_control"');
    const url = new URL(server.url);
    url.pathname = "/shopmate_tenant_test_control";
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    await migrateSource(admin);
    await sourceFixtures(admin);
    await grantControl(admin, "source_control_login");
    for (const name of [
      "source_worker_login",
      "source_read_login",
      "source_control_login",
      url.username,
    ]) {
      const client = new pg.Client({ connectionString: loginUrl(url.toString(), name) });
      await client.connect();
      clients.push(client);
    }
    const [worker, reader, control, barrier] = clients;
    await t.test(
      "helper exists and rejects absent, malformed, isolation and multiple keys",
      async () => {
        assert.equal(
          (await admin.query("SELECT to_regprocedure('demo.lock_source_control(text)') AS helper"))
            .rows[0].helper,
          "demo.lock_source_control(text)",
        );
        for (const id of [null, "", "bad scope", "good\n", "x".repeat(129)])
          await assert.rejects(
            worker.query("SELECT demo.lock_source_control($1)", [id]),
            (e) => e.code === "SM002",
          );
        await worker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await assert.rejects(
          worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]),
          (e) => e.code === "SM002",
        );
        await worker.query("ROLLBACK");
        await worker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
        await worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
        const locks = (
          await admin.query(
            "SELECT classid,objid,objsubid,mode FROM pg_locks WHERE pid=$1 AND locktype='advisory'",
            [worker.processID],
          )
        ).rows;
        assert.equal(locks.length, 1);
        assert.equal(Number(locks[0].classid), 1397575508);
        assert.equal(locks[0].objsubid, 2);
        assert.equal(locks[0].mode, "ExclusiveLock");
        const hash = (
          await admin.query("SELECT hashtext($1)::bigint & 4294967295::bigint AS key", [
            scopeFor().sessionId,
          ])
        ).rows[0].key;
        assert.equal(String(locks[0].objid), hash);
        await assert.rejects(
          worker.query("SELECT demo.lock_source_control($1)", [scopeFor("b").sessionId]),
          (e) => e.code === "SM002",
        );
        await worker.query("ROLLBACK");
        assert.equal(
          (
            await admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [
              worker.processID,
            ])
          ).rowCount,
          0,
        );
        await reader.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
      },
    );
    await t.test("raw INSERT and owner UPDATE require declared protocol", async () => {
      await assert.rejects(
        worker.query(rawInsert, rawValues(scopeFor())),
        (e) => e.code === "SM002",
      );
      await assert.rejects(
        worker.query(
          'INSERT INTO mock_platform."Runtime" SELECT * FROM mock_platform."Runtime" WHERE false',
        ),
        (e) => e.code === "SM002",
      );
      await assert.rejects(
        admin.query('UPDATE demo."DemoCommerceSession" SET revision=revision WHERE id=$1', [
          scopeFor().sessionId,
        ]),
        (e) => e.code === "SM002",
      );
      await beginControl(control, scopeFor().sessionId);
      await assert.rejects(
        control.query('UPDATE demo."DemoCommerceSession" SET revision=revision WHERE id=$1', [
          scopeFor("a2").sessionId,
        ]),
        (e) => e.code === "SM002",
      );
      await control.query("ROLLBACK");
      await control.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await control.query("SELECT set_config('demo.control_session_id',$1,true)", [
        scopeFor().sessionId,
      ]);
      await assert.rejects(
        control.query('UPDATE public."PlatformConnection" SET generation=generation WHERE id=$1', [
          scopeFor().connectionId,
        ]),
        (e) => e.code === "SM002",
      );
      await control.query("ROLLBACK");
    });
    await t.test(
      "owner SQL requires a manage actor and rejects multi-session UPDATE atomically",
      async () => {
        const before = (
          await admin.query('SELECT id,revision FROM demo."DemoCommerceSession" ORDER BY id')
        ).rows;
        await beginControl(admin, scopeFor().sessionId, "foreign-user");
        await assert.rejects(
          admin.query('UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=$1', [
            scopeFor().sessionId,
          ]),
          (e) => e.code === "SM001",
        );
        await admin.query("ROLLBACK");
        await beginControl(admin);
        await admin.query('UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=$1', [
          scopeFor().sessionId,
        ]);
        await assert.rejects(
          admin.query(
            'UPDATE demo."DemoCommerceSession" SET revision=revision+1 WHERE id=ANY($1::text[])',
            [[scopeFor().sessionId, scopeFor("a2").sessionId]],
          ),
          (e) => e.code === "SM002",
        );
        await admin.query("ROLLBACK");
        assert.deepEqual(
          (await admin.query('SELECT id,revision FROM demo."DemoCommerceSession" ORDER BY id'))
            .rows,
          before,
        );
        await beginControl(admin, scopeFor("a2").sessionId);
        await assert.rejects(
          admin.query(
            'UPDATE public."PlatformConnection" SET generation=generation+1 WHERE id=$1',
            [scopeFor().connectionId],
          ),
          (e) => e.code === "SM002",
        );
        await admin.query("ROLLBACK");
      },
    );
    await t.test(
      "raw old outer snapshot VALUES deny after reset, disconnect and revocation",
      async () => {
        const scope = scopeFor();
        for (const change of ["reset", "disconnect", "grant", "membership"]) {
          await beginControl(control);
          await beginWorker(worker);
          const denied = assert.rejects(
            worker.query(rawInsert, rawValues(scope)),
            (e) => e.code === "SM001",
          );
          await waitLock(admin, CONTROL, false, worker.processID);
          if (change === "reset")
            await control.query('UPDATE public."PlatformConnection" SET generation=1 WHERE id=$1', [
              scope.connectionId,
            ]);
          if (change === "disconnect")
            await control.query('UPDATE public."PlatformConnection" SET status=$1 WHERE id=$2', [
              "DISCONNECTED",
              scope.connectionId,
            ]);
          if (change === "grant")
            await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
              "REVOKED",
              "source-grant-a",
            ]);
          if (change === "membership")
            await admin.query('UPDATE public."OrganizationMember" SET status=$1 WHERE id=$2', [
              "INACTIVE",
              "member-a-source-worker",
            ]);
          await control.query("COMMIT");
          await denied;
          await worker.query("ROLLBACK");
          assert.equal(
            (
              await admin.query('SELECT 1 FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
                scope.sessionId,
              ])
            ).rowCount,
            0,
          );
          await admin.query('UPDATE demo."MockWorkerGrant" SET status=$1 WHERE id=$2', [
            "ACTIVE",
            "source-grant-a",
          ]);
          await admin.query('UPDATE public."OrganizationMember" SET status=$1 WHERE id=$2', [
            "ACTIVE",
            "member-a-source-worker",
          ]);
          await beginControl(control);
          await control.query(
            'UPDATE public."PlatformConnection" SET generation=0,status=$1 WHERE id=$2',
            ["ACTIVE", scope.connectionId],
          );
          await control.query("COMMIT");
        }
      },
    );
    await t.test(
      "ordinary UPDATE observes fresh manage revocation after its outer snapshot",
      async () => {
        for (const table of ['demo."DemoCommerceSession"', 'public."PlatformConnection"']) {
          await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await reader.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]);
          await control.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await control.query(
            "SELECT set_config('app.user_id',$1,true),set_config('demo.control_session_id',$2,true)",
            ["source-human", scopeFor().sessionId],
          );
          const column = table.startsWith("demo") ? "revision" : "generation";
          const id = table.startsWith("demo") ? scopeFor().sessionId : scopeFor().connectionId;
          const outcome = control
            .query(`UPDATE ${table} SET ${column}=${column}+1 WHERE id=$1`, [id])
            .then(
              () => null,
              (error) => error.code,
            );
          await waitLock(admin, CONTROL, false, control.processID);
          await admin.query('UPDATE public."OrganizationMember" SET status=$1 WHERE id=$2', [
            "INACTIVE",
            "member-a-source-human",
          ]);
          await reader.query("COMMIT");
          const code = await outcome;
          await control.query("ROLLBACK");
          await admin.query('UPDATE public."OrganizationMember" SET status=$1 WHERE id=$2', [
            "ACTIVE",
            "member-a-source-human",
          ]);
          assert.equal(code, "SM001");
        }
      },
    );
    await t.test(
      "source and control official methods acquire CONTROL before operative work",
      async () => {
        const source = await import("../../dist/src/mock-platform/index.js");
        sourceWorker = source.createMockSourceWorker(sourceEnv(url.toString()));
        sourceReader = source.createMockSourceReader(sourceEnv(url.toString()));
        process.env.DATABASE_URL = loginUrl(url.toString(), "source_control_login");
        repo = await import("../../dist/src/index.js");
        await beginControl(control);
        const pending = sourceWorker.initializeGeneration(
          { grantId: "source-grant-a" },
          scopeFor(),
        );
        await waitLock(admin, CONTROL, false);
        await control.query('UPDATE public."PlatformConnection" SET generation=1 WHERE id=$1', [
          scopeFor().connectionId,
        ]);
        await control.query("COMMIT");
        assert.deepEqual(await pending, { status: "DENIED" });
        assert.equal(
          (
            await admin.query('SELECT 1 FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
              scopeFor().sessionId,
            ])
          ).rowCount,
          0,
        );
        const next = { ...scopeFor(), generation: 1 };
        assert.equal(
          (await sourceWorker.initializeGeneration({ grantId: "source-grant-a" }, next)).status,
          "CREATED",
        );
        await beginControl(control);
        const read = sourceReader.findGeneration(readerActor, next);
        await waitLock(admin, CONTROL, false);
        await control.query('UPDATE public."PlatformConnection" SET generation=2 WHERE id=$1', [
          next.connectionId,
        ]);
        await control.query("COMMIT");
        assert.equal(await read, null);
        await beginWorker(worker, scopeFor("a2"), "source-grant-a2");
        await worker.query("SELECT demo.lock_source_control($1)", [scopeFor("a2").sessionId]);
        const advance = repo.advanceDemoSession(controlActor, scopeFor("a2").storeId, {
          expectedRevision: 0,
          durationMs: 1,
        });
        await waitLock(admin, CONTROL, false);
        await worker.query("COMMIT");
        assert.equal((await advance).status, "WRITTEN");
      },
    );
    await t.test(
      "initialization first orders real reset and disconnect through commit",
      async () => {
        await installBarrier(admin, 'mock_platform."Runtime"', "INSERT");
        try {
          for (const [key, kind] of [
            ["a2", "reset"],
            ["b", "disconnect"],
          ]) {
            const scope = scopeFor(key);
            const actor = actorFor(scope);
            const grant = { grantId: `source-grant-${key}` };
            await holdBarrier(barrier);
            const initialized = sourceWorker.initializeGeneration(grant, scope);
            const [sourceLock] = await waitLock(admin, 77224499, false);
            await waitLock(admin, CONTROL, true, sourceLock.pid);
            const before = await repo.findDemoSession(actor, scope.storeId);
            const changed =
              kind === "reset"
                ? repo.resetDemoSession(actor, scope.storeId, resetInput(scope, before.revision))
                : repo.disconnectDemoSession(actor, scope.storeId, before.revision);
            await waitLock(admin, CONTROL, false);
            await barrier.query("COMMIT");
            assert.equal((await initialized).status, "CREATED");
            const result = await changed;
            assert.equal(result.status, "WRITTEN");
            assert.equal(await sourceReader.findGeneration(actor, scope), null);
            assert.deepEqual(await sourceWorker.initializeGeneration(grant, scope), {
              status: "DENIED",
            });
            const next = { ...scope, generation: result.record.generation };
            assert.equal(
              (await sourceWorker.initializeGeneration(grant, next)).status,
              kind === "reset" ? "CREATED" : "DENIED",
            );
          }
        } finally {
          await removeBarrier(admin, 'mock_platform."Runtime"');
        }
      },
    );
    await t.test(
      "real reset and disconnect first deny waiting initialization without a stale row",
      async () => {
        await installBarrier(admin, 'public."PlatformConnection"', "UPDATE");
        try {
          for (const kind of ["reset", "disconnect"]) {
            const current = await repo.findDemoSession(controlActor, scopeFor().storeId);
            const scope = { ...scopeFor(), generation: current.generation };
            await holdBarrier(barrier);
            const changed =
              kind === "reset"
                ? repo.resetDemoSession(
                    controlActor,
                    scope.storeId,
                    resetInput(scope, current.revision),
                  )
                : repo.disconnectDemoSession(controlActor, scope.storeId, current.revision);
            const [controlLock] = await waitLock(admin, 77224499, false);
            await waitLock(admin, CONTROL, true, controlLock.pid);
            const initialized = sourceWorker.initializeGeneration(
              { grantId: "source-grant-a" },
              scope,
            );
            await waitLock(admin, CONTROL, false);
            await barrier.query("COMMIT");
            assert.equal((await changed).status, "WRITTEN");
            assert.deepEqual(await initialized, { status: "DENIED" });
            assert.equal(
              (
                await admin.query(
                  'SELECT 1 FROM mock_platform."Runtime" WHERE "sessionId"=$1 AND generation=$2',
                  [scope.sessionId, scope.generation],
                )
              ).rowCount,
              0,
            );
          }
        } finally {
          await removeBarrier(admin, 'public."PlatformConnection"');
        }
      },
    );
    await t.test(
      "own-lock inspection rejects raw second keys and shared reentry, independent sessions run concurrently",
      async () => {
        await worker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await worker.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [
          CONTROL,
          scopeFor("b").sessionId,
        ]);
        await worker.query("SELECT set_config('demo.control_session_id',$1,true)", [
          scopeFor().sessionId,
        ]);
        await assert.rejects(
          worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]),
          (e) => e.code === "SM002",
        );
        await worker.query("ROLLBACK");
        await worker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await worker.query("SELECT pg_advisory_xact_lock_shared($1,hashtext($2))", [
          CONTROL,
          scopeFor().sessionId,
        ]);
        await assert.rejects(
          worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]),
          (e) => e.code === "SM002",
        );
        await worker.query("ROLLBACK");
        await beginControl(control);
        await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await reader.query("SET LOCAL lock_timeout='1s'");
        await reader.query("SELECT demo.lock_source_control($1)", [scopeFor("b").sessionId]);
        const one = await waitLock(admin, CONTROL, true, reader.processID);
        const other = await waitLock(admin, CONTROL, true, control.processID);
        assert.notEqual(one[0].objid, other[0].objid);
        await reader.query("ROLLBACK");
        await control.query("ROLLBACK");
      },
    );
    await t.test(
      "negative hashes reenter safely and bigint namespace decoys confer no CONTROL",
      async () => {
        const negative = (
          await admin.query(
            "SELECT 'negative-'||n AS id,hashtext('negative-'||n) AS hash FROM generate_series(1,100) n WHERE hashtext('negative-'||n)<0 LIMIT 1",
          )
        ).rows[0];
        assert.ok(negative.hash < 0);
        await worker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await worker.query("SELECT pg_advisory_xact_lock($1::bigint*4294967296+1)", [CONTROL]);
        await worker.query("SELECT demo.lock_source_control($1)", [negative.id]);
        await worker.query("SELECT demo.lock_source_control($1)", [negative.id]);
        const locks = (
          await admin.query(
            "SELECT objsubid,objid FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=$2::oid",
            [worker.processID, CONTROL],
          )
        ).rows;
        assert.equal(locks.length, 2);
        assert.equal(
          locks.find((row) => row.objsubid === 2).objid,
          Number(BigInt(negative.hash) & 4294967295n),
        );
        await worker.query("ROLLBACK");
        await worker.query("SELECT pg_advisory_lock_shared($1,hashtext($2))", [
          CONTROL,
          scopeFor().sessionId,
        ]);
        await assert.rejects(
          worker.query("SELECT demo.lock_source_control($1)", [scopeFor().sessionId]),
          (e) => e.code === "SM002",
        );
        await worker.query("SELECT pg_advisory_unlock_shared($1,hashtext($2))", [
          CONTROL,
          scopeFor().sessionId,
        ]);
      },
    );
    await t.test(
      "a real hash collision waits but never authorizes a foreign full session",
      async () => {
        const collision = (
          await admin.query(
            "SELECT array_agg(id ORDER BY id) AS ids FROM (SELECT 'collision-'||n AS id,hashtext('collision-'||n) AS hash FROM generate_series(1,300000) n) keys GROUP BY hash HAVING count(*)>1 LIMIT 1",
          )
        ).rows[0];
        assert.ok(collision, "deterministic fixture must find a genuine hash collision");
        const scopes = collision.ids.slice(0, 2).map((id, index) => ({
          ...scopeFor(),
          sessionId: id,
          storeId: `collision-store-${index}`,
          connectionId: `collision-connection-${index}`,
          externalStoreId: `collision/${index}`,
        }));
        for (const [index, scope] of scopes.entries()) {
          await createSourceSession(admin, scope);
          await grantSource(admin, scope, `collision-grant-${index}`);
        }
        await beginControl(control, scopes[0].sessionId);
        await beginWorker(worker, scopes[1], "collision-grant-1");
        await worker.query("SELECT set_config('demo.control_session_id',$1,true)", [
          scopes[0].sessionId,
        ]);
        const denial = worker.query(rawInsert, rawValues(scopes[1])).then(
          () => null,
          (error) => error.code,
        );
        await waitLock(admin, CONTROL, false, worker.processID);
        await control.query("COMMIT");
        assert.equal(await denial, "SM002");
        await worker.query("ROLLBACK");
        assert.equal(
          (
            await admin.query(
              'SELECT 1 FROM mock_platform."Runtime" WHERE "sessionId"=ANY($1::text[])',
              [scopes.map((scope) => scope.sessionId)],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await sourceWorker.initializeGeneration({ grantId: "collision-grant-1" }, scopes[1]))
            .status,
          "CREATED",
        );
      },
    );
    await t.test(
      "concurrent identical initialization has one CREATED and identical frozen bytes; advance preserves them",
      async () => {
        const scope = scopeFor("a2", 2);
        const before = await repo.findDemoSession(controlActor, scope.storeId);
        assert.equal(
          (
            await repo.resetDemoSession(
              controlActor,
              scope.storeId,
              resetInput(scope, before.revision),
            )
          ).status,
          "WRITTEN",
        );
        const source = await import("../../dist/src/mock-platform/index.js");
        const second = source.createMockSourceWorker(sourceEnv(url.toString()));
        try {
          await beginControl(control, scope.sessionId);
          const first = sourceWorker.initializeGeneration({ grantId: "source-grant-a2" }, scope);
          const other = second.initializeGeneration({ grantId: "source-grant-a2" }, scope);
          const deadline = Date.now() + 4000;
          let waiting = [];
          while (Date.now() < deadline && waiting.length < 2)
            waiting = (
              await admin.query(
                "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND NOT granted",
                [CONTROL],
              )
            ).rows;
          assert.equal(waiting.length, 2);
          await control.query("COMMIT");
          const initialized = await Promise.all([first, other]);
          assert.deepEqual(initialized.map((result) => result.status).sort(), [
            "CREATED",
            "EXISTS",
          ]);
          assert.deepEqual(initialized[0].generation, initialized[1].generation);
          const current = await repo.findDemoSession(controlActor, scope.storeId);
          assert.equal(
            (
              await repo.advanceDemoSession(controlActor, scope.storeId, {
                expectedRevision: current.revision,
                durationMs: 1000,
              })
            ).status,
            "WRITTEN",
          );
          assert.deepEqual(
            await sourceReader.findGeneration(controlActor, scope),
            initialized[0].generation,
          );
          assert.equal(
            await sourceReader.findGeneration({ ...controlActor, userId: "foreign-user" }, scope),
            null,
          );
          assert.deepEqual(
            await sourceReader.findGeneration(controlActor, scope),
            initialized[0].generation,
          );
        } finally {
          await second.close();
        }
      },
    );
    await t.test(
      "actual max-one source clients clear every identity and scope setting on reuse",
      async () => {
        const scope = scopeFor("a2", 2);
        const observations = await observeSourceSettings(async () => {
          assert.equal(
            (await sourceWorker.initializeGeneration({ grantId: "source-grant-a2" }, scope)).status,
            "EXISTS",
          );
          assert.deepEqual(
            await sourceWorker.initializeGeneration({ grantId: "unknown" }, scopeFor("b")),
            { status: "DENIED" },
          );
          assert.equal(
            (await sourceWorker.initializeGeneration({ grantId: "source-grant-a2" }, scope)).status,
            "EXISTS",
          );
          assert.ok(await sourceReader.findGeneration(controlActor, scope));
          assert.equal(
            await sourceReader.findGeneration(actorFor(scopeFor("b")), scopeFor("b")),
            null,
          );
          assert.ok(await sourceReader.findGeneration(controlActor, scope));
        });
        assert.equal(observations.length, 6);
        assert.equal(new Set(observations.slice(0, 3).map((row) => row.pid)).size, 1);
        assert.equal(new Set(observations.slice(3).map((row) => row.pid)).size, 1);
        for (const row of observations)
          assert.ok(
            Object.values(row.settings).every((setting) => setting == null || setting === ""),
            "post-commit/rollback settings on the actual checked-out source backend are empty",
          );
      },
    );
    await t.test(
      "guard SQL denial returns existing public outcomes only after full rollback",
      async () => {
        const scope = {
          ...scopeFor(),
          sessionId: "denial-session",
          connectionId: "denial-connection",
          storeId: "denial-store",
          externalStoreId: "denial/store",
        };
        await createSourceSession(admin, scope);
        await grantSource(admin, scope, "denial-grant");
        await admin.query(
          "CREATE FUNCTION demo.test_guard_denial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Source control access denied' USING ERRCODE='SM001'; END $$",
        );
        await admin.query(
          'CREATE TRIGGER z_test_guard_denial AFTER INSERT ON mock_platform."Runtime" FOR EACH ROW EXECUTE FUNCTION demo.test_guard_denial()',
        );
        try {
          assert.deepEqual(
            await sourceWorker.initializeGeneration({ grantId: "denial-grant" }, scope),
            { status: "DENIED" },
          );
          assert.equal(
            (
              await admin.query('SELECT 1 FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
                scope.sessionId,
              ])
            ).rowCount,
            0,
          );
        } finally {
          await admin.query('DROP TRIGGER z_test_guard_denial ON mock_platform."Runtime"');
        }
        const before = await controlSnapshot(admin, scope);
        await admin.query(
          'CREATE TRIGGER z_test_guard_denial AFTER UPDATE ON demo."DemoCommerceSession" FOR EACH ROW EXECUTE FUNCTION demo.test_guard_denial()',
        );
        try {
          assert.deepEqual(
            await repo.resetDemoSession(controlActor, scope.storeId, resetInput(scope, 0)),
            { status: "NOT_FOUND" },
          );
          assert.deepEqual(await controlSnapshot(admin, scope), before);
        } finally {
          await admin.query('DROP TRIGGER z_test_guard_denial ON demo."DemoCommerceSession"');
          await admin.query("DROP FUNCTION demo.test_guard_denial()");
        }
      },
    );
    await t.test(
      "timeouts are bounded and sanitized, release failed locks and allow explicit retry",
      async () => {
        const scope = scopeFor("a2", 2);
        await beginControl(control, scope.sessionId);
        const result = sourceReader.findGeneration(controlActor, scope).then(
          () => null,
          (error) => error,
        );
        const [waiting] = await waitLock(admin, CONTROL, false);
        const error = await result;
        assert.equal(error.code, "SOURCE_STORAGE");
        assert.equal(error.message, "SOURCE_STORAGE");
        assert.equal(
          (
            await admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [
              waiting.pid,
            ])
          ).rowCount,
          0,
        );
        await control.query("COMMIT");
        assert.ok(await sourceReader.findGeneration(controlActor, scope));
      },
    );
    await t.test(
      "source cannot lock or mutate control/auth rows and forged principals fail guards",
      async () => {
        for (const table of [
          'demo."DemoCommerceSession"',
          'public."PlatformConnection"',
          'public."OrganizationMember"',
          'demo."MockWorkerGrant"',
        ])
          for (const client of [worker, reader])
            await assert.rejects(
              client.query(`SELECT * FROM ${table} FOR UPDATE`),
              (e) => e.code === "42501",
            );
        await beginWorker(worker, scopeFor("a2", 2), "source-grant-a2");
        await worker.query("SELECT set_config('app.user_id',$1,true)", ["source-human"]);
        await assert.rejects(
          worker.query(rawInsert, rawValues(scopeFor("a2", 2))),
          (e) => e.code === "SM001",
        );
        await worker.query("ROLLBACK");
        await assert.rejects(
          reader.query(rawInsert, rawValues(scopeFor())),
          (e) => e.code === "42501",
        );
      },
    );
    await t.test("official transactions override unsafe login isolation defaults", async () => {
      await sourceWorker.close();
      await repo.disconnectPrismaClient();
      await admin.query(
        "ALTER ROLE source_worker_login SET default_transaction_isolation='repeatable read'",
      );
      await admin.query(
        "ALTER ROLE source_control_login SET default_transaction_isolation='repeatable read'",
      );
      const source = await import("../../dist/src/mock-platform/index.js");
      sourceWorker = source.createMockSourceWorker(sourceEnv(url.toString()));
      assert.equal(
        (await sourceWorker.initializeGeneration({ grantId: "source-grant-a2" }, scopeFor("a2", 2)))
          .status,
        "EXISTS",
      );
      const current = await repo.findDemoSession(controlActor, scopeFor("a2").storeId);
      assert.equal(
        (
          await repo.advanceDemoSession(controlActor, current.storeId, {
            expectedRevision: current.revision,
            durationMs: 1,
          })
        ).status,
        "WRITTEN",
      );
    });
  } finally {
    if (sourceWorker) await sourceWorker.close();
    if (sourceReader) await sourceReader.close();
    if (repo) await repo.disconnectPrismaClient();
    for (const client of clients) await client.end();
    if (admin) await admin.end();
    await operator.end();
    await server.stop();
  }
});

function actorFor(scope) {
  return { userId: "source-human", merchantId: scope.organizationId.replace("legacy-org-", "") };
}
function resetInput(scope, expectedRevision) {
  const config = configFor(scope);
  return {
    expectedRevision,
    config,
    configHash: hashConfig(config),
    generatorVersion: "mock-source-v1",
    clockNow: new Date(config.historyStart),
  };
}
async function holdBarrier(client) {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(77224499,1)");
}
async function installBarrier(admin, table, operation) {
  await admin.query(
    "CREATE FUNCTION demo.test_control_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(77224499,1); RETURN NEW; END $$",
  );
  await admin.query(
    `CREATE TRIGGER a_test_control_barrier BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION demo.test_control_barrier()`,
  );
}
async function removeBarrier(admin, table) {
  await admin.query(`DROP TRIGGER a_test_control_barrier ON ${table}`);
  await admin.query("DROP FUNCTION demo.test_control_barrier()");
}
async function controlSnapshot(admin, scope) {
  return {
    connection: (
      await admin.query('SELECT * FROM public."PlatformConnection" WHERE id=$1', [
        scope.connectionId,
      ])
    ).rows,
    session: (
      await admin.query('SELECT * FROM demo."DemoCommerceSession" WHERE id=$1', [scope.sessionId])
    ).rows,
    audit: (
      await admin.query('SELECT * FROM demo."DemoControlAudit" WHERE "sessionId"=$1 ORDER BY id', [
        scope.sessionId,
      ])
    ).rows,
  };
}
