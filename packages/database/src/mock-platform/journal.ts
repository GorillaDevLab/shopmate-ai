import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceStorageError } from "./errors.js";
import type { AppendResult, ChunkInput, LeaseRef, SnapshotEvent } from "./publication-types.js";
import { validateCheckpoint, validateUInt } from "./publication-validation.js";
import type { SourceWorkerActor } from "./types.js";
import { requireCurrentWorkerAccess, workerOperation } from "./worker-operation.js";
import {
  finalJournalCheck,
  journalProtocol,
  journalScopeWhere,
  journalValues,
  lockJournal,
} from "./journal-state.js";
import { savedReceiptMatches, validateSavedReceipt } from "./journal-receipt.js";

async function insertSnapshots(
  client: pg.PoolClient,
  lease: LeaseRef,
  events: readonly SnapshotEvent[],
): Promise<void> {
  if (!events.length) return;
  // Each statement guard scans the pending suffix; batching avoids quadratic rescans.
  // Explicit input order preserves the row guard's DB-derived sequence allocation.
  const inserted = await client.query<{ eventSeq: string }>(
    `INSERT INTO mock_platform."SourceEvent"
    ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision",kind,"occurredAt",ordinal,payload)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::bigint,value->>'kind',
      (value->>'occurredAt')::timestamp,(value->>'ordinal')::bigint,value->'after'
    FROM jsonb_array_elements($9::jsonb) WITH ORDINALITY AS input(value,position)
    ORDER BY position RETURNING "eventSeq"::text AS "eventSeq"`,
    [...journalValues(lease), JSON.stringify(events)],
  );
  if (
    inserted.rowCount !== events.length ||
    inserted.rows.length !== events.length ||
    inserted.rows.some((row) => !validateUInt(row.eventSeq) || row.eventSeq === "0") ||
    new Set(inserted.rows.map((row) => row.eventSeq)).size !== events.length
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  const version = await client.query(
    `INSERT INTO mock_platform."EntityVersion"
    ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision","eventSeq")
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::bigint,sequence
    FROM unnest($9::bigint[]) WITH ORDINALITY AS input(sequence,position) ORDER BY position`,
    [...journalValues(lease), inserted.rows.map((row) => row.eventSeq)],
  );
  if (version.rowCount !== events.length) throw new SourceStorageError("SOURCE_INTEGRITY");
}

async function commitChunk(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: ChunkInput,
): Promise<AppendResult> {
  await client.query(
    "SELECT set_config('mock.expected_checkpoint_hash',$1,true),set_config('mock.source_append',$2,true)",
    [
      input.expectedCheckpointHash,
      JSON.stringify({ eventCount: input.events.length, next: input.next }),
    ],
  );
  await insertSnapshots(client, lease, input.events);
  const result = await client.query<{ checkpoint: unknown; checkpointHash: string }>(
    `UPDATE mock_platform."BuildJob"
    SET checkpoint=$9::jsonb WHERE ${journalScopeWhere} AND revision=$8::bigint RETURNING checkpoint,"checkpointHash"`,
    [...journalValues(lease), JSON.stringify(input.next)],
  );
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  const row = result.rows[0];
  validateCheckpoint(row.checkpoint);
  if (!/^[a-f0-9]{64}$/u.test(row.checkpointHash)) throw new SourceStorageError("SOURCE_INTEGRITY");
  await finalJournalCheck(client, lease);
  return { status: "COMMITTED", checkpoint: row.checkpoint, checkpointHash: row.checkpointHash };
}

async function appendAction(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: ChunkInput,
): Promise<AppendResult> {
  await journalProtocol(client, lease);
  const job = await lockJournal(client, lease);
  await requireCurrentWorkerAccess(client, lease.scope);
  if (!job?.matches) return { status: "FENCED" };
  // Prove prior committed facts before a fresh append can overwrite their receipt.
  const receipt = await validateSavedReceipt(client, lease);
  if (job.checkpointHash !== input.expectedCheckpointHash) {
    if (!receipt || !(await savedReceiptMatches(client, lease, input)))
      return { status: "CONFLICT" };
    await finalJournalCheck(client, lease);
    return {
      status: "ALREADY_COMMITTED",
      checkpoint: job.checkpoint,
      checkpointHash: job.checkpointHash,
    };
  }
  if (job.checkpoint.sealed) return { status: "CONFLICT" };
  return commitChunk(client, lease, input);
}

export function appendChunk(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  input: ChunkInput,
): Promise<AppendResult> {
  return workerOperation<AppendResult>(
    pool,
    actor,
    lease.scope,
    ["DENIED", "FENCED", "CONFLICT"],
    (result) => result.status !== "COMMITTED",
    { status: "DENIED" },
    (client) => appendAction(client, lease, input),
  );
}
