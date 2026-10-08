import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";
import {
  loginUrl,
  migrateSource,
  scopeFor,
  sourceFixtures,
  sourceEnv,
} from "../helpers/mock-platform-fixture.mjs";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const source = await import("../../dist/src/mock-platform/index.js");

async function insertScope(client, id, key = "a", generation = 0) {
  const scope = scopeFor(key, generation);
  return client.query(
    'INSERT INTO commerce."SourceScope" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      id,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      "MOCK",
      generation,
    ],
  );
}

async function product(client, scopeId, id = "product", cost = 100, category = "category") {
  await client.query(
    'INSERT INTO commerce."ProductListing" ("scopeId","organizationId","workspaceId","storeId","externalProductId",title,category,status,"sourceVersion","sourceUpdatedAt","sourcePayloadHash","qualityState","qualityIssues") SELECT id,"organizationId","workspaceId","storeId",$2,$2,$3,$4,$5,$6,$7,$8,$9 FROM commerce."SourceScope" WHERE id=$1',
    [
      scopeId,
      id,
      category,
      "DELETED",
      "opaque-v1",
      "2026-01-01T00:00:00.000Z",
      hash,
      cost === null ? "PARTIAL" : "COMPLETE",
      cost === null ? ["COST_MISSING"] : [],
    ],
  );
  await client.query(
    'INSERT INTO commerce."SkuListing" ("scopeId","organizationId","workspaceId","storeId","externalSkuId","externalProductId",attributes,"salePriceMinor","costPriceMinor",status) SELECT id,"organizationId","workspaceId","storeId",$2,$3,$4,$5,$6,$7 FROM commerce."SourceScope" WHERE id=$1',
    [
      scopeId,
      `sku-${id}`,
      id,
      JSON.stringify([{ name: "颜色", value: "黑色" }]),
      9007199254740991n,
      cost,
      "ACTIVE",
    ],
  );
}

async function transaction(client, action) {
  await client.query("BEGIN");
  try {
    await action();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function identity(client, user, merchant = "source-merchant-a") {
  await client.query(
    "SELECT set_config('app.user_id',$1,false),set_config('app.merchant_id',$2,false)",
    [user, merchant],
  );
}

test("canonical product storage enforces typed contracts and current scoped reader RLS", async (t) => {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_canonical";
  const admin = new pg.Client({ connectionString: url.toString() });
  let reader;
  try {
    await operator.connect();
    await operator.query('CREATE DATABASE "shopmate_tenant_test_canonical"');
    await admin.connect();
    await migrateSource(admin);
    await sourceFixtures(admin);
    await admin.query("CREATE ROLE commerce_read_login LOGIN NOSUPERUSER NOBYPASSRLS");
    await admin.query("GRANT shopmate_commerce_reader TO commerce_read_login");
    reader = new pg.Client({ connectionString: loginUrl(url.toString(), "commerce_read_login") });
    await reader.connect();
    await insertScope(admin, scopeA);
    await insertScope(admin, scopeB, "b");
    await transaction(admin, () => product(admin, scopeA, "product", null));
    await transaction(admin, () => product(admin, scopeB));
    await t.test(
      "typed facts retain deleted status, missing costs and safe-integer amounts",
      async () => {
        await identity(reader, "source-viewer");
        const row = (
          await reader.query(
            'SELECT p.status,s."costPriceMinor",s."salePriceMinor",p."qualityIssues" FROM commerce."ProductListing" p JOIN commerce."SkuListing" s USING ("scopeId")',
          )
        ).rows;
        assert.deepEqual(row, [
          {
            status: "DELETED",
            costPriceMinor: null,
            salePriceMinor: "9007199254740991",
            qualityIssues: ["COST_MISSING"],
          },
        ]);
      },
    );
    await t.test("missing identity and selected foreign merchant fail closed", async () => {
      await identity(reader, "", "");
      assert.equal((await reader.query('SELECT * FROM commerce."ProductListing"')).rowCount, 0);
      await identity(reader, "source-viewer", "source-merchant-b");
      assert.equal(
        (
          await reader.query('SELECT "scopeId" FROM commerce."ProductListing" WHERE "scopeId"=$1', [
            scopeA,
          ])
        ).rowCount,
        0,
      );
      await identity(reader, "source-viewer");
    });
    await t.test(
      "foreign SKU parent, namespace changes and direct reader writes are denied",
      async () => {
        await assert.rejects(
          admin.query(
            'UPDATE commerce."SkuListing" SET "scopeId"=$1,"externalSkuId"=\'foreign-parent\' WHERE "scopeId"=$2',
            [scopeB, scopeA],
          ),
          { code: "23503" },
        );
        await assert.rejects(
          admin.query('UPDATE commerce."SourceScope" SET generation=1 WHERE id=$1', [scopeA]),
          { code: "23514" },
        );
        await assert.rejects(reader.query('DELETE FROM commerce."ProductListing"'), {
          code: "42501",
        });
      },
    );
    await t.test(
      "product snapshot requires children and contract-compatible missing values",
      async () => {
        await assert.rejects(
          transaction(admin, async () => {
            await product(admin, scopeA, "missing-cost", null);
            await admin.query(
              'UPDATE commerce."ProductListing" SET "qualityState"=$1,"qualityIssues"=$2 WHERE "externalProductId"=$3',
              ["COMPLETE", [], "missing-cost"],
            );
          }),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(admin, async () => {
            await product(admin, scopeA, "no-sku");
            await admin.query('DELETE FROM commerce."SkuListing" WHERE "externalProductId"=$1', [
              "no-sku",
            ]);
          }),
          { code: "23514" },
        );
        await assert.rejects(
          transaction(admin, () => product(admin, scopeA, "no-category", 1, null)),
          { code: "23514" },
        );
      },
    );
    await t.test(
      "bounds, duplicate attributes and quality issues cannot bypass typed storage",
      async () => {
        for (const [column, value] of [
          ["salePriceMinor", "9007199254740992"],
          ["costPriceMinor", "-1"],
        ])
          await assert.rejects(
            admin.query(`UPDATE commerce."SkuListing" SET "${column}"=$1 WHERE "scopeId"=$2`, [
              value,
              scopeA,
            ]),
            { code: "23514" },
          );
        await assert.rejects(
          admin.query('UPDATE commerce."SkuListing" SET attributes=$1 WHERE "scopeId"=$2', [
            JSON.stringify([
              { name: "颜色", value: "黑" },
              { name: "颜色", value: "白" },
            ]),
            scopeA,
          ]),
          { code: "23514" },
        );
        await assert.rejects(
          admin.query(
            'UPDATE commerce."ProductListing" SET "qualityIssues"=$1 WHERE "scopeId"=$2',
            [["COST_MISSING", "COST_MISSING"], scopeA],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          admin.query('UPDATE commerce."ProductListing" SET title=$1 WHERE "scopeId"=$2', [
            "x".repeat(201),
            scopeA,
          ]),
          { code: "23514" },
        );
      },
    );
    await t.test(
      "workers have no listing writes and SET ROLE cannot impersonate a reader",
      async () => {
        const worker = new pg.Client({
          connectionString: loginUrl(url.toString(), "source_worker_login"),
        });
        await worker.connect();
        try {
          await assert.rejects(
            worker.query("INSERT INTO commerce.\"ProductListing\" (title) VALUES ('forged')"),
            { code: "42501" },
          );
          await reader.query("SET ROLE shopmate_commerce_reader");
          assert.equal((await reader.query('SELECT * FROM commerce."ProductListing"')).rowCount, 0);
        } finally {
          await reader.query("RESET ROLE");
          await worker.end();
        }
      },
    );
    await t.test("UTF-16 budgets and canonical text match Connector field limits", async () => {
      const { ConnectorProductSchema } = await import("../../../contracts/dist/index.js");
      const payload = {
        externalStoreId: "mock/store.a",
        externalProductId: "unicode",
        title: "😀".repeat(100),
        description: null,
        category: "category",
        brand: null,
        status: "ACTIVE",
        source: {
          version: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          quality: { state: "COMPLETE", issues: [] },
        },
        skus: [
          {
            externalSkuId: "sku-unicode",
            externalProductId: "unicode",
            attributes: [],
            salePriceMinor: 1,
            costPriceMinor: 1,
            originalPriceMinor: null,
            status: "ACTIVE",
          },
        ],
      };
      assert.equal(ConnectorProductSchema.safeParse(payload).success, true);
      await admin.query('UPDATE commerce."ProductListing" SET title=$1 WHERE "scopeId"=$2', [
        payload.title,
        scopeA,
      ]);
      for (const title of ["😀".repeat(101), " title", "title\r", "e\u0301"]) {
        await assert.rejects(
          admin.query('UPDATE commerce."ProductListing" SET title=$1 WHERE "scopeId"=$2', [
            title,
            scopeA,
          ]),
          { code: "23514" },
        );
      }
      await assert.rejects(
        admin.query('UPDATE commerce."SkuListing" SET attributes=$1 WHERE "scopeId"=$2', [
          JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ name: String(i), value: "v" }))),
          scopeA,
        ]),
        { code: "23514" },
      );
    });
    await t.test("whole-snapshot count accepts 500 SKUs and rolls back the 501st", async () => {
      await transaction(admin, async () => {
        await product(admin, scopeB, "large");
        await admin.query(
          'INSERT INTO commerce."SkuListing" ("scopeId","organizationId","workspaceId","storeId","externalSkuId","externalProductId",attributes,"salePriceMinor","costPriceMinor",status) SELECT "scopeId","organizationId","workspaceId","storeId",\'large-\'||n,\'large\',\'[]\'::jsonb,1,1,\'ACTIVE\' FROM commerce."ProductListing" CROSS JOIN generate_series(1,499) n WHERE "scopeId"=$1 AND "externalProductId"=\'large\'',
          [scopeB],
        );
      });
      await assert.rejects(
        admin.query(
          'INSERT INTO commerce."SkuListing" SELECT "scopeId","organizationId","workspaceId","storeId",\'too-many\',"externalProductId",attributes,"salePriceMinor","costPriceMinor","originalPriceMinor",status FROM commerce."SkuListing" WHERE "scopeId"=$1 AND "externalSkuId"=\'sku-large\'',
          [scopeB],
        ),
        { code: "23514" },
      );
      assert.equal(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM commerce."SkuListing" WHERE "scopeId"=$1 AND "externalProductId"=\'large\'',
            [scopeB],
          )
        ).rows[0].n,
        500,
      );
    });
    await t.test(
      "snapshot isolation cannot hide concurrent child changes from deferred checks",
      async () => {
        await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        try {
          await admin.query(
            'UPDATE commerce."ProductListing" SET title=\'new title\' WHERE "scopeId"=$1',
            [scopeA],
          );
          await assert.rejects(admin.query("COMMIT"), { code: "23514" });
        } finally {
          await admin.query("ROLLBACK");
        }
      },
    );
    await t.test(
      "unassigned workspaces are hidden while owners can read generic non-demo listings",
      async () => {
        await admin.query(
          "INSERT INTO \"Store\" (id,\"merchantId\",name,city,platform,\"organizationId\",\"workspaceId\") VALUES ('canonical-store','source-merchant-a','store','Shanghai','MOCK',$1,'source-unassigned')",
          [scopeFor().organizationId],
        );
        await admin.query(
          'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES (\'canonical-connection\',$1,\'source-unassigned\',\'canonical-store\',\'canonical-external\')',
          [scopeFor().organizationId],
        );
        await admin.query(
          "INSERT INTO commerce.\"SourceScope\" (id,\"organizationId\",\"workspaceId\",\"storeId\",\"connectionId\",\"externalStoreId\",provider,generation) VALUES ('33333333-3333-4333-8333-333333333333',$1,'source-unassigned','canonical-store','canonical-connection','canonical-external','MOCK',0)",
          [scopeFor().organizationId],
        );
        await transaction(admin, () => product(admin, "33333333-3333-4333-8333-333333333333"));
        await identity(reader, "source-viewer");
        assert.equal(
          (
            await reader.query(
              'SELECT * FROM commerce."ProductListing" WHERE "storeId"=\'canonical-store\'',
            )
          ).rowCount,
          0,
        );
        await identity(reader, "source-human");
        assert.equal(
          (
            await reader.query(
              'SELECT * FROM commerce."ProductListing" WHERE "storeId"=\'canonical-store\'',
            )
          ).rowCount,
          1,
        );
        await identity(reader, "source-viewer");
      },
    );
    await t.test("membership revocation and reset hide retained historical facts", async () => {
      await admin.query(
        'UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2 AND "workspaceId"=$3',
        ["INACTIVE", "source-viewer", scopeFor().workspaceId],
      );
      assert.equal((await reader.query('SELECT * FROM commerce."SkuListing"')).rowCount, 0);
      await identity(reader, "source-human");
      assert.equal(
        (await reader.query('SELECT * FROM commerce."ProductListing" WHERE "scopeId"=$1', [scopeA]))
          .rowCount,
        1,
      );
      await operatorControl(admin, 'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
        scopeFor().connectionId,
      ]);
      assert.equal(
        (await reader.query('SELECT * FROM commerce."ProductListing" WHERE "scopeId"=$1', [scopeA]))
          .rowCount,
        0,
      );
      assert.equal(
        (await admin.query('SELECT * FROM commerce."ProductListing" WHERE "scopeId"=$1', [scopeA]))
          .rowCount,
        1,
      );
    });
    await t.test("Prisma schema matches the deployed typed storage", () => {
      const output = execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)),
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code",
          "--script",
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: { ...process.env, DATABASE_URL: url.toString() },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.match(output, /empty migration/u);
    });
    await t.test(
      "commerce owner membership fences sync workers and source credentials",
      async () => {
        await admin.query("CREATE ROLE canonical_owner NOLOGIN NOSUPERUSER NOBYPASSRLS");
        await admin.query(
          "CREATE FUNCTION commerce.owner_probe() RETURNS boolean LANGUAGE sql AS 'SELECT true'",
        );
        await admin.query("ALTER FUNCTION commerce.owner_probe() OWNER TO canonical_owner");
        await admin.query("CREATE ROLE canonical_sync_login LOGIN NOSUPERUSER NOBYPASSRLS");
        await admin.query("GRANT shopmate_sync_worker,canonical_owner TO canonical_sync_login");
        assert.equal(
          (await admin.query("SELECT sync_host.safe_login('canonical_sync_login') AS safe")).rows[0]
            .safe,
          false,
        );
      },
    );
    await t.test("commerce owners cannot authenticate through mock source ports", async () => {
      await admin.query("GRANT canonical_owner TO source_worker_login,source_read_login");
      const worker = source.createMockSourceWorker(sourceEnv(url.toString()));
      const sourceReader = source.createMockSourceReader(sourceEnv(url.toString()));
      try {
        await assert.rejects(worker.listGrants(), { code: "SOURCE_CREDENTIALS" });
        await assert.rejects(
          sourceReader.findPublication(
            { userId: "source-human", merchantId: "source-merchant-a" },
            scopeFor(),
          ),
          { code: "SOURCE_CREDENTIALS" },
        );
      } finally {
        await Promise.allSettled([worker.close(), sourceReader.close()]);
        await admin.query("REVOKE canonical_owner FROM source_worker_login,source_read_login");
      }
    });
  } finally {
    await Promise.allSettled([reader?.end(), admin.end(), operator.end()]);
    await server.stop();
  }
});
