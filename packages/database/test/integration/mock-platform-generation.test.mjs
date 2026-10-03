import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import { idlePoolRecovery } from "../helpers/mock-platform-idle-regression.mjs";
import {
  migrateSource,
  sourceFixtures,
  sourceEnv,
  scopeFor,
  readerActor,
  configFor,
  hashConfig,
  loginUrl,
  grantSource,
  createSourceSession,
} from "../helpers/mock-platform-fixture.mjs";

const source = await import("../../dist/src/mock-platform/index.js").catch(() => null);
test("frozen source generations use real restricted logins and fresh RLS", async (t) => {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  let admin, reader, worker;
  const logins = [];
  try {
    await operator.connect();
    await operator.query('CREATE DATABASE "shopmate_tenant_test_source"');
    const url = new URL(server.url);
    url.pathname = "/shopmate_tenant_test_source";
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    await migrateSource(admin);
    await t.test("schema and source port are installed", async () => {
      assert.ok(
        (await admin.query("SELECT to_regclass('mock_platform.\"Runtime\"') AS runtime")).rows[0]
          .runtime,
        "Runtime schema must exist",
      );
      assert.ok(source, "dedicated source port must exist");
    });
    assert.ok(source, "stop if implementation is absent");
    await sourceFixtures(admin);
    const env = sourceEnv(url.toString());
    reader = source.createMockSourceReader(env);
    worker = source.createMockSourceWorker(env);
    const scope = scopeFor();
    const actor = { grantId: "source-grant-a" };
    for (const name of ["source_read_login", "source_worker_login", "source_app_login"]) {
      const client = new pg.Client({ connectionString: loginUrl(url.toString(), name) });
      await client.connect();
      logins.push(client);
    }
    const [readLogin, workLogin, appLogin] = logins;
    await t.test(
      "own grants resolve without application identity; roles are least privilege",
      async () => {
        assert.equal((await workLogin.query('SELECT * FROM demo."MockWorkerGrant"')).rowCount, 3);
        assert.equal((await worker.listGrants()).length, 3);
        for (const client of [readLogin, workLogin]) {
          assert.deepEqual(
            (
              await client.query(
                "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user",
              )
            ).rows[0],
            { rolsuper: false, rolbypassrls: false },
          );
          const boundaries = await client.query(
            "SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced,relowner::regrole::text AS owner FROM pg_class WHERE oid IN ('demo.\"MockWorkerGrant\"'::regclass,'mock_platform.\"Runtime\"'::regclass)",
          );
          assert.equal(boundaries.rowCount, 2);
          assert.ok(
            boundaries.rows.every(
              (row) =>
                row.enabled &&
                row.forced &&
                !["source_read_login", "source_worker_login"].includes(row.owner),
            ),
          );
          for (const table of [
            'public."TenantBootstrapEnvironment"',
            'public."OrganizationMember"',
            'public."WorkspaceMember"',
            'public."DemoTenant"',
            'public."PlatformConnection"',
            'demo."DemoCommerceSession"',
            'demo."MockWorkerGrant"',
            'public."Order"',
          ]) {
            await assert.rejects(client.query(`DELETE FROM ${table}`), (e) => e.code === "42501");
            const column = table.endsWith('"DemoTenant"') ? '"organizationId"' : "id";
            await assert.rejects(
              client.query(`UPDATE ${table} SET ${column}=${column}`),
              (e) => e.code === "42501",
            );
          }
        }
        await assert.rejects(
          appLogin.query('SELECT * FROM mock_platform."Runtime"'),
          (e) => e.code === "42501",
        );
        assert.equal((await readLogin.query('SELECT * FROM mock_platform."Runtime"')).rowCount, 0);
        await assert.rejects(
          readLogin.query('SELECT * FROM demo."MockWorkerGrant"'),
          (e) => e.code === "42501",
        );
        for (const table of [
          'demo."MockWorkerGrant"',
          'public."Product"',
          'public."Sku"',
          'public."Order"',
          'public."OrderItem"',
        ])
          await assert.rejects(
            workLogin.query(`INSERT INTO ${table} DEFAULT VALUES`),
            (e) => e.code === "42501",
          );
        for (const sql of [
          'INSERT INTO mock_platform."Runtime" DEFAULT VALUES',
          'UPDATE mock_platform."Runtime" SET generation=1',
          'DELETE FROM mock_platform."Runtime"',
        ])
          await assert.rejects(readLogin.query(sql), (e) => e.code === "42501");
      },
    );
    let frozen;
    await t.test(
      "initialization is immutable, idempotent and survives recreated clients",
      async () => {
        const started = Date.now();
        const result = await worker.initializeGeneration(actor, scope);
        assert.equal(result.status, "CREATED");
        frozen = result.generation;
        assert.ok(
          Date.parse(frozen.createdAt) >= started - 1000 &&
            Date.parse(frozen.createdAt) <= Date.now() + 1000,
          "creation timestamps are UTC even for a non-UTC database login",
        );
        assert.deepEqual(frozen.sourceConfig, configFor(scope));
        assert.equal(frozen.configHash, hashConfig(configFor(scope)));
        assert.equal(frozen.generatorVersion, "mock-source-v1");
        assert.equal(frozen.runtimeVersion, "mock-runtime-v2");
        assert.equal(frozen.openingAt, "2025-12-31T16:00:00.000Z");
        assert.equal(frozen.baselineEnd, "2026-01-30T16:00:00.000Z");
        assert.deepEqual(await worker.initializeGeneration(actor, scope), {
          status: "EXISTS",
          generation: frozen,
        });
        await worker.close();
        await reader.close();
        worker = source.createMockSourceWorker(env);
        reader = source.createMockSourceReader(env);
        assert.deepEqual(await reader.findGeneration(readerActor, scope), frozen);
        await admin.query(
          'UPDATE demo."DemoCommerceSession" SET "clockNow"="clockNow"+interval \'100 days\',revision=revision+1 WHERE id=$1',
          [scope.sessionId],
        );
        assert.deepEqual((await worker.initializeGeneration(actor, scope)).generation, frozen);
      },
    );
    await t.test(
      "all scope coordinates and selected merchant constrain reads and writes",
      async () => {
        for (const key of Object.keys(scope)) {
          const wrong = { ...scope, [key]: key === "generation" ? 1 : "foreign" };
          assert.equal(await reader.findGeneration(readerActor, wrong), null, key);
          assert.deepEqual(
            await worker.initializeGeneration(actor, wrong),
            { status: "DENIED" },
            key,
          );
        }
        assert.equal(
          await reader.findGeneration({ ...readerActor, merchantId: "source-merchant-b" }, scope),
          null,
        );
        assert.equal(
          await reader.findGeneration({ ...readerActor, userId: "unknown" }, scope),
          null,
        );
        assert.deepEqual(
          await reader.findGeneration(
            { userId: "source-viewer", merchantId: readerActor.merchantId },
            scope,
          ),
          frozen,
        );
      },
    );
    await t.test("same pooled reader never leaks a previous identity", async () => {
      assert.deepEqual(await reader.findGeneration(readerActor, scope), frozen);
      assert.equal(await reader.findGeneration({ ...readerActor, userId: "unknown" }, scope), null);
      assert.deepEqual(await reader.findGeneration(readerActor, scope), frozen);
      assert.deepEqual(await worker.initializeGeneration({ grantId: "unknown" }, scope), {
        status: "DENIED",
      });
      const foreign = source.createMockSourceWorker({
        MOCK_PLATFORM_WORKER_DATABASE_URL: loginUrl(url.toString(), "source_foreign_login"),
      });
      try {
        assert.deepEqual(await foreign.listGrants(), []);
        assert.deepEqual(await foreign.initializeGeneration(actor, scope), { status: "DENIED" });
      } finally {
        await foreign.close();
      }
    });
    await t.test("revocations deny the very next operation", async () => {
      const changes = [
        [
          "UPDATE demo.\"MockWorkerGrant\" SET status=$1 WHERE id='source-grant-a'",
          "REVOKED",
          "ACTIVE",
          false,
        ],
        [
          "UPDATE \"OrganizationMember\" SET status=$1 WHERE id='member-a-source-worker'",
          "INACTIVE",
          "ACTIVE",
          false,
        ],
        [
          "UPDATE \"OrganizationMember\" SET role=$1 WHERE id='member-a-source-worker'",
          "OWNER",
          "VIEWER",
          false,
        ],
        [
          "UPDATE \"WorkspaceMember\" SET status=$1 WHERE id='assigned-a-source-worker'",
          "INACTIVE",
          "ACTIVE",
          false,
        ],
        ['UPDATE "Organization" SET status=$1 WHERE id=$2', "SUSPENDED", "ACTIVE", true],
        ['UPDATE "Workspace" SET status=$1 WHERE "organizationId"=$2', "SUSPENDED", "ACTIVE", true],
        ['UPDATE "TenantBootstrapEnvironment" SET environment=$1', "PRODUCTION", "DEMO", true],
        [
          'UPDATE "PlatformConnection" SET status=$1 WHERE "organizationId"=$2',
          "DISCONNECTED",
          "ACTIVE",
          true,
        ],
      ];
      for (const [sql, off, on, both] of changes) {
        const parameters = sql.includes("$2") ? [off, scope.organizationId] : [off];
        await admin.query(sql, parameters);
        assert.deepEqual(
          await worker.initializeGeneration(actor, scope),
          { status: "DENIED" },
          sql,
        );
        assert.ok(!(await worker.listGrants()).some((grant) => grant.id === actor.grantId), sql);
        if (both) assert.equal(await reader.findGeneration(readerActor, scope), null, sql);
        await admin.query(sql, parameters.length === 2 ? [on, scope.organizationId] : [on]);
      }
      await admin.query('DELETE FROM "DemoTenant" WHERE "organizationId"=$1', [
        scope.organizationId,
      ]);
      assert.equal(await reader.findGeneration(readerActor, scope), null);
      assert.deepEqual(await worker.initializeGeneration(actor, scope), { status: "DENIED" });
      await admin.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
        scope.organizationId,
      ]);
    });
    await t.test("reset fences old rows and new opening depends on frozen days", async () => {
      const config = configFor(scope, "new", 60);
      await admin.query('UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
        scope.connectionId,
      ]);
      await admin.query(
        'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
        [config, hashConfig(config), scope.sessionId],
      );
      assert.equal(await reader.findGeneration(readerActor, scope), null);
      assert.deepEqual(await worker.initializeGeneration(actor, scope), { status: "DENIED" });
      const next = await worker.initializeGeneration(actor, { ...scope, generation: 1 });
      assert.equal(next.status, "CREATED");
      assert.equal(next.generation.openingAt, "2026-02-15T16:00:00.000Z");
      assert.equal(next.generation.baselineEnd, "2026-03-01T16:00:00.000Z");
      assert.equal((await admin.query('SELECT * FROM mock_platform."Runtime"')).rowCount, 2);
    });
    await t.test("malformed persisted configuration cannot create a runtime", async () => {
      const s = scopeFor("a2");
      const good = configFor(s);
      for (const config of [
        { ...good, profile: "invalid" },
        { ...good, days: 366 },
        { ...good, historyStart: "2026-02-30T16:00:00.000Z" },
        { ...good, historyStart: "2026-01-01T00:00:00.000Z" },
        { ...good, historyStart: "0000-01-01T16:00:00.000Z" },
        { ...good, historyStart: "9999-12-31T16:00:00.000Z" },
        { ...good, extra: true },
      ]) {
        await admin.query(
          'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
          [config, hashConfig(config), s.sessionId],
        );
        await assert.rejects(
          worker.initializeGeneration({ grantId: "source-grant-a2" }, s),
          (e) => e.code === "SOURCE_INTEGRITY",
        );
      }
      await admin.query(
        'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
        [good, "0".repeat(64), s.sessionId],
      );
      await assert.rejects(
        worker.initializeGeneration({ grantId: "source-grant-a2" }, s),
        (e) => e.code === "SOURCE_INTEGRITY",
      );
      assert.equal(
        (
          await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
            s.sessionId,
          ])
        ).rowCount,
        0,
      );
      await admin.query(
        'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
        [good, hashConfig(good), s.sessionId],
      );
    });
    await t.test("composite FKs and trigger prevent repurposing immutable rows", async () => {
      await assert.rejects(
        grantSource(admin, { ...scope, workspaceId: "source-unassigned" }, "bad-grant"),
        (e) => e.code === "23503",
      );
      await assert.rejects(
        admin.query('UPDATE mock_platform."Runtime" SET "configHash"=$1', ["f".repeat(64)]),
        (e) => e.code === "23514",
      );
      await assert.rejects(
        admin.query('UPDATE mock_platform."Runtime" SET "storeId"=$1', ["source-store-b"]),
        (e) => e.code === "23514",
      );
      // Isolate the composite FK from the earlier insert snapshot trigger.
      await admin.query(
        'ALTER TABLE mock_platform."Runtime" DISABLE TRIGGER validated_source_generation',
      );
      try {
        await assert.rejects(
          admin.query(
            `INSERT INTO mock_platform."Runtime" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","sourceConfig","configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd")
          SELECT "sessionId",2,"organizationId","workspaceId",'source-store-b',"connectionId","externalStoreId",jsonb_set("sourceConfig",'{binding,storeId}','"source-store-b"'),"configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd" FROM mock_platform."Runtime" WHERE "sessionId"=$1 AND generation=1`,
            [scope.sessionId],
          ),
          (e) => e.code === "23503",
        );
      } finally {
        await admin.query(
          'ALTER TABLE mock_platform."Runtime" ENABLE TRIGGER validated_source_generation',
        );
      }
    });
    await t.test(
      "unassigned viewer is fenced while organization owners retain workspace access",
      async () => {
        const s = {
          ...scopeFor(),
          workspaceId: "source-unassigned",
          storeId: "source-store-unassigned",
          connectionId: "source-connection-unassigned",
          sessionId: "source-session-unassigned",
          externalStoreId: "店铺/测试.1",
        };
        await createSourceSession(admin, s, "new", 7);
        await admin.query(
          'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
          ["assigned-unassigned-worker", s.organizationId, s.workspaceId, "source-worker"],
        );
        await grantSource(admin, s, "source-grant-unassigned");
        const created = await worker.initializeGeneration(
          { grantId: "source-grant-unassigned" },
          s,
        );
        assert.equal(created.status, "CREATED");
        assert.equal(created.generation.openingAt, "2025-12-31T16:00:00.000Z");
        assert.deepEqual(await reader.findGeneration(readerActor, s), created.generation);
        assert.equal(
          await reader.findGeneration(
            { userId: "source-viewer", merchantId: readerActor.merchantId },
            s,
          ),
          null,
        );
        await admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
          "INACTIVE",
          "assigned-a-source-viewer",
        ]);
        try {
          assert.equal(
            await reader.findGeneration(
              { userId: "source-viewer", merchantId: readerActor.merchantId },
              { ...scope, generation: 1 },
            ),
            null,
          );
        } finally {
          await admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
            "ACTIVE",
            "assigned-a-source-viewer",
          ]);
        }
      },
    );
    await t.test("immutable trigger survives accidental worker UPDATE privileges", async () => {
      await admin.query('GRANT UPDATE ON mock_platform."Runtime" TO source_worker_login');
      await admin.query(
        'CREATE POLICY test_runtime_update ON mock_platform."Runtime" FOR UPDATE TO source_worker_login USING (true) WITH CHECK (true)',
      );
      await workLogin.query("BEGIN");
      try {
        await workLogin.query(
          "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id',$3,true)",
          ["source-worker", readerActor.merchantId, "source-grant-a"],
        );
        await assert.rejects(
          workLogin.query(
            'UPDATE mock_platform."Runtime" SET "openingAt"="openingAt"+interval \'1 day\' WHERE "sessionId"=$1',
            [scope.sessionId],
          ),
          (e) => e.code === "23514",
        );
      } finally {
        await workLogin.query("ROLLBACK");
        await admin.query('DROP POLICY test_runtime_update ON mock_platform."Runtime"');
        await admin.query('REVOKE UPDATE ON mock_platform."Runtime" FROM source_worker_login');
      }
    });
    await t.test("worker INSERT cannot forge approved config, hash or frozen dates", async () => {
      const s = scopeFor("a2");
      const query = `INSERT INTO mock_platform."Runtime" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","sourceConfig","configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd")
        SELECT id,0,"organizationId","workspaceId","storeId","connectionId","externalStoreId",$1::jsonb,$2,"generatorVersion",'mock-runtime-v2',$3::timestamp,$4::timestamp FROM demo."DemoCommerceSession" WHERE id=$5`;
      const good = configFor(s);
      for (const parameters of [
        [
          { ...good, seed: 43 },
          hashConfig(good),
          good.historyStart,
          "2026-01-30T16:00:00.000Z",
          s.sessionId,
        ],
        [good, "f".repeat(64), good.historyStart, "2026-01-30T16:00:00.000Z", s.sessionId],
        [
          good,
          hashConfig(good),
          "2026-01-01T16:00:00.000Z",
          "2026-01-30T16:00:00.000Z",
          s.sessionId,
        ],
        [good, hashConfig(good), good.historyStart, "2026-01-31T16:00:00.000Z", s.sessionId],
      ]) {
        await workLogin.query("BEGIN");
        try {
          await workLogin.query(
            "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id',$3,true)",
            ["source-worker", "source-merchant-a", "source-grant-a2"],
          );
          await assert.rejects(workLogin.query(query, parameters), (e) => e.code === "23514");
        } finally {
          await workLogin.query("ROLLBACK");
        }
      }
      await workLogin.query("BEGIN");
      try {
        await workLogin.query(
          "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id',$3,true)",
          ["source-worker", "source-merchant-a", "source-grant-a2"],
        );
        const started = Date.now();
        const raw = await workLogin.query(
          `${query} RETURNING to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created`,
          [good, hashConfig(good), good.historyStart, "2026-01-30T16:00:00.000Z", s.sessionId],
        );
        assert.equal(raw.rowCount, 1);
        assert.ok(
          Date.parse(raw.rows[0].created) >= started - 1000 &&
            Date.parse(raw.rows[0].created) <= Date.now() + 1000,
          "raw worker creation timestamps are UTC under a non-UTC login",
        );
      } finally {
        await workLogin.query("ROLLBACK");
      }
      assert.equal(
        (
          await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
            s.sessionId,
          ])
        ).rowCount,
        0,
      );
    });
    await t.test(
      "genuine zero-row INSERT is an integrity failure and pooled identity rolls back",
      async () => {
        await admin.query(
          "CREATE FUNCTION mock_platform.test_suppress_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
        );
        await admin.query(
          'CREATE TRIGGER a_test_suppress_insert BEFORE INSERT ON mock_platform."Runtime" FOR EACH ROW EXECUTE FUNCTION mock_platform.test_suppress_insert()',
        );
        try {
          await assert.rejects(
            worker.initializeGeneration({ grantId: "source-grant-a2" }, scopeFor("a2")),
            (e) => e.code === "SOURCE_INTEGRITY",
          );
          assert.deepEqual(
            await worker.initializeGeneration({ grantId: "unknown" }, scopeFor("a2")),
            { status: "DENIED" },
          );
        } finally {
          await admin.query('DROP TRIGGER a_test_suppress_insert ON mock_platform."Runtime"');
          await admin.query("DROP FUNCTION mock_platform.test_suppress_insert()");
        }
        const initialized = await worker.initializeGeneration(
          { grantId: "source-grant-a2" },
          scopeFor("a2"),
        );
        assert.equal(initialized.status, "CREATED");
        assert.equal(
          (
            await workLogin.query(
              "SELECT current_setting('app.user_id',true) AS principal,current_setting('app.merchant_id',true) AS merchant,current_setting('mock.grant_id',true) AS grant",
            )
          ).rows[0].principal ?? "",
          "",
        );
      },
    );
    await t.test("mismatched active immutable snapshot fails without overwrite", async () => {
      const s = scopeFor("a2");
      const changed = { ...configFor(s), seed: 99 };
      await admin.query(
        'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
        [changed, hashConfig(changed), s.sessionId],
      );
      try {
        await assert.rejects(
          worker.initializeGeneration({ grantId: "source-grant-a2" }, s),
          (e) => e.code === "SOURCE_INTEGRITY",
        );
      } finally {
        const good = configFor(s);
        await admin.query(
          'UPDATE demo."DemoCommerceSession" SET config=$1,"configHash"=$2 WHERE id=$3',
          [good, hashConfig(good), s.sessionId],
        );
      }
    });
    await t.test(
      "generation change during INSERT never returns the old generation as active",
      async () => {
        // Operator-owned fault trigger reproduces a control change after the copied row is inserted.
        await admin.query(
          'CREATE FUNCTION mock_platform.test_reset_after_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public."PlatformConnection" SET generation=generation+1 WHERE id=NEW."connectionId"; RETURN NEW; END $$',
        );
        await admin.query(
          'CREATE TRIGGER test_reset_after_insert AFTER INSERT ON mock_platform."Runtime" FOR EACH ROW EXECUTE FUNCTION mock_platform.test_reset_after_insert()',
        );
        try {
          assert.deepEqual(
            await worker.initializeGeneration({ grantId: "source-grant-b" }, scopeFor("b")),
            { status: "DENIED" },
          );
          assert.equal(
            await reader.findGeneration(
              { ...readerActor, merchantId: "source-merchant-b" },
              scopeFor("b"),
            ),
            null,
          );
          assert.equal(
            (
              await admin.query('SELECT * FROM mock_platform."Runtime" WHERE "sessionId"=$1', [
                scopeFor("b").sessionId,
              ])
            ).rowCount,
            0,
          );
        } finally {
          await admin.query('DROP TRIGGER test_reset_after_insert ON mock_platform."Runtime"');
          await admin.query("DROP FUNCTION mock_platform.test_reset_after_insert()");
        }
      },
    );
    await t.test(
      "a human in both merchants selects the exact authorized organization and worker grant",
      async () => {
        const other = scopeFor("b");
        const created = await worker.initializeGeneration({ grantId: "source-grant-b" }, other);
        assert.equal(created.status, "CREATED");
        assert.deepEqual(
          await reader.findGeneration({ ...readerActor, merchantId: "source-merchant-b" }, other),
          created.generation,
        );
        assert.equal(await reader.findGeneration(readerActor, other), null);
        assert.deepEqual(await worker.initializeGeneration({ grantId: "source-grant-a" }, other), {
          status: "DENIED",
        });
        assert.deepEqual(
          await worker.initializeGeneration(
            { grantId: "source-grant-b" },
            { ...scope, generation: 1 },
          ),
          { status: "DENIED" },
        );
      },
    );
    await t.test("grant lookup rejects impersonation via SET ROLE", async () => {
      await workLogin.query("SET ROLE shopmate_mock_source_worker");
      try {
        assert.equal((await workLogin.query('SELECT * FROM demo."MockWorkerGrant"')).rowCount, 0);
      } finally {
        await workLogin.query("RESET ROLE");
      }
    });
    for (const mode of ["reader", "worker"]) {
      await t.test(
        `${mode} survives an idle backend loss with sanitized explicit recovery`,
        async () => {
          await idlePoolRecovery(admin, env, mode, readerActor, { ...scope, generation: 1 });
        },
      );
      await t.test(
        `${mode} survives loss of a checked-out backend and explicitly recovers`,
        async () => {
          await idlePoolRecovery(admin, env, mode, readerActor, { ...scope, generation: 1 }, true);
        },
      );
    }
    await t.test("elevated login and storage failures are sanitized", async () => {
      const bad = source.createMockSourceReader({
        MOCK_PLATFORM_READ_DATABASE_URL: url.toString(),
      });
      try {
        await assert.rejects(
          bad.findGeneration(readerActor, scope),
          (e) => e.code === "SOURCE_CREDENTIALS" && !e.message.includes(url.toString()),
        );
      } finally {
        await bad.close();
      }
      await admin.query("CREATE ROLE source_elevated NOLOGIN BYPASSRLS");
      await admin.query("GRANT source_elevated TO source_read_login");
      try {
        await assert.rejects(
          reader.findGeneration(readerActor, scope),
          (e) => e.code === "SOURCE_CREDENTIALS",
        );
      } finally {
        await admin.query("REVOKE source_elevated FROM source_read_login");
      }
      await admin.query("GRANT pg_write_all_data TO source_read_login");
      try {
        await assert.rejects(
          reader.findGeneration(readerActor, scope),
          (e) => e.code === "SOURCE_CREDENTIALS",
        );
      } finally {
        await admin.query("REVOKE pg_write_all_data FROM source_read_login");
      }
      await admin.query("GRANT shopmate_mock_source_reader TO source_worker_login");
      try {
        await assert.rejects(worker.listGrants(), (e) => e.code === "SOURCE_CREDENTIALS");
      } finally {
        await admin.query("REVOKE shopmate_mock_source_reader FROM source_worker_login");
      }
      await admin.query('ALTER TABLE mock_platform."Runtime" OWNER TO source_read_login');
      try {
        await assert.rejects(
          reader.findGeneration(readerActor, scope),
          (e) => e.code === "SOURCE_CREDENTIALS",
        );
      } finally {
        await admin.query('ALTER TABLE mock_platform."Runtime" OWNER TO CURRENT_USER');
      }
    });
  } finally {
    if (reader) await reader.close();
    if (worker) await worker.close();
    for (const client of logins) await client.end();
    if (admin) await admin.end();
    await operator.end();
    await server.stop();
  }
});
