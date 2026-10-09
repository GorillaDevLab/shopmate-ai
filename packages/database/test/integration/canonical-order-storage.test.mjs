import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";
import { isolatedPostgres, requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  scopeFor,
  loginUrl,
} from "../helpers/mock-platform-fixture.mjs";

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const scopeA2 = "33333333-3333-4333-8333-333333333333";
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
async function order(client, scope, id = "order", status = "PAID", issues = []) {
  await client.query(
    'INSERT INTO commerce."OrderListing" ("scopeId","organizationId","workspaceId","storeId","externalOrderId",status,"orderedAt","paidAt",currency,"grossMinor","discountMinor","shippingMinor","payableMinor","paidMinor","refundedMinor","sourceUpdatedAt","sourcePayloadHash","qualityState","qualityIssues") SELECT id,"organizationId","workspaceId","storeId",$2,$3,\'2026-01-01Z\', $4::timestamptz,\'CNY\',100,10,5,95,$5,0,\'2026-01-01Z\',$6,$7,$8 FROM commerce."SourceScope" WHERE id=$1',
    [
      scope,
      id,
      status,
      status === "PENDING_PAYMENT" ? null : "2026-01-02Z",
      status === "PENDING_PAYMENT" ? 0 : 95,
      "a".repeat(64),
      issues.length ? "PARTIAL" : "COMPLETE",
      issues,
    ],
  );
  await line(client, scope, id, "line", 100, 10);
}
async function line(client, scope, id, lineId, gross, discount = 0) {
  await client.query(
    'INSERT INTO commerce."OrderLineListing" ("scopeId","organizationId","workspaceId","storeId","externalOrderId","externalLineId","externalProductId","externalSkuId",quantity,"unitPriceMinor","grossMinor","discountMinor","netMinor") SELECT id,"organizationId","workspaceId","storeId",$2,$3,\'not-yet-synced-product\',\'not-yet-synced-sku\',1,$4,$4,$5,$4::bigint-$5::bigint FROM commerce."SourceScope" WHERE id=$1',
    [scope, id, lineId, gross, discount],
  );
}
test("canonical order storage preserves complete typed snapshots and tenant access", async (t) => {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_orders";
  requireIsolatedDatabaseUrl(url.toString());
  const admin = new pg.Client({ connectionString: url.toString() });
  let reader;
  let databaseCreated = false;
  try {
    await operator.connect();
    await operator.query('CREATE DATABASE "shopmate_tenant_test_orders"');
    databaseCreated = true;
    await admin.connect();
    await migrateSource(admin);
    await sourceFixtures(admin);
    assert.equal(
      (await admin.query("SELECT to_regclass('commerce.\"OrderListing\"') AS table")).rows[0].table,
      'commerce."OrderListing"',
    );
    for (const [id, key] of [
      [scopeA, "a"],
      [scopeB, "b"],
      [scopeA2, "a2"],
    ]) {
      const scope = scopeFor(key);
      await admin.query(
        'INSERT INTO commerce."SourceScope" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation) VALUES ($1,$2,$3,$4,$5,$6,\'MOCK\',0)',
        [
          id,
          scope.organizationId,
          scope.workspaceId,
          scope.storeId,
          scope.connectionId,
          scope.externalStoreId,
        ],
      );
      await transaction(admin, () => order(admin, id));
    }
    await t.test("all six statuses and explicit unknown/provider anomalies survive", async () => {
      for (const status of [
        "PENDING_PAYMENT",
        "PAID",
        "FULFILLED",
        "COMPLETED",
        "CANCELLED",
        "CLOSED",
      ])
        await transaction(admin, () => order(admin, scopeA, status, status));
      await transaction(admin, async () => {
        await order(admin, scopeA, "unknown", "PAID", [
          "PAYMENT_UNKNOWN",
          "REFUND_UNKNOWN",
          "SOURCE_TIME_MISSING",
        ]);
        await admin.query(
          'UPDATE commerce."OrderListing" SET "paidMinor"=NULL,"refundedMinor"=NULL,"paidAt"=NULL,"sourceUpdatedAt"=NULL WHERE "externalOrderId"=\'unknown\'',
        );
      });
      await transaction(admin, async () => {
        await order(admin, scopeA, "anomaly", "PENDING_PAYMENT", ["SOURCE_INCONSISTENT"]);
        await admin.query(
          'UPDATE commerce."OrderListing" SET "paidMinor"=1,"paidAt"=\'2026-01-02Z\' WHERE "externalOrderId"=\'anomaly\'',
        );
      });
      const row = (
        await admin.query(
          'SELECT "paidMinor","refundedMinor","paidAt","sourceVersion","sourceUpdatedAt" FROM commerce."OrderListing" WHERE "externalOrderId"=\'unknown\'',
        )
      ).rows[0];
      assert.deepEqual(row, {
        paidMinor: null,
        refundedMinor: null,
        paidAt: null,
        sourceVersion: null,
        sourceUpdatedAt: null,
      });
    });
    await t.test(
      "row economics, safe bounds, identifiers, quality and dates reject invalid facts",
      async () => {
        for (const assignment of [
          '"paidMinor"=96',
          '"refundedMinor"=96',
          '"payableMinor"=94',
          '"grossMinor"=99',
          '"discountMinor"=101',
          '"shippingMinor"=-1',
          '"paidMinor"=NULL',
          '"sourceUpdatedAt"=NULL',
          '"paidAt"=NULL',
          "\"paidAt\"='2025-01-01Z'",
          "\"orderedAt\"='infinity'",
          "\"sourceUpdatedAt\"='10000-01-01Z'",
          "currency='USD'",
          "status='BOGUS'",
          "\"qualityIssues\"=ARRAY['BAD']",
          "\"qualityState\"='PARTIAL'",
          "\"externalOrderId\"=' trailing '",
        ])
          await assert.rejects(
            admin.query(
              `UPDATE commerce."OrderListing" SET ${assignment} WHERE "scopeId"=$1 AND "externalOrderId"='order'`,
              [scopeA],
            ),
            { code: "23514" },
          );
        for (const assignment of [
          "quantity=0",
          "quantity=9007199254740992",
          '"unitPriceMinor"=9007199254740992',
          'quantity=9007199254740991,"unitPriceMinor"=2',
          '"grossMinor"=99',
          '"discountMinor"=101',
          '"netMinor"=89',
          "\"externalSkuId\"='bad\n'",
        ])
          await assert.rejects(
            admin.query(`UPDATE commerce."OrderLineListing" SET ${assignment} WHERE "scopeId"=$1`, [
              scopeA,
            ]),
            { code: "23514" },
          );
      },
    );
    await t.test("snapshot presence, sums, foreign ownership and atomic replacement", async () => {
      await assert.rejects(
        admin.query(
          'DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'order\'',
          [scopeA],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        admin.query(
          'UPDATE commerce."OrderLineListing" SET "storeId"=\'source-store-b\' WHERE "scopeId"=$1',
          [scopeA],
        ),
        { code: "23503" },
      );
      await assert.rejects(
        transaction(admin, () => line(admin, scopeA, "order", "extra", 1)),
        { code: "23514" },
      );
      await transaction(admin, async () => {
        await admin.query(
          'DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'order\'',
          [scopeA],
        );
        await line(admin, scopeA, "order", "replacement", 100, 10);
      });
      await assert.rejects(
        transaction(admin, async () => {
          await admin.query(
            'DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'order\'',
            [scopeA],
          );
          await line(admin, scopeA, "order", "bad", 99, 10);
        }),
        { code: "23514" },
      );
      assert.equal(
        (
          await admin.query(
            'SELECT "externalLineId" FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'order\'',
            [scopeA],
          )
        ).rows[0].externalLineId,
        "replacement",
      );
    });
    await t.test(
      "500 lines accepted; duplicate, 501st, aggregate overflow and snapshot isolation rejected",
      async () => {
        await transaction(admin, async () => {
          await order(admin, scopeB, "large");
          await admin.query(
            'INSERT INTO commerce."OrderLineListing" SELECT "scopeId","organizationId","workspaceId","storeId","externalOrderId",\'zero-\'||n,"externalProductId","externalSkuId",1,0,0,0,0 FROM commerce."OrderLineListing" CROSS JOIN generate_series(1,499) n WHERE "scopeId"=$1 AND "externalOrderId"=\'large\'',
            [scopeB],
          );
        });
        await assert.rejects(line(admin, scopeB, "large", "501", 0), { code: "23514" });
        await assert.rejects(line(admin, scopeB, "large", "line", 0), { code: "23505" });
        await assert.rejects(
          transaction(admin, () => line(admin, scopeB, "large", "overflow", 9007199254740991n)),
          { code: "23514" },
        );
        await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await admin.query(
          'UPDATE commerce."OrderListing" SET "sourceVersion"=\'v2\' WHERE "scopeId"=$1',
          [scopeA],
        );
        await assert.rejects(admin.query("COMMIT"), { code: "23514" });
        await admin.query("ROLLBACK");
      },
    );
    await t.test(
      "concurrent partial child changes cannot evade final aggregate checks",
      async () => {
        await transaction(admin, async () => {
          await order(admin, scopeB, "race");
          await admin.query(
            'DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'race\'',
            [scopeB],
          );
          await line(admin, scopeB, "race", "one", 50, 5);
          await line(admin, scopeB, "race", "two", 50, 5);
        });
        const other = new pg.Client({ connectionString: url.toString() });
        await other.connect();
        try {
          await admin.query("BEGIN");
          await other.query("BEGIN");
          await admin.query(
            'DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'race\' AND "externalLineId"=\'one\'',
            [scopeB],
          );
          await other.query(
            'DELETE FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'race\' AND "externalLineId"=\'two\'',
            [scopeB],
          );
          const commits = await Promise.allSettled([admin.query("COMMIT"), other.query("COMMIT")]);
          assert.equal(
            commits.every(
              (result) => result.status === "rejected" && result.reason.code === "23514",
            ),
            true,
          );
          assert.equal(
            (
              await admin.query(
                'SELECT count(*)::int AS n FROM commerce."OrderLineListing" WHERE "scopeId"=$1 AND "externalOrderId"=\'race\'',
                [scopeB],
              )
            ).rows[0].n,
            2,
          );
        } finally {
          await Promise.allSettled([admin.query("ROLLBACK"), other.query("ROLLBACK")]);
          await other.end();
        }
      },
    );
    await t.test(
      "literal Unicode identifiers remain distinct without product synchronization",
      async () => {
        await transaction(admin, () => order(admin, scopeA, "é"));
        await transaction(admin, () => order(admin, scopeA, "e\u0301"));
        assert.equal(
          (
            await admin.query(
              'SELECT * FROM commerce."OrderListing" WHERE "externalOrderId"=ANY($1)',
              [["é", "e\u0301"]],
            )
          ).rowCount,
          2,
        );
      },
    );
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='order_read_login') THEN CREATE ROLE order_read_login LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
    );
    await admin.query("GRANT shopmate_commerce_reader TO order_read_login");
    reader = new pg.Client({ connectionString: loginUrl(url.toString(), "order_read_login") });
    await reader.connect();
    await t.test(
      "tenant and store scope isolation, direct writes and role impersonation",
      async () => {
        await reader.query(
          "SELECT set_config('app.user_id','source-viewer',false),set_config('app.merchant_id','source-merchant-a',false)",
        );
        assert.deepEqual(
          (
            await reader.query(
              'SELECT DISTINCT "scopeId" FROM commerce."OrderListing" ORDER BY "scopeId"',
            )
          ).rows.map((r) => r.scopeId),
          [scopeA, scopeA2],
        );
        await assert.rejects(reader.query('DELETE FROM commerce."OrderListing"'), {
          code: "42501",
        });
        await reader.query("SET ROLE shopmate_commerce_reader");
        assert.equal((await reader.query('SELECT * FROM commerce."OrderListing"')).rowCount, 0);
        await reader.query("RESET ROLE");
        await reader.query("SELECT set_config('app.user_id','',false)");
        assert.equal((await reader.query('SELECT * FROM commerce."OrderLineListing"')).rowCount, 0);
        const worker = new pg.Client({
          connectionString: loginUrl(url.toString(), "source_worker_login"),
        });
        await worker.connect();
        try {
          await assert.rejects(worker.query('DELETE FROM commerce."OrderLineListing"'), {
            code: "42501",
          });
        } finally {
          await worker.end();
        }
      },
    );
    await t.test(
      "revocation, inactive connections and generation reset hide historical facts",
      async () => {
        await reader.query("SELECT set_config('app.user_id','source-viewer',false)");
        await admin.query(
          'UPDATE "WorkspaceMember" SET status=\'INACTIVE\' WHERE "userId"=\'source-viewer\' AND "workspaceId"=$1',
          [scopeFor().workspaceId],
        );
        assert.equal((await reader.query('SELECT * FROM commerce."OrderListing"')).rowCount, 0);
        await reader.query("SELECT set_config('app.user_id','source-human',false)");
        await operatorControl(
          admin,
          "UPDATE \"PlatformConnection\" SET status='DISCONNECTED' WHERE id=$1",
          [scopeFor().connectionId],
        );
        assert.equal(
          (await reader.query('SELECT * FROM commerce."OrderListing" WHERE "scopeId"=$1', [scopeA]))
            .rowCount,
          0,
        );
        await operatorControl(
          admin,
          "UPDATE \"PlatformConnection\" SET status='ACTIVE',generation=1 WHERE id=$1",
          [scopeFor().connectionId],
        );
        assert.equal(
          (await reader.query('SELECT * FROM commerce."OrderListing" WHERE "scopeId"=$1', [scopeA]))
            .rowCount,
          0,
        );
        assert.ok(
          (await admin.query('SELECT * FROM commerce."OrderListing" WHERE "scopeId"=$1', [scopeA]))
            .rowCount > 0,
        );
      },
    );
    await t.test("Prisma models have no migration drift", () => {
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
  } finally {
    await Promise.allSettled([reader?.end(), admin.end()]);
    if (databaseCreated) {
      requireIsolatedDatabaseUrl(url.toString());
      await operator.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_orders"');
    }
    await operator.end();
    await server.stop();
  }
});
