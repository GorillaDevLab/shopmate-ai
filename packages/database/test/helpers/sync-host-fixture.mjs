import pg from "pg";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import { loginUrl, migrateSource, scopeFor, sourceFixtures } from "./mock-platform-fixture.mjs";

export async function createSyncDatabase(suite = "sync") {
  if (!["sync", "receipt", "worker"].includes(suite)) throw new Error("Invalid sync fixture suite");
  const databaseName = `shopmate_tenant_test_${suite}${suite === "worker" ? randomBytes(6).toString("hex") : ""}`;
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  let admin;
  let created = false;
  try {
    await operator.connect();
    await operator.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(server.url);
    url.pathname = `/${databaseName}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    await migrateSource(admin);
    await sourceFixtures(admin);
    await provisionLogin(admin, "sync_worker_login");
    await provisionLogin(admin, "sync_foreign_login");
    return {
      admin,
      operator,
      server,
      url: url.toString(),
      ownedDatabase: suite === "worker" ? databaseName : null,
    };
  } catch (error) {
    await admin?.end();
    if (suite === "worker" && created) await operator.query(`DROP DATABASE "${databaseName}"`);
    await operator.end();
    await server.stop();
    throw error;
  }
}

async function provisionLogin(admin, login) {
  if (!["sync_worker_login", "sync_foreign_login"].includes(login))
    throw new Error("Invalid fixture role");
  // Suites share an isolated server in the mandatory gate; logins are cluster-wide.
  const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login]);
  if (!existing.rowCount) await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT shopmate_sync_worker TO ${login}`);
}

export async function createSyncGrant(
  admin,
  scope,
  id,
  login = "sync_worker_login",
  principal = "source-worker",
) {
  await admin.query(
    'INSERT INTO sync_host."WorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","connectionId","externalStoreId",provider,generation,"initialSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      id,
      login,
      principal,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      "MOCK",
      scope.generation,
      "2026-01-01T00:00:00.000Z",
    ],
  );
}

export async function connectSyncWorker(
  url,
  login = "sync_worker_login",
  grantId = "sync-grant-a",
) {
  const client = new pg.Client({ connectionString: loginUrl(url, login) });
  try {
    await client.connect();
    await client.query(
      "SELECT set_config('app.user_id',$1,false),set_config('sync.grant_id',$2,false)",
      ["source-worker", grantId],
    );
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

export function syncScope(key = "a", generation = 0) {
  const source = scopeFor(key, generation);
  return {
    organizationId: source.organizationId,
    workspaceId: source.workspaceId,
    storeId: source.storeId,
    connectionId: source.connectionId,
    externalStoreId: source.externalStoreId,
    provider: "MOCK",
    generation,
  };
}

export async function closeSyncDatabase(database) {
  const results = await Promise.allSettled([database.admin.end()]);
  if (database.ownedDatabase) {
    if (!/^shopmate_tenant_test_worker[0-9a-f]{12}$/u.test(database.ownedDatabase))
      throw new Error("Invalid owned fixture database");
    await database.operator.query(`DROP DATABASE "${database.ownedDatabase}"`);
  }
  results.push(...(await Promise.allSettled([database.operator.end()])));
  await database.server.stop();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Sync fixture cleanup failed",
    );
}
