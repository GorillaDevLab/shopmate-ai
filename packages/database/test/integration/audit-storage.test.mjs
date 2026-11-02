import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { TenantAuditEventSchema, AuditEventTypeSchema } from "@shopmate/contracts";
import { requireIsolatedDatabaseUrl } from "../helpers/isolated-postgres.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Audit proof requires owned isolated runner URL");
const serverUrl = requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
const migrations = new URL("../../prisma/migrations/", import.meta.url);
const auditMigration = "20261103090000_audit_append_foundation";
const scope = {
  organizationId: "legacy-org-audit-a",
  workspaceId: "legacy-workspace-audit-a",
  storeId: "audit-store-a",
};
const otherStore = { ...scope, storeId: "audit-store-c" };
const hash = "a".repeat(64);
const instant = "2026-11-03T00:00:00.000Z";

async function database(action) {
  const operator = new pg.Client({ connectionString: serverUrl });
  await operator.connect();
  const name = `shopmate_tenant_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  let client;
  const logins = [];
  try {
    await operator.query(`CREATE DATABASE "${name}"`);
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await action(client, url, logins);
  } finally {
    if (client) await client.end();
    try {
      await operator.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const name of logins) await operator.query(`DROP ROLE "${name}"`);
    } finally {
      await operator.end();
    }
  }
}
async function migrate(client, mode) {
  const names = (await readdir(migrations)).filter((name) => /^\d{14}_/u.test(name)).sort();
  for (const name of names.filter((name) => mode !== "baseline" || name < auditMigration))
    await client.query(await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"));
}
async function fixture(client) {
  for (const key of ["a", "b"]) {
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`audit-${key}`],
    );
    await client.query(
      'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
      [`audit-store-${key}`, `audit-${key}`, "Shanghai", "MOCK"],
    );
  }
  await client.query(
    'INSERT INTO "Store" (id,"merchantId",name,city,platform) VALUES ($1,$2,$1,$3,$4)',
    [otherStore.storeId, "audit-a", "Shanghai", "MOCK"],
  );
  for (const [user, role] of [
    ["audit-owner", "OWNER"],
    ["audit-viewer", "VIEWER"],
    ["audit-operator", "OPERATOR"],
  ]) {
    await client.query(
      'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$1,$3,now())',
      [user, scope.organizationId, role],
    );
    await client.query(
      'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
      [randomUUID(), scope.organizationId, scope.workspaceId, user],
    );
  }
}
async function login(client, url, names, capability) {
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^[a-z0-9_]+$/u);
  const password = randomBytes(32).toString("hex");
  await client.query(
    `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`,
  );
  names.push(name);
  if (capability) {
    assert.match(
      capability,
      /^shopmate_(?:audit_(?:reader|writer|service_writer)|auth_security_writer)$/u,
    );
    await client.query(`GRANT ${capability} TO "${name}"`);
  }
  const restricted = new URL(url);
  restricted.username = name;
  restricted.password = password;
  const connection = new pg.Client({ connectionString: restricted.toString() });
  await connection.connect();
  if (capability) await connection.query(`SET ROLE ${capability}`);
  return connection;
}
async function context(client, user = "audit-owner", binding = scope) {
  for (const [key, value] of Object.entries({
    user_id: user,
    organization_id: binding.organizationId,
    workspace_id: binding.workspaceId,
    store_id: binding.storeId,
  }))
    await client.query("SELECT set_config($1,$2,false)", [`app.${key}`, value]);
}
function event(patch = {}, binding = scope) {
  return {
    scopeKind: "TENANT",
    scope: binding,
    actor: { actorId: "audit-owner", actorKind: "USER", identitySource: "SERVER" },
    resource: null,
    result: "SUCCESS",
    occurredAt: instant,
    sourceOccurredAt: null,
    links: {
      requestId: randomUUID(),
      occurrenceId: randomUUID(),
      runId: null,
      evidenceId: null,
      actionId: null,
      revisionId: null,
      approvalId: null,
      executionId: null,
    },
    event: { eventType: "AUTH_LOGIN", redactedMetadata: { reasonCode: "COMPLETED" } },
    ...patch,
  };
}
async function head(client, binding = scope) {
  return (
    await client.query("SELECT * FROM public.audit_chain_head($1,$2,$3)", Object.values(binding))
  ).rows[0];
}
async function append(client, input = event(), patch = {}) {
  const tail = await head(client, input.scope);
  const row = {
    auditId: randomUUID(),
    ...input.scope,
    actorId: input.actor.actorId,
    actorKind: input.actor.actorKind,
    requestId: input.links.requestId,
    occurrenceId: input.links.occurrenceId,
    sequence: Number(tail.sequence) + 1,
    prevHash: tail.entryHash,
    entryHash: hash,
    hashVersion: 1,
    redactionVersion: 1,
    payload: input,
    ...patch,
  };
  const columns = Object.keys(row)
    .map((key) => `"${key}"`)
    .join(",");
  const params = Object.values(row).map((value) =>
    typeof value === "object" && value !== null ? JSON.stringify(value) : value,
  );
  return client.query(
    `INSERT INTO public.audit_logs (${columns}) VALUES (${params.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    params,
  );
}
async function transaction(client, action) {
  await client.query("BEGIN");
  try {
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function denied(t, name, action, code = "42501") {
  await t.test(name, () => assert.rejects(action(), { code }));
}
async function isolationCases(t, client, writer, reader) {
  await t.test("same scope appends and sees one entry; reader cannot append", async () => {
    await context(writer);
    await transaction(writer, () => append(writer));
    await context(reader, "audit-viewer");
    assert.equal((await reader.query("SELECT count(*) FROM audit_logs")).rows[0].count, "1");
    await assert.rejects(
      transaction(reader, () => append(reader)),
      { code: "42501" },
    );
  });
  for (const binding of [
    { ...scope, organizationId: "legacy-org-audit-b" },
    { ...scope, workspaceId: "wrong" },
    otherStore,
    { organizationId: "", workspaceId: "", storeId: "" },
  ]) {
    await context(reader, "audit-viewer", binding);
    await t.test(`read is scoped ${JSON.stringify(binding)}`, async () =>
      assert.equal((await reader.query("SELECT count(*) FROM audit_logs")).rows[0].count, "0"),
    );
  }
  await deniedScopeCases(t, client, writer);
}
async function deniedScopeCases(t, client, writer) {
  for (const binding of [
    { ...scope, organizationId: "legacy-org-audit-b" },
    { ...scope, workspaceId: "wrong" },
    { ...scope, storeId: "audit-store-b" },
    { organizationId: "", workspaceId: "", storeId: "" },
  ]) {
    await context(writer, "audit-owner", binding);
    await denied(t, "bound scope rejects unauthorized tail or append", () =>
      transaction(writer, () => append(writer)),
    );
  }
  await context(writer, "audit-operator");
  await denied(t, "USER cannot impersonate other principal", () =>
    transaction(writer, () => append(writer)),
  );
  await client.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    "audit-operator",
  ]);
  await denied(t, "revoked workspace membership denies head", () => head(writer));
  await context(writer);
}
async function constraintCases(t, client, writer) {
  for (const patch of [
    { sequence: 0 },
    { sequence: 9007199254740992 },
    { entryHash: "A".repeat(64) },
    { hashVersion: 2 },
    { redactionVersion: 2 },
    { prevHash: "b".repeat(64) },
    { sequence: 99 },
  ])
    await denied(
      t,
      `invalid chain columns ${JSON.stringify(patch)}`,
      () => transaction(writer, () => append(writer, event(), patch)),
      "23514",
    );
  await compoundForeignKeyCase(t, client);
  await occurrenceCases(t, writer);
  await malformedCases(t, writer);
}
async function occurrenceCases(t, writer) {
  const original = event();
  await transaction(writer, () => append(writer, original));
  await denied(
    t,
    "same occurrence rejects replay",
    () => transaction(writer, () => append(writer, original)),
    "23505",
  );
  await context(writer, "audit-owner", otherStore);
  await denied(
    t,
    "hidden store occurrence rejects changed replay",
    () =>
      transaction(writer, () =>
        append(writer, { ...original, scope: otherStore, result: "FAILED" }),
      ),
    "23505",
  );
  await context(writer);
}
async function malformedCases(t, writer) {
  for (const payload of [
    event({ token: "synthetic-secret" }),
    event({ actor: { actorId: "audit-owner", actorKind: "SERVICE", identitySource: "SERVER" } }),
    event({
      event: {
        eventType: "AUTH_LOGIN",
        redactedMetadata: { reasonCode: "COMPLETED", rawPrompt: "synthetic-secret" },
      },
    }),
  ])
    await denied(
      t,
      "rejects unsafe envelope, metadata or actor capability",
      () => transaction(writer, () => append(writer, payload)),
      payload.actor.actorKind === "SERVICE" ? "42501" : "23514",
    );
}
async function compoundForeignKeyCase(t, client) {
  await context(client);
  await t.test("compound audit Store FK independently rejects mismatched tenant", async () => {
    await client.query("BEGIN");
    try {
      // Isolate referential integrity from the earlier authorization trigger, then roll back DDL.
      await client.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append");
      const mismatch = { ...scope, storeId: "audit-store-b" };
      const input = event();
      await assert.rejects(
        append(client, input, { ...mismatch, payload: { ...input, scope: mismatch } }),
        {
          code: "23503",
        },
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
}
const metadata = {
  security: { reasonCode: null },
  role: { previousRole: null, nextRole: "OPERATOR" },
  action: { actionKind: "PRICE", oldPriceMinor: 1234, newPriceMinor: 1250, reasonCode: null },
  run: { runStatus: "STARTED" },
  notification: { channel: "IN_APP", deliveryStatus: "NOT_APPLICABLE" },
};
function lifecycleEvent() {
  const evidenceReference = {
    schemaVersion: 1,
    id: "evidence/opaque.1",
    version: "version.1",
    hash: "sha256:opaque",
    binding: { ...scope, connectionId: "connection-1", externalStoreId: "external/store.1" },
    eventType: "REVENUE_DROP",
    entity: { kind: "STORE" },
    definitionVersion: "definition.1",
    baselineVersion: null,
  };
  return event({
    resource: { type: "EVENT", id: "event/opaque.1" },
    event: {
      eventType: "EVENT_STATE_CHANGE",
      redactedMetadata: {
        fromState: "OPEN",
        toState: "ACKNOWLEDGED",
        reason: "ACKNOWLEDGED_BY_OPERATOR",
        expectedRevision: 1,
        revision: 2,
        evidenceReference,
      },
    },
  });
}
function familyEvent(kind) {
  if (kind === "EVENT_STATE_CHANGE") return lifecycleEvent();
  const group = [
    "PROPOSAL",
    "APPROVAL",
    "REJECTION",
    "EXECUTION",
    "VERIFICATION",
    "COMPENSATION",
  ].includes(kind)
    ? "action"
    : kind.startsWith("NOTIFICATION_") || kind === "BRIEF"
      ? "notification"
      : kind === "ROLE_CHANGE"
        ? "role"
        : kind === "AGENT_RUN"
          ? "run"
          : "security";
  return event({ event: { eventType: kind, redactedMetadata: metadata[group] } });
}
async function dtoCases(t, writer) {
  for (const kind of AuditEventTypeSchema.options)
    await t.test(`strict DTO family ${kind} preserves bounded metadata`, async () => {
      const input = TenantAuditEventSchema.parse(familyEvent(kind));
      const stored = (await transaction(writer, () => append(writer, input))).rows[0];
      assert.deepEqual(stored.payload, input);
    });
  await timestampCase(t, writer);
  const lifecycle = lifecycleEvent();
  const invalid = [
    { ...lifecycle, result: "FAILED" },
    { ...lifecycle, occurredAt: "2026-11-03T00:00:00.0001Z" },
    {
      ...lifecycle,
      event: {
        ...lifecycle.event,
        redactedMetadata: { ...lifecycle.event.redactedMetadata, revision: 3 },
      },
    },
    { ...lifecycle, links: { ...lifecycle.links, evidenceId: "forbidden-link" } },
  ];
  for (const input of invalid)
    await denied(
      t,
      "lifecycle boundary rejects inconsistent envelope",
      () => transaction(writer, () => append(writer, input)),
      "23514",
    );
}
async function timestampCase(t, writer) {
  await t.test("timestamp boundary matches DTO calendar and offset rules", async () => {
    for (const occurredAt of [
      instant,
      "2026-11-03T24:00:00Z",
      "2026-02-30T00:00:00Z",
      "2024-02-29T23:59:59.001Z",
      "0000-02-29T00:00:00Z",
      "2026-11-03T00:00:00+23:59",
    ]) {
      const expected = TenantAuditEventSchema.safeParse(event({ occurredAt })).success;
      const result = await writer.query("SELECT public.audit_timestamp($1::jsonb) AS valid", [
        JSON.stringify(occurredAt),
      ]);
      assert.equal(result.rows[0].valid, expected, occurredAt);
    }
  });
}
async function immutableCases(t, client, writer) {
  const tail = await head(writer);
  await writer.query(
    'INSERT INTO audit_checkpoints ("organizationId","workspaceId","storeId",sequence,"entryHash","hashVersion") VALUES ($1,$2,$3,$4,$5,1)',
    [...Object.values(scope), tail.sequence, tail.entryHash],
  );
  for (const table of ["audit_logs", "audit_checkpoints", "auth_security_events"])
    for (const command of [
      `UPDATE ${table} SET "entryHash"="entryHash"`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table} CASCADE`,
    ]) {
      if (table === "auth_security_events" && command.startsWith("UPDATE")) continue;
      await denied(t, `ordinary writer forbidden ${command}`, () => writer.query(command));
    }
  for (const table of ["audit_logs", "audit_checkpoints", "auth_security_events"])
    await denied(
      t,
      `owner history immutable ${table}`,
      () => client.query(`DELETE FROM ${table}`),
      "23514",
    );
  await denied(
    t,
    "checkpoint rejects invented anchor",
    () =>
      writer.query(
        'INSERT INTO audit_checkpoints ("organizationId","workspaceId","storeId",sequence,"entryHash","hashVersion") VALUES ($1,$2,$3,999,$4,1)',
        [...Object.values(scope), hash],
      ),
    "23503",
  );
}
async function anonymousCases(t, writer, security) {
  const payload = {
    scopeKind: "ANONYMOUS_AUTH_SECURITY",
    scope: null,
    actor: null,
    requestId: randomUUID(),
    occurredAt: instant,
    result: "REJECTED",
    reason: "INVALID_CREDENTIALS",
    redactedMetadata: { attemptClass: "LOGIN", rateLimited: false },
  };
  const insert = (input) =>
    security.query('INSERT INTO auth_security_events ("auditId",payload) VALUES ($1,$2)', [
      randomUUID(),
      input,
    ]);
  await anonymousBoundaryCases(t, writer, security, payload, insert);
}
async function anonymousBoundaryCases(t, writer, security, payload, insert) {
  await t.test("separate anonymous sink inserts explicit null identity", () => insert(payload));
  await denied(t, "anonymous sink cannot probe tenant membership helpers", () =>
    security.query("SELECT public.audit_member_access($1,$2,$3,$4)", [
      ...Object.values(scope),
      "audit-owner",
    ]),
  );
  await denied(t, "security sink denies tenant reads", () =>
    security.query("SELECT * FROM audit_logs"),
  );
  await denied(t, "tenant writer denies anonymous reads", () =>
    writer.query("SELECT * FROM auth_security_events"),
  );
  await denied(t, "anonymous writer cannot select its own sink", () =>
    security.query("SELECT * FROM auth_security_events"),
  );
  await denied(
    t,
    "anonymous sink rejects tenant scope",
    () => insert({ ...payload, scope }),
    "23514",
  );
  await denied(
    t,
    "anonymous sink rejects metadata extras",
    () =>
      insert({
        ...payload,
        redactedMetadata: { ...payload.redactedMetadata, token: "synthetic-secret" },
      }),
    "23514",
  );
  await denied(t, "anonymous writer cannot erase sink", () =>
    security.query("TRUNCATE auth_security_events"),
  );
}
async function serviceCases(t, client, service, writer) {
  await context(service);
  const identity = (await service.query("SELECT session_user AS name")).rows[0].name;
  const input = event({
    actor: { actorId: "audit-service", actorKind: "SERVICE", identitySource: "SERVER" },
  });
  await denied(t, "unprovisioned SERVICE cannot use tenant chain", () => head(service));
  await client.query(
    'INSERT INTO audit_service_grants ("loginRole","organizationId","workspaceId","storeId","actorId","actorKind","authorizedByUserId") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [identity, ...Object.values(scope), "audit-service", "SERVICE", "audit-owner"],
  );
  await t.test("provisioned SERVICE appends without fake human actor FK", () =>
    transaction(service, () => append(service, input)),
  );
  await denied(t, "service cannot claim SYSTEM identity", () =>
    transaction(service, () =>
      append(service, { ...input, actor: { ...input.actor, actorKind: "SYSTEM" } }),
    ),
  );
  await writer.query("SELECT set_config('app.actor_kind','SYSTEM',false)");
  await denied(t, "GUC cannot grant service capability", () =>
    transaction(writer, () => append(writer, input)),
  );
  await denied(t, "service cannot provision grants", () =>
    service.query("DELETE FROM audit_service_grants"),
  );
  await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    "audit-owner",
  ]);
  await denied(t, "revoked authorizer denies SERVICE head", () => head(service));
  await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "ACTIVE",
    "audit-owner",
  ]);
}
async function privilegeCases(t, client, writer, service) {
  await denied(t, "ordinary writer cannot SET ROLE to service capability", () =>
    writer.query("SET ROLE shopmate_audit_service_writer"),
  );
  await denied(t, "service cannot SET ROLE to internal chain owner", () =>
    service.query("SET ROLE shopmate_audit_chain"),
  );
  await t.test("internal chain helper owner has no payload or mutation access", async () => {
    const privileges = await client.query(
      "SELECT has_column_privilege('shopmate_audit_chain','audit_logs','payload','SELECT') AS payload, has_table_privilege('shopmate_audit_chain','audit_logs','UPDATE') AS mutation",
    );
    assert.deepEqual(privileges.rows[0], { payload: false, mutation: false });
  });
  await client.query('UPDATE audit_service_grants SET "actorKind"=$1', ["SYSTEM"]);
  await t.test("provisioned SYSTEM identity remains separate from human membership", () =>
    transaction(service, () =>
      append(
        service,
        event({
          actor: { actorId: "audit-service", actorKind: "SYSTEM", identitySource: "SERVER" },
        }),
      ),
    ),
  );
  await client.query("DELETE FROM audit_service_grants");
  await denied(t, "revoked grant denies service despite forged GUCs", () => head(service));
  await t.test("repeatable-read cannot reuse a stale organization head snapshot", async () => {
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await assert.rejects(head(writer), { code: "42501" });
    } finally {
      await writer.query("ROLLBACK");
    }
  });
}
async function waitingForChain(client, second) {
  const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  return async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const locks = await client.query(
        "SELECT count(*) FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
        [pid],
      );
      if (locks.rows[0].count === "1") return;
      await delay(10);
    }
    assert.fail("Second session did not wait for organization advisory lock");
  };
}
async function concurrencyCases(t, client, writer, second) {
  await context(writer);
  await context(second, "audit-owner", otherStore);
  const waitForLock = await waitingForChain(client, second);
  await t.test(
    "two sessions serialize same-org different-store heads and rollback allocates nothing",
    async () => {
      const before = await head(writer);
      await writer.query("BEGIN");
      await append(writer);
      await second.query("BEGIN");
      let settled = false;
      const waiting = head(second, otherStore).then((value) => {
        settled = true;
        return value;
      });
      await waitForLock();
      assert.equal(settled, false);
      await writer.query("ROLLBACK");
      assert.equal((await waiting).sequence, before.sequence);
      const row = (await append(second, event({}, otherStore))).rows[0];
      assert.equal(Number(row.sequence), Number(before.sequence) + 1);
      await second.query("COMMIT");
      await transaction(writer, () => append(writer));
      assert.equal(Number((await head(writer)).sequence), Number(before.sequence) + 2);
    },
  );
}
async function waitingAuthorizationCase(t, client, writer, second) {
  const waitForLock = await waitingForChain(client, second);
  await t.test(
    "waiting same-org session rechecks revoked membership before returning head",
    async () => {
      await writer.query("BEGIN");
      await head(writer);
      await second.query("BEGIN");
      const waiting = assert.rejects(head(second, otherStore), { code: "42501" });
      await waitForLock();
      await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
        "INACTIVE",
        "audit-owner",
      ]);
      await writer.query("ROLLBACK");
      await waiting;
      await second.query("ROLLBACK");
      await client.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
        "ACTIVE",
        "audit-owner",
      ]);
    },
  );
}
async function proof(t, client, url, names) {
  const connections = [];
  try {
    for (const capability of [
      "shopmate_audit_writer",
      "shopmate_audit_reader",
      "shopmate_auth_security_writer",
      "shopmate_audit_service_writer",
      "shopmate_audit_writer",
    ])
      connections.push(await login(client, url, names, capability));
    const [writer, reader, security, service, second] = connections;
    await isolationCases(t, client, writer, reader);
    await constraintCases(t, client, writer);
    await dtoCases(t, writer);
    await immutableCases(t, client, writer);
    await anonymousCases(t, writer, security);
    await serviceCases(t, client, service, writer);
    await privilegeCases(t, client, writer, service);
    await concurrencyCases(t, client, writer, second);
    await waitingAuthorizationCase(t, client, writer, second);
  } finally {
    for (const connection of connections) await connection.end();
  }
}
for (const mode of ["fresh", "baseline"])
  test(`audit ${mode} install proves restricted storage and transactional organization chain`, async (t) => {
    await database(async (client, url, names) => {
      await migrate(client, mode);
      await fixture(client);
      if (mode === "baseline")
        await client.query(
          await readFile(new URL(`${auditMigration}/migration.sql`, migrations), "utf8"),
        );
      await proof(t, client, url, names);
    });
  });
