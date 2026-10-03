import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";

export const readerActor = { userId: "source-human", merchantId: "source-merchant-a" };
export function scopeFor(key = "a", generation = 0) {
  const org = key === "a2" ? "a" : key;
  return {
    organizationId: `legacy-org-source-merchant-${org}`,
    workspaceId: `legacy-workspace-source-merchant-${org}`,
    storeId: `source-store-${key}`,
    sessionId: `source-session-${key}`,
    connectionId: `source-connection-${key}`,
    externalStoreId: `mock/store.${key}`,
    generation,
  };
}
export function configFor(scope, profile = "mature", days = 30) {
  const { organizationId, workspaceId, storeId, connectionId, externalStoreId } = scope;
  return {
    binding: { organizationId, workspaceId, storeId, connectionId, externalStoreId },
    seed: 42,
    profile,
    historyStart: "2025-12-31T16:00:00.000Z",
    days,
    productCount: 60,
    variantsPerProduct: 3,
    dailyOrders: 100,
    growthBps: 0,
    refundBps: 150,
    adSpendMinor: 10000,
  };
}
export const hashConfig = (config) =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");

export async function migrateSource(client) {
  const root = new URL("../../prisma/migrations/", import.meta.url);
  for (const name of (await readdir(root)).filter((v) => /^\d{14}_/u.test(v)).sort())
    await client.query(await readFile(new URL(`${name}/migration.sql`, root), "utf8"));
}

export async function sourceFixtures(client) {
  for (const key of ["a", "b"]) {
    const scope = scopeFor(key);
    await client.query(
      'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [`source-merchant-${key}`],
    );
    for (const [user, role] of [
      ["source-human", "OWNER"],
      ["source-worker", "VIEWER"],
      ["source-viewer", "VIEWER"],
    ]) {
      await client.query(
        'INSERT INTO "OrganizationMember" (id,"organizationId","userId",role,"updatedAt") VALUES ($1,$2,$3,$4,now())',
        [`member-${key}-${user}`, scope.organizationId, user, role],
      );
      if (user !== "source-human")
        await client.query(
          'INSERT INTO "WorkspaceMember" (id,"organizationId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
          [`assigned-${key}-${user}`, scope.organizationId, scope.workspaceId, user],
        );
    }
    await client.query('INSERT INTO "DemoTenant" ("organizationId") VALUES ($1)', [
      scope.organizationId,
    ]);
  }
  await client.query('UPDATE "TenantBootstrapEnvironment" SET environment=$1', ["DEMO"]);
  await client.query(
    'INSERT INTO "Workspace" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,now())',
    ["source-unassigned", scopeFor().organizationId],
  );
  for (const key of ["a", "a2", "b"]) await createSourceSession(client, scopeFor(key));
  for (const [login, group] of [
    ["source_read_login", "shopmate_mock_source_reader"],
    ["source_worker_login", "shopmate_mock_source_worker"],
    ["source_foreign_login", "shopmate_mock_source_worker"],
  ]) {
    await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT ${group} TO ${login}`);
  }
  await client.query("CREATE ROLE source_app_login LOGIN NOSUPERUSER NOBYPASSRLS");
  await client.query("ALTER ROLE source_worker_login SET timezone='Pacific/Auckland'");
  for (const key of ["a", "a2", "b"])
    await grantSource(client, scopeFor(key), `source-grant-${key}`);
}

export async function createSourceSession(client, scope, profile = "mature", days = 30) {
  const config = configFor(scope, profile, days);
  const merchant = scope.organizationId.replace("legacy-org-", "");
  await client.query(
    'INSERT INTO "Store" (id,"merchantId",name,city,platform,"organizationId","workspaceId") VALUES ($1,$2,$1,$3,$4,$5,$6)',
    [scope.storeId, merchant, "Shanghai", "MOCK", scope.organizationId, scope.workspaceId],
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
    'INSERT INTO demo."DemoCommerceSession" (id,"organizationId","workspaceId","storeId","connectionId","externalStoreId",config,"configHash","generatorVersion","clockNow") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      scope.sessionId,
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.connectionId,
      scope.externalStoreId,
      config,
      hashConfig(config),
      "mock-source-v1",
      config.historyStart,
    ],
  );
}

export async function grantSource(client, scope, id, login = "source_worker_login") {
  await client.query(
    'INSERT INTO demo."MockWorkerGrant" (id,"databaseRole","principalUserId","organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",operation,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      id,
      login,
      "source-worker",
      scope.organizationId,
      scope.workspaceId,
      scope.storeId,
      scope.sessionId,
      scope.connectionId,
      scope.externalStoreId,
      "SOURCE_BUILD",
      "ACTIVE",
    ],
  );
}

export function loginUrl(base, name) {
  const url = new URL(base);
  url.username = name;
  url.password = "";
  return url.toString();
}
export function sourceEnv(base) {
  return {
    MOCK_PLATFORM_READ_DATABASE_URL: loginUrl(base, "source_read_login"),
    MOCK_PLATFORM_WORKER_DATABASE_URL: loginUrl(base, "source_worker_login"),
  };
}
