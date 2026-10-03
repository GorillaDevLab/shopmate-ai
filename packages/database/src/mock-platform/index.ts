import { sourcePool } from "./clients.js";
import { findGeneration, initializeGeneration } from "./generations.js";
import { findGrant, listGrants, matchesGrant } from "./grants.js";
import { currentAccess, readIdentity, transaction, workerIdentity } from "./transaction.js";
import { validateReadActor, validateScope, validateWorkerActor } from "./validation.js";
import type {
  MockSourceReader,
  MockSourceWorker,
  SourceEnvironment,
  SourceInitialization,
} from "./types.js";

export type * from "./types.js";
export { SourceStorageError, type SourceErrorCode } from "./errors.js";

export function createMockSourceReader(env: SourceEnvironment): MockSourceReader {
  const pool = sourcePool(env, "reader");
  return {
    async findGeneration(actor, scope) {
      validateReadActor(actor);
      validateScope(scope);
      return transaction(pool, "reader", async (client) => {
        await readIdentity(client, actor);
        const found = await findGeneration(client, scope);
        return found && (await currentAccess(client, scope, "reader")) ? found : null;
      });
    },
    close: () => pool.end(),
  };
}
export function createMockSourceWorker(env: SourceEnvironment): MockSourceWorker {
  const pool = sourcePool(env, "worker");
  return {
    listGrants: () => transaction(pool, "worker", listGrants),
    async initializeGeneration(actor, scope) {
      validateWorkerActor(actor);
      validateScope(scope);
      return transaction<SourceInitialization>(
        pool,
        "worker",
        async (client) => {
          const grant = await findGrant(client, actor.grantId);
          if (!grant || !matchesGrant(grant, scope) || !(await workerIdentity(client, grant)))
            return { status: "DENIED" };
          await client.query("SELECT set_config('mock.scope',$1,true)", [JSON.stringify(scope)]);
          return initializeGeneration(client, scope);
        },
        (result) => result.status === "DENIED",
      );
    },
    close: () => pool.end(),
  };
}
