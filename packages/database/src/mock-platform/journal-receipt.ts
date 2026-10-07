import type pg from "pg";
import { SourceStorageError } from "./errors.js";
import type { ChunkInput, LeaseRef } from "./publication-types.js";
import { journalScopeWhere, journalValues } from "./journal-state.js";

// The extra candidate detects an oversized receipt without reading its full history.
const receiptRange = `WITH job AS MATERIALIZED (SELECT j FROM mock_platform."BuildJob" j
  WHERE ${journalScopeWhere} AND revision=$8::bigint),
 candidates AS MATERIALIZED (SELECT e AS fact,e."eventSeq" AS seq
  FROM mock_platform."SourceEvent" e,job WHERE e."sessionId"=(job.j)."sessionId" AND e.generation=(job.j).generation
  AND (e."eventSeq">=(job.j)."lastAppendStartSeq" OR (e."releaseRevision"=(job.j).revision
  AND e."appendIndex"=mock_platform.source_uint((job.j).checkpoint->>'chunkIndex')))
  ORDER BY e."eventSeq" LIMIT 101),
 events AS MATERIALIZED (SELECT *,row_number() OVER w AS position,lag(fact) OVER w AS prior
   FROM candidates WINDOW w AS (ORDER BY seq)),
 versions AS MATERIALIZED (SELECT v AS fact,v."eventSeq" AS seq FROM mock_platform."EntityVersion" v,job
  WHERE v."sessionId"=(job.j)."sessionId" AND v.generation=(job.j).generation
  AND v."eventSeq">=(job.j)."lastAppendStartSeq" ORDER BY v."eventSeq" LIMIT 101),
 matched AS (SELECT e.seq AS event_seq,v.seq AS version_seq,
  e.seq::numeric=(job.j)."lastAppendStartSeq"::numeric+e.position-1
  AND (e.fact)."appendIndex"=mock_platform.source_uint((job.j).checkpoint->>'chunkIndex')
  AND ((e.prior)."eventSeq" IS NULL OR ((e.prior)."acceptedFence"=(e.fact)."acceptedFence" AND
    ROW((e.prior)."occurredAt",(e.prior)."phaseRank",(e.prior)."entityKey" COLLATE "C",(e.prior).ordinal)
    <ROW((e.fact)."occurredAt",(e.fact)."phaseRank",(e.fact)."entityKey" COLLATE "C",(e.fact).ordinal))) AND
  mock_platform.publish_event_matches(e.fact,v.fact,job.j,mock_platform.hash_jsonb(mock_platform.version_envelope(e.fact))) AS valid
  FROM events e FULL JOIN versions v USING(seq) CROSS JOIN job)
 SELECT mock_platform.integrity((job.j)."lastAppendEventCount" BETWEEN 0 AND 100
  AND (job.j)."lastAppendStartSeq"::numeric+(job.j)."lastAppendEventCount"-1=(job.j)."highEventSeq"::numeric
  AND (job.j)."lastAppendExpectedHash" ~ '^[a-f0-9]{64}$'
  AND (job.j)."lastAppendHash"=mock_platform.hash_jsonb(jsonb_build_object('codec','source-chunk-v1',
    'scope',mock_platform.source_scope(to_jsonb(job.j)),'revision',(job.j).revision::text,
    'expectedCheckpointHash',(job.j)."lastAppendExpectedHash",'next',jsonb_build_object(
      'processedThrough',(job.j).checkpoint->'processedThrough','sealed',(job.j).checkpoint->'sealed'),
    'eventEnvelopeHashes',(SELECT coalesce(jsonb_agg((fact)."envelopeHash" ORDER BY seq),'[]'::jsonb) FROM events)))
  AND (SELECT count(*)=(job.j)."lastAppendEventCount" AND count(event_seq)=count(*) AND count(version_seq)=count(*)
    AND coalesce(bool_and(valid IS TRUE),true) FROM matched)) FROM job`;

export async function validateSavedReceipt(
  client: pg.PoolClient,
  lease: LeaseRef,
): Promise<boolean> {
  const exists = await client.query<{ receipt: boolean }>(
    `SELECT "lastAppendHash" IS NOT NULL AS receipt
    FROM mock_platform."BuildJob" WHERE ${journalScopeWhere} AND revision=$8::bigint`,
    [...journalValues(lease)],
  );
  if (exists.rowCount !== 1 || !exists.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  if (!exists.rows[0].receipt) return false;
  const checked = await client.query(receiptRange, [...journalValues(lease)]);
  if (checked.rowCount !== 1) throw new SourceStorageError("SOURCE_INTEGRITY");
  return true;
}

export async function savedReceiptMatches(
  client: pg.PoolClient,
  lease: LeaseRef,
  input: ChunkInput,
): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    `SELECT mock_platform.saved_append_matches(j,$9::jsonb) AS matches
    FROM mock_platform."BuildJob" j WHERE ${journalScopeWhere} AND revision=$8::bigint`,
    [...journalValues(lease), JSON.stringify(input)],
  );
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0].matches === true;
}
