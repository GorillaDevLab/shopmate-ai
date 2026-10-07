import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceAccessDenied, type SourceFailureStatus } from "./errors.js";
import { findGrant, matchesGrant } from "./grants.js";
import { currentAccess, lockControl, transaction, workerIdentity } from "./transaction.js";
import type { SourceScope, SourceWorkerActor } from "./types.js";

async function authorize(
  client: pg.PoolClient,
  actor: SourceWorkerActor,
  scope: SourceScope,
): Promise<boolean> {
  await lockControl(client, scope);
  const grant = await findGrant(client, actor.grantId);
  if (!grant || !matchesGrant(grant, scope) || !(await workerIdentity(client, grant))) return false;
  await client.query("SELECT set_config('mock.scope',$1,true)", [JSON.stringify(scope)]);
  return currentAccess(client, scope, "worker");
}

export async function requireCurrentWorkerAccess(
  client: pg.PoolClient,
  scope: SourceScope,
): Promise<void> {
  if (!(await currentAccess(client, scope, "worker"))) throw new SourceAccessDenied();
}

export async function workerOperation<T>(
  pool: SourcePool,
  actor: SourceWorkerActor,
  scope: SourceScope,
  failures: readonly SourceFailureStatus[],
  rollbackWhen: (result: T) => boolean,
  denied: T,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return transaction(
    pool,
    "worker",
    async (client) => ((await authorize(client, actor, scope)) ? action(client) : denied),
    rollbackWhen,
    failures,
  );
}
