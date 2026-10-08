import { sourcePool, type SourcePool } from "./clients.js";
import { readTransaction } from "./read-transaction.js";
import { SourceAccessDenied, SourceDomainFailure } from "./errors.js";
import { findGeneration, initializeGeneration } from "./generations.js";
import { findGrant, listGrants, matchesGrant } from "./grants.js";
import { assertFailureCode, claimJob, failJob, renewJob } from "./jobs.js";
import { appendChunk } from "./journal.js";
import { publish } from "./publication.js";
import { findPublication } from "./publication-certificate.js";
import { readLatestStates, validateLatestInput } from "./latest.js";
import { scanVersions, validateScanInput } from "./scan.js";
import type {
  ClaimResult,
  AppendResult,
  ChunkInput,
  FailResult,
  LeaseRef,
  RenewResult,
  SourceFailureCode,
  PublishInput,
  PublishResult,
} from "./publication-types.js";
import {
  validateChunk,
  validateLeaseInput,
  validatePublishInput,
} from "./publication-validation.js";
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
export type * from "./scan-types.js";
export type * from "./latest-types.js";
export { SourceStorageError, type SourceErrorCode } from "./errors.js";

export function createMockSourceReader(env: SourceEnvironment): MockSourceReader {
  const pool = sourcePool(env, "reader");
  return {
    async readLatestStates(actor, scope, input) {
      validateReadActor(actor);
      validateScope(scope);
      validateLatestInput(input);
      return readLatestStates(pool, env.MOCK_SOURCE_CURSOR_KEY ?? "", actor, scope, input);
    },
    async scanVersions(actor, scope, input, control) {
      validateReadActor(actor);
      validateScope(scope);
      validateScanInput(input);
      return scanVersions(pool, env.MOCK_SOURCE_CURSOR_KEY ?? "", actor, scope, input, control);
    },
    async findPublication(actor, scope, control) {
      validateReadActor(actor);
      validateScope(scope);
      return findPublication(pool, actor, scope, control);
    },
    async findGeneration(actor, scope, control) {
      validateReadActor(actor);
      validateScope(scope);
      return readTransaction(
        pool,
        async (client) => {
          await readIdentity(client, actor);
          await lockControl(client, scope);
          if (!(await currentAccess(client, scope, "reader"))) return null;
          const found = await findGeneration(client, scope);
          return found && (await currentAccess(client, scope, "reader")) ? found : null;
        },
        undefined,
        control,
      );
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
    appendChunk: (actor, lease, input) => appendControlled(pool, actor, lease, input),
    publish: (actor, lease, input) => publishControlled(pool, actor, lease, input),
    close: () => pool.end(),
  };
}
async function publishControlled(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  input: PublishInput,
): Promise<PublishResult> {
  validateWorkerActor(actor);
  validateLeaseInput(lease);
  validatePublishInput(input);
  try {
    return await publish(pool, actor, lease, input);
  } catch (error) {
    if (error instanceof SourceDomainFailure) return { status: error.status };
    throw error;
  }
}
async function appendControlled(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  input: ChunkInput,
): Promise<AppendResult> {
  validateWorkerActor(actor);
  validateLeaseInput(lease);
  validateChunk(input, lease.scope);
  try {
    return await appendChunk(pool, actor, lease, input);
  } catch (error) {
    if (error instanceof SourceDomainFailure) return { status: error.status };
    throw error;
  }
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
