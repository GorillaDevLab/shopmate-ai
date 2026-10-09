import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { isolatedPostgres, requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";
import {
  migrateSource,
  sourceFixtures,
  scopeFor,
  loginUrl,
} from "../helpers/mock-platform-fixture.mjs";
import { operatorControl } from "../helpers/mock-source-control-fixture.mjs";

const scopes = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const tables = ["RefundListing", "InventoryListing", "CampaignMetricListing"];
const keyFields = ["externalRefundId", "externalSkuId", "externalCampaignId"];
const factFields = [
  [
    "externalRefundId",
    "externalOrderId",
    "externalSkuId",
    "status",
    "requestedMinor",
    "succeededMinor",
    "requestedAt",
    "succeededAt",
    "currency",
  ],
  [
    "externalSkuId",
    "externalLocationId",
    "available",
    "reserved",
    "onHand",
    "safetyStock",
    "leadTimeDays",
  ],
  [
    "externalCampaignId",
    "date",
    "impressions",
    "clicks",
    "attributedOrders",
    "spendMinor",
    "attributedRevenueMinor",
    "currency",
  ],
];
function facts(kind, id = "fact") {
  return [
    [
      id,
      "unseen-order",
      null,
      "SUCCEEDED",
      100,
      90,
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "CNY",
    ],
    [id, "unseen-location", 3, 2, 5, null, null],
    [id, "2026-01-01", 100, 5, 2, 10, 90, "CNY"],
  ][kind];
}
async function insert(client, kind, scope = scopes[0], values = facts(kind), issues = []) {
  const fields = [
    ...factFields[kind],
    "sourceVersion",
    "sourceUpdatedAt",
    "sourcePayloadHash",
    "qualityState",
    "qualityIssues",
  ];
  const data = [
    ...values,
    null,
    "2026-01-01T00:00:00Z",
    "a".repeat(64),
    issues.length ? "PARTIAL" : "COMPLETE",
    issues,
  ];
  await client.query(
    `INSERT INTO commerce."${tables[kind]}" ("scopeId","organizationId","workspaceId","storeId",${fields.map((f) => `"${f}"`).join(",")}) SELECT id,"organizationId","workspaceId","storeId",${data.map((_, i) => `$${i + 2}`).join(",")} FROM commerce."SourceScope" WHERE id=$1`,
    [scope, ...data],
  );
}
async function invalid(client, kind, assignment, params = [], code = "23514") {
  await assert.rejects(
    client.query(
      `UPDATE commerce."${tables[kind]}" SET ${assignment} WHERE "scopeId"=$1 AND "${keyFields[kind]}"='fact'`,
      [scopes[0], ...params],
    ),
    { code },
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
async function fixture(client) {
  await migrateSource(client);
  await sourceFixtures(client);
  for (const [index, key] of ["a", "b", "a2"].entries()) {
    const scope = scopeFor(key);
    await client.query(
      'INSERT INTO commerce."SourceScope" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation) VALUES ($1,$2,$3,$4,$5,$6,\'MOCK\',0)',
      [
        scopes[index],
        scope.organizationId,
        scope.workspaceId,
        scope.storeId,
        scope.connectionId,
        scope.externalStoreId,
      ],
    );
  }
}
async function relations({ admin }) {
  for (const table of tables)
    assert.equal(
      (await admin.query("SELECT to_regclass($1) AS name", [`commerce."${table}"`])).rows[0].name,
      `commerce."${table}"`,
    );
  for (let kind = 0; kind < 3; kind++) for (const scope of scopes) await insert(admin, kind, scope);
}

async function refundStates({ admin }) {
  for (const status of [
    "REQUESTED",
    "APPROVED",
    "PROCESSING",
    "SUCCEEDED",
    "FAILED",
    "REJECTED",
    "CANCELLED",
  ]) {
    const values = facts(0, status);
    values[3] = status;
    if (status !== "SUCCEEDED") {
      values[5] = null;
      values[7] = null;
    }
    await insert(admin, 0, scopes[0], values);
  }
  const anomaly = facts(0, "anomaly");
  anomaly[3] = "FAILED";
  await insert(admin, 0, scopes[0], anomaly, ["SOURCE_INCONSISTENT"]);
  const unknown = facts(0, "unknown");
  unknown[5] = null;
  unknown[7] = null;
  await insert(admin, 0, scopes[0], unknown, ["REFUND_UNKNOWN"]);
  assert.equal(
    (
      await admin.query(
        'SELECT "succeededMinor" FROM commerce."RefundListing" WHERE "externalRefundId"=$1',
        ["unknown"],
      )
    ).rows[0].succeededMinor,
    null,
  );
}

async function unknownFacts({ admin }) {
  await insert(
    admin,
    1,
    scopes[0],
    ["unknown", "location", null, null, null, null, null],
    ["INVENTORY_UNKNOWN", "SOURCE_TIME_MISSING"],
  );
  await insert(
    admin,
    2,
    scopes[0],
    ["unknown", "2026-01-01", null, null, null, null, null, "CNY"],
    ["MARKETING_UNKNOWN", "SOURCE_TIME_MISSING"],
  );
  for (const kind of [1, 2]) {
    await admin.query(
      `UPDATE commerce."${tables[kind]}" SET "sourceUpdatedAt"=NULL WHERE "${keyFields[kind]}"=$1`,
      ["unknown"],
    );
    const row = (
      await admin.query(`SELECT * FROM commerce."${tables[kind]}" WHERE "${keyFields[kind]}"=$1`, [
        "unknown",
      ])
    ).rows[0];
    for (const name of kind === 1
      ? ["available", "reserved", "onHand", "safetyStock", "leadTimeDays"]
      : ["impressions", "clicks", "attributedOrders", "spendMinor", "attributedRevenueMinor"])
      assert.equal(row[name], null);
    assert.equal(row.sourceUpdatedAt, null);
    assert.equal(row.sourceVersion, null);
  }
  // Campaign metrics deliberately do not impose click/order funnel assumptions.
  await insert(admin, 2, scopes[0], ["anomaly", "2026-01-01", 0, 100, 100, 0, 100, "CNY"]);
}

async function refundConstraints({ admin }) {
  for (const assignment of [
    "status='BOGUS'",
    "currency='USD'",
    '"requestedMinor"=-1',
    '"requestedMinor"=9007199254740992',
    '"succeededMinor"=101',
    '"succeededMinor"=-1',
    '"succeededMinor"=NULL',
    '"succeededAt"=NULL',
    "\"succeededAt\"='2025-01-01Z'",
    "\"requestedAt\"='infinity'",
    "\"requestedAt\"='10000-01-01Z'",
    "status='FAILED'",
  ])
    await invalid(admin, 0, assignment);
  await invalid(
    admin,
    0,
    "status='FAILED',\"qualityState\"='PARTIAL',\"qualityIssues\"=ARRAY['REFUND_UNKNOWN']",
  );
  await invalid(
    admin,
    0,
    '"succeededMinor"=101,"qualityState"=\'PARTIAL\',"qualityIssues"=ARRAY[\'SOURCE_INCONSISTENT\']',
  );
}

async function inventoryConstraints({ admin }) {
  for (const assignment of [
    "available=-1",
    "reserved=9007199254740992",
    '"onHand"=4',
    'available=9007199254740991,reserved=9007199254740991,"onHand"=9007199254740991',
    "available=NULL",
    '"safetyStock"=-1',
    '"safetyStock"=9007199254740992',
    '"leadTimeDays"=-1',
    '"leadTimeDays"=366',
  ])
    await invalid(admin, 1, assignment);
  await invalid(
    admin,
    1,
    "available=5,\"qualityState\"='PARTIAL',\"qualityIssues\"=ARRAY['SOURCE_INCONSISTENT']",
  );
  await insert(admin, 1, scopes[0], [
    "max",
    "loc",
    9007199254740991n,
    0,
    9007199254740991n,
    9007199254740991n,
    365,
  ]);
  await insert(
    admin,
    1,
    scopes[0],
    ["partial", "loc", null, 9007199254740991n, 0, 0, 0],
    ["INVENTORY_UNKNOWN"],
  );
}

async function marketingConstraints({ admin }) {
  for (const name of [
    "impressions",
    "clicks",
    "attributedOrders",
    "spendMinor",
    "attributedRevenueMinor",
  ])
    for (const value of ["NULL", "-1", "9007199254740992"])
      await invalid(admin, 2, `"${name}"=${value}`);
  for (const value of ["infinity", "10000-01-01", "0001-01-01 BC"])
    await invalid(admin, 2, "date=$2::date", [value]);
  await invalid(admin, 2, "currency='USD'");
  for (const date of ["0001-01-01", "9999-12-31", "2024-02-29"])
    await insert(admin, 2, scopes[0], [
      "calendar",
      date,
      9007199254740991n,
      9007199254740991n,
      0,
      9007199254740991n,
      0,
      "CNY",
    ]);
  await assert.rejects(
    insert(admin, 2, scopes[0], ["calendar", "2023-02-29", 0, 0, 0, 0, 0, "CNY"]),
    { code: "22008" },
  );
}

async function metadataAndIdentity({ admin }) {
  for (let kind = 0; kind < 3; kind++) {
    for (const assignment of [
      '"sourceUpdatedAt"=NULL',
      "\"sourceUpdatedAt\"='infinity'",
      "\"sourceUpdatedAt\"='10000-01-01Z'",
      "\"sourcePayloadHash\"='bad'",
      "\"qualityState\"='PARTIAL'",
      "\"qualityIssues\"=ARRAY['BAD']",
      "\"sourceVersion\"=' padded '",
    ])
      await invalid(admin, kind, assignment);
    await invalid(admin, kind, '"storeId"=$2', ["source-store-b"], "23503");
    for (const id of ["", " padded ", "bad\n", "😀".repeat(129)])
      await invalid(admin, kind, `"${keyFields[kind]}"=$2`, [id]);
    for (const id of ["é", "e\u0301", "😀".repeat(128)])
      await insert(admin, kind, scopes[0], facts(kind, id));
    await assert.rejects(insert(admin, kind), { code: "23505" });
  }
  await invalid(admin, 0, '"externalOrderId"=$2', ["😀".repeat(129)]);
  await invalid(admin, 0, '"externalSkuId"=$2', [" bad"]);
  await invalid(admin, 1, '"externalLocationId"=$2', [" bad"]);
  await insert(admin, 1, scopes[0], ["fact", "other-location", 0, 0, 0, 0, 0]);
  await insert(admin, 2, scopes[0], ["fact", "2026-01-02", 0, 0, 0, 0, 0, "CNY"]);
}

async function sourceQualityAndScope({ admin, reader }) {
  for (let kind = 0; kind < 3; kind++) {
    for (const assignment of [
      `"qualityState"='COMPLETE',"qualityIssues"=ARRAY['SOURCE_INCONSISTENT']`,
      `"qualityState"='PARTIAL',"qualityIssues"=ARRAY['SOURCE_INCONSISTENT','SOURCE_INCONSISTENT']`,
      `"qualityState"='PARTIAL',"qualityIssues"=ARRAY[NULL]::text[]`,
      `"organizationId"='legacy-org-source-merchant-b'`,
      `"workspaceId"='legacy-workspace-source-merchant-b'`,
      `"scopeId"='44444444-4444-4444-8444-444444444444'`,
    ])
      await invalid(
        admin,
        kind,
        assignment,
        [],
        assignment.includes("quality") ? "23514" : "23503",
      );
    await admin.query(
      `UPDATE commerce."${tables[kind]}" SET "sourceVersion"=$1 WHERE "scopeId"=$2`,
      ["😀".repeat(128), scopes[0]],
    );
    await invalid(admin, kind, '"sourceVersion"=$2', ["😀".repeat(129)]);
    await preservedMetadata(admin, kind);
    await assert.rejects(
      reader.query("SELECT commerce.valid_quality('COMPLETE',ARRAY[]::text[])"),
      { code: "42501" },
    );
    await admin.query(
      `UPDATE commerce."${tables[kind]}" SET "sourceVersion"=NULL WHERE "scopeId"=$1`,
      [scopes[0]],
    );
  }
}
async function preservedMetadata(admin, kind) {
  const row = (
    await admin.query(
      `SELECT "sourceVersion","sourcePayloadHash","qualityState","qualityIssues" FROM commerce."${tables[kind]}" WHERE "scopeId"=$1 AND "${keyFields[kind]}"=$2`,
      [scopes[0], "fact"],
    )
  ).rows[0];
  assert.deepEqual(row, {
    sourceVersion: "😀".repeat(128),
    sourcePayloadHash: "a".repeat(64),
    qualityState: "COMPLETE",
    qualityIssues: [],
  });
}
async function literalIdentityCatalog({ admin }) {
  for (let kind = 0; kind < 3; kind++) {
    const columns = factFields[kind].filter((name) => name.startsWith("external"));
    const rows = (
      await admin.query(
        "SELECT a.attname,c.collname FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation WHERE a.attrelid=$1::regclass AND a.attname=ANY($2) ORDER BY a.attname",
        [`commerce."${tables[kind]}"`, columns],
      )
    ).rows;
    assert.equal(rows.length, columns.length);
    assert.ok(rows.every((row) => row.collname === "C"));
    assert.equal(
      (
        await admin.query(
          `SELECT * FROM commerce."${tables[kind]}" WHERE "scopeId"=$1 AND "${keyFields[kind]}"=ANY($2)`,
          [scopes[0], ["é", "e\u0301"]],
        )
      ).rowCount,
      2,
    );
  }
}
async function workerWriteDenial({ admin, url }) {
  await admin.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='facts_sync_login') THEN CREATE ROLE facts_sync_login LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await admin.query("GRANT shopmate_sync_worker TO facts_sync_login");
  const worker = new pg.Client({ connectionString: loginUrl(url.toString(), "facts_sync_login") });
  await worker.connect();
  try {
    for (const table of tables)
      for (const operation of [
        `DELETE FROM commerce."${table}"`,
        `UPDATE commerce."${table}" SET "sourceVersion"='forged'`,
        `INSERT INTO commerce."${table}" SELECT * FROM commerce."${table}"`,
      ])
        await assert.rejects(worker.query(operation), { code: "42501" });
    await assert.rejects(
      worker.query("SELECT commerce.valid_quality('COMPLETE',ARRAY[]::text[])"),
      { code: "42501" },
    );
  } finally {
    await worker.end();
  }
}
async function timestampBounds({ admin }) {
  const values = facts(0, "timestamp-boundary");
  values[4] = 9007199254740991n;
  values[5] = 9007199254740991n;
  values[6] = "0001-01-01T00:00:00Z";
  values[7] = "9999-12-31T23:59:59.999Z";
  values[2] = "unseen-sku";
  await insert(admin, 0, scopes[0], values);
  for (let kind = 0; kind < 3; kind++)
    for (const value of ["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"]) {
      await admin.query(
        `UPDATE commerce."${tables[kind]}" SET "sourceUpdatedAt"=$1 WHERE "scopeId"=$2 AND "${keyFields[kind]}"=$3`,
        [value, scopes[0], "fact"],
      );
    }
}
async function atomicRollback({ admin }) {
  await assert.rejects(
    transaction(admin, async () => {
      await admin.query(
        'UPDATE commerce."RefundListing" SET "sourceVersion"=$1 WHERE "externalRefundId"=$2',
        ["changed", "fact"],
      );
      await admin.query(
        'UPDATE commerce."InventoryListing" SET available=9007199254740991,reserved=9007199254740991',
      );
    }),
    { code: "23514" },
  );
  assert.equal(
    (
      await admin.query(
        'SELECT "sourceVersion" FROM commerce."RefundListing" WHERE "scopeId"=$1 AND "externalRefundId"=$2',
        [scopes[0], "fact"],
      )
    ).rows[0].sourceVersion,
    null,
  );
}
async function readerBoundaries({ admin, reader }) {
  await reader.query(
    "SELECT set_config('app.user_id','source-viewer',false),set_config('app.merchant_id','source-merchant-a',false)",
  );
  for (const table of tables) {
    assert.deepEqual(
      (
        await reader.query(`SELECT DISTINCT "scopeId" FROM commerce."${table}" ORDER BY "scopeId"`)
      ).rows.map((row) => row.scopeId),
      [scopes[0], scopes[2]],
    );
    for (const operation of [
      `DELETE FROM commerce."${table}"`,
      `UPDATE commerce."${table}" SET "sourceVersion"='x'`,
      `INSERT INTO commerce."${table}" SELECT * FROM commerce."${table}"`,
    ])
      await assert.rejects(reader.query(operation), { code: "42501" });
    const flags = (
      await admin.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
        [`commerce."${table}"`],
      )
    ).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
  }
}

async function roleAndForeignScope({ reader, url }) {
  await reader.query("SET ROLE shopmate_commerce_reader");
  for (const table of tables)
    assert.equal((await reader.query(`SELECT * FROM commerce."${table}"`)).rowCount, 0);
  await reader.query("RESET ROLE");
  await reader.query("SELECT set_config('app.merchant_id','source-merchant-b',false)");
  for (const table of tables)
    assert.deepEqual(
      (await reader.query(`SELECT DISTINCT "scopeId" FROM commerce."${table}"`)).rows.map(
        (row) => row.scopeId,
      ),
      [scopes[1]],
    );
  await reader.query("SELECT set_config('app.user_id','',false)");
  for (const table of tables)
    assert.equal((await reader.query(`SELECT * FROM commerce."${table}"`)).rowCount, 0);
  const worker = new pg.Client({
    connectionString: loginUrl(url.toString(), "source_worker_login"),
  });
  await worker.connect();
  try {
    for (const table of tables)
      await assert.rejects(worker.query(`DELETE FROM commerce."${table}"`), {
        code: "42501",
      });
  } finally {
    await worker.end();
  }
}

async function revocationAndReset({ admin, reader }) {
  await reader.query(
    "SELECT set_config('app.user_id','source-viewer',false),set_config('app.merchant_id','source-merchant-a',false)",
  );
  await admin.query(
    'UPDATE "WorkspaceMember" SET status=\'INACTIVE\' WHERE "userId"=$1 AND "workspaceId"=$2',
    ["source-viewer", scopeFor().workspaceId],
  );
  for (const table of tables)
    assert.equal((await reader.query(`SELECT * FROM commerce."${table}"`)).rowCount, 0);
  await reader.query("SELECT set_config('app.user_id','source-human',false)");
  await operatorControl(admin, 'UPDATE "PlatformConnection" SET generation=1 WHERE id=$1', [
    scopeFor().connectionId,
  ]);
  for (const table of tables) {
    assert.equal(
      (await reader.query(`SELECT * FROM commerce."${table}" WHERE "scopeId"=$1`, [scopes[0]]))
        .rowCount,
      0,
    );
    assert.ok(
      (await admin.query(`SELECT * FROM commerce."${table}" WHERE "scopeId"=$1`, [scopes[0]]))
        .rowCount > 0,
    );
  }
}

async function inactiveConnection({ admin, reader }) {
  await reader.query(
    "SELECT set_config('app.user_id','source-human',false),set_config('app.merchant_id','source-merchant-a',false)",
  );
  await operatorControl(
    admin,
    "UPDATE \"PlatformConnection\" SET status='DISCONNECTED' WHERE id=$1",
    [scopeFor().connectionId],
  );
  for (const table of tables)
    assert.equal(
      (await reader.query(`SELECT * FROM commerce."${table}" WHERE "scopeId"=$1`, [scopes[0]]))
        .rowCount,
      0,
    );
  await operatorControl(admin, "UPDATE \"PlatformConnection\" SET status='ACTIVE' WHERE id=$1", [
    scopeFor().connectionId,
  ]);
  for (const table of tables)
    assert.ok(
      (await reader.query(`SELECT * FROM commerce."${table}" WHERE "scopeId"=$1`, [scopes[0]]))
        .rowCount > 0,
    );
}

async function prismaDrift({ url }) {
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
}
async function openDatabase() {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_facts";
  requireIsolatedDatabaseUrl(url.toString());
  const admin = new pg.Client({ connectionString: url.toString() });
  const context = { server, operator, url, admin, reader: undefined, created: false };
  try {
    await operator.connect();
    await operator.query('CREATE DATABASE "shopmate_tenant_test_facts"');
    context.created = true;
    await admin.connect();
    await fixture(admin);
    await admin.query("GRANT shopmate_commerce_reader TO source_read_login");
    context.reader = new pg.Client({
      connectionString: loginUrl(url.toString(), "source_read_login"),
    });
    await context.reader.connect();
    return context;
  } catch (error) {
    await closeDatabase(context);
    throw error;
  }
}
async function closeDatabase({ admin, reader, created, url, operator, server }) {
  await Promise.allSettled([reader?.end(), admin.end()]);
  try {
    if (created) {
      requireIsolatedDatabaseUrl(url.toString());
      await operator.query('DROP DATABASE IF EXISTS "shopmate_tenant_test_facts"');
    }
  } finally {
    await operator.end();
    await server.stop();
  }
}
test("canonical refund inventory marketing preserve typed facts and current tenant authority", async (t) => {
  const context = await openDatabase();
  try {
    for (const [name, check] of [
      ["all three normalized relations exist", relations],
      ["all refund statuses and independent business references are accepted", refundStates],
      ["nullable inventories and marketing metrics remain unknown", unknownFacts],
      [
        "refund chronology amount and anomaly quality constraints match contract",
        refundConstraints,
      ],
      [
        "inventory conservation safe bounds and nullable knowledge are enforced",
        inventoryConstraints,
      ],
      ["marketing date currency and all safe numeric bounds are enforced", marketingConstraints],
      [
        "all source metadata ownership and literal UTF16 identifiers are validated",
        metadataAndIdentity,
      ],
      ["quality metadata and compound scope foreign keys are exact", sourceQualityAndScope],
      ["literal identifiers use C collation", literalIdentityCatalog],
      ["safe maximum and year boundaries are accepted", timestampBounds],
      ["sync worker has no direct writes or internal function execution", workerWriteDenial],
      ["invalid facts roll back prior changes atomically", atomicRollback],
      [
        "FORCE RLS restricts tenants sessions current grants and direct privileges",
        readerBoundaries,
      ],
      ["SQL session role and foreign tenant scope are isolated", roleAndForeignScope],
      ["disconnected connections hide current canonical facts", inactiveConnection],
      ["membership revocation and connection reset hide historical facts", revocationAndReset],
      ["Prisma migration diff is empty", prismaDrift],
    ])
      await t.test(name, () => check(context));
  } finally {
    await closeDatabase(context);
  }
});
