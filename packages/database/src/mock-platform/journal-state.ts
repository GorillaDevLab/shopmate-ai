import type pg from "pg";
import { SourceStorageError } from "./errors.js";
import type { Checkpoint, LeaseRef } from "./publication-types.js";
import { validateCheckpoint } from "./publication-validation.js";
import { scopeValues } from "./transaction.js";
import { requireCurrentWorkerAccess } from "./worker-operation.js";

export const journalScopeWhere = `"organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3 AND
  "sessionId"=$4 AND "connectionId"=$5 AND "externalStoreId"=$6 AND generation=$7`;
export interface JournalState {
  readonly matches: boolean;
  readonly checkpoint: Checkpoint;
  readonly checkpointHash: string;
  readonly valid: boolean;
}
export const journalValues = (lease: LeaseRef): readonly unknown[] => [
  ...scopeValues(lease.scope),
  lease.revision,
];

export async function journalProtocol(client: pg.PoolClient, lease: LeaseRef): Promise<void> {
  await client.query(
    "SELECT set_config('mock.source_op','APPEND',true),set_config('mock.source_lease',$1,true)",
    [JSON.stringify({ revision: lease.revision, fence: lease.fence, ownerId: lease.ownerId })],
  );
}

export async function lockJournal(
  client: pg.PoolClient,
  lease: LeaseRef,
): Promise<JournalState | null> {
  const result = await client.query<JournalState>(
    `SELECT state='BUILDING' AND fence::text=$9 AND "leaseOwner"=$10
       AND "leaseGrantId"=current_setting('mock.grant_id',true) AND "leaseUntil">clock_timestamp() AS matches,
       checkpoint,"checkpointHash", "checkpointHash"=mock_platform.hash_jsonb(jsonb_build_object(
       'codec','source-checkpoint-hash-v1','scope',mock_platform.source_scope(to_jsonb(j)),
       'revision',revision::text,'checkpoint',checkpoint)) AND checkpoint->>'highEventSeq'="highEventSeq"::text
       AND checkpoint->>'processedThrough'=mock_platform.canonical_utc("processedThrough")
       AND "eventCount"="versionCount" AND "highEventSeq"::numeric="baseHighEventSeq"::numeric+"eventCount"::numeric AS valid
     FROM mock_platform."BuildJob" j WHERE ${journalScopeWhere} AND revision=$8::bigint FOR UPDATE`,
    [...journalValues(lease), lease.fence, lease.ownerId],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  const row = result.rows[0];
  if (row.matches) {
    validateCheckpoint(row.checkpoint);
    if (row.valid !== true) throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  return row;
}

export async function finalJournalCheck(client: pg.PoolClient, lease: LeaseRef): Promise<void> {
  await requireCurrentWorkerAccess(client, lease.scope);
  const result = await client.query(
    `SELECT mock_platform.require_live_lease(j)
    FROM mock_platform."BuildJob" j WHERE ${journalScopeWhere} AND revision=$8::bigint`,
    [...journalValues(lease)],
  );
  if (result.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
}
