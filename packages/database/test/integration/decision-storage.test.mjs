import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";
import { tenantEnvironment } from "../../../../scripts/test-tenant-database.mjs";
import { EventEvidenceV1Schema, DecisionResultSchema, ExternalIdSchema } from "@shopmate/contracts";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Decision storage requires runner TEST_DATABASE_URL");
const serverUrl = requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
const migrationRoot = new URL("../../prisma/migrations/", import.meta.url);
const instant = "2026-01-02T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const binding = {
  organizationId: "legacy-org-decision-a",
  workspaceId: "legacy-workspace-decision-a",
  storeId: "decision-store-a",
  connectionId: "decision-connection-a",
  externalStoreId: "decision/external.a",
};
const labels = {
  severity: "HIGH",
  notificationRoute: "DAILY_BRIEF",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "HIGH_PRIORITY",
  reasonCodes: ["REVENUE_DROP"],
};
const correlationId = "c4c2bd72-d62c-4c26-8ec7-43d90249e36a";

async function withDatabase(action) {
  const operator = new pg.Client({ connectionString: serverUrl });
  await operator.connect();
  const name = `shopmate_tenant_test_${randomUUID().replaceAll("-", "")}`;
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
async function migrate(client) {
  for (const name of (await readdir(migrationRoot)).filter((v) => /^\d{14}_/u.test(v)).sort())
    await client.query(await readFile(new URL(`${name}/migration.sql`, migrationRoot), "utf8"));
}
async function insert(client, table, row) {
  assert.match(table, /^decision_[a-z_]+$|^events$|^event_evidence$/u);
  const keys = Object.keys(row);
  assert.ok(keys.every((key) => /^[a-zA-Z]+$/u.test(key)));
  const columns = keys.map((key) => `"${key}"`).join(",");
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(",");
  return client.query(
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`,
    Object.entries(row).map(([key, value]) =>
      (["suggested", "effective"].includes(key) && typeof value === "string") ||
      Array.isArray(value)
        ? JSON.stringify(value)
        : value,
    ),
  );
}
async function fixture(client) {
  for (const key of ["a", "b"]) {
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`decision-${key}`],
    );
    await client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      [`decision-store-${key}`, `decision-${key}`, "Shanghai", "MOCK"],
    );
    await client.query(
      'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES ($1,$2,$3,$4,$5)',
      [
        `decision-connection-${key}`,
        `legacy-org-decision-${key}`,
        `legacy-workspace-decision-${key}`,
        `decision-store-${key}`,
        `decision/external.${key}`,
      ],
    );
  }
  for (const role of ["OWNER", "OPERATOR", "VIEWER"]) {
    await client.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$1,$3,now())',
      [`decision-${role}`, binding.organizationId, role],
    );
    await client.query(
      'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
      [randomUUID(), binding.organizationId, binding.workspaceId, `decision-${role}`],
    );
  }
  await client.query(
    'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$1,$3,now())',
    ["decision-b-owner", "legacy-org-decision-b", "OWNER"],
  );
}
function event(scope = binding) {
  const fingerprint = JSON.stringify([
    "event-fingerprint-v1",
    scope.organizationId,
    scope.workspaceId,
    scope.storeId,
    "REVENUE_DROP",
    "STORE",
    scope.storeId,
    null,
  ]);
  return {
    ...scope,
    id: randomUUID(),
    schemaVersion: 1,
    eventType: "REVENUE_DROP",
    entityKind: "STORE",
    entityId: scope.storeId,
    baselineVersion: null,
    fingerprint,
    severityFloor: "HIGH",
    rulePolicyVersion: "rules-v1",
    state: "OPEN",
    revision: 1,
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentEvidenceId: randomUUID(),
    currentEvidenceVersion: "v1",
    currentEvidenceHash: hash,
  };
}
function evidence(row, patch = {}) {
  const scope = Object.fromEntries(Object.keys(binding).map((key) => [key, row[key]]));
  const quality = evidenceQuality();
  const payload = EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding: scope,
    eventType: "REVENUE_DROP",
    entity: { kind: "STORE" },
    baselineVersion: null,
    ...quality,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [evidenceSource(scope, quality)],
    facts: financialFacts(quality),
  });
  return {
    ...scope,
    id: row.currentEvidenceId,
    eventId: row.id,
    evidenceRevision: 1,
    schemaVersion: 1,
    fingerprint: row.fingerprint,
    version: row.currentEvidenceVersion,
    hash: row.currentEvidenceHash,
    ...quality,
    payload,
    ...patch,
  };
}
function evidenceQuality() {
  return {
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
  };
}
function evidenceSource(scope, quality) {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: "visible-fact-1",
    version: "v1",
    hash,
    binding: scope,
    definitionVersion: "v1",
    period: {
      periodStart: quality.periodStart,
      periodEnd: instant,
      timezone: quality.timezone,
      currency: quality.currency,
    },
    observedAt: instant,
    measure: null,
  };
}
function financialFacts(quality) {
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
      period: {
        periodStart: quality.periodStart,
        periodEnd: instant,
        timezone: quality.timezone,
        currency: quality.currency,
      },
    },
  };
}
async function appendEvent(client, scope = binding, patch = {}) {
  const row = { ...event(scope), ...patch };
  await client.query("BEGIN");
  try {
    await insert(client, "events", row);
    await insert(client, "event_evidence", evidence(row));
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function context(client, user, action, patch = {}) {
  const settings = {
    user_id: user,
    organization_id: binding.organizationId,
    workspace_id: binding.workspaceId,
    store_id: binding.storeId,
    connection_id: binding.connectionId,
    external_store_id: binding.externalStoreId,
    ...patch,
  };
  try {
    for (const [key, value] of Object.entries(settings))
      await client.query("SELECT set_config($1,$2,false)", [`app.${key}`, value]);
    return await action();
  } finally {
    for (const key of Object.keys(settings))
      await client.query("SELECT set_config($1,$2,false)", [`app.${key}`, ""]);
  }
}
async function claim(
  client,
  row,
  key = randomUUID(),
  deadline = new Date(Date.now() + 60_000),
  token = randomUUID(),
) {
  return (
    await client.query("SELECT * FROM public.decision_claim($1,$2,$3,$4,$5,$6,$7)", [
      row.id,
      row.currentEvidenceId,
      row.currentEvidenceVersion,
      row.currentEvidenceHash,
      key,
      token,
      deadline,
    ])
  ).rows[0];
}
async function commit(client, lease, runId, token = lease.claimToken) {
  return (await client.query("SELECT decision_commit($1,$2,$3) AS won", [lease.id, token, runId]))
    .rows[0].won;
}
function run(lease, patch = {}) {
  return {
    ...binding,
    id: randomUUID(),
    claimId: lease.id,
    claimToken: lease.claimToken,
    eventId: lease.eventId,
    fingerprint: lease.fingerprint,
    evidenceId: lease.evidenceId,
    evidenceVersion: lease.evidenceVersion,
    evidenceHash: lease.evidenceHash,
    decisionKey: lease.decisionKey,
    schemaVersion: 1,
    requestId: randomUUID(),
    correlationId,
    providerKey: "rules",
    providerVersion: "rules-v1",
    supportedInputVersions: [1],
    rulesetVersion: "rules-v1",
    mode: "PRIMARY",
    fallbackOf: null,
    fallbackMode: null,
    fallbackStatus: null,
    resultStatus: "EVALUATED",
    result: {
      schemaVersion: 1,
      correlationId,
      status: "EVALUATED",
      rulesetVersion: "rules-v1",
      labels,
      confidenceMetadata: null,
    },
    effective: labels,
    overrideReason: null,
    latencyMs: 5,
    createdAt: instant,
    ...patch,
  };
}
function comparison(primary, shadow, patch = {}) {
  return {
    claimId: primary.claimId,
    ...binding,
    id: randomUUID(),
    schemaVersion: 1,
    eventId: primary.eventId,
    fingerprint: primary.fingerprint,
    evidenceId: primary.evidenceId,
    evidenceVersion: primary.evidenceVersion,
    evidenceHash: primary.evidenceHash,
    decisionKey: primary.decisionKey,
    correlationId,
    primaryRunId: primary.id,
    primaryMode: "PRIMARY",
    shadowRunId: shadow.id,
    shadowMode: "SHADOW",
    resultStatus: "EVALUATED",
    evaluationVersion: "compare-v1",
    differences: [],
    ...patch,
  };
}
async function claimCases(t, client, row) {
  await t.test(
    "claim reuses stable token despite a new request and rejects wrong current evidence",
    async () => {
      const first = await claim(client, row, "stable-key");
      const retry = await claim(client, row, "stable-key");
      assert.equal(retry.id, first.id);
      assert.equal(retry.claimToken, first.claimToken);
      await assert.rejects(claim(client, { ...row, currentEvidenceHash: "wrong" }), {
        code: "23514",
      });
    },
  );
  await t.test("only one evaluated PRIMARY wins; wrong token and shadow lose", async () => {
    const lease = await claim(client, row);
    const primary = run(lease),
      shadow = run(lease, { mode: "SHADOW", effective: null });
    await insert(client, "decision_runs", primary);
    await insert(client, "decision_runs", shadow);
    const commit = (token, id) =>
      client.query("SELECT public.decision_commit($1,$2,$3) AS won", [lease.id, token, id]);
    assert.equal((await commit("wrong", primary.id)).rows[0].won, false);
    assert.equal((await commit(lease.claimToken, shadow.id)).rows[0].won, false);
    assert.equal((await commit(lease.claimToken, primary.id)).rows[0].won, true);
    assert.equal((await commit(lease.claimToken, primary.id)).rows[0].won, false);
    assert.equal((await claim(client, row, lease.decisionKey)).winnerRunId, primary.id);
    await assert.rejects(insert(client, "decision_runs", run(lease)), { code: "23514" });
  });
}
async function runCases(t, client, row) {
  const lease = await claim(client, row);
  const primary = run(lease);
  await insert(client, "decision_runs", primary);
  await recordCases(t, client, primary);
  await fallbackCases(t, client, lease, primary);
  await comparisonCases(t, client, lease, primary);
  await invalidRunCases(t, client, lease);
}
async function recordCases(t, client, primary) {
  await t.test("run/type is unique and label projection cannot contradict result", async () => {
    const record = {
      ...binding,
      runId: primary.id,
      decisionType: "SEVERITY",
      suggested: "HIGH",
      effective: "HIGH",
    };
    await insert(client, "decision_records", record);
    await assert.rejects(insert(client, "decision_records", record), { code: "23505" });
    await assert.rejects(
      insert(client, "decision_records", {
        ...record,
        decisionType: "NOTIFICATION_ROUTE",
        suggested: "ESCALATE",
      }),
      { code: "23514" },
    );
  });
}
async function fallbackCases(t, client, lease, primary) {
  await t.test(
    "unavailable PRIMARY links an evaluated Rules fallback with immutable failure",
    async () => {
      const failure = run(lease, {
        resultStatus: "UNAVAILABLE",
        result: { schemaVersion: 1, correlationId, status: "UNAVAILABLE", code: "TIMEOUT" },
        effective: null,
      });
      await insert(client, "decision_runs", failure);
      await insert(
        client,
        "decision_runs",
        run(lease, {
          fallbackOf: failure.id,
          fallbackMode: "PRIMARY",
          fallbackStatus: "UNAVAILABLE",
        }),
      );
      await assert.rejects(
        insert(
          client,
          "decision_runs",
          run(lease, {
            fallbackOf: primary.id,
            fallbackMode: "PRIMARY",
            fallbackStatus: "UNAVAILABLE",
          }),
        ),
        { code: "23503" },
      );
    },
  );
}
async function comparisonCases(t, client, lease, primary) {
  const shadow = run(lease, { mode: "SHADOW", effective: null });
  const otherShadow = run(lease, { mode: "SHADOW", effective: null }),
    otherPrimary = run(lease);
  await insert(client, "decision_runs", shadow);
  await insert(client, "decision_runs", otherShadow);
  await insert(client, "decision_runs", otherPrimary);
  await t.test(
    "comparison binds evaluated PRIMARY and SHADOW to exact same evidence and correlation",
    async () => {
      await insert(client, "decision_comparisons", comparison(primary, shadow));
      for (const patch of [
        { evidenceHash: "other" },
        { evidenceVersion: "other" },
        { primaryRunId: otherShadow.id },
        { shadowRunId: otherPrimary.id },
        { correlationId: randomUUID() },
        { decisionKey: "other" },
        { workspaceId: "other" },
      ])
        await assert.rejects(
          insert(
            client,
            "decision_comparisons",
            comparison(primary, shadow, { evaluationVersion: randomUUID(), ...patch }),
          ),
          { code: "23503" },
        );
    },
  );
}
async function invalidRunCases(t, client, lease) {
  const evaluated = run(lease).result;
  const patches = [
    { mode: "SHADOW" },
    { rulesetVersion: "other" },
    { claimToken: "wrong" },
    { result: { ...evaluated, confidenceMetadata: 0.9 } },
    { result: { ...evaluated, confidenceMetadata: { kind: "PROBABILITY", value: 0.9 } } },
    { result: { ...evaluated, vendorPayload: {} } },
    { result: { ...evaluated, labels: { ...labels, severity: "MADE_UP" } } },
    { effective: { ...labels, notificationRoute: "ESCALATE" } },
  ];
  for (const [index, patch] of patches.entries())
    await t.test(`invalid run boundary ${index}`, () =>
      assert.rejects(insert(client, "decision_runs", run(lease, patch)), {
        code: index === 2 ? "23503" : "23514",
      }),
    );
  await t.test("known host acceptance remains typed boolean and null is preserved", async () => {
    const confidenceMetadata = {
      kind: "HOST_ACCEPTANCE",
      value: false,
      semanticsVersion: "host-acceptance-v1",
      calibrationVersion: null,
    };
    const stored = (
      await insert(
        client,
        "decision_runs",
        run(lease, { result: { ...evaluated, confidenceMetadata } }),
      )
    ).rows[0];
    assert.deepEqual(stored.result.confidenceMetadata, confidenceMetadata);
  });
}
async function immutableCases(t, client) {
  for (const table of ["decision_runs", "decision_records", "decision_comparisons"])
    for (const sql of [
      `UPDATE ${table} SET "organizationId"="organizationId"`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table} CASCADE`,
    ])
      await t.test(`immutable history: ${sql}`, () =>
        assert.rejects(client.query(sql), { code: "23514" }),
      );
  await t.test("claim token and deadline cannot be rewritten by operator", () =>
    assert.rejects(client.query('UPDATE decision_claims SET "expiresAt"=now()'), { code: "23514" }),
  );
}
test("versioned decision storage enforces evidence, authority, history and atomic claims", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    assert.equal(
      (await client.query("SELECT to_regclass('public.decision_runs') AS name")).rows[0].name,
      "decision_runs",
    );
    await fixture(client);
    const row = await appendEvent(client);
    await context(client, "decision-OWNER", async () => {
      await claimCases(t, client, row);
      await runCases(t, client, row);
    });
    await context(client, "decision-OWNER", async () => {
      const lease = await claim(client, row);
      await insert(client, "decision_runs", run(lease));
    });
    await immutableCases(t, client);
  });
});
async function expiryCases(t, client, row) {
  await t.test(
    "native database deadline rejects late winner and raw outcome insertion",
    async () => {
      const lease = await claim(client, row, "expires", new Date(Date.now() + 1000));
      const terminal = run(lease);
      await insert(client, "decision_runs", terminal);
      await client.query("SELECT pg_sleep(1.05)");
      assert.equal(await commit(client, lease, terminal.id), false);
      await assert.rejects(insert(client, "decision_runs", run(lease)), { code: "23514" });
      await assert.rejects(
        client.query('UPDATE decision_claims SET "winnerRunId"=$1 WHERE id=$2', [
          terminal.id,
          lease.id,
        ]),
        { code: "23514" },
      );
      assert.equal((await claim(client, row, "expires")).claimToken, lease.claimToken);
    },
  );
  await t.test("null or malformed claim values cannot bypass checks", async () => {
    const args = [
      row.id,
      row.currentEvidenceId,
      row.currentEvidenceVersion,
      row.currentEvidenceHash,
      "valid-key",
      "valid-token",
      new Date(Date.now() + 60_000),
    ];
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const values = [...args];
      values[index] = null;
      await assert.rejects(client.query("SELECT decision_claim($1,$2,$3,$4,$5,$6,$7)", values), {
        code: "23514",
      });
    }
  });
}
async function supersededCases(t, client, row) {
  const lease = await claim(client, row),
    terminal = run(lease);
  await insert(client, "decision_runs", terminal);
  const nextId = randomUUID();
  await insert(
    client,
    "event_evidence",
    evidence(row, { id: nextId, evidenceRevision: 2, version: "v2" }),
  );
  await client.query(
    'UPDATE events SET "currentEvidenceId"=$1,"currentEvidenceVersion"=$2,revision=2 WHERE id=$3',
    [nextId, "v2", row.id],
  );
  await t.test(
    "superseded full evidence rejects winner and late direct PRIMARY append",
    async () => {
      assert.equal(
        (
          await client.query("SELECT decision_commit($1,$2,$3) AS won", [
            lease.id,
            lease.claimToken,
            terminal.id,
          ])
        ).rows[0].won,
        false,
      );
      await assert.rejects(insert(client, "decision_runs", run(lease)), { code: "23514" });
      await assert.rejects(
        client.query('UPDATE decision_claims SET "winnerRunId"=$1 WHERE id=$2', [
          terminal.id,
          lease.id,
        ]),
        { code: "23514" },
      );
    },
  );
}
test("expired and superseded tokens cannot publish through SQL bypasses", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const row = await appendEvent(client);
    await context(client, "decision-OWNER", async () => {
      await expiryCases(t, client, row);
      await supersededCases(t, client, row);
    });
  });
});
async function capabilities(client, url, action) {
  const connections = [];
  try {
    for (const role of ["reader", "writer", "ungranted"]) {
      const name = `decision_${role}_${randomUUID().replaceAll("-", "")}`;
      assert.match(name, /^[a-z0-9_]+$/u);
      await client.query(`CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      if (role !== "ungranted") await client.query(`GRANT shopmate_decision_${role} TO ${name}`);
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
async function writerCases(t, roles, row) {
  await t.test("restricted assigned OPERATOR claims, appends and chooses one winner", () =>
    context(roles.writer, "decision-OPERATOR", async () => {
      const lease = await claim(roles.writer, row),
        terminal = run(lease);
      await insert(roles.writer, "decision_runs", terminal);
      await insert(roles.writer, "decision_records", {
        ...binding,
        runId: terminal.id,
        decisionType: "SEVERITY",
        suggested: "HIGH",
        effective: "HIGH",
      });
      assert.equal(await commit(roles.writer, lease, terminal.id), true);
      await assert.rejects(insert(roles.writer, "decision_runs", run(lease)), { code: "23514" });
      await assert.rejects(
        roles.writer.query('UPDATE decision_claims SET "winnerRunId"=$1', [terminal.id]),
        { code: "42501" },
      );
      await assert.rejects(insert(roles.writer, "decision_claims", lease), { code: "42501" });
    }),
  );
  await t.test("VIEWER cannot claim even with writer database capability", () =>
    context(roles.writer, "decision-VIEWER", async () => {
      await assert.rejects(claim(roles.writer, row), { code: "42501" });
    }),
  );
  await assert.rejects(roles.reader.query("DELETE FROM decision_runs"), { code: "42501" });
  await assert.rejects(roles.ungranted.query("SELECT * FROM decision_runs"), { code: "42501" });
  await assert.rejects(claim(roles.ungranted, row), { code: "42501" });
}
async function readerCases(t, client, roles, row) {
  for (const user of ["OWNER", "OPERATOR", "VIEWER"])
    await t.test(`${user} reads immutable assigned decision history`, () =>
      context(roles.reader, `decision-${user}`, async () => {
        assert.equal((await roles.reader.query("SELECT * FROM decision_runs")).rowCount, 1);
      }),
    );
  await missingScopeCases(t, roles, row);
  await revokedCases(t, client, roles, row);
}
async function missingScopeCases(t, roles, row) {
  for (const key of [
    "user_id",
    "organization_id",
    "workspace_id",
    "store_id",
    "connection_id",
    "external_store_id",
  ])
    await t.test(`missing ${key} defaults deny reads and claims`, async () => {
      await context(
        roles.reader,
        "decision-OWNER",
        async () => {
          assert.equal((await roles.reader.query("SELECT * FROM decision_runs")).rowCount, 0);
        },
        { [key]: "" },
      );
      await context(
        roles.writer,
        "decision-OWNER",
        () => assert.rejects(claim(roles.writer, row), { code: "42501" }),
        { [key]: "" },
      );
    });
}
async function revokedCases(t, client, roles, row) {
  await t.test("revoked live membership denies reads, appends and winner commit", async () => {
    const lease = await context(roles.writer, "decision-OPERATOR", () => claim(roles.writer, row));
    await client.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
      "INACTIVE",
      "decision-OPERATOR",
    ]);
    await context(roles.writer, "decision-OPERATOR", async () => {
      assert.equal((await roles.writer.query("SELECT * FROM decision_runs")).rowCount, 0);
      await assert.rejects(claim(roles.writer, row), { code: "42501" });
      await assert.rejects(insert(roles.writer, "decision_runs", run(lease)), { code: "42501" });
      assert.equal(await commit(roles.writer, lease, "absent"), false);
    });
  });
}
test("forced decision RLS defaults deny and rechecks current membership", async (t) => {
  await withDatabase(async (client, url) => {
    await migrate(client);
    await fixture(client);
    const row = await appendEvent(client);
    await capabilities(client, url, async (roles) => {
      await writerCases(t, roles, row);
      await readerCases(t, client, roles, row);
    });
  });
});
function prisma(url, args) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)), ...args],
    {
      cwd: root,
      env: tenantEnvironment(process.env, requireIsolatedDatabaseUrl(url)),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    },
  );
}
test("Prisma deploy mirrors decision storage without drift exclusions", async () => {
  await withDatabase(async (client, url) => {
    assert.match(prisma(url, ["migrate", "deploy"]), /20261031090000_decision_records/u);
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
    assert.equal((await client.query("SELECT * FROM decision_claims")).rowCount, 0);
  });
});
async function scopedHistory(client, row, scope, user) {
  const settings = Object.fromEntries(
    Object.entries(scope).map(([key, value]) => [
      key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
  return context(
    client,
    user,
    async () => {
      const lease = await claim(client, row);
      const failure = run(lease, {
        ...scope,
        resultStatus: "UNAVAILABLE",
        effective: null,
        result: { schemaVersion: 1, correlationId, status: "UNAVAILABLE", code: "TIMEOUT" },
      });
      const primary = run(lease, scope),
        shadow = run(lease, { ...scope, mode: "SHADOW", effective: null });
      for (const outcome of [failure, primary, shadow])
        await insert(client, "decision_runs", outcome);
      return { lease, failure, primary, shadow };
    },
    settings,
  );
}
test("actual foreign tenant fallback and comparison references are rejected", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const foreignScope = Object.fromEntries(
      Object.entries(binding).map(([key, value]) => [key, value.replace(/a$/u, "b")]),
    );
    const local = await scopedHistory(client, await appendEvent(client), binding, "decision-OWNER");
    const foreign = await scopedHistory(
      client,
      await appendEvent(client, foreignScope),
      foreignScope,
      "decision-b-owner",
    );
    await context(client, "decision-OWNER", () =>
      foreignReferenceCases(t, client, local, foreign, foreignScope),
    );
  });
});
async function foreignReferenceCases(t, client, local, foreign, foreignScope) {
  await t.test("foreign fallback cannot attach to local claim even with matching correlation", () =>
    assert.rejects(
      insert(
        client,
        "decision_runs",
        run(local.lease, {
          fallbackOf: foreign.failure.id,
          fallbackMode: "PRIMARY",
          fallbackStatus: "UNAVAILABLE",
        }),
      ),
      { code: "23503" },
    ),
  );
  await t.test("foreign SHADOW cannot compare with local PRIMARY", () =>
    assert.rejects(
      insert(client, "decision_comparisons", comparison(local.primary, foreign.shadow)),
      { code: "23503" },
    ),
  );
  for (const key of Object.keys(binding))
    await t.test(`run cannot mix foreign ${key}`, () =>
      assert.rejects(
        insert(client, "decision_runs", run(local.lease, { [key]: foreignScope[key] })),
        { code: "23503" },
      ),
    );
}
async function concurrentClaims(client, url, row) {
  const other = new pg.Client({ connectionString: url });
  await other.connect();
  try {
    const [first, second] = await Promise.all([
      context(client, "decision-OWNER", () => claim(client, row, "race-key")),
      context(other, "decision-OWNER", () => claim(other, row, "race-key")),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(first.claimToken, second.claimToken);
    const left = run(first),
      right = run(second);
    await context(client, "decision-OWNER", () => insert(client, "decision_runs", left));
    await context(other, "decision-OWNER", () => insert(other, "decision_runs", right));
    const winners = await Promise.all([
      context(client, "decision-OWNER", () => commit(client, first, left.id)),
      context(other, "decision-OWNER", () => commit(other, second, right.id)),
    ]);
    assert.deepEqual(winners.toSorted(), [false, true]);
    assert.equal((await client.query("SELECT count(*) FROM decision_claims")).rows[0].count, "1");
  } finally {
    await other.end();
  }
}
test("separate PostgreSQL connections share one stable claim and one primary winner", async () => {
  await withDatabase(async (client, url) => {
    await migrate(client);
    await fixture(client);
    await concurrentClaims(client, url, await appendEvent(client));
  });
});
async function invalidCorrelations(client, lease) {
  for (const value of [null, 123, "malformed", randomUUID()])
    for (const resultStatus of ["EVALUATED", "UNAVAILABLE"]) {
      const result =
        resultStatus === "EVALUATED"
          ? { ...run(lease).result, correlationId: value }
          : { schemaVersion: 1, status: resultStatus, correlationId: value, code: "TIMEOUT" };
      await assert.rejects(
        insert(
          client,
          "decision_runs",
          run(lease, {
            resultStatus,
            result,
            effective: resultStatus === "EVALUATED" ? labels : null,
          }),
        ),
        { code: "23514" },
      );
    }
}
async function uppercaseHistory(client, lease) {
  await invalidCorrelations(client, lease);
  const uppercase = correlationId.toUpperCase();
  const failure = run(lease, {
    correlationId: uppercase,
    resultStatus: "UNAVAILABLE",
    effective: null,
    result: { schemaVersion: 1, correlationId: uppercase, status: "UNAVAILABLE", code: "TIMEOUT" },
  });
  const primary = run(lease, {
    correlationId: uppercase,
    fallbackOf: failure.id,
    fallbackMode: "PRIMARY",
    fallbackStatus: "UNAVAILABLE",
    result: { ...run(lease).result, correlationId: uppercase },
  });
  const shadow = run(lease, {
    correlationId: uppercase,
    mode: "SHADOW",
    effective: null,
    result: { ...run(lease).result, correlationId: uppercase },
  });
  for (const outcome of [failure, primary, shadow]) {
    DecisionResultSchema.parse(outcome.result);
    const stored = (await insert(client, "decision_runs", outcome)).rows[0];
    assert.equal(stored.result.correlationId, uppercase);
    assert.equal(stored.correlationId, correlationId);
  }
  await insert(
    client,
    "decision_comparisons",
    comparison(primary, shadow, { correlationId: uppercase }),
  );
  assert.equal(await commit(client, lease, primary.id), true);
}
test("uppercase UUID correlation preserves original result JSON through fallback and comparison", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const row = await appendEvent(client);
    await context(client, "decision-OWNER", async () =>
      uppercaseHistory(client, await claim(client, row)),
    );
  });
});

function correlatedRun(lease, value, resultStatus) {
  const result =
    resultStatus === "EVALUATED"
      ? { ...run(lease).result, correlationId: value }
      : { schemaVersion: 1, status: resultStatus, correlationId: value, code: "TIMEOUT" };
  return run(lease, {
    correlationId: value,
    resultStatus,
    result,
    effective: resultStatus === "EVALUATED" ? labels : null,
  });
}
async function uuidSemantics(t, client, lease) {
  const invalid = [
    "00000000-0000-0000-0000-000000000001",
    "c4c2bd72-d62c-0c26-8ec7-43d90249e36a",
    "c4c2bd72-d62c-9c26-8ec7-43d90249e36a",
    "c4c2bd72-d62c-fc26-8ec7-43d90249e36a",
    ...["0", "7", "c", "f"].map((variant) => `c4c2bd72-d62c-4c26-${variant}ec7-43d90249e36a`),
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
  ];
  const valid = ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"];
  for (let version = 1; version <= 8; version++)
    for (const variant of ["8", "9", "a", "b"])
      valid.push(`C4C2BD72-D62C-${version}C26-${variant.toUpperCase()}EC7-43D90249E36A`);
  for (const value of [...invalid, ...valid])
    for (const status of ["EVALUATED", "UNAVAILABLE"])
      await t.test(`${status} UUID semantics ${value}`, async () => {
        const outcome = correlatedRun(lease, value, status);
        assert.equal(DecisionResultSchema.safeParse(outcome.result).success, valid.includes(value));
        if (invalid.includes(value))
          await assert.rejects(insert(client, "decision_runs", outcome), { code: "23514" });
        else {
          const stored = (await insert(client, "decision_runs", outcome)).rows[0];
          assert.equal(stored.result.correlationId, value);
          assert.equal(stored.correlationId, value.toLowerCase());
        }
      });
}
test("stored result UUID version and variant semantics match the shared contract", async (t) => {
  await withDatabase(async (client) => {
    await migrate(client);
    await fixture(client);
    const row = await appendEvent(client);
    await context(client, "decision-OWNER", async () =>
      uuidSemantics(t, client, await claim(client, row)),
    );
  });
});

function incompressibleId(length) {
  const bytes = randomBytes(length * 2);
  return ExternalIdSchema.parse(
    Array.from({ length }, (_, index) =>
      String.fromCharCode(0x4e00 + (bytes.readUInt16BE(index * 2) % 20_000)),
    ).join(""),
  );
}
async function longHistory(client, row, makeId, scope = binding) {
  const key = makeId(),
    token = makeId();
  const lease = await claim(client, row, key, new Date(Date.now() + 60_000), token);
  assert.equal((await claim(client, row, key)).id, lease.id);
  assert.equal(lease.claimToken, token);
  const failure = run(lease, {
    ...scope,
    id: makeId(),
    resultStatus: "UNAVAILABLE",
    effective: null,
    result: { schemaVersion: 1, correlationId, status: "UNAVAILABLE", code: "TIMEOUT" },
  });
  const primary = run(lease, {
    ...scope,
    id: makeId(),
    fallbackOf: failure.id,
    fallbackMode: "PRIMARY",
    fallbackStatus: "UNAVAILABLE",
  });
  const shadow = run(lease, { ...scope, id: makeId(), mode: "SHADOW", effective: null });
  for (const outcome of [failure, primary, shadow]) await insert(client, "decision_runs", outcome);
  await longProjections(client, primary, shadow, scope, makeId);
  await exactBindingCases(client, lease, primary, shadow);
  assert.equal(await commit(client, lease, primary.id), true);
}
async function longProjections(client, primary, shadow, scope, makeId) {
  await insert(client, "decision_records", {
    ...scope,
    runId: primary.id,
    decisionType: "SEVERITY",
    suggested: "HIGH",
    effective: "HIGH",
  });
  await insert(
    client,
    "decision_comparisons",
    comparison(primary, shadow, {
      ...scope,
      id: makeId(),
      evaluationVersion: makeId(),
    }),
  );
}
async function exactBindingCases(client, lease, primary, shadow) {
  const scope = Object.fromEntries(Object.keys(binding).map((key) => [key, primary[key]]));
  for (const field of [
    "eventId",
    "fingerprint",
    "evidenceId",
    "evidenceVersion",
    "evidenceHash",
    "decisionKey",
  ])
    for (const table of ["decision_runs", "decision_comparisons"]) {
      const row =
        table === "decision_runs" ? run(lease, scope) : comparison(primary, shadow, scope);
      await assert.rejects(insert(client, table, { ...row, [field]: "other" }), { code: "23503" });
    }
  for (const field of Object.keys(binding))
    await assert.rejects(
      insert(
        client,
        "decision_comparisons",
        comparison(primary, shadow, {
          ...scope,
          [field]: "other",
        }),
      ),
      { code: "23503" },
    );
}
function supplementaryId() {
  const bytes = randomBytes(256);
  return ExternalIdSchema.parse(
    Array.from({ length: 128 }, (_, index) =>
      String.fromCodePoint(0x20000 + (bytes.readUInt16BE(index * 2) % 0x8000)),
    ).join(""),
  );
}
async function literalSize(client, value, bytes, characters) {
  assert.equal(value.length, 256);
  assert.equal(Buffer.byteLength(value), bytes);
  const stored = await client.query(
    "SELECT octet_length($1::text) AS bytes, char_length($1::text) AS characters, metric_literal($1) AS valid",
    [value],
  );
  assert.deepEqual(stored.rows[0], { bytes, characters, valid: true });
  assert.equal(ExternalIdSchema.safeParse(value + "a").success, false);
  assert.equal(
    (await client.query("SELECT metric_literal($1) AS valid", [value + "a"])).rows[0].valid,
    false,
  );
}
for (const [name, makeId, bytes, characters] of [
  ["CJK", () => incompressibleId(256), 768, 256],
  ["supplementary", supplementaryId, 512, 128],
])
  test(`maximum ${name} references fit decision indexes after event evidence accepts them`, async () => {
    await withDatabase(async (client) => {
      await migrate(client);
      await fixture(client);
      await literalSize(client, makeId(), bytes, characters);
      const row = await appendEvent(client, binding, {
        id: makeId(),
        currentEvidenceId: makeId(),
        currentEvidenceVersion: makeId(),
      });
      assert.equal((await client.query("SELECT count(*) FROM event_evidence")).rows[0].count, "1");
      await context(client, "decision-OWNER", () => longHistory(client, row, makeId));
    });
  });

async function maximumTenant(client, scope) {
  await client.query('INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())', [
    "decision-max",
  ]);
  await client.query(
    'UPDATE "Organization" SET "legacyMerchantId"=NULL WHERE "legacyMerchantId"=$1',
    ["decision-max"],
  );
  await client.query(
    'INSERT INTO "Organization" (id,name,"legacyMerchantId","updatedAt") VALUES ($1,$1,$2,now())',
    [scope.organizationId, "decision-max"],
  );
  await client.query(
    'INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,now())',
    [scope.workspaceId, scope.organizationId],
  );
}
async function maximumScopeFixture(client) {
  const scope = Object.fromEntries(
    Object.keys(binding).map((key) => [
      key,
      key === "externalStoreId"
        ? incompressibleId(144) + supplementaryId().slice(0, 112)
        : randomBytes(64).toString("hex"),
    ]),
  );
  await maximumTenant(client, scope);
  await client.query(
    'INSERT INTO "Store" (id,"merchantId",name,city,platform,"organizationId","workspaceId") VALUES ($1,$2,$1,$3,$4,$5,$6)',
    [scope.storeId, "decision-max", "Shanghai", "MOCK", scope.organizationId, scope.workspaceId],
  );
  await client.query(
    'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES ($1,$2,$3,$4,$5)',
    [
      scope.connectionId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.externalStoreId,
    ],
  );
  await client.query(
    'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$1,$3,now())',
    ["decision-OWNER", scope.organizationId, "OWNER"],
  );
  return scope;
}
test("maximum tenant scope and CJK token fit scoped decision indexes", async () => {
  await withDatabase(async (client) => {
    await migrate(client);
    const scope = await maximumScopeFixture(client);
    await literalSize(client, scope.externalStoreId, 656, 200);
    const row = await appendEvent(client, scope);
    const settings = Object.fromEntries(
      Object.entries(scope).map(([key, value]) => [
        key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
        value,
      ]),
    );
    await context(
      client,
      "decision-OWNER",
      () => longHistory(client, row, () => incompressibleId(256), scope),
      settings,
    );
  });
});
