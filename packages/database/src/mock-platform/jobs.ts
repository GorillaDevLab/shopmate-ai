import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceStorageError } from "./errors.js";
import type {
  BuildLease,
  ClaimResult,
  FailResult,
  LeaseRef,
  RenewResult,
  SourceFailureCode,
} from "./publication-types.js";
import { validateBuildLease } from "./publication-validation.js";
import { scopeValues } from "./transaction.js";
import type { SourceScope, SourceWorkerActor } from "./types.js";
import { requireCurrentWorkerAccess, workerOperation } from "./worker-operation.js";

interface OpenJob {
  readonly revision: string;
  readonly state: "BUILDING" | "FAILED";
  readonly active: boolean;
}
type LeaseRow = Omit<BuildLease, "scope">;
const scopeWhere = `"organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND
  "sessionId"=$4 AND "connectionId"=$5 AND "externalStoreId"=$6 AND generation=$7`;
const leaseColumns = `revision::text AS revision,fence::text AS fence,"leaseOwner" AS "ownerId",
  "targetClockRevision",mock_platform.canonical_utc("targetTime") AS "targetTime",
  "baseRevision"::text AS "baseRevision","baseHighEventSeq"::text AS "baseHighEventSeq",
  checkpoint,"checkpointHash",mock_platform.canonical_utc("leaseUntil") AS "leaseUntil"`;

function leaseFrom(row: LeaseRow | undefined, scope: SourceScope): BuildLease {
  if (!row) throw new SourceStorageError("SOURCE_INTEGRITY");
  const lease = { scope: { ...scope }, ...row };
  validateBuildLease(lease);
  return lease;
}

async function protocol(
  client: pg.PoolClient,
  operation: "CLAIM" | "RENEW" | "FAIL",
  lease: LeaseRef | null,
): Promise<void> {
  const reference = lease && {
    revision: lease.revision,
    fence: lease.fence,
    ownerId: lease.ownerId,
  };
  await client.query(
    "SELECT set_config('mock.source_op',$1,true),set_config('mock.source_lease',$2,true)",
    [operation, JSON.stringify(reference)],
  );
}

async function finalLeaseCheck(client: pg.PoolClient, lease: BuildLease): Promise<void> {
  await client.query("SELECT set_config('mock.source_lease',$1,true)", [
    JSON.stringify({ revision: lease.revision, fence: lease.fence, ownerId: lease.ownerId }),
  ]);
  await requireCurrentWorkerAccess(client, lease.scope);
  const result = await client.query(
    `SELECT mock_platform.require_live_lease(j) FROM mock_platform."BuildJob" j
      WHERE ${scopeWhere} AND revision=$8::bigint`,
    [...scopeValues(lease.scope), lease.revision],
  );
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
}

async function openJob(client: pg.PoolClient, scope: SourceScope): Promise<OpenJob | null> {
  const result = await client.query<OpenJob>(
    `SELECT revision::text AS revision,state,("leaseUntil">clock_timestamp()) AS active
      FROM mock_platform."BuildJob" WHERE ${scopeWhere} AND state IN ('BUILDING','FAILED') FOR UPDATE`,
    [...scopeValues(scope)],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0];
}

async function takeover(
  client: pg.PoolClient,
  scope: SourceScope,
  revision: string,
): Promise<BuildLease> {
  const result = await client.query<LeaseRow>(
    `UPDATE mock_platform."BuildJob" SET "leaseOwner"=$9,state='BUILDING',"failureCode"=NULL
      WHERE ${scopeWhere} AND revision=$8::bigint RETURNING ${leaseColumns}`,
    [...scopeValues(scope), revision, randomUUID()],
  );
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  return leaseFrom(result.rows[0], scope);
}

async function hasRuntime(client: pg.PoolClient, scope: SourceScope): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM mock_platform."Runtime" WHERE ${scopeWhere}`, [
    ...scopeValues(scope),
  ]);
  if (result.rowCount !== 0 && result.rowCount !== 1)
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rowCount === 1;
}

async function insertJob(client: pg.PoolClient, scope: SourceScope): Promise<BuildLease | null> {
  const result = await client.query<LeaseRow>(
    `INSERT INTO mock_platform."BuildJob"
      ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"leaseOwner")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${leaseColumns}`,
    [...scopeValues(scope), randomUUID()],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  return leaseFrom(result.rows[0], scope);
}

async function claimAction(
  client: pg.PoolClient,
  scope: SourceScope,
  sliced: boolean,
): Promise<ClaimResult> {
  await protocol(client, "CLAIM", null);
  // The server supplies the fixed budget; takeover never changes an accepted target.
  await client.query("SELECT set_config('mock.source_slice',$1,true)", [sliced ? "6h" : ""]);
  const open = await openJob(client, scope);
  await requireCurrentWorkerAccess(client, scope);
  if (open?.state === "BUILDING" && open.active) return { status: "BUSY" };
  if (open) {
    const lease = await takeover(client, scope, open.revision);
    await finalLeaseCheck(client, lease);
    return { status: "CLAIMED", lease };
  }
  if (!(await hasRuntime(client, scope))) return { status: "UNINITIALIZED" };
  const lease = await insertJob(client, scope);
  if (!lease) return { status: "IDLE" };
  await finalLeaseCheck(client, lease);
  return { status: "CLAIMED", lease };
}

export function claimJob(
  pool: SourcePool,
  actor: SourceWorkerActor,
  scope: SourceScope,
  sliced = false,
): Promise<ClaimResult> {
  return workerOperation<ClaimResult>(
    pool,
    actor,
    scope,
    ["DENIED"],
    (result) => result.status !== "CLAIMED",
    { status: "DENIED" },
    (client) => claimAction(client, scope, sliced),
  );
}

async function lockLease(client: pg.PoolClient, lease: LeaseRef): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    `SELECT state='BUILDING' AND fence::text=$9 AND "leaseOwner"=$10
       AND "leaseGrantId"=current_setting('mock.grant_id',true)
       AND "leaseUntil">clock_timestamp() AS matches
     FROM mock_platform."BuildJob" WHERE ${scopeWhere} AND revision=$8::bigint FOR UPDATE`,
    [...scopeValues(lease.scope), lease.revision, lease.fence, lease.ownerId],
  );
  if (result.rowCount === 0) return false;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0].matches === true;
}

async function renewAction(client: pg.PoolClient, lease: LeaseRef): Promise<RenewResult> {
  await protocol(client, "RENEW", lease);
  const matches = await lockLease(client, lease);
  await requireCurrentWorkerAccess(client, lease.scope);
  if (!matches) return { status: "FENCED" };
  const result = await client.query<LeaseRow>(
    `UPDATE mock_platform."BuildJob" SET "leaseOwner"="leaseOwner"
      WHERE ${scopeWhere} AND revision=$8::bigint RETURNING ${leaseColumns}`,
    [...scopeValues(lease.scope), lease.revision],
  );
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  const renewed = leaseFrom(result.rows[0], lease.scope);
  await finalLeaseCheck(client, renewed);
  return { status: "RENEWED", lease: renewed };
}

export function renewJob(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
): Promise<RenewResult> {
  return workerOperation<RenewResult>(
    pool,
    actor,
    lease.scope,
    ["DENIED", "FENCED"],
    (result) => result.status !== "RENEWED",
    { status: "DENIED" },
    (client) => renewAction(client, lease),
  );
}

async function failAction(
  client: pg.PoolClient,
  lease: LeaseRef,
  code: SourceFailureCode,
): Promise<FailResult> {
  await protocol(client, "FAIL", lease);
  const matches = await lockLease(client, lease);
  await requireCurrentWorkerAccess(client, lease.scope);
  if (!matches) return { status: "FENCED" };
  const result = await client.query(
    `UPDATE mock_platform."BuildJob" SET state='FAILED',"failureCode"=$9
      WHERE ${scopeWhere} AND revision=$8::bigint`,
    [...scopeValues(lease.scope), lease.revision, code],
  );
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  const fullLease = leaseFrom(
    (
      await client.query<LeaseRow>(
        `SELECT ${leaseColumns} FROM mock_platform."BuildJob" WHERE ${scopeWhere} AND revision=$8::bigint`,
        [...scopeValues(lease.scope), lease.revision],
      )
    ).rows[0],
    lease.scope,
  );
  await finalLeaseCheck(client, fullLease);
  return { status: "FAILED" };
}

export function failJob(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  code: SourceFailureCode,
): Promise<FailResult> {
  return workerOperation<FailResult>(
    pool,
    actor,
    lease.scope,
    ["DENIED", "FENCED"],
    (result) => result.status !== "FAILED",
    { status: "DENIED" },
    (client) => failAction(client, lease, code),
  );
}

export function assertFailureCode(value: unknown): asserts value is SourceFailureCode {
  if (value !== "INTERRUPTED" && value !== "GENERATOR_INVALID")
    throw new SourceStorageError("SOURCE_INPUT");
}
