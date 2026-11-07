import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { requireIsolatedDatabaseUrl } from "./isolated-postgres.mjs";

export const migrationName = "20261103100000_notification_outbox";
const root = new URL("../../", import.meta.url);
const migrations = new URL("prisma/migrations/", root);
export const time = "2026-11-03T00:00:00.000Z";
export const later = "2026-11-03T00:01:00.000Z";
export const binding = {
  organizationId: "note-org-a",
  workspaceId: "note-workspace-a",
  storeId: "note-store-a",
  connectionId: "note-connection-a",
  externalStoreId: "external/store a.1",
};
export const other = {
  organizationId: "note-org-b",
  workspaceId: "note-workspace-b",
  storeId: "note-store-b",
  connectionId: "note-connection-b",
  externalStoreId: "external/store b.1",
};
export const publicColumns = [
  "intentId",
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
  "recipientUserId",
  "eventId",
  "eventState",
  "eventRevision",
  "channel",
  "decisionRunId",
  "route",
  "eventType",
  "severity",
  "createdAt",
  "notBefore",
  "evidenceId",
  "evidenceVersion",
  "evidenceHash",
  "entityKind",
  "entityId",
  "definitionVersion",
  "baselineVersion",
];

export function prisma(url, args) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL("node_modules/prisma/build/index.js", root)), ...args],
    {
      cwd: fileURLToPath(root),
      env: { ...process.env, DATABASE_URL: url.toString() },
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    },
  );
}
export function drift(url) {
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
}
export async function migrate(admin, prior = false) {
  for (const name of (await readdir(migrations)).filter((name) => /^\d{14}_/u.test(name)).sort()) {
    if (prior && name === migrationName) continue;
    await admin.query(await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"));
  }
}
export async function notificationMigration(admin) {
  await admin.query(await readFile(new URL(`${migrationName}/migration.sql`, migrations), "utf8"));
}
export async function historyHashes() {
  const { createHash } = await import("node:crypto");
  const names = (await readdir(migrations))
    .filter((name) => /^\d{14}_/u.test(name) && name !== migrationName)
    .sort();
  return Promise.all(
    names.map(async (name) => [
      name,
      createHash("sha256")
        .update(await readFile(new URL(`${name}/migration.sql`, migrations)))
        .digest("hex"),
    ]),
  );
}
export async function database(action) {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Notification proof requires owned isolated runner URL");
  const serverUrl = requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
  const operator = new pg.Client({ connectionString: serverUrl });
  const name = `shopmate_tenant_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const state = { operator, name, url, sessions: [], logins: [], created: false, admin: null };
  await operator.connect();
  try {
    await operator.query(`CREATE DATABASE "${name}"`);
    state.created = true;
    state.admin = new pg.Client({ connectionString: url.toString() });
    await state.admin.connect();
    await action(state);
  } finally {
    await cleanup(state);
  }
}
async function cleanup(state) {
  const failures = [];
  for (const client of state.sessions) await cleanupStep(() => client.end(), failures);
  if (state.admin) await cleanupStep(() => state.admin.end(), failures);
  if (state.created)
    await cleanupStep(
      () => state.operator.query(`DROP DATABASE "${state.name}" WITH (FORCE)`),
      failures,
    );
  for (const name of state.logins)
    await cleanupStep(() => state.operator.query(`DROP ROLE IF EXISTS "${name}"`), failures);
  await cleanupStep(() => state.operator.end(), failures);
  if (failures.length) throw new AggregateError(failures, "Notification resource cleanup failed");
}
async function cleanupStep(action, failures) {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}
export async function login(state, capability) {
  const name = `note_${randomUUID().replaceAll("-", "")}`;
  const password = randomBytes(32).toString("hex");
  const formatted = await state.admin.query(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',$1::text,$2::text) AS command",
    [name, password],
  );
  state.logins.push(name);
  await state.admin.query(formatted.rows[0].command);
  if (capability) {
    assert.match(capability, /^shopmate_notification_(?:enqueuer|worker|recipient)$/u);
    await state.admin.query(`GRANT ${capability} TO "${name}"`);
  }
  const url = new URL(state.url);
  url.username = name;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  state.sessions.push(client);
  await client.connect();
  if (capability) await client.query(`SET ROLE ${capability}`);
  client.notificationLogin = name;
  return client;
}
export async function seedBinding(admin, scope = binding, merchant = "note-merchant-a") {
  await admin.query('ALTER TABLE "Merchant" DISABLE TRIGGER "Merchant_initialize_tenant"');
  try {
    await admin.query('INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())', [
      merchant,
    ]);
  } finally {
    await admin.query('ALTER TABLE "Merchant" ENABLE TRIGGER "Merchant_initialize_tenant"');
  }
  await admin.query(
    'INSERT INTO "Organization" (id,name,"legacyMerchantId","updatedAt") VALUES ($1,$1,$2,now())',
    [scope.organizationId, merchant],
  );
  await admin.query(
    'INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,now())',
    [scope.workspaceId, scope.organizationId],
  );
  await seedStore(admin, scope, merchant);
}
export async function seedStore(admin, scope, merchant = "note-merchant-a") {
  await admin.query(
    'INSERT INTO "Store" (id,"merchantId",name,city,platform,"organizationId","workspaceId") VALUES ($1,$2,$1,$3,$4,$5,$6)',
    [scope.storeId, merchant, "Shanghai", "MOCK", scope.organizationId, scope.workspaceId],
  );
  await admin.query(
    'INSERT INTO "PlatformConnection" (id,"organizationId","workspaceId","storeId","externalStoreId") VALUES ($1,$2,$3,$4,$5)',
    [
      scope.connectionId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.externalStoreId,
    ],
  );
}
export async function members(admin, scope = binding) {
  for (const [user, role] of [
    ["owner", "OWNER"],
    ["admin", "ADMIN"],
    ["operator", "OPERATOR"],
    ["recipient", "VIEWER"],
    ["second", "VIEWER"],
    ["readonly", "ANALYST"],
  ]) {
    await admin.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      [randomUUID(), scope.organizationId, user, role],
    );
    if (!["OWNER", "ADMIN"].includes(role))
      await admin.query(
        'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
        [randomUUID(), scope.organizationId, scope.workspaceId, user],
      );
  }
}
export async function fixture(action) {
  await database(async (state) => {
    await migrate(state.admin);
    await seedBinding(state.admin);
    await seedBinding(state.admin, other, "note-merchant-b");
    await members(state.admin);
    await members(state.admin, other);
    state.enqueuer = await login(state, "shopmate_notification_enqueuer");
    state.worker = await login(state, "shopmate_notification_worker");
    state.recipient = await login(state, "shopmate_notification_recipient");
    await context(state.enqueuer);
    await context(state.worker);
    await context(state.recipient, "recipient");
    await workerGrant(state);
    await action(state);
  });
}
export async function context(client, user = "owner", scope = binding) {
  const settings = {
    user_id: user,
    organization_id: scope.organizationId,
    workspace_id: scope.workspaceId,
    store_id: scope.storeId,
    connection_id: scope.connectionId,
    external_store_id: scope.externalStoreId,
  };
  for (const [key, value] of Object.entries(settings))
    await client.query("SELECT set_config($1,$2,false)", [`app.${key}`, value]);
}
export async function workerGrant(
  state,
  client = state.worker,
  scope = binding,
  principal = "owner",
  generation = 0,
) {
  await state.admin.query(
    'INSERT INTO notification_worker_grants ("databaseRole","connectionId","organizationId","workspaceId","storeId","externalStoreId","principalUserId","connectionGeneration") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      client.notificationLogin,
      scope.connectionId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.externalStoreId,
      principal,
      generation,
    ],
  );
}
export function pending(patch = {}, scope = binding) {
  return {
    intentId: randomUUID(),
    ...scope,
    recipientUserId: "recipient",
    eventId: randomUUID(),
    eventState: "OPEN",
    eventRevision: "1",
    channel: "IN_APP",
    decisionRunId: "run/opaque .1",
    route: "NOTIFY_NOW",
    eventType: "REVENUE_DROP",
    severity: "HIGH",
    createdAt: time,
    notBefore: time,
    evidenceId: "evidence/opaque .1",
    evidenceVersion: "version .1",
    evidenceHash: "sha256:opaque .1",
    entityKind: "STORE",
    entityId: null,
    definitionVersion: "definition .1",
    baselineVersion: null,
    connectionGeneration: 0,
    nextAttemptAt: time,
    ...patch,
  };
}
export async function insert(client, row = pending(), conflict = false) {
  const allowed = new Set([...publicColumns, "connectionGeneration", "nextAttemptAt"]);
  assert.ok(
    Object.keys(row).every((key) => allowed.has(key)),
    "fixed notification insert allowlist",
  );
  const columns = Object.keys(row)
    .map((key) => `"${key}"`)
    .join(",");
  const params = Object.values(row);
  const suffix = conflict
    ? "ON CONFLICT ON CONSTRAINT notification_outbox_natural_key DO NOTHING"
    : "";
  return client.query(
    `INSERT INTO notification_outbox (${columns}) VALUES (${params.map((_, i) => `$${i + 1}`).join(",")}) ${suffix} RETURNING *`,
    params,
  );
}
export async function update(client, id, patch) {
  const allowed = new Set([
    "status",
    "attempt",
    "nextAttemptAt",
    "leaseToken",
    "leaseUntil",
    "deliveredAt",
  ]);
  assert.ok(Object.keys(patch).every((key) => allowed.has(key)));
  const assignments = Object.keys(patch)
    .map((key, i) => `"${key}"=$${i + 2}`)
    .join(",");
  return client.query(
    `UPDATE notification_outbox SET ${assignments} WHERE "rowId"=$1 RETURNING *`,
    [id, ...Object.values(patch)],
  );
}
export async function lease(client, id, patch = {}) {
  return update(client, id, {
    status: "LEASED",
    attempt: 1,
    nextAttemptAt: null,
    leaseToken: "lease/opaque .1",
    leaseUntil: later,
    ...patch,
  });
}
export async function deliver(state, row = pending()) {
  const saved = (await insert(state.enqueuer, row)).rows[0];
  await lease(state.worker, saved.rowId);
  await update(state.worker, saved.rowId, {
    status: "DELIVERED",
    leaseToken: null,
    leaseUntil: null,
    deliveredAt: later,
  });
  return saved;
}
export async function transaction(client, action) {
  await client.query("BEGIN");
  try {
    const value = await action();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
export async function count(client, table = "notification_outbox") {
  assert.ok(["notification_outbox", "recipient_inbox"].includes(table));
  return Number((await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}
export async function connectionPatch(admin, field, value) {
  assert.ok(["generation", "status"].includes(field));
  await transaction(admin, async () => {
    // These are synthetic parent fixtures; unrelated demo runtime control is outside this card.
    await admin.query(
      'ALTER TABLE "PlatformConnection" DISABLE TRIGGER source_control_connection_update',
    );
    await admin.query(
      'ALTER TABLE "PlatformConnection" DISABLE TRIGGER source_control_connection_row',
    );
    await admin.query(`UPDATE "PlatformConnection" SET "${field}"=$1 WHERE id=$2`, [
      value,
      binding.connectionId,
    ]);
    await admin.query(
      'ALTER TABLE "PlatformConnection" ENABLE TRIGGER source_control_connection_row',
    );
    await admin.query(
      'ALTER TABLE "PlatformConnection" ENABLE TRIGGER source_control_connection_update',
    );
  });
}
export async function expectCode(action, code = "42501") {
  await assert.rejects(action, { code });
}
