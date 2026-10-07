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

async function insertSnapshot(
  client: pg.PoolClient,
  lease: LeaseRef,
  event: SnapshotEvent,
): Promise<void> {
  const inserted = await client.query<{ eventSeq: string }>(
    `INSERT INTO mock_platform."SourceEvent"
    ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision",kind,"occurredAt",ordinal,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,$10::timestamp,$11::bigint,$12::jsonb) RETURNING "eventSeq"::text AS "eventSeq"`,
    [
      ...journalValues(lease),
      event.kind,
      event.occurredAt,
      event.ordinal,
      JSON.stringify(event.after),
    ],
  );
  if (
    inserted.rowCount !== 1 ||
    !validateUInt(inserted.rows[0]?.eventSeq) ||
    inserted.rows[0]?.eventSeq === "0"
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  const version = await client.query(
    `INSERT INTO mock_platform."EntityVersion"
    ("organizationId","workspaceId","storeId","sessionId","connectionId","externalStoreId",generation,"releaseRevision","eventSeq")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint)`,
    [...journalValues(lease), inserted.rows[0]?.eventSeq],
  );
  if (version.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
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
  for (const event of input.events) await insertSnapshot(client, lease, event);
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
