import type pg from "pg";
import { SourceStorageError } from "./errors.js";
import { currentAccess, workerIdentity } from "./transaction.js";
import { exact, safeId, validateScope } from "./validation.js";
import type { SourceBuildWork, SourceScope, SourceWorkerGrant } from "./types.js";

const grantKeys = [
  "id",
  "databaseRole",
  "principalUserId",
  "organizationId",
  "workspaceId",
  "storeId",
  "sessionId",
  "connectionId",
  "externalStoreId",
  "operation",
  "status",
];

function validateGrant(value: unknown): SourceWorkerGrant {
  if (
    !exact(value, grantKeys) ||
    !safeId(value.id) ||
    !safeId(value.principalUserId) ||
    typeof value.databaseRole !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value.databaseRole) ||
    value.operation !== "SOURCE_BUILD" ||
    value.status !== "ACTIVE"
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  const scope = {
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    storeId: value.storeId,
    sessionId: value.sessionId,
    connectionId: value.connectionId,
    externalStoreId: value.externalStoreId,
    generation: 0,
  };
  try {
    validateScope(scope);
  } catch {
    throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  return value as unknown as SourceWorkerGrant;
}
export async function findGrant(
  client: pg.PoolClient,
  id: string,
): Promise<SourceWorkerGrant | null> {
  const result = await client.query('SELECT * FROM demo."MockWorkerGrant" WHERE id=$1', [id]);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  return validateGrant(result.rows[0]);
}
export function matchesGrant(grant: SourceWorkerGrant, scope: SourceScope): boolean {
  return [
    "organizationId",
    "workspaceId",
    "storeId",
    "sessionId",
    "connectionId",
    "externalStoreId",
  ].every((key) => grant[key as keyof SourceWorkerGrant] === scope[key as keyof SourceScope]);
}
async function grantScope(
  client: pg.PoolClient,
  grant: SourceWorkerGrant,
): Promise<SourceScope | null> {
  if (!(await workerIdentity(client, grant))) return null;
  const result = await client.query<{ generation: number }>(
    'SELECT generation FROM public."PlatformConnection" WHERE id=$1',
    [grant.connectionId],
  );
  const generation = result.rows[0]?.generation;
  if (result.rowCount !== 1 || generation === undefined) return null;
  const { organizationId, workspaceId, storeId, sessionId, connectionId, externalStoreId } = grant;
  const scope = {
    organizationId,
    workspaceId,
    storeId,
    sessionId,
    connectionId,
    externalStoreId,
    generation,
  };
  try {
    validateScope(scope);
  } catch {
    throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  return (await currentAccess(client, scope, "worker")) ? scope : null;
}
export async function listGrants(client: pg.PoolClient): Promise<readonly SourceWorkerGrant[]> {
  const result = await client.query('SELECT * FROM demo."MockWorkerGrant" ORDER BY id');
  const available: SourceWorkerGrant[] = [];
  for (const row of result.rows) {
    const grant = validateGrant(row);
    if (await grantScope(client, grant)) available.push(grant);
  }
  return available;
}
export async function listBuildScopes(client: pg.PoolClient): Promise<readonly SourceBuildWork[]> {
  const result = await client.query('SELECT * FROM demo."MockWorkerGrant" ORDER BY id');
  const available: SourceBuildWork[] = [];
  for (const row of result.rows) {
    const grant = validateGrant(row);
    const scope = await grantScope(client, grant);
    if (scope)
      available.push(
        Object.freeze({ actor: Object.freeze({ grantId: grant.id }), scope: Object.freeze(scope) }),
      );
  }
  return Object.freeze(available);
}
