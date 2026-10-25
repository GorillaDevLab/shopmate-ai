import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { EventEvidenceV1Schema } from "@shopmate/contracts";
import { requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";
import { tenantEnvironment } from "../../../../scripts/test-tenant-database.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Event storage requires runner TEST_DATABASE_URL");
const serverUrl = requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
const migrationRoot = new URL("../../prisma/migrations/", import.meta.url);
const eventMigration = "20261025090000_events_evidence";
const binding = {
  organizationId: "legacy-org-event-a",
  workspaceId: "legacy-workspace-event-a",
  storeId: "event-store-a",
  connectionId: "event-connection-a",
  externalStoreId: "event/external.a",
};
const instant = "2026-01-02T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const id = () => randomBytes(12).toString("hex");

async function withDatabase(action) {
  const operator = new pg.Client({ connectionString: serverUrl });
  await operator.connect();
  const name = `shopmate_tenant_test_${id()}`;
  assert.match(name, /^[a-z0-9_]+$/u);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  let client;
  try {
    await operator.query(`CREATE DATABASE "${name}"`);
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await action(client, url.toString());
  } finally {
    if (client) await client.end();
    try {
      await operator.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await operator.end();
    }
  }
}
async function migrate(client, before = "z") {
  for (const name of (await readdir(migrationRoot))
    .filter((v) => /^\d{14}_/u.test(v) && v < before)
    .sort())
    await client.query(await readFile(new URL(`${name}/migration.sql`, migrationRoot), "utf8"));
}
async function fixture(client) {
  for (const key of ["a", "b"]) {
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`event-${key}`],
    );
    await client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      [`event-store-${key}`, `event-${key}`, "Shanghai", "MOCK"],
    );
    await client.query(
      'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES ($1,$2,$3,$4,$5)',
      [
        `event-connection-${key}`,
        `legacy-org-event-${key}`,
        `legacy-workspace-event-${key}`,
        `event-store-${key}`,
        `event/external.${key}`,
      ],
    );
  }
  for (const role of ["OWNER", "ADMIN", "OPERATOR", "ANALYST", "VIEWER"])
    await client.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$1,$3,now())',
      [`event-${role}`, binding.organizationId, role],
    );
  for (const role of ["OPERATOR", "ANALYST", "VIEWER"])
    await client.query(
      'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
      [id(), binding.organizationId, binding.workspaceId, `event-${role}`],
    );
}
function fingerprint(row = {}) {
  const value = {
    ...binding,
    eventType: "REVENUE_DROP",
    entityKind: "STORE",
    entityId: binding.storeId,
    baselineVersion: null,
    ...row,
  };
  return JSON.stringify([
    "event-fingerprint-v1",
    value.organizationId,
    value.workspaceId,
    value.storeId,
    value.eventType,
    value.entityKind,
    value.entityId,
    value.baselineVersion,
  ]);
}
function event(overrides = {}) {
  const row = {
    ...binding,
    id: id(),
    schemaVersion: 1,
    eventType: "REVENUE_DROP",
    entityKind: "STORE",
    entityId: binding.storeId,
    baselineVersion: null,
    fingerprint: fingerprint(),
    severityFloor: "HIGH",
    rulePolicyVersion: "rules-v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentEvidenceId: id(),
    currentEvidenceVersion: "v1",
    currentEvidenceHash: digest,
    ...overrides,
  };
  return row;
}
function evidence(row, overrides = {}) {
  const value = {
    ...binding,
    id: row.currentEvidenceId,
    eventId: row.id,
    evidenceRevision: 1,
    schemaVersion: 1,
    fingerprint: row.fingerprint,
    version: row.currentEvidenceVersion,
    hash: row.currentEvidenceHash,
    definitionVersion: "v1",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: instant,
    observedAt: instant,
    sourceWatermark: instant,
    timezone: "Asia/Shanghai",
    currency: "CNY",
    dataStatus: "VERIFIED",
    sampleSize: 10,
    coverageBasisPoints: 10000,
    issues: [],
    ...overrides,
  };
  return {
    ...value,
    payload: overrides.payload === undefined ? evidencePayload(row, value) : overrides.payload,
  };
}
function evidencePayload(row, value) {
  const entity =
    row.entityKind === "STORE"
      ? { kind: "STORE" }
      : { kind: row.entityKind, externalSkuId: row.entityId };
  return {
    schemaVersion: value.schemaVersion,
    binding: Object.fromEntries(Object.keys(binding).map((key) => [key, value[key]])),
    eventType: row.eventType,
    entity,
    definitionVersion: value.definitionVersion,
    baselineVersion: row.baselineVersion,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    observedAt: value.observedAt,
    sourceWatermark: value.sourceWatermark,
    timezone: value.timezone,
    currency: value.currency,
    dataStatus: value.dataStatus,
    sampleSize: value.sampleSize,
    coverageBasisPoints: value.coverageBasisPoints,
    issues: value.issues,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [sourceReference(value)],
    facts: financialFacts(value),
  };
}
function period(value) {
  return {
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    timezone: value.timezone,
    currency: value.currency,
  };
}
function sourceReference(value) {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: "visible-fact-1",
    version: "v1",
    hash: digest,
    binding: Object.fromEntries(Object.keys(binding).map((key) => [key, value[key]])),
    definitionVersion: value.definitionVersion,
    period: period(value),
    observedAt: value.observedAt,
    measure: null,
  };
}
function financialFacts(value) {
  return {
    paidRevenueMinor: null,
    netRevenueMinor: 100,
    grossMerchandiseMinor: null,
    grossProfitMinor: null,
    contributionMinor: null,
    discountMinor: null,
    spendMinor: null,
    costCoverageBasisPoints: 0,
    feeCoverageBasisPoints: 0,
    profitDeltaMinor: null,
    attributionVersion: null,
    contributions: [],
    skuContributions: [],
    promotionPeriod: null,
    discountRate: {
      numerator: null,
      denominator: null,
      valueBasisPoints: null,
      period: period(value),
    },
  };
}
function insert(client, table, row) {
  assert.ok(
    [
      "events",
      "event_evidence",
      "event_evidence_metrics",
      "metric_definitions",
      "metric_snapshots",
    ].includes(table),
  );
  const keys = Object.keys(row);
  keys.forEach((key) => assert.match(key, /^[A-Za-z][A-Za-z0-9]*$/u));
  const values = keys.map((key) =>
    ["issues", "payload"].includes(key) ? JSON.stringify(row[key]) : row[key],
  );
  return client.query(
    `INSERT INTO public.${table} (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    values,
  );
}
async function append(client, row = event(), overrides = {}) {
  await client.query("BEGIN");
  try {
    await insert(client, "events", row);
    await insert(client, "event_evidence", evidence(row, overrides));
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
test("event storage installs full scope tables on a fresh database", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    const result = await client.query(
      "SELECT to_regclass('events') AS events,to_regclass('event_evidence') AS evidence,to_regclass('event_evidence_metrics') AS metrics",
    );
    assert.deepEqual(result.rows[0], {
      events: "events",
      evidence: "event_evidence",
      metrics: "event_evidence_metrics",
    });
  });
});

test("upgrade preserves prior rows and validates the additive event schema", async () => {
  await withDatabase(async (client) => {
    await migrate(client, eventMigration);
    await fixture(client);
    await client.query(
      await readFile(new URL(`${eventMigration}/migration.sql`, migrationRoot), "utf8"),
    );
    assert.equal((await client.query('SELECT * FROM "Store"')).rowCount, 2);
    await append(client);
  });
});
async function invalidEvents(t, client) {
  const cases = [
    { schemaVersion: 2 },
    { fingerprint: "forged" },
    { entityKind: "CAMPAIGN" },
    { eventType: "MADE_UP" },
    { eventType: "PRODUCT_BREAKOUT", entityKind: "SKU", entityId: "sku-1", severityFloor: "HIGH" },
    { revision: 0 },
    { revision: "9007199254740992" },
    { state: "UNKNOWN" },
    { rulePolicyVersion: " v1" },
    { lastSeenAt: "2026-01-01T00:00:00.000Z" },
    { firstSeenAt: "infinity" },
    { currentEvidenceHash: "" },
  ];
  for (const row of cases)
    await t.test(`invalid event ${JSON.stringify(row)}`, () =>
      assert.rejects(append(client, event(row)), { code: "23514" }),
    );
}
async function invalidEvidence(t, client) {
  const cases = [
    { schemaVersion: 2 },
    { version: "" },
    { hash: "" },
    { definitionVersion: " v1" },
    { evidenceRevision: 0 },
    { periodEnd: "2025-01-01T00:00:00.000Z" },
    { observedAt: "2026-01-01T00:00:00.000Z" },
    { sourceWatermark: "2026-01-03T00:00:00.000Z" },
    { sourceWatermark: null },
    { sampleSize: -1 },
    { coverageBasisPoints: 9999 },
    { issues: [{ code: "MADE_UP", field: "x", evidenceIds: ["x"] }] },
    { payload: null },
    { payload: [] },
    { dataStatus: "UNAVAILABLE", issues: [] },
  ];
  for (const row of cases)
    await t.test(`invalid evidence ${JSON.stringify(row)}`, () =>
      assert.rejects(append(client, event(), row), { code: "23514" }),
    );
}
test("versioned missing baseline retains explicit nullable quality", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const identity = { baselineVersion: "baseline-v1" };
    const row = event({ ...identity, fingerprint: fingerprint(identity) });
    const payload = evidence(row).payload;
    payload.baseline = {
      status: "MISSING",
      alignment: "MISSING",
      version: "baseline-v1",
      aggregation: "EXACT_MEDIAN",
      measure: { kind: "NET_MERCHANDISE_REVENUE", unit: "minorCNY" },
      period: null,
      median: null,
      mad: null,
      sampleSize: 0,
      coverageBasisPoints: 0,
      sourceReferences: [],
    };
    EventEvidenceV1Schema.parse(payload);
    await append(client, row, { payload });
  });
});

test("database rejects invalid event and evidence envelopes", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    await invalidEvents(t, client);
    await invalidEvidence(t, client);
  });
});
test("database rejects evidence payloads that disagree with their immutable envelope", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    for (const patch of [
      { schemaVersion: 2 },
      { definitionVersion: "other" },
      { eventType: "REFUND_SPIKE" },
      { binding: { ...binding, connectionId: "event-connection-b" } },
      { entity: { kind: "SKU", externalSkuId: "sku" } },
      { observedAt: "2025-01-01T00:00:00.000Z" },
      { dataStatus: "STALE" },
      { baselineVersion: "invented" },
      { facts: null },
      { issues: [{ code: "MISSING_INPUT", field: "source", evidenceIds: ["visible-fact-1"] }] },
      {
        sourceReferences: [
          { ...sourceReference(evidence(event())), observedAt: "2025-01-01T00:00:00.000Z" },
        ],
      },
    ]) {
      const row = event({ state: "RESOLVED" });
      const payload = { ...evidence(row).payload, ...patch };
      await t.test(JSON.stringify(patch), () =>
        assert.rejects(append(client, row, { payload }), { code: "23514" }),
      );
    }
  });
});
async function historyCases(t, client, row) {
  await t.test("evidence revision is append only and unique per event", async () => {
    await insert(
      client,
      "event_evidence",
      evidence(row, { id: id(), evidenceRevision: 2, version: "v2" }),
    );
    await assert.rejects(
      insert(client, "event_evidence", evidence(row, { id: id(), evidenceRevision: 2 })),
      { code: "23505" },
    );
  });
  for (const table of ["event_evidence", "event_evidence_metrics"])
    for (const sql of [
      `UPDATE ${table} SET "organizationId"="organizationId"`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table} CASCADE`,
    ])
      await t.test(`operator cannot mutate history: ${sql}`, () =>
        assert.rejects(client.query(sql), { code: "23514" }),
      );
  await t.test("event identity cannot change", () =>
    assert.rejects(
      client.query('UPDATE events SET "firstSeenAt"=$1', ["2026-01-01T00:00:00.000Z"]),
      { code: "23514" },
    ),
  );
}
async function scopeCases(t, client, row) {
  for (const field of Object.keys(binding)) {
    const foreign = binding[field].replace(/a$/u, "b");
    await t.test(`event rejects mixed ${field}`, () =>
      assert.rejects(append(client, foreignEvent(field, foreign)), { code: "23503" }),
    );
    await t.test(`evidence rejects mixed ${field}`, () =>
      assert.rejects(
        insert(
          client,
          "event_evidence",
          evidence(row, { id: id(), evidenceRevision: 3, [field]: foreign }),
        ),
        { code: "23503" },
      ),
    );
  }
  await t.test("current evidence hash and version are bound", async () => {
    await assert.rejects(
      client.query('UPDATE events SET "currentEvidenceHash"=$1 WHERE id=$2', ["other", row.id]),
      { code: "23503" },
    );
    await assert.rejects(
      client.query('UPDATE events SET "currentEvidenceVersion"=$1 WHERE id=$2', ["other", row.id]),
      { code: "23503" },
    );
  });
}
function foreignEvent(field, foreign) {
  const identity = { [field]: foreign, entityId: field === "storeId" ? foreign : binding.storeId };
  return event({ ...identity, state: "RESOLVED", fingerprint: fingerprint(identity) });
}
test("full binding references and immutable evidence hold even for database operator", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const row = await append(client);
    await metricFixture(client, row);
    await historyCases(t, client, row);
    await scopeCases(t, client, row);
  });
});
async function metricFixture(client, row) {
  const definition = {
    ...binding,
    key: "GMV",
    definitionVersion: "v1",
    unit: "minorCNY",
    definitionHash: digest,
  };
  await insert(client, "metric_definitions", definition);
  const metric = await insert(client, "metric_snapshots", metricSnapshot());
  await metricReferences(client, row, metric.rows[0].id);
  const next = await insert(client, "metric_snapshots", {
    ...metricSnapshot(),
    inputRevision: "v2",
  });
  await insert(client, "event_evidence_metrics", {
    ...binding,
    evidenceId: row.currentEvidenceId,
    metricSnapshotId: next.rows[0].id,
  });
  assert.equal((await client.query("SELECT * FROM event_evidence_metrics")).rowCount, 2);
  await foreignMetric(client, row, definition);
}
async function foreignMetric(client, row, definition) {
  const foreign = Object.fromEntries(
    Object.entries(binding).map(([key, value]) => [key, value.replace(/a$/u, "b")]),
  );
  await insert(client, "metric_definitions", { ...definition, ...foreign });
  const metric = await insert(client, "metric_snapshots", { ...metricSnapshot(), ...foreign });
  await assert.rejects(
    insert(client, "event_evidence_metrics", {
      ...binding,
      evidenceId: row.currentEvidenceId,
      metricSnapshotId: metric.rows[0].id,
    }),
    { code: "23503", constraint: "event_evidence_metrics_metric_fkey" },
  );
}
function metricSnapshot() {
  return {
    ...binding,
    key: "GMV",
    definitionVersion: "v1",
    inputRevision: "v1",
    inputHash: digest,
    subjectKind: "STORE",
    subjectId: "",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: instant,
    timezone: "Asia/Shanghai",
    currency: "CNY",
    visibleAt: instant,
    sourceWatermark: instant,
    computedAt: instant,
    sampleSize: 10,
    coverageBasisPoints: 10000,
    status: "VERIFIED",
    evidenceIds: ["visible-fact-1"],
    issues: [],
    valueMinor: 100,
  };
}
async function metricReferences(client, row, metricSnapshotId) {
  for (const field of Object.keys(binding))
    await assert.rejects(
      insert(client, "event_evidence_metrics", {
        ...binding,
        evidenceId: row.currentEvidenceId,
        metricSnapshotId,
        [field]: binding[field].replace(/a$/u, "b"),
      }),
      { code: "23503" },
    );
  await insert(client, "event_evidence_metrics", {
    ...binding,
    evidenceId: row.currentEvidenceId,
    metricSnapshotId,
  });
}
async function context(client, user, overrides, action) {
  await client.query("BEGIN");
  try {
    const values = {
      user_id: user,
      ...Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [
          key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
          value,
        ]),
      ),
      ...overrides,
    };
    for (const [key, value] of Object.entries(values))
      await client.query("SELECT set_config($1,$2,true)", [`app.${key}`, value]);
    return await action();
  } finally {
    await client.query("ROLLBACK");
  }
}
async function capabilities(client, url, action) {
  const connections = [];
  try {
    for (const role of ["reader", "writer", "ungranted"]) {
      const name = `event_${role}_${id()}`;
      assert.match(name, /^[a-z0-9_]+$/u);
      await client.query(`CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      if (role !== "ungranted") await client.query(`GRANT shopmate_event_${role} TO ${name}`);
      const connection = new pg.Client({ connectionString: url });
      await connection.connect();
      await connection.query(`SET ROLE ${name}`);
      connections.push({ name, role, connection });
    }
    await action(Object.fromEntries(connections.map((entry) => [entry.role, entry.connection])));
  } finally {
    for (const { name, connection } of connections) {
      await connection.end();
      await client.query(`DROP ROLE ${name}`);
    }
  }
}
async function roleCases(t, roles) {
  await t.test("assigned OPERATOR appends scoped evidence with restricted writer", () =>
    context(roles.writer, "event-OPERATOR", {}, () => scopedAppend(roles.writer)),
  );
  for (const user of ["OWNER", "ADMIN", "OPERATOR", "ANALYST", "VIEWER"])
    await t.test(`${user} reads assigned scope`, () =>
      context(roles.reader, `event-${user}`, {}, async () =>
        assert.equal((await roles.reader.query("SELECT * FROM events")).rowCount, 1),
      ),
    );
  for (const user of ["OWNER", "ADMIN", "OPERATOR"])
    await t.test(`${user} may manage events`, () =>
      context(roles.writer, `event-${user}`, {}, async () =>
        assert.equal(
          (await roles.writer.query("UPDATE events SET state='ACKNOWLEDGED' RETURNING id"))
            .rowCount,
          1,
        ),
      ),
    );
  for (const user of ["ANALYST", "VIEWER"])
    await t.test(`${user} cannot manage events`, () =>
      context(roles.writer, `event-${user}`, {}, async () =>
        assert.equal(
          (await roles.writer.query("UPDATE events SET state='ACKNOWLEDGED' RETURNING id"))
            .rowCount,
          0,
        ),
      ),
    );
  await deniedCapabilities(roles);
}
async function deniedCapabilities(roles) {
  await assert.rejects(roles.reader.query("UPDATE events SET state='RESOLVED'"), { code: "42501" });
  await assert.rejects(roles.ungranted.query("SELECT * FROM events"), { code: "42501" });
  await assert.rejects(
    roles.ungranted.query(
      "SELECT public.event_scope_access($1,$2,$3,$4,$5,false)",
      Object.values(binding),
    ),
    { code: "42501" },
  );
}
async function scopedAppend(client) {
  const identity = { entityKind: "SKU", entityId: "visible-sku-2" };
  const row = event({ ...identity, fingerprint: fingerprint(identity) });
  await insert(client, "events", row);
  await insert(client, "event_evidence", evidence(row));
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  assert.equal((await client.query("SELECT * FROM event_evidence")).rowCount, 2);
}
async function deniedCases(t, client, roles) {
  for (const key of [
    "user_id",
    "organization_id",
    "workspace_id",
    "store_id",
    "connection_id",
    "external_store_id",
  ])
    await t.test(`missing ${key} defaults deny`, () =>
      context(roles.reader, "event-OWNER", { [key]: "" }, async () =>
        assert.equal((await roles.reader.query("SELECT * FROM event_evidence")).rowCount, 0),
      ),
    );
  await client.query('UPDATE "WorkspaceMember" SET status=\'INACTIVE\' WHERE "userId"=$1', [
    "event-OPERATOR",
  ]);
  await context(roles.writer, "event-OPERATOR", {}, async () =>
    assert.equal(
      (await roles.writer.query("UPDATE events SET state='RESOLVED' RETURNING id")).rowCount,
      0,
    ),
  );
  await client.query('UPDATE "OrganizationMember" SET status=\'INACTIVE\' WHERE "userId"=$1', [
    "event-OWNER",
  ]);
  await context(roles.reader, "event-OWNER", {}, async () =>
    assert.equal((await roles.reader.query("SELECT * FROM events")).rowCount, 0),
  );
}
test("forced RLS checks live membership and event operator assignment with default deny", async (t) => {
  await withDatabase(async (client, url) => {
    await migrate(client);
    await fixture(client);
    await append(client);
    await capabilities(client, url, async (roles) => {
      await roleCases(t, roles);
      await deniedCases(t, client, roles);
    });
  });
});
async function waitForLock(client, pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [
      pid,
    ]);
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await delay(10);
  }
  assert.fail("Concurrent client never waited on the active fingerprint lock");
}
async function race(client, url, state) {
  const other = new pg.Client({ connectionString: url });
  await other.connect();
  const first = event({ state });
  try {
    await other.query("SET statement_timeout='5s'");
    await client.query("BEGIN");
    await insert(client, "events", first);
    await insert(client, "event_evidence", evidence(first));
    const pending = append(other, event()).then(
      () => "inserted",
      (error) => error.code,
    );
    await waitForLock(client, other.processID);
    // The loser is a separate connection awaiting the first transaction's index conflict.
    await client.query("COMMIT");
    assert.equal(await pending, "23505");
    await client.query("UPDATE events SET state='RESOLVED' WHERE id=$1", [first.id]);
    await append(other);
    assert.equal((await client.query("SELECT * FROM events")).rowCount, 2);
  } finally {
    await client.query("ROLLBACK");
    await other.end();
  }
}
test("concurrent active fingerprints are unique and RESOLVED permits recurrence", async (t) => {
  for (const state of ["OPEN", "ACKNOWLEDGED", "SUPPRESSED"])
    await t.test(state, () =>
      withDatabase(async (client, url) => {
        await migrate(client);
        await fixture(client);
        await race(client, url, state);
      }),
    );
});
function prisma(url, args) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  return execFileSync(
    process.execPath,
    [path.join(root, "node_modules/prisma/build/index.js"), ...args],
    {
      cwd: root,
      env: tenantEnvironment(process.env, requireIsolatedDatabaseUrl(url)),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    },
  );
}
test("Prisma deploy and schema mirror event storage without drift exclusions", async () => {
  await withDatabase(async (client, url) => {
    assert.match(prisma(url, ["migrate", "deploy"]), /20261025090000_events_evidence/u);
    assert.match(
      prisma(url, [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
        "--script",
      ]),
      /empty migration/u,
    );
    assert.equal((await client.query("SELECT * FROM events")).rowCount, 0);
  });
});
