import assert from "node:assert/strict";
import pg from "pg";
import { configFor, hashConfig, scopeFor } from "./mock-platform-fixture.mjs";

export const controlActor = { userId: "source-human", merchantId: "source-merchant-a" };
export async function beginWorker(client, scope = scopeFor(), grant = "source-grant-a") {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query(
    "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id',$3,true),set_config('demo.control_session_id',$4,true)",
    ["source-worker", scope.organizationId.replace("legacy-org-", ""), grant, scope.sessionId],
  );
}
export async function beginControl(
  client,
  sessionId = scopeFor().sessionId,
  user = "source-human",
) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SELECT set_config('app.user_id',$1,true)", [user]);
  await client.query("SELECT demo.lock_source_control($1)", [sessionId]);
}
export async function operatorControl(
  client,
  sql,
  values,
  scope = scopeFor(),
  user = "source-human",
) {
  await beginControl(client, scope.sessionId, user);
  try {
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
export function maintenanceClient(client, user) {
  return new Proxy(client, {
    get(target, key) {
      if (key === "query")
        return async (sql, values = []) => {
          if (
            !/^UPDATE\s+(?:public\.)?"PlatformConnection"|^UPDATE\s+demo\."DemoCommerceSession"/u.test(
              sql,
            )
          )
            return target.query(sql, values);
          const ids = values.filter((value) => typeof value === "string");
          const rows = (
            await target.query(
              'SELECT id FROM demo."DemoCommerceSession" WHERE id=ANY($1::text[]) OR "connectionId"=ANY($1::text[])',
              [ids],
            )
          ).rows;
          assert.equal(rows.length, 1, "maintenance fixture must name exactly one session");
          return operatorControl(target, sql, values, { sessionId: rows[0].id }, user);
        };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function grantControl(client, login) {
  // Locally fixed fixture login identifiers, never user input.
  assert.match(login, /^[a-z_]+$/u);
  await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
  await client.query(`GRANT USAGE ON SCHEMA public,demo TO ${login}`);
  await client.query(
    `GRANT SELECT ON public."Organization",public."OrganizationMember",public."Workspace",public."WorkspaceMember",public."Store",public."DemoTenant",public."TenantBootstrapEnvironment" TO ${login}`,
  );
  await client.query(
    `GRANT SELECT,INSERT,UPDATE ON public."PlatformConnection",demo."DemoCommerceSession" TO ${login}`,
  );
  await client.query(`GRANT SELECT,INSERT ON demo."DemoControlAudit" TO ${login}`);
  await client.query(
    `GRANT EXECUTE ON FUNCTION demo.has_store_access(TEXT,TEXT,TEXT,BOOLEAN),demo.lock_source_control(TEXT) TO ${login}`,
  );
}
export async function waitLock(admin, namespace, granted, pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = (
      await admin.query(
        "SELECT pid,objid,mode FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objsubid=2 AND granted=$2 AND ($3::integer IS NULL OR pid=$3)",
        [namespace, granted, pid ?? null],
      )
    ).rows;
    if (rows.length) return rows;
  }
  assert.fail(`Expected ${granted ? "held" : "waiting"} advisory lock in namespace ${namespace}`);
}
export const rawInsert = `INSERT INTO mock_platform."Runtime" ("sessionId",generation,"organizationId","workspaceId","storeId","connectionId","externalStoreId","sourceConfig","configHash","generatorVersion","runtimeVersion","openingAt","baselineEnd")
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'mock-source-v1','mock-runtime-v2',$10::timestamp,$11::timestamp)`;
export function rawValues(scope) {
  const config = configFor(scope);
  return [
    scope.sessionId,
    scope.generation,
    scope.organizationId,
    scope.workspaceId,
    scope.storeId,
    scope.connectionId,
    scope.externalStoreId,
    JSON.stringify(config),
    hashConfig(config),
    config.historyStart,
    "2026-01-30T16:00:00.000Z",
  ];
}
export async function observeSourceSettings(action) {
  const original = pg.Pool.prototype.connect;
  const restored = new Map();
  const observations = [];
  pg.Pool.prototype.connect = async function (...args) {
    const client = await original.apply(this, args);
    if (!restored.has(client)) {
      const query = client.query.bind(client);
      restored.set(client, client.query);
      client.query = async (...queryArgs) => {
        const result = await query(...queryArgs);
        if (["COMMIT", "ROLLBACK"].includes(queryArgs[0])) {
          const settings = (
            await query(
              "SELECT current_setting('app.user_id',true) AS actor,current_setting('app.merchant_id',true) AS merchant,current_setting('mock.grant_id',true) AS grant,current_setting('mock.scope',true) AS mock_scope,current_setting('demo.control_session_id',true) AS control_scope",
            )
          ).rows[0];
          observations.push({ pid: client.processID, settings });
        }
        return result;
      };
    }
    return client;
  };
  try {
    await action();
    return observations;
  } finally {
    pg.Pool.prototype.connect = original;
    for (const [client, query] of restored) client.query = query;
  }
}
