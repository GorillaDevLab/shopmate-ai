import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceDomainFailure, SourceStorageError } from "./errors.js";
import type { BuildHydrationInput, BuildHydrationResult } from "./hydration-types.js";
import {
  finalJournalCheck,
  journalProtocol,
  journalScopeWhere,
  journalValues,
  lockJournal,
} from "./journal-state.js";
import type { LeaseRef } from "./publication-types.js";
import { validateDataBounds } from "./record-bounds.js";
import { validateEntityKey } from "./record-codec.js";
import { fields, list, requireInput, validateUtc } from "./record-primitives.js";
import { checkedVersion } from "./scan.js";
import type { SourceVersion } from "./scan-types.js";
import { validateLeaseInput } from "./publication-validation.js";
import { validateWorkerActor } from "./validation.js";
import type { SourceWorkerActor } from "./types.js";
import { workerOperation } from "./worker-operation.js";

// One index seek per explicit key, with time predicate inside the occurrence index.
export const hydratePointSql = `SELECT v.kind,v."entityKey",v."eventSeq"::text AS "eventSeq",
  v."releaseRevision"::text AS "releaseRevision",
  to_char(v."occurredAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",v.payload,v."versionHash"
  FROM mock_platform."EntityVersion" v WHERE ${journalScopeWhere}
  AND v.kind COLLATE "C"=$13::text COLLATE "C" AND v."entityKey" COLLATE "C"=$12::jsonb::text COLLATE "C"
  AND v."occurredAt"<$10::timestamp AND v."eventSeq"<=$11::bigint
  AND (v."releaseRevision"=$8::bigint OR (v."releaseRevision"<=$9::bigint AND EXISTS (
    SELECT 1 FROM mock_platform."BuildJob" b WHERE b."sessionId"=v."sessionId" AND b.generation=v.generation
    AND b.revision=v."releaseRevision" AND b.state='PUBLISHED'
    AND b."organizationId"=v."organizationId" AND b."workspaceId"=v."workspaceId" AND b."storeId"=v."storeId"
    AND b."connectionId"=v."connectionId" AND b."externalStoreId"=v."externalStoreId")))
  ORDER BY v."occurredAt" DESC,v."eventSeq" DESC LIMIT 1`;

export function validateHydrationInput(value: unknown): asserts value is BuildHydrationInput {
  validateDataBounds(value, 128 * 1024, 1000, 5);
  const input = fields(value, ["expectedCheckpointHash", "beforeTime", "kind", "entityKeys"]);
  requireInput(
    typeof input.expectedCheckpointHash === "string" &&
      /^[a-f0-9]{64}$/u.test(input.expectedCheckpointHash),
  );
  requireInput(
    validateUtc(input.beforeTime) &&
      ["ORDER", "INVENTORY", "MARKETING"].includes(input.kind as string),
  );
  requireInput(list(input.entityKeys, 1, 100));
  const seen = new Set<string>();
  for (const key of input.entityKeys) {
    validateEntityKey(input.kind as BuildHydrationInput["kind"], key);
    const text = JSON.stringify(key);
    requireInput(!seen.has(text));
    seen.add(text);
  }
}
async function baseRevision(client: pg.PoolClient, lease: LeaseRef): Promise<string> {
  const result = await client.query<{ revision: string }>(
    `SELECT "baseRevision"::text AS revision FROM mock_platform."BuildJob" WHERE ${journalScopeWhere} AND revision=$8::bigint`,
    [...journalValues(lease)],
  );
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0].revision;
}
export function hydrationValues(
  lease: LeaseRef,
  base: string,
  high: string,
  input: BuildHydrationInput,
  key: BuildHydrationInput["entityKeys"][number],
): unknown[] {
  return [...journalValues(lease), base, input.beforeTime, high, JSON.stringify(key), input.kind];
}
async function recoveryAction(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: BuildHydrationInput,
): Promise<BuildHydrationResult> {
  await journalProtocol(client, lease);
  const job = await lockJournal(client, lease);
  if (!job?.matches) return { status: "FENCED" };
  if (job.checkpointHash !== input.expectedCheckpointHash) return { status: "CONFLICT" };
  requireInput(input.beforeTime <= job.checkpoint.processedThrough);
  const base = await baseRevision(client, lease),
    items: SourceVersion[] = [];
  for (const key of input.entityKeys) {
    const rows = await client.query<SourceVersion>(
      hydratePointSql,
      hydrationValues(lease, base, job.checkpoint.highEventSeq, input, key),
    );
    if (rows.rowCount === 1 && rows.rows[0]) items.push(checkedVersion(rows.rows[0], lease.scope));
    else if (rows.rowCount !== 0) throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  await finalJournalCheck(client, lease);
  return {
    status: "HYDRATED",
    checkpoint: job.checkpoint,
    checkpointHash: job.checkpointHash,
    items,
  };
}
export async function hydrateBuild(
  pool: SourcePool,
  actor: SourceWorkerActor,
  lease: LeaseRef,
  input: BuildHydrationInput,
): Promise<BuildHydrationResult> {
  validateWorkerActor(actor);
  validateLeaseInput(lease);
  validateHydrationInput(input);
  try {
    return await workerOperation<BuildHydrationResult>(
      pool,
      actor,
      lease.scope,
      ["DENIED", "FENCED", "CONFLICT"],
      () => true,
      { status: "DENIED" },
      (client) => recoveryAction(client, lease, input),
    );
  } catch (error) {
    if (error instanceof SourceDomainFailure) return { status: error.status };
    throw error;
  }
}
