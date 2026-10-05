import { sourcePool, type SourcePool } from "./clients.js";
import { SourceAccessDenied, SourceDomainFailure } from "./errors.js";
import { findGeneration, initializeGeneration } from "./generations.js";
import { findGrant, listGrants, matchesGrant } from "./grants.js";
import { assertFailureCode, claimJob, failJob, renewJob } from "./jobs.js";
import type {
  ClaimResult,
  FailResult,
  LeaseRef,
  RenewResult,
  SourceFailureCode,
} from "./publication-types.js";
import { validateLeaseInput } from "./publication-validation.js";
import {
  currentAccess,
  lockControl,
  readIdentity,
  transaction,
  workerIdentity,
} from "./transaction.js";
import { validateReadActor, validateScope, validateWorkerActor } from "./validation.js";
import type {
  MockSourceReader,
  MockSourceWorker,
  SourceEnvironment,
  SourceInitialization,
  SourceScope,
  SourceWorkerActor,
} from "./types.js";

export type * from "./types.js";
export type * from "./publication-types.js";
export { SourceStorageError, type SourceErrorCode } from "./errors.js";

export function createMockSourceReader(env: SourceEnvironment): MockSourceReader {
  const pool = sourcePool(env, "reader");
  return {
    async findGeneration(actor, scope) {
      validateReadActor(actor);
      validateScope(scope);
      return transaction(pool, "reader", async (client) => {
        await readIdentity(client, actor);
        await lockControl(client, scope);
        if (!(await currentAccess(client, scope, "reader"))) return null;
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
      return initializeControlled(pool, actor, scope);
    },
    claim: (actor, scope) => claimControlled(pool, actor, scope),
    renew: (actor, lease) => renewControlled(pool, actor, lease),
    fail: (actor, lease, code) => failControlled(pool, actor, lease, code),
    close: () => pool.end(),
  };
}
async function claimControlled(
  pool: SourcePool,
  actor: SourceWorkerActor,
  scope: SourceScope,
): Promise<ClaimResult> {
  validateWorkerActor(actor);
  validateScope(scope);
  try {
    return await claimJob(pool, actor, scope);
  } catch (error) {
    if (error instanceof SourceDomainFailure && error.status === "DENIED")
      return { status: "DENIED" };
    throw error;
  }
}
async function renewControlled(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
): Promise<RenewResult> {
  validateWorkerActor(actor);
  validateLeaseInput(lease);
  try {
    return await renewJob(pool, actor, lease);
  } catch (error) {
    if (error instanceof SourceDomainFailure && error.status !== "CONFLICT")
      return { status: error.status };
    throw error;
  }
}
async function failControlled(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  code: SourceFailureCode,
): Promise<FailResult> {
  validateWorkerActor(actor);
  validateLeaseInput(lease);
  assertFailureCode(code);
  try {
    return await failJob(pool, actor, lease, code);
  } catch (error) {
    if (error instanceof SourceDomainFailure && error.status !== "CONFLICT")
      return { status: error.status };
    throw error;
  }
}
async function initializeControlled(
  pool: SourcePool,
  actor: SourceWorkerActor,
  scope: SourceScope,
): Promise<SourceInitialization> {
  try {
    return await transaction<SourceInitialization>(
      pool,
      "worker",
      async (client) => {
        await lockControl(client, scope);
        const grant = await findGrant(client, actor.grantId);
        if (!grant || !matchesGrant(grant, scope) || !(await workerIdentity(client, grant)))
          return { status: "DENIED" };
        await client.query("SELECT set_config('mock.scope',$1,true)", [JSON.stringify(scope)]);
        if (!(await currentAccess(client, scope, "worker"))) return { status: "DENIED" };
        return initializeGeneration(client, scope);
      },
      (result) => result.status === "DENIED",
    );
  } catch (error) {
    if (error instanceof SourceAccessDenied) return { status: "DENIED" };
    throw error;
  }
}
