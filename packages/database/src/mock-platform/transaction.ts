import type pg from "pg";
import { verifyCredentials, type SourceMode, type SourcePool } from "./clients.js";
import { SourceStorageError, transactionFailure, type SourceFailureStatus } from "./errors.js";
import type { SourceReadActor, SourceScope, SourceWorkerGrant } from "./types.js";

async function rollbackFailed(client: pg.PoolClient | undefined, begun: boolean): Promise<boolean> {
  if (!client || !begun) return false;
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}
export async function transaction<T>(
  pool: SourcePool,
  mode: SourceMode,
  action: (client: pg.PoolClient) => Promise<T>,
  rollbackWhen: (result: T) => boolean = () => false,
  failures: readonly SourceFailureStatus[] = ["DENIED"],
): Promise<T> {
  let client: pg.PoolClient | undefined;
  let begun = false;
  let discard = false;
  const onError = () => {
    discard = true;
  };
  try {
    client = await pool.connect();
    // A checked-out client has no pg-pool idle listener; contain socket failures here.
    client.on("error", onError);
    await verifyCredentials(client, mode);
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    begun = true;
    await configureTransaction(client);
    const result = await action(client);
    if (discard) throw new SourceStorageError("SOURCE_STORAGE");
    await client.query(rollbackWhen(result) ? "ROLLBACK" : "COMMIT");
    begun = false;
    if (discard) throw new SourceStorageError("SOURCE_STORAGE");
    return result;
  } catch (error) {
    discard = (await rollbackFailed(client, begun)) || discard;
    if (discard) throw new SourceStorageError("SOURCE_STORAGE");
    throw transactionFailure(error, failures);
  } finally {
    client?.off("error", onError);
    client?.release(discard);
  }
}
export async function configureTransaction(client: pg.PoolClient): Promise<void> {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='10s'");
}
export async function lockControl(client: pg.PoolClient, scope: SourceScope): Promise<void> {
  await client.query("SELECT demo.lock_source_control($1)", [scope.sessionId]);
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
