import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
      'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES ($1,$2,$3,$4,$5)',
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
