import type pg from "pg";
import { SourceAccessDenied, SourceStorageError } from "./errors.js";
import { journalScopeWhere } from "./journal-state.js";
import type { LatestCursorState, LatestPosition } from "./latest-cursor.js";
import type { LatestStateInput } from "./latest-types.js";
import type { Publication } from "./publication-types.js";
import { currentAccess, scopeValues } from "./transaction.js";
import type { SourceScope } from "./types.js";

const witnessSql = `SELECT kind,"entityKey","eventSeq"::text AS "eventSeq"
  FROM mock_platform."EntityVersion" WHERE ${journalScopeWhere}
    AND "eventSeq"=$8::bigint AND "releaseRevision"<=$9::bigint
    AND "eventSeq"<=$10::bigint AND "occurredAt"<=$11::timestamp
    AND ($12::text IS NULL OR kind COLLATE "C"=$12::text COLLATE "C")`;

export async function restoreLatestPosition(
  client: pg.PoolClient,
  scope: SourceScope,
  publication: Publication,
  state: LatestCursorState,
  input: LatestStateInput,
): Promise<LatestPosition> {
  const result = await client.query<LatestPosition>(witnessSql, [
    ...scopeValues(scope),
    state.afterEventSeq,
    publication.revision,
    publication.highEventSeq,
    publication.targetTime,
    input.kind ?? null,
  ]);
  if (result.rowCount !== 1 || !result.rows[0]) {
    if (!(await currentAccess(client, scope, "reader"))) throw new SourceAccessDenied();
    throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  return result.rows[0];
}
