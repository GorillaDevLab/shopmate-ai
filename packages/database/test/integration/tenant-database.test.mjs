import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import process from "node:process";
import { URL } from "node:url";
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
  } finally {
    await client.end();
    await server.stop();
  }
});
