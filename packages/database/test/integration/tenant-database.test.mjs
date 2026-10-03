import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";

const migrationRoot = new URL("../../prisma/migrations/", import.meta.url);
const tenantMigration = "20261003000000_tenant_foundation";
const rlsMigration = "20261003010000_tenant_row_security";

async function applyMigrations(client, beforeTenant = false) {
  const directories = (await readdir(migrationRoot))
    .filter((name) => /^\d{14}_/u.test(name))
    .sort();
  for (const directory of directories) {
    if (beforeTenant && directory >= tenantMigration) continue;
    await client.query(
      await readFile(new URL(`${directory}/migration.sql`, migrationRoot), "utf8"),
    );
  }
}

async function insertLegacyRecords(client) {
  for (const key of ["a", "b"]) {
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`merchant-${key}`],
    );
    await client.query(
      'INSERT INTO "Product" (id,"merchantId",name,price,"updatedAt") VALUES ($1,$2,$1,59,now())',
      [`product-${key}`, `merchant-${key}`],
    );
    await client.query(
      'INSERT INTO "Sku" (id,"merchantId","productId",code,cost,"updatedAt") VALUES ($1,$2,$3,$1,20,now())',
      [`sku-${key}`, `merchant-${key}`, `product-${key}`],
    );
    await client.query(
      'INSERT INTO "Order" (id,"merchantId","orderNo","orderedAt","totalAmount","updatedAt") VALUES ($1,$2,$1,now(),59,now())',
      [`order-${key}`, `merchant-${key}`],
    );
    await client.query(
      'INSERT INTO "OrderItem" (id,"orderId","skuId",quantity,"unitPrice","lineAmount") VALUES ($1,$2,$3,1,59,59)',
      [`item-${key}`, `order-${key}`, `sku-${key}`],
    );
  }
}

test("tenant migration preserves legacy records and rejects foreign relations in PostgreSQL", async (t) => {
  const server = await isolatedPostgres();
  const client = new pg.Client({ connectionString: server.url });
  await client.connect();
  try {
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.equal(tables.rowCount, 0, "refusing to migrate a nonempty test database");
    await applyMigrations(client, true);
    await insertLegacyRecords(client);
    await client.query(
      await readFile(new URL(`${tenantMigration}/migration.sql`, migrationRoot), "utf8"),
    );
    await t.test(
      "maps existing merchants and default workspaces without granting users",
      async () => {
        assert.equal((await client.query('SELECT * FROM "Organization"')).rowCount, 2);
        assert.equal(
          (await client.query('SELECT * FROM "Workspace" WHERE slug=$1', ["default"])).rowCount,
          2,
        );
        assert.equal((await client.query('SELECT * FROM "OrganizationMember"')).rowCount, 0);
        assert.equal(
          (await client.query('SELECT "merchantId" FROM "OrderItem" WHERE id=$1', ["item-a"]))
            .rows[0].merchantId,
          "merchant-a",
        );
      },
    );
    await t.test("rejects a sku referencing a different merchant product", async () => {
      await assert.rejects(
        client.query(
          'INSERT INTO "Sku" (id,"merchantId","productId",code,cost,"updatedAt") VALUES ($1,$2,$3,$1,20,now())',
          ["foreign-sku", "merchant-a", "product-b"],
        ),
        (error) => error.code === "23503",
      );
    });
    await t.test("rejects a foreign sku on an order item", async () => {
      await assert.rejects(
        client.query(
          'INSERT INTO "OrderItem" (id,"orderId","skuId",quantity,"unitPrice","lineAmount") VALUES ($1,$2,$3,1,59,59)',
          ["foreign-item", "order-a", "sku-b"],
        ),
        (error) => error.code === "23503",
      );
    });
    await t.test("keeps new legacy inserts compatible and scoped", async () => {
      await client.query(
        'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
        ["merchant-c"],
      );
      assert.equal(
        (
          await client.query('SELECT * FROM "Organization" WHERE "legacyMerchantId"=$1', [
            "merchant-c",
          ])
        ).rowCount,
        1,
      );
      await client.query(
        'INSERT INTO "OrderItem" (id,"orderId","skuId",quantity,"unitPrice","lineAmount") VALUES ($1,$2,$3,1,59,59)',
        ["new-item", "order-a", "sku-a"],
      );
      assert.equal(
        (await client.query('SELECT "merchantId" FROM "OrderItem" WHERE id=$1', ["new-item"]))
          .rows[0].merchantId,
        "merchant-a",
      );
    });
    await t.test(
      "requires same organization for workspace member and store relations",
      async () => {
        await client.query(
          'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
          ["member-a", "legacy-org-merchant-a", "user-a", "VIEWER"],
        );
        await assert.rejects(
          client.query(
            'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
            ["grant-bad", "legacy-org-merchant-a", "legacy-workspace-merchant-b", "user-a"],
          ),
          (error) => error.code === "23503",
        );
      },
    );
    await t.test(
      "RLS hides all tenant rows without verified identity and restricts assigned workspaces",
      async () => {
        await client.query(
          'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
          ["member-b", "legacy-org-merchant-b", "user-b", "OWNER"],
        );
        await client.query(
          'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
          ["grant-a", "legacy-org-merchant-a", "legacy-workspace-merchant-a", "user-a"],
        );
        await client.query(
          'INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,now())',
          ["unassigned-a", "legacy-org-merchant-a"],
        );
        await client.query(
          await readFile(new URL(`${rlsMigration}/migration.sql`, migrationRoot), "utf8"),
        );
        await client.query(
          "CREATE ROLE shopmate_tenant_test_reader NOLOGIN NOSUPERUSER NOBYPASSRLS",
        );
        await client.query("GRANT USAGE ON SCHEMA public TO shopmate_tenant_test_reader");
        await client.query(
          'GRANT SELECT ON "Organization","OrganizationMember","Workspace","WorkspaceMember" TO shopmate_tenant_test_reader',
        );
        await client.query("SET ROLE shopmate_tenant_test_reader");
        assert.equal((await client.query('SELECT * FROM "Organization"')).rowCount, 0);
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.user_id',$1,true)", ["user-a"]);
        assert.deepEqual((await client.query('SELECT id FROM "Organization"')).rows, [
          { id: "legacy-org-merchant-a" },
        ]);
        assert.deepEqual((await client.query('SELECT id FROM "Workspace"')).rows, [
          { id: "legacy-workspace-merchant-a" },
        ]);
        await client.query("COMMIT");
        assert.equal((await client.query('SELECT * FROM "Workspace"')).rowCount, 0);
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.user_id',$1,true)", ["user-b"]);
        assert.deepEqual((await client.query('SELECT id FROM "Workspace"')).rows, [
          { id: "legacy-workspace-merchant-b" },
        ]);
        await client.query("COMMIT");
        await client.query("RESET ROLE");
      },
    );
    await t.test(
      "legacy store writes work under a role without RLS bypass or tenant identity",
      async () => {
        await client.query(
          await readFile(
            new URL("20261003030000_tenant_compatibility_hardening/migration.sql", migrationRoot),
            "utf8",
          ),
        );
        await client.query('GRANT SELECT,INSERT,UPDATE ON "Store" TO shopmate_tenant_test_reader');
        await client.query("SET ROLE shopmate_tenant_test_reader");
        try {
          await client.query(
            'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
            ["store-legacy", "merchant-a", "上海", "mock"],
          );
          await client.query('UPDATE "Store" SET name=$1 WHERE id=$2', [
            "更新门店",
            "store-legacy",
          ]);
          assert.equal(
            (
              await client.query('SELECT "organizationId" FROM "Store" WHERE id=$1', [
                "store-legacy",
              ])
            ).rows[0].organizationId,
            "legacy-org-merchant-a",
          );
        } finally {
          await client.query("RESET ROLE");
        }
      },
    );
    await t.test(
      "repository resolves fresh memberships and clears identity after its transaction",
      async () => {
        process.env.DATABASE_URL = server.url;
        const { resolveTenantMembership, disconnectPrismaClient, getPrismaClient } = await import(
          "../../dist/src/index.js"
        );
        try {
          assert.equal(typeof resolveTenantMembership, "function");
          const context = await resolveTenantMembership("user-a", "merchant-a");
          assert.equal(context?.role, "VIEWER");
          assert.equal(await resolveTenantMembership("user-a", "merchant-b"), null);
          assert.equal(await resolveTenantMembership("user-a", "merchant-a", "unassigned-a"), null);
          const scope = await getPrismaClient()
            .$queryRaw`SELECT current_setting('app.user_id',true) AS identity`;
          assert.ok(!scope[0].identity);
          await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE id=$2', [
            "INACTIVE",
            "member-a",
          ]);
          assert.equal(await resolveTenantMembership("user-a", "merchant-a"), null);
          await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE id=$2', [
            "ACTIVE",
            "member-a",
          ]);
          await client.query('UPDATE "Organization" SET status=$1 WHERE id=$2', [
            "SUSPENDED",
            "legacy-org-merchant-a",
          ]);
          assert.equal(await resolveTenantMembership("user-a", "merchant-a"), null);
          await client.query('UPDATE "Organization" SET status=$1 WHERE id=$2', [
            "ACTIVE",
            "legacy-org-merchant-a",
          ]);
        } finally {
          await disconnectPrismaClient();
        }
      },
    );
    await t.test(
      "bootstrap requires a matching marker, previews without writes and never elevates existing members",
      async () => {
        await client.query(
          await readFile(
            new URL("20261003020000_tenant_bootstrap_environment/migration.sql", migrationRoot),
            "utf8",
          ),
        );
        const { bootstrapTenantMembership } = await import("../../dist/src/tenant-bootstrap.js");
        const env = {
          APP_ENV: "test",
          NODE_ENV: "test",
          DATABASE_URL: server.url,
          TENANT_BOOTSTRAP_USER_ID: "bootstrap-user",
          TENANT_BOOTSTRAP_MERCHANT_ID: "merchant-c",
        };
        await assert.rejects(bootstrapTenantMembership(env), /marker/u);
        await client.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1 WHERE id=$2', [
          "TEST",
          "singleton",
        ]);
        assert.equal((await bootstrapTenantMembership(env)).applied, false);
        assert.equal(
          (
            await client.query('SELECT * FROM "OrganizationMember" WHERE "userId"=$1', [
              "bootstrap-user",
            ])
          ).rowCount,
          0,
        );
        const apply = { ...env, TENANT_BOOTSTRAP_APPLY: "true" };
        await bootstrapTenantMembership(apply);
        await bootstrapTenantMembership(apply);
        assert.equal(
          (
            await client.query('SELECT * FROM "OrganizationMember" WHERE "userId"=$1', [
              "bootstrap-user",
            ])
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await client.query('SELECT * FROM "WorkspaceMember" WHERE "userId"=$1', [
              "bootstrap-user",
            ])
          ).rowCount,
          1,
        );
        await assert.rejects(
          bootstrapTenantMembership({ ...apply, TENANT_BOOTSTRAP_ROLE: "OWNER" }),
          /cannot be changed/u,
        );
        await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
          "INACTIVE",
          "bootstrap-user",
        ]);
        await assert.rejects(bootstrapTenantMembership(apply), /cannot be changed/u);
      },
    );
    await t.test(
      "legacy tenant identifiers fit the contract at the maximum merchant identifier length",
      async () => {
        const id = "x".repeat(128);
        await client.query(
          'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
          [id],
        );
        const row = (
          await client.query(
            'SELECT o.id AS organization,w.id AS workspace FROM "Organization" o JOIN "Workspace" w ON w."organizationId"=o.id WHERE o."legacyMerchantId"=$1',
            [id],
          )
        ).rows[0];
        assert.ok(row.organization.length <= 128);
        assert.ok(row.workspace.length <= 128);
        const digest = createHash("sha256").update(id).digest("hex");
        await client.query(
          'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
          [digest],
        );
        const other = (
          await client.query(
            'SELECT o.id AS organization,w.id AS workspace FROM "Organization" o JOIN "Workspace" w ON w."organizationId"=o.id WHERE o."legacyMerchantId"=$1',
            [digest],
          )
        ).rows[0];
        assert.notEqual(other.organization, row.organization);
        assert.notEqual(other.workspace, row.workspace);
      },
    );
    await t.test("legacy Prisma seed and order seed work with inherited tenant fields", () => {
      const directory = fileURLToPath(new URL("../../", import.meta.url));
      for (const script of ["src/seed.ts", "src/order-seed.ts"]) {
        execFileSync(process.execPath, ["--import", "tsx", script], {
          cwd: directory,
          env: { ...process.env, DATABASE_URL: server.url },
          encoding: "utf8",
          windowsHide: true,
        });
      }
    });
    await t.test("deployed migrations match the Prisma schema without drift", async () => {
      await client.query(
        await readFile(
          new URL("20261003040000_demo_commerce_sessions/migration.sql", migrationRoot),
          "utf8",
        ),
      );
      await client.query(
        await readFile(
          new URL("20261003050000_mock_source_generation/migration.sql", migrationRoot),
          "utf8",
        ),
      );
      const directory = fileURLToPath(new URL("../../", import.meta.url));
      const cli = fileURLToPath(
        new URL("../../node_modules/prisma/build/index.js", import.meta.url),
      );
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
          env: { ...process.env, DATABASE_URL: server.url },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.match(output, /empty migration/u);
    });
  } finally {
    await client.end();
    await server.stop();
  }
});
