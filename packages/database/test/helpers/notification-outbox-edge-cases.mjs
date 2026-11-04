import assert from "node:assert/strict";
import {
  binding,
  time,
  later,
  publicColumns,
  database,
  login,
  context,
  workerGrant,
  insert,
  pending,
  lease,
  update,
  count,
  expectCode,
} from "./notification-outbox-fixture.mjs";

export async function exactPrivileges(state) {
  for (const role of ["enqueuer", "worker", "recipient"]) {
    const result = await state.admin.query(
      "SELECT column_name FROM information_schema.column_privileges WHERE grantee=$1 AND table_name=$2 AND privilege_type=$3 ORDER BY column_name",
      [`shopmate_notification_${role}`, "notification_outbox", "INSERT"],
    );
    assert.deepEqual(
      result.rows.map((row) => row.column_name),
      role === "enqueuer" ? [...publicColumns, "connectionGeneration", "nextAttemptAt"].sort() : [],
    );
    const permissions = await state.admin.query("SELECT has_table_privilege($1,$2,$3) AS allowed", [
      `shopmate_notification_${role}`,
      "notification_worker_grants",
      "SELECT,INSERT,UPDATE,DELETE,TRUNCATE",
    ]);
    assert.equal(permissions.rows[0].allowed, false);
  }
  const tables = await state.admin.query(
    "SELECT relname,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname=ANY($1)",
    [["notification_outbox", "recipient_inbox", "notification_worker_grants"]],
  );
  assert.ok(tables.rows.every((row) => row.owner !== "shopmate_notification_guard"));
  const publicRights = await state.admin.query(
    "SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relname=ANY($1) AND a.grantee=0",
    [tables.rows.map((row) => row.relname)],
  );
  assert.equal(publicRights.rows[0].count, "0");
}
export async function stateNullMatrix(state) {
  const row = (await insert(state.enqueuer)).rows[0];
  await lease(state.worker, row.rowId);
  for (const status of ["PENDING", "LEASED", "DELIVERED", "FAILED", "UNKNOWN"])
    for (let mask = 0; mask < 16; mask++) {
      const patch = {
        status,
        nextAttemptAt: mask & 1 ? later : null,
        leaseToken: mask & 2 ? "lease" : null,
        leaseUntil: mask & 4 ? later : null,
        deliveredAt: mask & 8 ? later : null,
      };
      const valid =
        status === "PENDING"
          ? mask === 1
          : status === "LEASED"
            ? mask === 6
            : status === "DELIVERED"
              ? mask === 8
              : mask === 0 || mask === 1;
      await state.worker.query("BEGIN");
      try {
        if (valid) assert.equal((await update(state.worker, row.rowId, patch)).rowCount, 1);
        else await expectCode(() => update(state.worker, row.rowId, patch), "23514");
      } finally {
        await state.worker.query("ROLLBACK");
      }
    }
}
export async function timeAndIdentityEdges(state) {
  const row = (await insert(state.enqueuer)).rows[0];
  assert.equal(
    (
      await state.recipient.query('UPDATE recipient_inbox SET "readAt"=$1 WHERE "outboxId"=$2', [
        later,
        row.rowId,
      ])
    ).rowCount,
    0,
  );
  await expectCode(
    () =>
      state.admin.query(
        'UPDATE notification_outbox SET "connectionGeneration"=$1 WHERE "rowId"=$2',
        [1, row.rowId],
      ),
    "23514",
  );
  await expectCode(
    () =>
      state.admin.query('UPDATE notification_outbox SET severity=$1 WHERE "rowId"=$2', [
        "LOW",
        row.rowId,
      ]),
    "23514",
  );
  await timestampRange(state);
  for (const value of [time, "infinity"])
    await expectCode(() => lease(state.worker, row.rowId, { leaseUntil: value }), "23514");
}
async function timestampRange(state) {
  for (const value of ["0001-01-01 00:00:00+00 BC", "9999-12-31T23:59:59.999Z"])
    assert.equal(
      (
        await insert(
          state.enqueuer,
          pending({ createdAt: value, notBefore: value, nextAttemptAt: value }),
        )
      ).rowCount,
      1,
    );
  for (const value of ["0002-12-31 00:00:00+00 BC", "infinity", "10000-01-01T00:00:00Z"])
    await expectCode(
      () =>
        insert(
          state.enqueuer,
          pending({ createdAt: value, notBefore: value, nextAttemptAt: value }),
        ),
      "23514",
    );
}
export async function workerSessionRevocation(state) {
  const operator = await login(state, "shopmate_notification_worker");
  await context(operator, "operator");
  await workerGrant(state, operator, binding, "operator");
  assert.ok((await count(operator)) > 0);
  await state.admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
    "INACTIVE",
    "operator",
  ]);
  assert.equal(await count(operator), 0);
  await state.admin.query('UPDATE "WorkspaceMember" SET status=$1 WHERE "userId"=$2', [
    "ACTIVE",
    "operator",
  ]);
  const name = state.worker.notificationLogin;
  assert.match(name, /^note_[a-f0-9]{32}$/u);
  await state.admin.query(`REVOKE shopmate_notification_worker FROM "${name}"`);
  assert.equal(await count(state.worker), 0);
  await state.admin.query(`GRANT shopmate_notification_worker TO "${name}"`);
  assert.ok((await count(state.worker)) > 0);
}
export async function immutableProjection(state, outboxId) {
  await expectCode(
    () =>
      state.admin.query('UPDATE recipient_inbox SET "intentId"=$1 WHERE "outboxId"=$2', [
        "changed",
        outboxId,
      ]),
    "23514",
  );
  await expectCode(
    () =>
      state.admin.query('UPDATE recipient_inbox SET "deliveredAt"=$1 WHERE "outboxId"=$2', [
        time,
        outboxId,
      ]),
    "23514",
  );
}
export async function ownedFailureCleanup(state) {
  let owned;
  await assert.rejects(
    database(async (inner) => {
      owned = inner;
      await login(inner);
      throw new Error("Synthetic notification fixture failure");
    }),
    /Synthetic notification fixture failure/u,
  );
  assert.equal(
    (await state.admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [owned.name])).rowCount,
    0,
  );
  assert.equal(
    (await state.admin.query("SELECT 1 FROM pg_roles WHERE rolname=ANY($1)", [owned.logins]))
      .rowCount,
    0,
  );
  assert.equal(
    (await state.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [owned.name]))
      .rowCount,
    0,
  );
}
