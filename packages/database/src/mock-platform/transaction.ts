import type pg from "pg";
import { verifyCredentials, type SourceMode } from "./clients.js";
import { sanitized, SourceStorageError } from "./errors.js";
import type { SourceReadActor, SourceScope, SourceWorkerGrant } from "./types.js";

export async function transaction<T>(
  pool: pg.Pool,
  mode: SourceMode,
  action: (client: pg.PoolClient) => Promise<T>,
  rollbackWhen: (result: T) => boolean = () => false,
): Promise<T> {
  let client: pg.PoolClient | undefined;
  let begun = false;
  try {
    client = await pool.connect();
    await verifyCredentials(client, mode);
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await action(client);
    await client.query(rollbackWhen(result) ? "ROLLBACK" : "COMMIT");
    begun = false;
    return result;
  } catch (error) {
    if (client && begun) {
      try {
        await client.query("ROLLBACK");
      } catch {
        client.release(true);
        client = undefined;
      }
    }
    throw sanitized(error);
  } finally {
    client?.release();
  }
}
export async function readIdentity(client: pg.PoolClient, actor: SourceReadActor): Promise<void> {
  await client.query(
    "SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),set_config('mock.grant_id','',true)",
    [actor.userId, actor.merchantId],
  );
}
export function scopeValues(scope: SourceScope): readonly (string | number)[] {
  return [
    scope.organizationId,
    scope.workspaceId,
    scope.storeId,
    scope.sessionId,
    scope.connectionId,
    scope.externalStoreId,
    scope.generation,
  ];
}
export async function workerIdentity(
  client: pg.PoolClient,
  grant: SourceWorkerGrant,
): Promise<boolean> {
  await client.query(
    "SELECT set_config('app.user_id',$1,true),set_config('mock.grant_id',$2,true)",
    [grant.principalUserId, grant.id],
  );
  const stores = await client.query<{ merchantId: string }>(
    'SELECT "merchantId" FROM public."Store" WHERE id=$1 AND "organizationId"=$2 AND "workspaceId"=$3',
    [grant.storeId, grant.organizationId, grant.workspaceId],
  );
  if (stores.rowCount !== 1) return false;
  const merchant = stores.rows[0]?.merchantId;
  if (!merchant) throw new SourceStorageError("SOURCE_INTEGRITY");
  await client.query("SELECT set_config('app.merchant_id',$1,true)", [merchant]);
  return true;
}
export async function currentAccess(
  client: pg.PoolClient,
  scope: SourceScope,
  mode: SourceMode,
): Promise<boolean> {
  const sql =
    mode === "reader"
      ? "SELECT mock_platform.has_current_access($1,$2,$3,$4,$5,$6,$7) AS allowed"
      : "SELECT mock_platform.has_worker_access($1,$2,$3,$4,$5,$6,$7) AS allowed";
  const result = await client.query<{ allowed: boolean }>(sql, [...scopeValues(scope)]);
  return result.rowCount === 1 && result.rows[0]?.allowed === true;
}
