import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import {
  loginUrl,
  migrateSource,
  scopeFor,
  sourceFixtures,
} from "./mock-platform-fixture.mjs";

export async function createSyncDatabase() {
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  let admin;
  try {
  await operator.connect();
  await operator.query('CREATE DATABASE "shopmate_tenant_test_sync"');
  const url = new URL(server.url);
  url.pathname = "/shopmate_tenant_test_sync";
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await migrateSource(admin);
  await sourceFixtures(admin);
  await provisionLogin(admin, "sync_worker_login");
  await provisionLogin(admin, "sync_foreign_login");
  return { admin, operator, server, url: url.toString() };
  } catch (error) {
    await Promise.allSettled([admin?.end(), operator.end()]);
    await server.stop();
    throw error;
  }
}

async function provisionLogin(admin, login) {
  if (!["sync_worker_login", "sync_foreign_login"].includes(login)) throw new Error("Invalid fixture role");
  await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT shopmate_sync_worker TO ${login}`);
}

export async function createSyncGrant(admin, scope, id, login = "sync_worker_login", principal = "source-worker") {
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

export async function connectSyncWorker(url, login = "sync_worker_login", grantId = "sync-grant-a") {
  const client = new pg.Client({ connectionString: loginUrl(url, login) });
  await client.connect();
  await client.query("SELECT set_config('app.user_id',$1,false),set_config('sync.grant_id',$2,false)", [
    "source-worker",
    grantId,
  ]);
  return client;
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
  await database.admin.end();
  await database.operator.end();
  await database.server.stop();
}
