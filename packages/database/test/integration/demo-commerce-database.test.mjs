import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";

const actor = { userId: "demo-owner", merchantId: "demo-merchant-a" };
const viewer = { ...actor, userId: "demo-viewer" };
const binding = {
  organizationId: "legacy-org-demo-merchant-a",
  workspaceId: "legacy-workspace-demo-merchant-a",
  storeId: "demo-store-a",
  connectionId: "demo-connection-a",
  externalStoreId: "external-a",
};
const input = {
  id: "demo-session-a",
  connectionId: binding.connectionId,
  externalStoreId: binding.externalStoreId,
  config: { binding, seed: 42 },
  configHash: "a".repeat(64),
  generatorVersion: "mock-source-v1",
  clockNow: new Date("2026-01-01T00:00:00.000Z"),
};

async function migrate(client) {
  const root = new URL("../../prisma/migrations/", import.meta.url);
  for (const name of (await readdir(root)).filter((v) => /^\d{14}_/u.test(v)).sort()) {
    await client.query(await readFile(new URL(`${name}/migration.sql`, root), "utf8"));
  }
}

async function fixtures(client) {
  for (const key of ["a", "b", "real"]) {
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`demo-merchant-${key}`],
    );
    await client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      [`demo-store-${key}`, `demo-merchant-${key}`, "Shanghai", "MOCK"],
    );
    await client.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      [`demo-member-${key}`, `legacy-org-demo-merchant-${key}`, "demo-owner", "OWNER"],
    );
  }
  await client.query(
    'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
    ["demo-viewer-member", binding.organizationId, "demo-viewer", "VIEWER"],
  );
  await client.query(
    'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
    ["demo-viewer-grant", binding.organizationId, binding.workspaceId, "demo-viewer"],
  );
  await client.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1),($2)', [
    binding.organizationId,
    "legacy-org-demo-merchant-b",
  ]);
  await client.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  await client.query("CREATE ROLE shopmate_demo_runtime LOGIN NOSUPERUSER NOBYPASSRLS");
  await client.query("GRANT USAGE ON SCHEMA public,demo TO shopmate_demo_runtime");
  await client.query(
    "GRANT EXECUTE ON FUNCTION demo.has_store_access(TEXT,TEXT,TEXT,BOOLEAN) TO shopmate_demo_runtime",
  );
  await client.query(
    'GRANT SELECT ON "Organization","OrganizationMember","Workspace","WorkspaceMember","Store","DemoTenant","TenantBootstrapEnvironment" TO shopmate_demo_runtime',
  );
  await client.query(
    'GRANT SELECT,INSERT,UPDATE ON "PlatformConnection",demo."DemoCommerceSession" TO shopmate_demo_runtime',
  );
  await client.query('GRANT SELECT,INSERT ON demo."DemoControlAudit" TO shopmate_demo_runtime');
}

async function identity(client, userId, action) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

test("persistent demo controls run under real restricted PostgreSQL RLS", async (t) => {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  const dbUrl = new URL(server.url);
  dbUrl.pathname = "/shopmate_tenant_test_demo";
  let admin, runtime, repo;
  try {
    await operator.query('CREATE DATABASE "shopmate_tenant_test_demo"');
    admin = new pg.Client({ connectionString: dbUrl.toString() });
    await admin.connect();
    await migrate(admin);
    await t.test("migration creates separate persistent demo tables", async () => {
      const tables = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='demo'");
      assert.deepEqual(tables.rows.map((v) => v.tablename).sort(), [
        "DemoCommerceSession",
        "DemoControlAudit",
      ]);
    });
    // Stop before fixtures if the feature is absent, making the initial red assertion meaningful.
    assert.ok(
      (await admin.query("SELECT to_regclass('public.\"DemoTenant\"') AS table")).rows[0].table,
    );
    await fixtures(admin);
    dbUrl.username = "shopmate_demo_runtime";
    dbUrl.password = "";
    runtime = new pg.Client({ connectionString: dbUrl.toString() });
    await runtime.connect();
    process.env.DATABASE_URL = dbUrl.toString();
    repo = await import("../../dist/src/index.js");
    await t.test("runtime is non-owner and cannot bypass RLS", async () => {
      const role = (
        await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
      ).rows[0];
      assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
      const tables = await runtime.query(
        "SELECT relowner::regrole::text AS owner,relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('public.\"DemoTenant\"'::regclass,'public.\"PlatformConnection\"'::regclass,'demo.\"DemoCommerceSession\"'::regclass,'demo.\"DemoControlAudit\"'::regclass)",
      );
      assert.ok(tables.rows.every((v) => v.owner !== "shopmate_demo_runtime" && v.forced));
    });
    await t.test(
      "marker cannot be provisioned by runtime and missing identity denies",
      async () => {
        assert.equal((await runtime.query('SELECT * FROM "DemoTenant"')).rowCount, 0);
        await assert.rejects(
          runtime.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
            "legacy-org-demo-merchant-real",
          ]),
          (e) => e.code === "42501",
        );
        assert.equal(
          await repo.findDemoStore({ ...actor, userId: "unassigned" }, binding.storeId),
          null,
        );
        assert.equal(await repo.findDemoStore(actor, "demo-store-b"), null);
        assert.equal(
          await repo.findDemoStore(
            { ...actor, merchantId: "demo-merchant-real" },
            "demo-store-real",
          ),
          null,
        );
      },
    );
    await t.test("create persists scoped config and atomic audit", async () => {
      const result = await repo.createDemoSession(actor, binding.storeId, input);
      assert.equal(result.status, "WRITTEN");
      assert.equal(result.record.role, "OWNER");
      assert.equal(result.record.generation, 0);
      assert.equal((await admin.query('SELECT * FROM demo."DemoControlAudit"')).rowCount, 1);
      assert.equal(
        (await repo.createDemoSession(actor, binding.storeId, input)).status,
        "CONFLICT",
      );
    });
    await t.test("new Prisma client sees persisted state and identity clears", async () => {
      await repo.disconnectPrismaClient();
      assert.equal(
        (await repo.findDemoSession(actor, binding.storeId)).configHash,
        input.configHash,
      );
      const local = await repo.getPrismaClient()
        .$queryRaw`SELECT current_setting('app.user_id',true) AS identity`;
      assert.ok(!local[0].identity);
      assert.equal((await runtime.query('SELECT * FROM demo."DemoCommerceSession"')).rowCount, 0);
    });
    await t.test(
      "viewer reads but cannot mutate and unassigned workspace cannot read",
      async () => {
        assert.equal((await repo.findDemoSession(viewer, binding.storeId)).role, "VIEWER");
        assert.equal(
          (
            await repo.advanceDemoSession(viewer, binding.storeId, {
              expectedRevision: 0,
              durationMs: 1,
            })
          ).status,
          "NOT_FOUND",
        );
        await admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
          "INACTIVE",
          "demo-viewer-grant",
        ]);
        assert.equal(await repo.findDemoSession(viewer, binding.storeId), null);
        await admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE id=$2', [
          "ACTIVE",
          "demo-viewer-grant",
        ]);
      },
    );
    await t.test(
      "database refuses fake config binding, external association and foreign ownership",
      async () => {
        for (const field of Object.keys(binding)) {
          await assert.rejects(
            identity(runtime, actor.userId, () =>
              runtime.query('UPDATE demo."DemoCommerceSession" SET config=$1 WHERE id=$2', [
                { binding: { ...binding, [field]: "foreign" } },
                input.id,
              ]),
            ),
            (e) => e.code === "23514",
          );
        }
        await assert.rejects(
          identity(runtime, actor.userId, () =>
            runtime.query('UPDATE "PlatformConnection" SET "storeId"=$1 WHERE id=$2', [
              "demo-store-b",
              input.connectionId,
            ]),
          ),
        );
        await assert.rejects(
          admin.query(
            'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES ($1,$2,$3,$4,$5)',
            [
              "foreign-connection",
              binding.organizationId,
              binding.workspaceId,
              "demo-store-b",
              "external",
            ],
          ),
          (e) => e.code === "23503",
        );
      },
    );
    await t.test("advance is CAS atomic and increments clock without generation", async () => {
      const results = await Promise.all(
        [1, 2].map(() =>
          repo.advanceDemoSession(actor, binding.storeId, {
            expectedRevision: 0,
            durationMs: 1000,
          }),
        ),
      );
      assert.deepEqual(results.map((v) => v.status).sort(), ["CONFLICT", "WRITTEN"]);
      const row = await repo.findDemoSession(actor, binding.storeId);
      assert.equal(row.clockNow.toISOString(), "2026-01-01T00:00:01.000Z");
      assert.equal(row.clockRevision, 1);
      assert.equal(row.generation, 0);
    });
    await t.test(
      "disconnect revokes generation, reset reactivates selected persistent connection",
      async () => {
        const disconnected = await repo.disconnectDemoSession(actor, binding.storeId, 1);
        assert.equal(disconnected.record.status, "DISCONNECTED");
        assert.equal(disconnected.record.generation, 1);
        const reset = await repo.resetDemoSession(actor, binding.storeId, {
          ...input,
          expectedRevision: 2,
          configHash: "b".repeat(64),
        });
        assert.equal(reset.record.status, "ACTIVE");
        assert.equal(reset.record.generation, 2);
        assert.equal(reset.record.clockRevision, 2);
        assert.equal(reset.record.revision, 3);
      },
    );
    await t.test(
      "marker, suspended tenant and stale membership deny fresh repository reads",
      async () => {
        for (const [sql, off, on] of [
          ['UPDATE "TenantBootstrapEnvironment" SET environment=$1', "PRODUCTION", "DEMO"],
          [
            "UPDATE \"Organization\" SET status=$1 WHERE id='legacy-org-demo-merchant-a'",
            "SUSPENDED",
            "ACTIVE",
          ],
          [
            "UPDATE \"Workspace\" SET status=$1 WHERE id='legacy-workspace-demo-merchant-a'",
            "SUSPENDED",
            "ACTIVE",
          ],
          [
            "UPDATE \"OrganizationMember\" SET status=$1 WHERE id='demo-member-a'",
            "INACTIVE",
            "ACTIVE",
          ],
        ]) {
          await admin.query(sql, [off]);
          assert.equal(await repo.findDemoSession(actor, binding.storeId), null);
          assert.equal(
            (await repo.disconnectDemoSession(actor, binding.storeId, 3)).status,
            "NOT_FOUND",
          );
          await admin.query(sql, [on]);
        }
      },
    );
    await t.test("invalid primitive inputs and binding fail without scoped mutation", async () => {
      for (const bad of [
        { expectedRevision: -1, durationMs: 1 },
        { expectedRevision: 3, durationMs: 0 },
        { expectedRevision: 3, durationMs: NaN },
      ]) {
        assert.equal(
          (await repo.advanceDemoSession(actor, binding.storeId, bad)).status,
          "CONFLICT",
        );
      }
      assert.equal(
        await repo.findDemoStore({ ...actor, userId: "bad identity" }, binding.storeId),
        null,
      );
      assert.equal(
        (
          await repo.resetDemoSession(actor, binding.storeId, {
            ...input,
            expectedRevision: 3,
            config: { binding: { ...binding, storeId: "foreign" } },
          })
        ).status,
        "CONFLICT",
      );
      assert.equal(
        (
          await repo.resetDemoSession(actor, binding.storeId, {
            ...input,
            expectedRevision: 3,
            clockNow: new Date("0000-01-01T00:00:00.000Z"),
          })
        ).status,
        "CONFLICT",
      );
      assert.equal((await repo.findDemoSession(actor, binding.storeId)).revision, 3);
    });
    await t.test("clock and counters cannot overflow and conflicts produce no audit", async () => {
      await admin.query('UPDATE demo."DemoCommerceSession" SET "clockNow"=$1 WHERE id=$2', [
        "9999-12-31T23:59:59.999Z",
        input.id,
      ]);
      assert.equal(
        (
          await repo.advanceDemoSession(actor, binding.storeId, {
            expectedRevision: 3,
            durationMs: 1,
          })
        ).status,
        "CONFLICT",
      );
      await admin.query('UPDATE demo."DemoCommerceSession" SET revision=2147483647 WHERE id=$1', [
        input.id,
      ]);
      assert.equal(
        (await repo.disconnectDemoSession(actor, binding.storeId, 2147483647)).status,
        "CONFLICT",
      );
      assert.equal((await admin.query('SELECT * FROM demo."DemoControlAudit"')).rowCount, 4);
      await admin.query(
        'UPDATE demo."DemoCommerceSession" SET revision=3,"clockNow"=$1 WHERE id=$2',
        [input.clockNow, input.id],
      );
    });
    await t.test(
      "audit is tenant scoped and append only even with explicit update grants",
      async () => {
        assert.equal((await runtime.query('SELECT * FROM demo."DemoControlAudit"')).rowCount, 0);
        assert.equal(
          (
            await identity(runtime, actor.userId, () =>
              runtime.query('SELECT * FROM demo."DemoControlAudit"'),
            )
          ).rowCount,
          4,
        );
        assert.equal(
          (
            await identity(runtime, "foreign-user", () =>
              runtime.query('SELECT * FROM demo."DemoControlAudit"'),
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          runtime.query("UPDATE demo.\"DemoControlAudit\" SET kind='RESET'"),
          (e) => e.code === "42501",
        );
        await admin.query(
          'GRANT UPDATE,DELETE ON demo."DemoControlAudit" TO shopmate_demo_runtime',
        );
        assert.equal(
          (
            await identity(runtime, actor.userId, () =>
              runtime.query('DELETE FROM demo."DemoControlAudit"'),
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await identity(runtime, actor.userId, () =>
              runtime.query("UPDATE demo.\"DemoControlAudit\" SET kind='RESET'"),
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test("audit failure rolls back connection and session mutation together", async () => {
      await admin.query('REVOKE INSERT ON demo."DemoControlAudit" FROM shopmate_demo_runtime');
      await assert.rejects(repo.disconnectDemoSession(actor, binding.storeId, 3));
      const row = await repo.findDemoSession(actor, binding.storeId);
      assert.equal(row.revision, 3);
      assert.equal(row.generation, 2);
      assert.equal(row.status, "ACTIVE");
      await admin.query('GRANT INSERT ON demo."DemoControlAudit" TO shopmate_demo_runtime');
    });
    await t.test("multi-schema Prisma migration has no schema drift", () => {
      const directory = fileURLToPath(new URL("../../", import.meta.url));
      const cli = fileURLToPath(
        new URL("../../node_modules/prisma/build/index.js", import.meta.url),
      );
      dbUrl.username = "tenant_test_admin";
      const output = execFileSync(
        process.execPath,
        [
          cli,
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code",
          "--script",
        ],
        {
          cwd: directory,
          env: { ...process.env, DATABASE_URL: dbUrl.toString() },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.match(output, /empty migration/u);
    });
    await t.test("malformed JSON source values cannot be silently dropped or coerced", async () => {
      for (const value of [undefined, NaN, Infinity, () => "invalid", Symbol("invalid")]) {
        const result = await repo.resetDemoSession(actor, binding.storeId, {
          ...input,
          expectedRevision: 3,
          config: { binding, value },
        });
        assert.equal(result.status, "CONFLICT");
      }
      assert.equal((await repo.findDemoSession(actor, binding.storeId)).revision, 3);
    });
    await t.test(
      "advance competing with reset has one winner and leaves a second store unchanged",
      async () => {
        const otherBinding = {
          ...binding,
          organizationId: "legacy-org-demo-merchant-b",
          workspaceId: "legacy-workspace-demo-merchant-b",
          storeId: "demo-store-b",
          connectionId: "demo-connection-b",
          externalStoreId: "42",
        };
        const otherActor = { ...actor, merchantId: "demo-merchant-b" };
        const otherInput = {
          ...input,
          id: "demo-session-b",
          connectionId: otherBinding.connectionId,
          externalStoreId: otherBinding.externalStoreId,
          config: { binding: otherBinding },
        };
        const other = await repo.createDemoSession(otherActor, otherBinding.storeId, otherInput);
        assert.equal(other.status, "WRITTEN");
        const results = await Promise.all([
          repo.advanceDemoSession(actor, binding.storeId, { expectedRevision: 3, durationMs: 1 }),
          repo.resetDemoSession(actor, binding.storeId, { ...input, expectedRevision: 3 }),
        ]);
        assert.deepEqual(results.map((v) => v.status).sort(), ["CONFLICT", "WRITTEN"]);
        assert.equal((await repo.findDemoSession(actor, binding.storeId)).revision, 4);
        assert.deepEqual(
          await repo.findDemoSession(otherActor, otherBinding.storeId),
          other.record,
        );
        await assert.rejects(
          identity(runtime, actor.userId, () =>
            runtime.query('UPDATE demo."DemoCommerceSession" SET config=$1 WHERE id=$2', [
              { binding: { ...otherBinding, externalStoreId: 42 } },
              otherInput.id,
            ]),
          ),
          (error) => error.code === "23514",
        );
      },
    );
    await t.test("revoked demo marker denies existing session without deleting data", async () => {
      const before = (
        await admin.query('SELECT * FROM demo."DemoCommerceSession" WHERE id=$1', [input.id])
      ).rows[0];
      await admin.query('DELETE FROM "DemoTenant" WHERE "organizationId"=$1', [
        binding.organizationId,
      ]);
      assert.equal(await repo.findDemoSession(actor, binding.storeId), null);
      assert.equal(
        (await repo.disconnectDemoSession(actor, binding.storeId, 4)).status,
        "NOT_FOUND",
      );
      assert.deepEqual(
        (await admin.query('SELECT * FROM demo."DemoCommerceSession" WHERE id=$1', [input.id]))
          .rows[0],
        before,
      );
      await admin.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
        binding.organizationId,
      ]);
    });
    await t.test(
      "first Gregorian year persists and generation/clock counters refuse overflow",
      async () => {
        const result = await repo.resetDemoSession(actor, binding.storeId, {
          ...input,
          expectedRevision: 4,
          clockNow: new Date("0001-01-01T00:00:00.000Z"),
        });
        assert.equal(result.status, "WRITTEN");
        assert.equal(result.record.clockNow.toISOString(), "0001-01-01T00:00:00.000Z");
        const snapshot = result.record;
        await admin.query('UPDATE "PlatformConnection" SET generation=2147483647 WHERE id=$1', [
          input.connectionId,
        ]);
        assert.equal(
          (await repo.disconnectDemoSession(actor, binding.storeId, 5)).status,
          "CONFLICT",
        );
        assert.equal(
          (await repo.resetDemoSession(actor, binding.storeId, { ...input, expectedRevision: 5 }))
            .status,
          "CONFLICT",
        );
        await admin.query('UPDATE "PlatformConnection" SET generation=$1 WHERE id=$2', [
          snapshot.generation,
          input.connectionId,
        ]);
        await admin.query(
          'UPDATE demo."DemoCommerceSession" SET "clockRevision"=2147483647 WHERE id=$1',
          [input.id],
        );
        assert.equal(
          (
            await repo.advanceDemoSession(actor, binding.storeId, {
              expectedRevision: 5,
              durationMs: 1,
            })
          ).status,
          "CONFLICT",
        );
        assert.equal(
          (await repo.resetDemoSession(actor, binding.storeId, { ...input, expectedRevision: 5 }))
            .status,
          "CONFLICT",
        );
        assert.equal((await repo.findDemoSession(actor, binding.storeId)).revision, 5);
      },
    );
  } finally {
    if (repo) await repo.disconnectPrismaClient();
    if (runtime) await runtime.end();
    if (admin) await admin.end();
    await operator.end();
    await server.stop();
  }
});
