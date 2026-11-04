import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  binding,
  other,
  time,
  later,
  context,
  count,
  pending,
  insert,
  update,
  lease,
  deliver,
  login,
  seedBinding,
  seedStore,
  members,
  expectCode,
  transaction,
  connectionPatch,
} from "./notification-outbox-fixture.mjs";

import {
  exactPrivileges,
  stateNullMatrix,
  timeAndIdentityEdges,
  workerSessionRevocation,
  immutableProjection,
  ownedFailureCleanup,
} from "./notification-outbox-edge-cases.mjs";

export async function catalog(state) {
  await exactPrivileges(state);
  const roles = (
    await state.admin.query(
      "SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname LIKE $1",
      ["shopmate_notification_%"],
    )
  ).rows;
  assert.equal(roles.length, 4);
  for (const role of roles)
    assert.ok(Object.entries(role).every(([key, value]) => key === "rolname" || value === false));
  assert.equal(
    (
      await state.admin.query(
        "SELECT count(*) FROM pg_class WHERE relname=ANY($1) AND relrowsecurity AND relforcerowsecurity",
        [["notification_outbox", "recipient_inbox", "notification_worker_grants"]],
      )
    ).rows[0].count,
    "3",
  );
  await capabilityPrivileges(state);
  await pendingRoundTrip(state);
}
async function capabilityPrivileges(state) {
  for (const capability of ["enqueuer", "worker", "recipient"]) {
    const role = `shopmate_notification_${capability}`;
    const columns = (
      await state.admin.query(
        "SELECT table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE grantee=$1 ORDER BY table_name,column_name,privilege_type",
        [role],
      )
    ).rows;
    const writable = columns
      .filter((row) => row.privilege_type === "UPDATE")
      .map((row) => `${row.table_name}.${row.column_name}`)
      .sort();
    assert.deepEqual(
      writable,
      capability === "worker"
        ? ["attempt", "deliveredAt", "leaseToken", "leaseUntil", "nextAttemptAt", "status"]
            .map((column) => `notification_outbox.${column}`)
            .sort()
        : capability === "recipient"
          ? ["recipient_inbox.readAt"]
          : [],
    );
    assert.ok(!columns.some((row) => row.table_name === "notification_worker_grants"));
    await expectCode(() => state[capability].query("SET ROLE shopmate_notification_guard"));
  }
}
async function pendingRoundTrip(state) {
  assert.equal(
    (
      await state.admin.query(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname=$1 AND p.proname LIKE $2 AND a.grantee=0",
        ["public", "notification_%"],
      )
    ).rows[0].count,
    "0",
  );
  await expectCode(() =>
    state.enqueuer.query("SELECT notification_member_access($1,$2,$3,false)", [
      binding.organizationId,
      binding.workspaceId,
      "owner",
    ]),
  );
  const row = (await insert(state.enqueuer)).rows[0];
  assert.equal(row.status, "PENDING");
  assert.equal(row.attempt, "0");
  assert.equal(row.nextAttemptAt.toISOString(), time);
  assert.equal(row.deliveredAt, null);
}
async function waitForLock(admin, loginName) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      (
        await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type=$2",
          [loginName, "Lock"],
        )
      ).rowCount
    )
      return;
    await delay(10);
  }
  throw new Error("Notification contention did not reach a real PostgreSQL lock");
}
export async function dedup(state) {
  const second = await login(state, "shopmate_notification_enqueuer");
  await context(second);
  const row = pending();
  let waiting;
  try {
    await state.enqueuer.query("BEGIN");
    await second.query("BEGIN");
    const original = (await insert(state.enqueuer, row)).rows[0];
    waiting = insert(second, { ...row, intentId: randomUUID(), severity: "LOW" }, true).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForLock(state.admin, second.notificationLogin);
    await state.enqueuer.query("COMMIT");
    const result = await waiting;
    if (result.error) throw result.error;
    assert.equal(result.value.rowCount, 0);
    const durable = (
      await second.query('SELECT * FROM notification_outbox WHERE "eventId"=$1', [row.eventId])
    ).rows[0];
    assert.equal(durable.rowId, original.rowId);
    assert.equal(durable.severity, "HIGH");
    await second.query("COMMIT");
    await replayCases(second, row);
  } finally {
    await state.enqueuer.query("ROLLBACK");
    await second.query("ROLLBACK");
    if (waiting) await waiting;
  }
}
async function replayCases(second, row) {
  assert.equal(
    (
      await insert(
        second,
        { ...row, intentId: randomUUID(), severity: "INFO", decisionRunId: "later" },
        true,
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await insert(second, {
        ...row,
        intentId: randomUUID(),
        eventRevision: "2",
        eventState: "ACKNOWLEDGED",
      })
    ).rowCount,
    1,
  );
  assert.equal(
    (await insert(second, { ...row, intentId: randomUUID(), recipientUserId: "second" })).rowCount,
    1,
  );
  await expectCode(() => insert(second, pending({ channel: "EMAIL" })), "23514");
}
function cjk(offset) {
  return Array.from({ length: 256 }, (_, i) =>
    String.fromCodePoint(0x4e00 + ((i * 7919 + offset) % 20000)),
  ).join("");
}
export async function wideIdentifiers(state) {
  const wide = {
    organizationId: "o".repeat(128),
    workspaceId: "w".repeat(128),
    storeId: "s".repeat(128),
    connectionId: "c".repeat(128),
    externalStoreId: cjk(0).slice(0, 200),
  };
  await seedBinding(state.admin, wide, "wide-merchant");
  await members(state.admin, wide);
  const recipient = "r".repeat(128);
  await state.admin.query(
    'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
    [randomUUID(), wide.organizationId, recipient, "OWNER"],
  );
  await context(state.enqueuer, "owner", wide);
  const maximal = pending(
    { intentId: cjk(1), eventId: cjk(2), recipientUserId: recipient, eventRevision: "4294967296" },
    wide,
  );
  assert.equal((await insert(state.enqueuer, maximal)).rowCount, 1);
  await expectCode(() => insert(state.enqueuer, { ...maximal, eventId: "new" }), "23505");
  await expectCode(() => insert(state.enqueuer, { ...maximal, intentId: "new" }), "23505");
  for (const value of ["😀".repeat(128), "opaque punctuation:/ a.b", "é", "e\u0301"])
    assert.equal((await insert(state.enqueuer, pending({ eventId: value }, wide))).rowCount, 1);
  for (const value of [
    "😀".repeat(129),
    "漢".repeat(257),
    " leading",
    "trailing\u00a0",
    "a\u0001b",
    "a\u200bb",
    "\ufeffprefix",
  ])
    await expectCode(() => insert(state.enqueuer, pending({ eventId: value }, wide)), "23514");
  assert.equal(await count(state.enqueuer), 5);
}
export async function foreignKeys(state) {
  await expectCode(() => insert(state.admin, pending({ storeId: other.storeId })), "23503");
  await expectCode(() => insert(state.admin, pending({ recipientUserId: "missing" })), "23503");
  for (const [table, field, value, inactive] of [
    ["WorkspaceMember", "userId", "recipient", "INACTIVE"],
    ["OrganizationMember", "userId", "recipient", "INACTIVE"],
    ["Organization", "id", binding.organizationId, "SUSPENDED"],
    ["Workspace", "id", binding.workspaceId, "SUSPENDED"],
  ]) {
    await state.admin.query(`UPDATE "${table}" SET status=$1 WHERE "${field}"=$2`, [
      inactive,
      value,
    ]);
    await expectCode(() => insert(state.enqueuer));
    await state.admin.query(`UPDATE "${table}" SET status=$1 WHERE "${field}"=$2`, [
      "ACTIVE",
      value,
    ]);
  }
  await connectionPatch(state.admin, "status", "DISCONNECTED");
  await expectCode(() => insert(state.enqueuer));
  await connectionPatch(state.admin, "status", "ACTIVE");
  await state.admin.query('DELETE FROM "WorkspaceMember" WHERE "userId"=$1', ["recipient"]);
  await expectCode(() => insert(state.enqueuer));
}
export async function memberships(state) {
  for (const actor of ["owner", "admin", "operator"]) {
    await context(state.enqueuer, actor);
    assert.equal((await insert(state.enqueuer)).rowCount, 1);
  }
  await context(state.enqueuer, "readonly");
  await expectCode(() => insert(state.enqueuer));
  await context(state.enqueuer, "operator");
  await state.admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    "operator",
  ]);
  await expectCode(() => insert(state.enqueuer));
  await context(state.enqueuer, "owner");
  assert.equal((await insert(state.enqueuer, pending({ recipientUserId: "admin" }))).rowCount, 1);
}
export async function scopes(state) {
  await insert(state.enqueuer);
  for (const key of Object.keys(binding)) {
    await context(state.enqueuer, "owner", { ...binding, [key]: other[key] });
    assert.equal(await count(state.enqueuer), 0);
    await expectCode(() => insert(state.enqueuer));
    await context(state.enqueuer, "owner", { ...binding, [key]: "" });
    await expectCode(() => insert(state.enqueuer));
  }
  await context(state.enqueuer, "missing");
  await expectCode(() => insert(state.enqueuer));
  await context(state.enqueuer, "");
  await expectCode(() => insert(state.enqueuer));
  const empty = await login(state, "shopmate_notification_enqueuer");
  assert.equal(await count(empty), 0);
  await expectCode(() => insert(empty));
  await context(state.enqueuer);
  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
    await state.enqueuer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    try {
      assert.equal(await count(state.enqueuer), 0);
      await expectCode(() => insert(state.enqueuer));
    } finally {
      await state.enqueuer.query("ROLLBACK");
    }
  }
  const sibling = {
    ...binding,
    storeId: "same-workspace-store",
    connectionId: "sibling-connection",
    externalStoreId: "sibling/external",
  };
  await seedStore(state.admin, sibling);
  await context(state.enqueuer, "owner", sibling);
  assert.equal(await count(state.enqueuer), 0);
  await expectCode(() => insert(state.enqueuer));
  await context(state.enqueuer);
  assert.equal((await insert(state.enqueuer, pending({ recipientUserId: "second" }))).rowCount, 1);
}
export async function allowlist(state) {
  const invalid = [
    { channel: "EMAIL" },
    { route: "NONE" },
    { eventState: "CLOSED" },
    { eventRevision: "0" },
    { eventRevision: "9007199254740992" },
    { entityKind: "STORE", entityId: "not-null" },
    { eventType: "STOCKOUT_RISK" },
    { eventType: "ROAS_DROP", entityKind: "SKU", entityId: "sku" },
    { eventType: "SYNC_FAILURE", entityKind: "CONNECTION", entityId: "other" },
    { evidenceVersion: " " },
    { evidenceHash: "\u0001" },
    { entityKind: "SKU", entityId: null },
    { eventType: "arbitrary" },
    { severity: "URGENT" },
  ];
  for (const patch of invalid)
    await expectCode(() => insert(state.enqueuer, pending(patch)), "23514");
  for (const patch of [
    {},
    { entityKind: "SKU", entityId: "sku/ .1", baselineVersion: "base .1" },
    { eventType: "ROAS_DROP", entityKind: "CAMPAIGN", entityId: "campaign" },
    { eventType: "SYNC_FAILURE", entityKind: "CONNECTION", entityId: binding.connectionId },
  ])
    assert.equal((await insert(state.enqueuer, pending(patch))).rowCount, 1);
  await expectCode(
    () =>
      state.enqueuer.query("INSERT INTO notification_outbox (payload) VALUES ($1)", ["raw prompt"]),
    "42703",
  );
  await expectCode(() =>
    state.enqueuer.query('UPDATE notification_outbox SET "evidenceHash"=$1', ["changed"]),
  );
}

async function pendingStateCases(state, row) {
  for (const patch of [
    { status: "LEASED", attempt: 0 },
    { status: "LEASED", attempt: 1, nextAttemptAt: null },
    { leaseToken: "unexpected" },
    { leaseUntil: later },
    { nextAttemptAt: null },
    { deliveredAt: later },
    { nextAttemptAt: "2026-11-02T00:00:00Z" },
    { nextAttemptAt: "infinity" },
    { status: "UNKNOWN", attempt: 0 },
    { attempt: "9007199254740992" },
    { status: "INVENTED" },
    { status: "DELIVERED", attempt: 1, nextAttemptAt: null, deliveredAt: later },
  ])
    await expectCode(() => update(state.worker, row.rowId, patch), "23514");
}
async function retryStateCases(state, row) {
  for (const status of ["FAILED", "UNKNOWN"])
    for (const retry of [null, later])
      assert.equal(
        (
          await update(state.worker, row.rowId, {
            status,
            attempt: 1,
            nextAttemptAt: retry,
            leaseToken: null,
            leaseUntil: null,
          })
        ).rowCount,
        1,
      );
}
export async function states(state) {
  const row = (await insert(state.enqueuer)).rows[0];
  await pendingStateCases(state, row);
  await lease(state.worker, row.rowId);
  for (const patch of [
    { leaseUntil: time },
    { leaseUntil: null },
    { leaseToken: null },
    { leaseToken: " bad" },
    { leaseUntil: "infinity" },
    { nextAttemptAt: later },
    { attempt: 0 },
  ])
    await expectCode(() => update(state.worker, row.rowId, patch), "23514");
  await retryStateCases(state, row);
  await terminalStateCases(state, row);
  await stateNullMatrix(state);
  await timeAndIdentityEdges(state);
}
async function terminalStateCases(state, row) {
  await lease(state.worker, row.rowId, { attempt: 2 });
  await expectCode(
    () =>
      update(state.worker, row.rowId, {
        status: "DELIVERED",
        leaseToken: null,
        leaseUntil: null,
        deliveredAt: "-infinity",
      }),
    "23514",
  );
  await update(state.worker, row.rowId, {
    status: "DELIVERED",
    leaseToken: null,
    leaseUntil: null,
    deliveredAt: later,
  });
  await expectCode(
    () => update(state.worker, row.rowId, { status: "FAILED", deliveredAt: null }),
    "23514",
  );
  await expectCode(() => update(state.worker, row.rowId, { attempt: 3 }), "23514");
  for (const timestamp of ["infinity", "-infinity", "10000-01-01T00:00:00Z"])
    await expectCode(() => insert(state.enqueuer, pending({ createdAt: timestamp })), "23514");
  await expectCode(
    () => state.recipient.query('UPDATE recipient_inbox SET "readAt"=$1', [time]),
    "23514",
  );
}
export async function workerAuthority(state) {
  const row = (await insert(state.enqueuer)).rows[0];
  const stranger = await login(state, "shopmate_notification_worker");
  await context(stranger);
  assert.equal(await count(stranger), 0);
  assert.equal((await lease(stranger, row.rowId)).rowCount, 0);
  const attacker = await login(state);
  await context(attacker);
  await expectCode(() => attacker.query("SET ROLE shopmate_notification_worker"));
  await expectCode(() => count(attacker));
  await context(state.worker, "recipient");
  assert.equal((await lease(state.worker, row.rowId)).rowCount, 0);
  await context(state.worker, "owner", other);
  assert.equal((await lease(state.worker, row.rowId)).rowCount, 0);
  await context(state.worker);
  assert.equal((await lease(state.worker, row.rowId)).rowCount, 1);
  await expectCode(() =>
    state.worker.query('UPDATE notification_outbox SET "intentId"=$1', ["forged"]),
  );
  await expectCode(() => insert(state.worker));
  await expectCode(() => state.worker.query("INSERT INTO recipient_inbox DEFAULT VALUES"));
  await workerSessionRevocation(state);
  await workerRevocation(state, row);
}
async function workerRevocation(state, row) {
  await state.admin.query("UPDATE notification_worker_grants SET active=$1", [false]);
  assert.equal(await count(state.worker), 0);
  assert.equal((await lease(state.worker, row.rowId)).rowCount, 0);
  await state.admin.query("UPDATE notification_worker_grants SET active=$1", [true]);
  await state.admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    "owner",
  ]);
  assert.equal(await count(state.worker), 0);
  await state.admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "ACTIVE",
    "owner",
  ]);
  await connectionPatch(state.admin, "generation", 1);
  assert.equal(await count(state.worker), 0);
  assert.equal(await count(state.enqueuer), 0);
  await expectCode(() => insert(state.enqueuer));
  assert.equal((await insert(state.enqueuer, pending({ connectionGeneration: 1 }))).rowCount, 1);
  assert.equal(await count(state.worker), 0);
}
export async function recipientBoundary(state) {
  await deliver(state);
  await deliver(state, pending({ recipientUserId: "second" }));
  for (const sql of [
    "SELECT * FROM notification_outbox",
    "SELECT * FROM notification_worker_grants",
    'SELECT "leaseToken" FROM recipient_inbox',
    "INSERT INTO recipient_inbox DEFAULT VALUES",
    "INSERT INTO notification_outbox DEFAULT VALUES",
    "DELETE FROM recipient_inbox",
    "TRUNCATE recipient_inbox",
    "DELETE FROM notification_outbox",
    "TRUNCATE notification_outbox",
    "UPDATE notification_outbox SET status='LEASED'",
  ])
    await expectCode(
      () => state.recipient.query(sql),
      sql.includes('SELECT "leaseToken"') ? "42703" : "42501",
    );
  await ownInboxRows(state);
}
async function ownInboxRows(state) {
  assert.equal(await count(state.recipient, "recipient_inbox"), 1);
  assert.equal(
    (
      await state.recipient.query('SELECT * FROM recipient_inbox WHERE "recipientUserId"=$1', [
        "second",
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await state.recipient.query(
        'UPDATE recipient_inbox SET "readAt"=$1 WHERE "recipientUserId"=$2',
        [later, "second"],
      )
    ).rowCount,
    0,
  );
  await context(state.recipient, "admin");
  assert.equal(await count(state.recipient, "recipient_inbox"), 0);
  await expectCode(() => state.recipient.query("SET ROLE shopmate_notification_worker"));
}
export async function projection(state) {
  const row = await deliver(state);
  await immutableProjection(state, row.rowId);
  assert.equal(await count(state.recipient, "recipient_inbox"), 1);
  const inbox = (await state.recipient.query("SELECT * FROM recipient_inbox")).rows[0];
  for (const key of [
    "connectionGeneration",
    "status",
    "attempt",
    "nextAttemptAt",
    "leaseToken",
    "leaseUntil",
  ])
    assert.ok(!Object.hasOwn(inbox, key), key);
  assert.equal(inbox.readAt, null);
  assert.equal(inbox.deliveredAt.toISOString(), later);
  assert.equal((await update(state.worker, row.rowId, { status: "DELIVERED" })).rowCount, 1);
  assert.equal((await insert(state.enqueuer, pending({ eventId: row.eventId }), true)).rowCount, 0);
  for (const status of ["PENDING", "LEASED", "FAILED", "UNKNOWN"]) {
    const next = (await insert(state.enqueuer)).rows[0];
    if (status !== "PENDING") await lease(state.worker, next.rowId);
    if (["FAILED", "UNKNOWN"].includes(status))
      await update(state.worker, next.rowId, { status, leaseToken: null, leaseUntil: null });
  }
  assert.equal(await count(state.recipient, "recipient_inbox"), 1);
  await conflictingProjection(state);
}
async function conflictingProjection(state) {
  const row = (await insert(state.enqueuer)).rows[0];
  await lease(state.worker, row.rowId);
  await state.admin.query(
    'INSERT INTO recipient_inbox SELECT "rowId","intentId","organizationId","workspaceId","storeId","connectionId","externalStoreId","recipientUserId","eventId","eventState","eventRevision",channel,"decisionRunId",route,"eventType",$2,"createdAt","notBefore","evidenceId","evidenceVersion","evidenceHash","entityKind","entityId","definitionVersion","baselineVersion",$3,NULL FROM notification_outbox WHERE "rowId"=$1',
    [row.rowId, "LOW", later],
  );
  await expectCode(
    () =>
      update(state.worker, row.rowId, {
        status: "DELIVERED",
        leaseToken: null,
        leaseUntil: null,
        deliveredAt: later,
      }),
    "23514",
  );
  assert.equal(
    (
      await state.worker.query('SELECT status FROM notification_outbox WHERE "rowId"=$1', [
        row.rowId,
      ])
    ).rows[0].status,
    "LEASED",
  );
}
export async function rollback(state) {
  const row = (await insert(state.enqueuer)).rows[0];
  await lease(state.worker, row.rowId);
  await state.worker.query("BEGIN");
  try {
    await update(state.worker, row.rowId, {
      status: "DELIVERED",
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: later,
    });
    assert.equal(await count(state.worker, "recipient_inbox"), 1);
    assert.equal(await count(state.recipient, "recipient_inbox"), 0);
  } finally {
    await state.worker.query("ROLLBACK");
  }
  assert.equal(await count(state.recipient, "recipient_inbox"), 0);
  assert.equal(
    (
      await state.worker.query('SELECT status FROM notification_outbox WHERE "rowId"=$1', [
        row.rowId,
      ])
    ).rows[0].status,
    "LEASED",
  );
  await syntheticMutationRollback(state);
  await ownedFailureCleanup(state);
}
async function syntheticMutationRollback(state) {
  await state.admin.query(
    "CREATE TABLE synthetic_parent_mutation (id text PRIMARY KEY, value integer NOT NULL)",
  );
  await state.admin.query("INSERT INTO synthetic_parent_mutation VALUES ($1,$2)", ["one", 0]);
  await state.admin.query(
    "GRANT SELECT,UPDATE ON synthetic_parent_mutation TO shopmate_notification_enqueuer",
  );
  await expectCode(
    () =>
      transaction(state.enqueuer, async () => {
        await state.enqueuer.query("UPDATE synthetic_parent_mutation SET value=$1 WHERE id=$2", [
          1,
          "one",
        ]);
        await insert(state.enqueuer);
        await state.enqueuer.query("SELECT 1/0");
      }),
    "22012",
  );
  assert.equal(
    (await state.admin.query("SELECT value FROM synthetic_parent_mutation")).rows[0].value,
    0,
  );
  assert.equal(await count(state.enqueuer), 1);
}
export async function markRead(state) {
  const row = await deliver(state);
  await deliver(state, pending({ recipientUserId: "second" }));
  await expectCode(() => readAt(state.recipient, row.rowId, time), "23514");
  assert.equal((await readAt(state.recipient, row.rowId, later)).rowCount, 1);
  assert.equal((await readAt(state.recipient, row.rowId, later)).rowCount, 1);
  for (const value of [null, "2026-11-03T00:02:00.000Z"])
    await expectCode(() => readAt(state.recipient, row.rowId, value), "23514");
  await expectCode(() =>
    state.recipient.query('UPDATE recipient_inbox SET "intentId"=$1', ["changed"]),
  );
  const cross = await state.recipient.query(
    'UPDATE recipient_inbox SET "readAt"=$1 WHERE "recipientUserId"=$2',
    [later, "second"],
  );
  assert.equal(cross.rowCount, 0);
  await readRevocation(state);
}
async function readAt(client, id, value) {
  return client.query('UPDATE recipient_inbox SET "readAt"=$1 WHERE "outboxId"=$2', [value, id]);
}
async function readRevocation(state) {
  await context(state.recipient, "recipient", other);
  assert.equal(await count(state.recipient, "recipient_inbox"), 0);
  await context(state.recipient, "recipient");
  await connectionPatch(state.admin, "generation", 1);
  assert.equal(await count(state.recipient, "recipient_inbox"), 1);
  await state.admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    "recipient",
  ]);
  assert.equal(await count(state.recipient, "recipient_inbox"), 0);
  assert.equal(
    (await state.recipient.query('UPDATE recipient_inbox SET "readAt"=$1', [later])).rowCount,
    0,
  );
  await state.admin.query('UPDATE "OrganizationMember" SET status=$1 WHERE "userId"=$2', [
    "ACTIVE",
    "recipient",
  ]);
  const confirmed = (await state.recipient.query('SELECT "readAt" FROM recipient_inbox')).rows[0];
  assert.equal(confirmed.readAt.toISOString(), later);
}
