import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Metric storage requires runner TEST_DATABASE_URL");
const serverUrl = requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
const migrationRoot = new URL("../../prisma/migrations/", import.meta.url);

async function withDatabase(action) {
  const operator = new pg.Client({ connectionString: serverUrl });
  await operator.connect();
  // Identifiers cannot bind; this disposable name is generated locally and validated.
  const name = `shopmate_tenant_test_${randomBytes(8).toString("hex")}`;
  assert.match(name, /^[a-z0-9_]+$/u);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  let client;
  let created = false;
  try {
    await operator.query(`CREATE DATABASE "${name}"`);
    created = true;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await action(client, url.toString());
  } finally {
    try {
      if (client) await client.end();
    } finally {
      try {
        if (created) await operator.query(`DROP DATABASE "${name}"`);
      } finally {
        await operator.end();
      }
    }
  }
}

async function migrate(client) {
  for (const name of (await readdir(migrationRoot)).filter((v) => /^\d{14}_/u.test(v)).sort())
    await client.query(await readFile(new URL(`${name}/migration.sql`, migrationRoot), "utf8"));
}

test("metric history has dedicated scoped definition and snapshot relations", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    const result = await client.query(
      "SELECT to_regclass('public.metric_definitions') AS definitions,to_regclass('public.metric_snapshots') AS snapshots",
    );
    assert.equal(result.rows[0].definitions, "metric_definitions");
    assert.equal(result.rows[0].snapshots, "metric_snapshots");
  });
});
const binding = {
  organizationId: "legacy-org-metric-a",
  workspaceId: "legacy-workspace-metric-a",
  storeId: "metric-store-a",
  connectionId: "metric-connection-a",
  externalStoreId: "metric/external.a",
};
const kinds = {
  minorCNY: [
    "GMV",
    "PAID_REVENUE",
    "AOV",
    "REFUND_SETTLED_AMOUNT",
    "COGS",
    "NET_REVENUE_SETTLEMENT",
    "NET_MERCHANDISE_REVENUE",
    "GROSS_PROFIT",
    "CONTRIBUTION",
    "ESTIMATED_NET_PROFIT",
    "PROFIT_DELTA",
  ],
  units: ["PAID_ORDERS", "PAID_UNITS", "REFUNDED_COHORT_ORDERS", "INVENTORY_AVAILABLE"],
  basisPoints: [
    "REFUND_COHORT_ORDER_RATE",
    "REFUND_COHORT_AMOUNT_RATE",
    "CONVERSION_RATE",
    "CART_RATE",
    "CHECKOUT_RATE",
    "ROAS",
  ],
  hours: ["INVENTORY_HOURS_REMAINING", "LEAD_TIME_HOURS"],
};
const digest = `sha256:${"a".repeat(64)}`;
const issue = { code: "LOW_SAMPLE", field: "paymentFacts", evidenceIds: ["source/raw:1"] };
function snapshot(overrides = {}) {
  return {
    ...binding,
    key: "GMV",
    definitionVersion: "v1",
    schemaVersion: 1,
    hashVersion: "metric-input-sha256-v1",
    inputRevision: randomBytes(8).toString("hex"),
    inputHash: digest,
    subjectKind: "STORE",
    subjectId: "",
    timezone: "Asia/Shanghai",
    currency: "CNY",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-01-02T00:00:00.000Z",
    visibleAt: "2026-01-02T01:00:00.000Z",
    sourceWatermark: "2026-01-02T00:00:00.000Z",
    computedAt: "2026-01-02T02:00:00.000Z",
    sampleSize: 0,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    evidenceIds: ["source/raw:1"],
    issues: [],
    valueMinor: 0,
    ...overrides,
  };
}
function insert(client, table, row) {
  assert.ok(["metric_definitions", "metric_snapshots"].includes(table));
  const keys = Object.keys(row);
  // Identifiers cannot bind; allow only locally constructed test column names.
  keys.forEach((key) => assert.match(key, /^[A-Za-z][A-Za-z0-9]*$/u));
  const columns = keys.map((key) => `"${key}"`).join(",");
  const values = keys.map((key) => (key === "issues" ? JSON.stringify(row[key]) : row[key]));
  return client.query(
    `INSERT INTO public.${table} (${columns}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    values,
  );
}
function definition(client, overrides = {}) {
  return insert(client, "metric_definitions", {
    ...binding,
    key: "GMV",
    definitionVersion: "v1",
    unit: "minorCNY",
    definitionHash: digest,
    ...overrides,
  });
}
async function fixture(client) {
  for (const key of ["a", "b"]) {
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`metric-${key}`],
    );
    await client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      [`metric-store-${key}`, `metric-${key}`, "Shanghai", "MOCK"],
    );
    await client.query(
      'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId",status) VALUES ($1,$2,$3,$4,$5,\'DISCONNECTED\')',
      [
        `metric-connection-${key}`,
        `legacy-org-metric-${key}`,
        `legacy-workspace-metric-${key}`,
        `metric-store-${key}`,
        `metric/external.${key}`,
      ],
    );
  }
  for (const [user, role] of [
    ["metric-owner", "OWNER"],
    ["metric-admin", "ADMIN"],
    ["metric-viewer", "VIEWER"],
  ]) {
    await client.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      [`membership-${user}`, binding.organizationId, user, role],
    );
  }
  await client.query(
    'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
    ["metric-assignment", binding.organizationId, binding.workspaceId, "metric-viewer"],
  );
  for (const [unit, keys] of Object.entries(kinds))
    for (const key of keys) await definition(client, { key, unit });
}
const invalidRows = [
  ["unsafe integer money", { valueMinor: "9007199254740992" }],
  ["negative gross sales", { valueMinor: -1 }],
  ["missing available value", { valueMinor: null }],
  ["multiple unit values", { valueUnits: 1 }],
  ["money cannot use hours", { valueMinor: null, valueHours: 1.5 }],
  [
    "probability upper bound",
    { key: "CONVERSION_RATE", valueMinor: null, valueBasisPoints: 10001 },
  ],
  ["negative units", { key: "PAID_UNITS", valueMinor: null, valueUnits: -1 }],
  ["unsafe units", { key: "PAID_UNITS", valueMinor: null, valueUnits: "9007199254740992" }],
  ["nonfinite hours", { key: "LEAD_TIME_HOURS", valueMinor: null, valueHours: "NaN" }],
  ["infinite hours", { key: "LEAD_TIME_HOURS", valueMinor: null, valueHours: "Infinity" }],
  ["negative hours", { key: "LEAD_TIME_HOURS", valueMinor: null, valueHours: -0.5 }],
  ["unsafe sample", { sampleSize: "9007199254740992" }],
  ["negative sample", { sampleSize: -1 }],
  ["coverage upper bound", { coverageBasisPoints: 10001 }],
  ["negative coverage", { coverageBasisPoints: -1 }],
  ["verified partial coverage", { coverageBasisPoints: 9999 }],
  ["verified issues", { issues: [issue] }],
  ["verified short watermark", { sourceWatermark: "2026-01-01T23:59:59.999Z" }],
  ["missing watermark", { sourceWatermark: null }],
  ["unavailable value", { status: "UNAVAILABLE", issues: [issue] }],
  [
    "unavailable missing issues",
    { status: "UNAVAILABLE", valueMinor: null, sourceWatermark: null },
  ],
  ["estimated missing issues", { status: "ESTIMATED" }],
  ["unknown status", { status: "UNKNOWN" }],
  ["bad schema version", { schemaVersion: 2 }],
  ["bad hash version", { hashVersion: "other" }],
  ["bad input hash", { inputHash: "sha256:ABC" }],
  ["unknown timezone", { timezone: "UTC" }],
  ["unknown currency", { currency: "USD" }],
  ["store sentinel", { subjectId: "unexpected" }],
  ["sku missing identifier", { subjectKind: "SKU" }],
  ["unknown subject", { subjectKind: "USER" }],
  ["empty period", { periodEnd: "2026-01-01T00:00:00.000Z" }],
  ["future period", { visibleAt: "2026-01-01T00:00:00.000Z" }],
  ["future watermark", { sourceWatermark: "2026-01-03T00:00:00.000Z" }],
  ["premature computation", { computedAt: "2026-01-01T00:00:00.000Z" }],
  ["infinite timestamp", { periodStart: "-infinity" }],
  ["timestamp outside public year", { computedAt: "10000-01-01T00:00:00Z" }],
];
async function rejectedRows(t, client) {
  for (const [name, row] of invalidRows)
    await t.test(`rejects ${name}`, () =>
      assert.rejects(insert(client, "metric_snapshots", snapshot(row)), { code: "23514" }),
    );
}
const invalidIssues = [
  null,
  {},
  [null],
  [{}],
  [{ ...issue, extra: true }],
  [{ ...issue, code: null }],
  [{ ...issue, code: "UNKNOWN" }],
  [{ ...issue, field: "" }],
  [{ ...issue, field: " x" }],
  [{ code: "LOW_SAMPLE", field: "x" }],
  [{ ...issue, evidenceIds: null }],
  [{ ...issue, evidenceIds: [] }],
  [{ ...issue, evidenceIds: ["foreign"] }],
  [{ ...issue, evidenceIds: ["source/raw:1", "source/raw:1"] }],
  [{ ...issue, field: 3 }],
  [{ ...issue, evidenceIds: [null] }],
  [{ ...issue, evidenceIds: "source/raw:1" }],
];
async function rejectedQuality(t, client) {
  for (const [index, issues] of invalidIssues.entries())
    await t.test(`rejects malformed issue ${index}`, () =>
      assert.rejects(
        insert(client, "metric_snapshots", snapshot({ status: "ESTIMATED", issues })),
        { code: "23514" },
      ),
    );
  for (const evidenceIds of [
    [],
    [null],
    ["source/raw:1", "source/raw:1"],
    [" "],
    ["x\u200b"],
    ["a".repeat(257)],
  ])
    await t.test(
      `rejects invalid snapshot evidence ${JSON.stringify(evidenceIds).slice(0, 35)}`,
      () =>
        assert.rejects(insert(client, "metric_snapshots", snapshot({ evidenceIds })), {
          code: "23514",
        }),
    );
}
async function positiveRows(t, client) {
  for (const [unit, keys] of Object.entries(kinds)) {
    const column = {
      minorCNY: "valueMinor",
      units: "valueUnits",
      basisPoints: "valueBasisPoints",
      hours: "valueHours",
    }[unit];
    for (const key of keys)
      await t.test(`stores public ${key} in ${unit}`, async () => {
        const row = snapshot({
          key,
          valueMinor: null,
          [column]: unit === "hours" ? 1.25 : "9007199254740991",
        });
        if (unit === "basisPoints" && key !== "ROAS") row[column] = 10000;
        const result = await insert(client, "metric_snapshots", row);
        assert.equal(Number(result.rows[0][column]), Number(row[column]));
        assert.deepEqual(result.rows[0].evidenceIds, ["source/raw:1"]);
      });
  }
}
async function positiveQuality(t, client) {
  for (const status of ["ESTIMATED", "INSUFFICIENT", "STALE", "UNAVAILABLE"])
    await t.test(`retains ${status} quality`, async () => {
      const row = snapshot({
        status,
        issues: [issue],
        ...(status === "UNAVAILABLE" ? { valueMinor: null, sourceWatermark: null } : {}),
      });
      assert.equal((await insert(client, "metric_snapshots", row)).rows[0].status, status);
    });
  await t.test("negative profit retains integer sign without float conversion", async () => {
    assert.equal(
      (
        await insert(
          client,
          "metric_snapshots",
          snapshot({ key: "PROFIT_DELTA", valueMinor: "-9007199254740991" }),
        )
      ).rows[0].valueMinor,
      "-9007199254740991",
    );
  });
}

test("metric storage rejects malformed values and preserves exact public units", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    await rejectedRows(t, client);
    await rejectedQuality(t, client);
    await positiveRows(t, client);
    await positiveQuality(t, client);
    await t.test("definition kind and unit must agree", () =>
      assert.rejects(definition(client, { key: "GMV", definitionVersion: "bad", unit: "hours" }), {
        code: "23514",
      }),
    );
    await t.test("definition digest format is strict", () =>
      assert.rejects(definition(client, { definitionVersion: "bad-hash", definitionHash: "bad" }), {
        code: "23514",
      }),
    );
  });
});
async function immutableHistory(t, client) {
  const row = snapshot({ inputRevision: "history-original" });
  const original = (await insert(client, "metric_snapshots", row)).rows[0];
  await t.test("same immutable snapshot identity is a unique violation", () =>
    assert.rejects(insert(client, "metric_snapshots", row), { code: "23505" }),
  );
  await t.test("revision and definition version append without replacing history", async () => {
    await insert(client, "metric_snapshots", {
      ...row,
      inputRevision: "history-next",
      valueMinor: 5,
    });
    await definition(client, { definitionVersion: "v2" });
    await insert(client, "metric_snapshots", { ...row, definitionVersion: "v2", valueMinor: 8 });
    const rows = await client.query(
      'SELECT "definitionVersion","inputRevision","valueMinor" FROM metric_snapshots ORDER BY "createdAt",id',
    );
    assert.equal(rows.rowCount, 3);
    assert.equal(
      (await client.query('SELECT "valueMinor" FROM metric_snapshots WHERE id=$1', [original.id]))
        .rows[0].valueMinor,
      "0",
    );
    assert.equal(
      (await client.query("SELECT count(*) FROM metric_definitions WHERE key=$1", ["GMV"])).rows[0]
        .count,
      "2",
    );
  });
}
async function immutableDml(t, client) {
  for (const table of ["metric_definitions", "metric_snapshots"])
    for (const statement of [
      `UPDATE ${table} SET id=id`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table} CASCADE`,
    ])
      await t.test(`operator cannot ${statement}`, () =>
        assert.rejects(client.query(statement), { code: "23514" }),
      );
  await t.test("rolled back insertion leaves no history", async () => {
    await client.query("BEGIN");
    await insert(client, "metric_snapshots", snapshot({ inputRevision: "rolled-back" }));
    await client.query("ROLLBACK");
    assert.equal(
      (
        await client.query('SELECT 1 FROM metric_snapshots WHERE "inputRevision"=$1', [
          "rolled-back",
        ])
      ).rowCount,
      0,
    );
  });
}
async function ownershipCases(t, client) {
  for (const field of Object.keys(binding)) {
    const foreign =
      field === "externalStoreId" ? "metric/external.b" : binding[field].replace(/a$/u, "b");
    await t.test(`definition ${field} cannot mix ownership`, () =>
      assert.rejects(definition(client, { [field]: foreign }), { code: "23503" }),
    );
    await t.test(`snapshot ${field} cannot mix ownership`, () =>
      assert.rejects(insert(client, "metric_snapshots", snapshot({ [field]: foreign })), {
        code: "23503",
      }),
    );
  }
  await t.test("snapshot references exact definition version", () =>
    assert.rejects(insert(client, "metric_snapshots", snapshot({ definitionVersion: "missing" })), {
      code: "23503",
    }),
  );
  await t.test("metadata cannot duplicate a full scope and version", () =>
    assert.rejects(definition(client), { code: "23505" }),
  );
}
test("metric history is immutable even for operator DML and binds all ownership fields", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    await ownershipCases(t, client);
    await immutableHistory(t, client);
    await immutableDml(t, client);
  });
});

async function loginClients(client, url, action) {
  const logins = [];
  try {
    for (const capability of ["reader", "writer", "definition_writer"]) {
      const name = `metric_${capability}_${randomBytes(6).toString("hex")}`;
      const password = randomBytes(20).toString("hex");
      // PostgreSQL identifiers/password DDL cannot bind; generated hex-only fragments prevent injection.
      assert.match(name, /^[a-z0-9_]+$/u);
      await client.query(
        `CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
      );
      const login = new pg.Client({ connectionString: roleUrl(url, name, password) });
      logins.push({ name, login, capability });
      await client.query(`GRANT shopmate_metric_${capability} TO ${name}`);
      await login.connect();
    }
    await action(Object.fromEntries(logins.map(({ capability, login }) => [capability, login])));
  } finally {
    for (const { name, login } of logins) {
      try {
        await login.end();
      } finally {
        await client.query(`DROP ROLE ${name}`);
      }
    }
  }
}
function roleUrl(url, name, password) {
  const target = new URL(url);
  target.username = name;
  target.password = password;
  return target.toString();
}
async function withContext(client, user, overrides, action, isolation = "READ COMMITTED") {
  assert.ok(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"].includes(isolation));
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  try {
    const context = {
      user_id: user,
      ...Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [
          key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
          value,
        ]),
      ),
      ...overrides,
    };
    for (const [key, value] of Object.entries(context))
      await client.query("SELECT set_config($1,$2,true)", [`app.${key}`, value]);
    return await action();
  } finally {
    await client.query("ROLLBACK");
  }
}
async function allowedRoles(t, client, roles) {
  await insert(client, "metric_snapshots", snapshot());
  await t.test("actual restricted logins enforce separate capabilities", async () => {
    assert.deepEqual(
      (
        await roles.reader.query(
          "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0],
      { rolsuper: false, rolbypassrls: false },
    );
    await withContext(roles.reader, "metric-viewer", {}, async () => {
      assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 1);
      assert.equal((await roles.reader.query("SELECT * FROM metric_definitions")).rowCount, 23);
    });
    await withContext(roles.writer, "metric-owner", {}, () =>
      insert(roles.writer, "metric_snapshots", snapshot()),
    );
    await withContext(roles.definition_writer, "metric-admin", {}, () =>
      definition(roles.definition_writer, { definitionVersion: "role-v2" }),
    );
  });
}
async function deniedRoles(t, roles) {
  await t.test("runtime roles cannot read raw tenants or stores", async () => {
    for (const login of Object.values(roles))
      for (const table of [
        '"Store"',
        '"Organization"',
        '"OrganizationMember"',
        '"Workspace"',
        '"WorkspaceMember"',
      ])
        await assert.rejects(login.query(`SELECT * FROM ${table}`), { code: "42501" });
  });
  await t.test("snapshot writer cannot provision definitions", () =>
    withContext(roles.writer, "metric-owner", {}, () =>
      assert.rejects(definition(roles.writer, { definitionVersion: "forbidden" }), {
        code: "42501",
      }),
    ),
  );
  await t.test("definition writer cannot insert snapshots", () =>
    withContext(roles.definition_writer, "metric-owner", {}, () =>
      assert.rejects(insert(roles.definition_writer, "metric_snapshots", snapshot()), {
        code: "42501",
      }),
    ),
  );
  for (const login of Object.values(roles))
    for (const table of ["metric_definitions", "metric_snapshots"])
      for (const command of [
        `UPDATE ${table} SET id=id`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ])
        await t.test(
          `restricted ${Object.keys(roles).find((k) => roles[k] === login)} cannot ${command}`,
          () => assert.rejects(login.query(command), { code: "42501" }),
        );
}
async function missingContexts(t, roles) {
  for (const key of [
    "user_id",
    "organization_id",
    "workspace_id",
    "store_id",
    "connection_id",
    "external_store_id",
  ])
    await t.test(`missing ${key} hides reads and denies insertion`, async () => {
      await withContext(roles.reader, "metric-viewer", { [key]: "" }, async () =>
        assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 0),
      );
      await withContext(roles.writer, "metric-owner", { [key]: "" }, () =>
        assert.rejects(insert(roles.writer, "metric_snapshots", snapshot()), { code: "42501" }),
      );
    });
}
async function foreignContexts(t, roles) {
  for (const key of [
    "organization_id",
    "workspace_id",
    "store_id",
    "connection_id",
    "external_store_id",
  ])
    await t.test(`foreign ${key} hides reads and denies insertion`, async () => {
      await withContext(roles.reader, "metric-viewer", { [key]: "foreign" }, async () =>
        assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 0),
      );
      await withContext(roles.writer, "metric-owner", { [key]: "foreign" }, () =>
        assert.rejects(insert(roles.writer, "metric_snapshots", snapshot()), { code: "42501" }),
      );
    });
  await t.test("context is transaction-local and unavailable to the next request", async () =>
    assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 0),
  );
  await t.test("ordinary member cannot write with writer capability", () =>
    withContext(roles.writer, "metric-viewer", {}, () =>
      assert.rejects(insert(roles.writer, "metric_snapshots", snapshot()), { code: "42501" }),
    ),
  );
}
async function revokedContexts(t, client, roles) {
  const changes = [
    ['UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', "metric-viewer"],
    ['UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', "metric-viewer"],
    ['UPDATE "Organization" SET status=$1 WHERE id=$2', binding.organizationId],
    ['UPDATE "Workspace" SET status=$1 WHERE id=$2', binding.workspaceId],
  ];
  for (const [index, [query, key]] of changes.entries())
    await t.test(`revoked authority ${index} is rechecked on the next transaction`, async () => {
      await client.query(query, [index < 2 ? "INACTIVE" : "SUSPENDED", key]);
      try {
        await withContext(roles.reader, "metric-viewer", {}, async () =>
          assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 0),
        );
      } finally {
        await client.query(query, ["ACTIVE", key]);
      }
    });
  await t.test("historical reads do not require active connection or DEMO tenant", async () => {
    assert.equal(
      (
        await client.query('SELECT status FROM "PlatformConnection" WHERE id=$1', [
          binding.connectionId,
        ])
      ).rows[0].status,
      "DISCONNECTED",
    );
    await withContext(roles.reader, "metric-viewer", {}, async () =>
      assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 1),
    );
    assert.equal((await client.query('SELECT * FROM "DemoTenant"')).rowCount, 0);
  });
}
test("metric capabilities use fresh complete tenant context with actual restricted LOGINs", async (t) => {
  await withDatabase(async (client, url) => {
    await migrate(client);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM pg_roles WHERE rolname IN ('shopmate_metric_reader','shopmate_metric_writer','shopmate_metric_definition_writer')",
        )
      ).rowCount,
      3,
    );
    await fixture(client);
    await loginClients(client, url, async (roles) => {
      await allowedRoles(t, client, roles);
      await deniedRoles(t, roles);
      await missingContexts(t, roles);
      await foreignContexts(t, roles);
      await revokedContexts(t, client, roles);
      await securityBoundary(t, client, roles);
      await hardenedDefiner(t, client, roles);
    });
  });
});

test("literal identifiers share the public UTF-16 length budget", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const supplementary = String.fromCodePoint(0x1f600);
    assert.equal(
      (await definition(client, { definitionVersion: supplementary.repeat(128) })).rowCount,
      1,
    );
    await assert.rejects(definition(client, { definitionVersion: supplementary.repeat(129) }), {
      code: "23514",
    });
  });
});

async function securityBoundary(t, _client, roles) {
  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"])
    await t.test(`${isolation} cannot retain stale authorization`, async () => {
      await withContext(
        roles.reader,
        "metric-viewer",
        {},
        async () =>
          assert.equal((await roles.reader.query("SELECT * FROM metric_snapshots")).rowCount, 0),
        isolation,
      );
      await withContext(
        roles.writer,
        "metric-owner",
        {},
        () =>
          assert.rejects(insert(roles.writer, "metric_snapshots", snapshot()), { code: "42501" }),
        isolation,
      );
    });
}
async function hardenedDefiner(t, client, roles) {
  await t.test("reader cannot execute unneeded validators or assume definer owner", async () => {
    await assert.rejects(roles.reader.query("SELECT public.metric_literal($1)", ["x"]), {
      code: "42501",
    });
    const owner = (await client.query("SELECT current_user AS name")).rows[0].name;
    assert.match(owner, /^[a-z0-9_]+$/u);
    await assert.rejects(roles.reader.query(`SET ROLE ${owner}`), { code: "42501" });
    const functions = await client.query(
      "SELECT prosecdef,proconfig,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='public.metric_scope_access(text,text,text,text,text,boolean)'::regprocedure",
    );
    assert.deepEqual(functions.rows[0], {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog"],
      owner,
    });
  });
  await t.test("both metric tables force RLS without mutation policies", async () => {
    const rows = await client.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('metric_definitions'::regclass,'metric_snapshots'::regclass)",
    );
    assert.equal(rows.rowCount, 2);
    assert.ok(rows.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    assert.equal(
      (
        await client.query(
          "SELECT * FROM pg_policies WHERE tablename IN ('metric_definitions','metric_snapshots') AND cmd NOT IN ('SELECT','INSERT')",
        )
      ).rowCount,
      0,
    );
  });
}
const apiTargets = ["test/tenant-database.e2e-spec.ts", "test/demo-commerce-database.e2e-spec.ts"];
function apiReport() {
  return {
    success: true,
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: apiTargets.map((name) => ({
      name: `/fixture/apps/api/${name}`,
      status: "passed",
      assertionResults: [{ status: "passed", failureMessages: [] }],
    })),
  };
}
const passingTap =
  "TAP version 13\n1..2\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const invalidApiReports = [
  [
    "zero tests",
    (r) => {
      r.numTotalTests = 0;
      r.numPassedTests = 0;
    },
  ],
  [
    "missing expected file",
    (r) => {
      r.testResults.pop();
    },
  ],
  [
    "zero file assertions",
    (r) => {
      r.testResults[0].assertionResults = [];
    },
  ],
  [
    "pending",
    (r) => {
      r.numPendingTests = 1;
    },
  ],
  [
    "todo",
    (r) => {
      r.numTodoTests = 1;
    },
  ],
  [
    "failed",
    (r) => {
      r.numFailedTests = 1;
    },
  ],
  [
    "failed suite",
    (r) => {
      r.numFailedTestSuites = 1;
    },
  ],
  [
    "pending suite",
    (r) => {
      r.numPendingTestSuites = 1;
    },
  ],
  [
    "false success",
    (r) => {
      r.success = false;
    },
  ],
  [
    "skipped assertion",
    (r) => {
      r.testResults[0].assertionResults[0].status = "skipped";
    },
  ],
  [
    "failed assertion",
    (r) => {
      r.testResults[0].assertionResults[0].status = "failed";
    },
  ],
  [
    "missing counts",
    (r) => {
      delete r.numTodoTests;
    },
  ],
  [
    "empty report",
    (r) => {
      r.testResults = [];
    },
  ],
];
async function runnerReports(t, runner) {
  await t.test("TAP requires actual positive passing counts", () =>
    assert.deepEqual(runner.assertTapReport(passingTap), {
      tests: 2,
      pass: 2,
      fail: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    }),
  );
  for (const [name, report] of [
    ["missing", ""],
    ["zero", passingTap.replaceAll("2", "0")],
    ["skip", passingTap.replace("# skipped 0", "# skipped 1")],
    ["todo", passingTap.replace("# todo 0", "# todo 1")],
    ["cancelled", passingTap.replace("# cancelled 0", "# cancelled 1")],
    ["failed", passingTap.replace("# fail 0", "# fail 1")],
    ["count mismatch", passingTap.replace("# pass 2", "# pass 1")],
  ])
    await t.test(`TAP rejects ${name}`, () => assert.throws(() => runner.assertTapReport(report)));
  await t.test("JSON proves each expected API file and every assertion", () =>
    assert.deepEqual(
      runner.assertApiReport(apiReport(), apiTargets),
      apiTargets.map((file) => ({ file, tests: 1 })),
    ),
  );
  for (const [name, mutate] of invalidApiReports)
    await t.test(`JSON rejects ${name}`, () => {
      const report = apiReport();
      mutate(report);
      assert.throws(() => runner.assertApiReport(report, apiTargets));
    });
}
const poisonedEnvironment = {
  DATABASE_URL: "postgresql://invalid.invalid/production",
  SHADOW_DATABASE_URL: "unsafe",
  DIRECT_URL: "unsafe",
  TENANT_TEST_OPERATOR_URL: "unsafe",
  MOCK_PLATFORM_WORKER_DATABASE_URL: "unsafe",
  MIGRATION_DATABASE_URL: "unsafe",
  DOTENV_CONFIG_OVERRIDE: "true",
  DOTENV_CONFIG_PATH: "unsafe",
  PGHOST: "unsafe",
  KEEP_ME: "yes",
};
async function runnerEnvironment(t, runner) {
  await t.test(
    "children receive only runner-owned database URLs and cannot dotenv override",
    () => {
      const env = runner.tenantEnvironment(poisonedEnvironment, serverUrl);
      assert.equal(env.DATABASE_URL, serverUrl);
      assert.equal(env.TEST_DATABASE_URL, serverUrl);
      assert.equal(env.DOTENV_CONFIG_OVERRIDE, "false");
      assert.equal(env.KEEP_ME, "yes");
      for (const key of Object.keys(poisonedEnvironment).filter(
        (k) => !["DATABASE_URL", "KEEP_ME", "DOTENV_CONFIG_OVERRIDE"].includes(k),
      ))
        assert.equal(env[key], undefined, key);
    },
  );
  await t.test(
    "API runtime URL is restricted to prepared login on same disposable instance",
    () => {
      const runtime = new URL(serverUrl);
      runtime.username = "shopmate_tenant_api";
      runtime.password = "";
      const env = runner.tenantEnvironment(poisonedEnvironment, serverUrl, runtime.toString());
      assert.equal(env.DATABASE_URL, runtime.toString());
      assert.equal(env.TENANT_TEST_OPERATOR_URL, serverUrl);
      assert.throws(() =>
        runner.tenantEnvironment(
          poisonedEnvironment,
          "postgresql://example.com/shopmate_tenant_test",
        ),
      );
      runtime.pathname = "/shopmate_tenant_test_other";
      assert.throws(() =>
        runner.tenantEnvironment(poisonedEnvironment, serverUrl, runtime.toString()),
      );
    },
  );
}
test("mandatory tenant runner rejects empty/skipped reports and poisoned inherited URLs", async (t) => {
  const source = await readFile(
    new URL("../../../../scripts/test-tenant-database.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /export function assertTapReport/u);
  const runner = await import("../../../../scripts/test-tenant-database.mjs");
  await runnerReports(t, runner);
  await nodeReporterProof(t, source, runner);
  await runnerEnvironment(t, runner);
  assert.match(
    source,
    /await run\("packages\/database", "test\/integration\/metric-storage.test.mjs"/u,
  );
  const tenant = await readFile(
    new URL("../../../../apps/api/vitest.tenant.config.ts", import.meta.url),
    "utf8",
  );
  const ordinary = await readFile(
    new URL("../../../../apps/api/vitest.config.ts", import.meta.url),
    "utf8",
  );
  for (const file of apiTargets) {
    assert.ok(tenant.includes(file));
    assert.ok(ordinary.includes(file));
  }
  assert.match(ordinary, /exclude:/u);
});

async function removeMigrationHistory(directory) {
  const absolute = path.resolve(directory);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith("shopmate-metric-migrations-")
  )
    throw new Error("Refusing to remove an unowned metric migration fixture");
  await rm(absolute, { recursive: true, force: true });
}

async function nodeReporterProof(t, source, runner) {
  await t.test(
    "direct TAP execution rejects an empty file but accepts real assertions",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "shopmate-metric-migrations-"));
      try {
        const file = path.join(directory, "probe.mjs");
        await writeFile(file, "");
        const empty = execFileSync(process.execPath, ["--test-reporter=tap", file], {
          encoding: "utf8",
          windowsHide: true,
        });
        assert.throws(() => runner.assertTapReport(empty));
        await writeFile(
          file,
          'import test from "node:test"; import assert from "node:assert/strict"; test("real assertion", () => assert.equal(2 + 2, 4));',
        );
        const positive = execFileSync(process.execPath, ["--test-reporter=tap", file], {
          encoding: "utf8",
          windowsHide: true,
        });
        assert.equal(runner.assertTapReport(positive).tests, 1);
        assert.doesNotMatch(source, /\["--test", "--test-reporter=tap"\]/u);
      } finally {
        await removeMigrationHistory(directory);
      }
    },
  );
}
