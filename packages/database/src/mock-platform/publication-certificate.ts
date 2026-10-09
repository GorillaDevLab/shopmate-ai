import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { readTransaction } from "./read-transaction.js";
import { SourceAccessDenied, SourceStorageError } from "./errors.js";
import { journalScopeWhere } from "./journal-state.js";
import type { Publication } from "./publication-types.js";
import { validatePublication } from "./publication-validation.js";
import { currentAccess, lockControl, readIdentity, scopeValues } from "./transaction.js";
import type { SourceReadActor, SourceReadControl, SourceScope } from "./types.js";

// Public columns and builtins also work under the reader's deliberately narrow grants.
const certificateSql = `WITH certificate AS (SELECT jsonb_build_object(
  'scope',jsonb_build_object('organizationId',"organizationId",'workspaceId',"workspaceId",'storeId',"storeId",
    'sessionId',"sessionId",'connectionId',"connectionId",'externalStoreId',"externalStoreId",'generation',generation),
  'revision',revision::text,'targetClockRevision',"targetClockRevision",
  'targetTime',to_char("targetTime",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'baseRevision',"baseRevision"::text,'baseHighEventSeq',"baseHighEventSeq"::text,'highEventSeq',"highEventSeq"::text,
  'eventCount',"eventCount"::text,'versionCount',"versionCount"::text,
  'processedThrough',to_char("processedThrough",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'generatorVersion',"generatorVersion",'runtimeVersion',"runtimeVersion",'codec',codec,
  'publishedAt',to_char("publishedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS value,"certificateHash"
  FROM mock_platform."BuildJob" WHERE ${journalScopeWhere} AND state='PUBLISHED'
  AND ($8::bigint IS NULL OR revision=$8::bigint) ORDER BY revision DESC LIMIT 1)
 SELECT value||jsonb_build_object('certificateHash',"certificateHash") AS publication,
 "certificateHash"=encode(sha256(convert_to(jsonb_build_object('codec','source-certificate-v1',
 'certificate',value)::text,'UTF8')),'hex') AS valid FROM certificate`;

export async function readPublication(
  client: pg.PoolClient,
  scope: SourceScope,
  revision: string | null = null,
): Promise<Publication | null> {
  const result = await client.query<{ publication: unknown; valid: boolean }>(certificateSql, [
    ...scopeValues(scope),
    revision,
  ]);
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row || row.valid !== true)
    throw new SourceStorageError("SOURCE_INTEGRITY");
  validatePublication(row.publication);
  return row.publication;
}

export async function findPublication(
  pool: SourcePool,
  actor: SourceReadActor,
  scope: SourceScope,
  control?: SourceReadControl,
): Promise<Publication | null> {
  try {
    return await readTransaction(
      pool,
      async (client) => {
        await lockControl(client, scope);
        await readIdentity(client, actor);
        if (!(await currentAccess(client, scope, "reader"))) return null;
        const found = await readPublication(client, scope);
        if (!(await currentAccess(client, scope, "reader"))) throw new SourceAccessDenied();
        return found;
      },
      (result) => result === null,
      control,
    );
  } catch (error) {
    if (error instanceof SourceAccessDenied) return null;
    throw error;
  }
}
