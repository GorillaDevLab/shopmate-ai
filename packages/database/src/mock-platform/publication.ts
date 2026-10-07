import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceStorageError } from "./errors.js";
import { journalScopeWhere, journalValues } from "./journal-state.js";
import { readPublication } from "./publication-certificate.js";
import type { LeaseRef, PublishInput, PublishResult } from "./publication-types.js";
import { validateCheckpoint } from "./publication-validation.js";
import { requireCurrentWorkerAccess, workerOperation } from "./worker-operation.js";
import type { SourceWorkerActor } from "./types.js";

interface PublishState {
  readonly state: string;
  readonly matches: boolean;
  readonly expected: boolean;
  readonly valid: boolean;
  readonly checkpoint: unknown;
}

async function publishProtocol(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: PublishInput,
): Promise<void> {
  await client.query(
    `SELECT set_config('mock.source_op','PUBLISH',true),
    set_config('mock.source_lease',$1,true),set_config('mock.expected_checkpoint_hash',$2,true),
    set_config('mock.expected_base_revision',$3,true)`,
    [
      JSON.stringify({ revision: lease.revision, fence: lease.fence, ownerId: lease.ownerId }),
      input.checkpointHash,
      input.expectedBaseRevision,
    ],
  );
}

async function lockPublication(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: PublishInput,
): Promise<PublishState | null> {
  const result = await client.query<PublishState>(
    `SELECT state,checkpoint,
    fence::text=$9 AND "leaseOwner"=$10 AND "leaseGrantId"=current_setting('mock.grant_id',true) AS matches,
    "checkpointHash"=$11 AND "baseRevision"::text=$12 AS expected,
    "checkpointHash"=mock_platform.hash_jsonb(jsonb_build_object('codec','source-checkpoint-hash-v1',
    'scope',mock_platform.source_scope(to_jsonb(j)),'revision',revision::text,'checkpoint',checkpoint))
    AND checkpoint->>'highEventSeq'="highEventSeq"::text
    AND checkpoint->>'processedThrough'=mock_platform.canonical_utc("processedThrough") AS valid
    FROM mock_platform."BuildJob" j WHERE ${journalScopeWhere} AND revision=$8::bigint FOR UPDATE`,
    [
      ...journalValues(lease),
      lease.fence,
      lease.ownerId,
      input.checkpointHash,
      input.expectedBaseRevision,
    ],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0];
}

async function publishAction(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: PublishInput,
): Promise<PublishResult> {
  await publishProtocol(client, lease, input);
  const job = await lockPublication(client, lease, input);
  await requireCurrentWorkerAccess(client, lease.scope);
  if (!job || !job.matches) return { status: "FENCED" };
  validateCheckpoint(job.checkpoint);
  if (job.valid !== true) throw new SourceStorageError("SOURCE_INTEGRITY");
  if (job.state === "PUBLISHED") {
    if (!job.expected) return { status: "CONFLICT" };
    return publishedResult(client, lease, "ALREADY_PUBLISHED");
  }
  await livePublication(client, lease);
  if (!job.expected || job.state !== "BUILDING") return { status: "CONFLICT" };
  const update = await client.query(
    `UPDATE mock_platform."BuildJob" SET state='PUBLISHED'
    WHERE ${journalScopeWhere} AND revision=$8::bigint`,
    [...journalValues(lease)],
  );
  if (update.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  await livePublication(client, lease);
  return publishedResult(client, lease, "PUBLISHED");
}

async function livePublication(client: pg.PoolClient, lease: LeaseRef): Promise<void> {
  await requireCurrentWorkerAccess(client, lease.scope);
  const result = await client.query(
    `SELECT mock_platform.require_live_lease(j)
    FROM mock_platform."BuildJob" j WHERE ${journalScopeWhere} AND revision=$8::bigint`,
    [...journalValues(lease)],
  );
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
}

async function publishedResult(
  client: pg.PoolClient,
  lease: LeaseRef,
  status: "PUBLISHED" | "ALREADY_PUBLISHED",
): Promise<PublishResult> {
  const publication = await readPublication(client, lease.scope, lease.revision);
  if (!publication) throw new SourceStorageError("SOURCE_INTEGRITY");
  await requireCurrentWorkerAccess(client, lease.scope);
  return { status, publication };
}

export async function publish(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  input: PublishInput,
): Promise<PublishResult> {
  return workerOperation<PublishResult>(
    pool,
    actor,
    lease.scope,
    ["DENIED", "FENCED", "CONFLICT"],
    (result) => result.status !== "PUBLISHED",
    { status: "DENIED" },
    (client) => publishAction(client, lease, input),
  );
}
