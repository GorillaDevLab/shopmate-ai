import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createSourceSession,
  grantSource,
  scopeFor,
  configFor,
  hashConfig,
} from "./mock-platform-fixture.mjs";
import { beginWorker, rawInsert, rawValues } from "./mock-source-control-fixture.mjs";

export const claimSql = `INSERT INTO mock_platform."BuildJob" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","leaseOwner") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`;
export const updateSql = `UPDATE mock_platform."BuildJob" SET "leaseOwner"=$4,state=$5,"failureCode"=$6 WHERE "sessionId"=$1 AND generation=$2 AND revision=$3 RETURNING *`;
export const scopeValues = (scope) => [
  scope.sessionId,
  scope.generation,
  scope.organizationId,
  scope.workspaceId,
  scope.storeId,
  scope.connectionId,
  scope.externalStoreId,
];
export const sqlError = (code) => (error) => error.code === code;
export const leaseOf = (job) => ({
  revision: job.revision,
  fence: job.fence,
  ownerId: job.leaseOwner,
});
export const renewValues = (job) => [
  job.sessionId,
  job.generation,
  job.revision,
  job.leaseOwner,
  job.state,
  null,
];

export async function sourceTransaction(
  client,
  scope,
  op,
  action,
  lease = null,
  grant = "source-grant-a",
) {
  await beginWorker(client, scope, grant);
  try {
    await client.query(
      "SELECT set_config('mock.source_op',$1,true),set_config('mock.source_lease',$2,true)",
      [op, JSON.stringify(lease)],
    );
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
export async function newScope(admin, worker, suffix, initialized = true, profile = "mature") {
  const scope = {
    ...scopeFor(),
    storeId: `lease-store-${suffix}`,
    sessionId: `lease-session-${suffix}`,
    connectionId: `lease-connection-${suffix}`,
  };
  await createSourceSession(admin, scope, profile);
  await grantSource(admin, scope, `lease-grant-${suffix}`);
  const config = configFor(scope, profile),
    values = rawValues(scope);
  values[7] = JSON.stringify(config);
  values[8] = hashConfig(config);
  const offset = profile === "new" ? Math.max(0, config.days - 14) : 0;
  values[9] = new Date(Date.parse(config.historyStart) + offset * 86400000).toISOString();
  if (initialized)
    await sourceTransaction(
      worker,
      scope,
      "CLAIM",
      () => worker.query(rawInsert, values),
      null,
      `lease-grant-${suffix}`,
    );
  return { scope, grant: `lease-grant-${suffix}` };
}
export async function claim(client, context, owner = randomUUID()) {
  return sourceTransaction(
    client,
    context.scope,
    "CLAIM",
    () => client.query(claimSql, [...scopeValues(context.scope), owner]),
    null,
    context.grant,
  );
}
export async function change(client, context, job, op, options = {}) {
  const {
    owner = job.leaseOwner,
    state = job.state,
    failure = null,
    lease = leaseOf(job),
  } = options;
  return sourceTransaction(
    client,
    context.scope,
    op,
    () =>
      client.query(updateSql, [job.sessionId, job.generation, job.revision, owner, state, failure]),
    lease,
    context.grant,
  );
}
export async function jobFor(admin, context) {
  const rows = (
    await admin.query('SELECT * FROM mock_platform."BuildJob" WHERE "sessionId"=$1', [
      context.scope.sessionId,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  return rows[0];
}
