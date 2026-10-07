import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceAccessDenied, SourceStorageError } from "./errors.js";
import { journalScopeWhere } from "./journal-state.js";
import { readPublication } from "./publication-certificate.js";
import { validateSnapshotEvent } from "./publication-validation.js";
import { positiveUInt, validateUtc } from "./record-primitives.js";
import {
  createScanCursor,
  readScanCursor,
  validateScanKey,
  type ScanCursorState,
} from "./scan-cursor.js";
import type { SourceScanInput, SourceScanPage, SourceVersion } from "./scan-types.js";
import {
  currentAccess,
  lockControl,
  readIdentity,
  scopeValues,
  transaction,
} from "./transaction.js";
import type { SourceReadActor, SourceScope } from "./types.js";
import { exact, integer, object } from "./validation.js";

const versionSql = `SELECT kind,"entityKey","eventSeq"::text AS "eventSeq",
  "releaseRevision"::text AS "releaseRevision",
  to_char("occurredAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
  payload,"versionHash" FROM mock_platform."EntityVersion"
  WHERE ${journalScopeWhere} AND "releaseRevision"<=$8::bigint AND "eventSeq"<=$9::bigint
    AND "occurredAt">=$10::timestamp AND "occurredAt"<=$11::timestamp
    AND ($12::text IS NULL OR (kind COLLATE "C","entityKey" COLLATE "C","eventSeq") >
      ($12::text COLLATE "C",$13::text COLLATE "C",$14::bigint))
  ORDER BY kind COLLATE "C","entityKey" COLLATE "C","eventSeq" LIMIT $15`;
const hash = /^[a-f0-9]{64}$/u;

export function validateScanInput(value: unknown): asserts value is SourceScanInput {
  const keys = exact(value, ["since", "until", "limit"])
    ? ["since", "until", "limit"]
    : ["since", "until", "limit", "cursor"];
  if (
    !exact(value, keys) ||
    !validateUtc(value.since) ||
    !validateUtc(value.until) ||
    value.since > value.until ||
    !integer(value.limit, 1, 200) ||
    ("cursor" in value &&
      (typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 4096))
  )
    throw new SourceStorageError("SOURCE_INPUT");
}

function pin(
  state: ScanCursorState | null,
  publication: SourceScanPage["publication"] | null,
  input: SourceScanInput,
): void {
  if (state && (state.since !== input.since || state.until !== input.until))
    throw new SourceStorageError("SOURCE_INPUT");
  if (!publication) return;
  if (
    state &&
    (state.certificateHash !== publication.certificateHash ||
      state.highEventSeq !== publication.highEventSeq ||
      state.revision !== publication.revision)
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  if (input.until > publication.targetTime) throw new SourceStorageError("SOURCE_INPUT");
}

function checkedVersion(row: SourceVersion, scope: SourceScope): SourceVersion {
  if (
    !positiveUInt(row.eventSeq) ||
    !positiveUInt(row.releaseRevision) ||
    typeof row.entityKey !== "string" ||
    row.entityKey.length > 1024 ||
    typeof row.versionHash !== "string" ||
    !hash.test(row.versionHash)
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  try {
    if (
      !object(row.payload) ||
      !object(row.payload.source) ||
      row.payload.source.version !== `mock-runtime-v2:g:${scope.generation}:e:${row.eventSeq}`
    )
      throw new SourceStorageError("SOURCE_INTEGRITY");
    const after = { ...row.payload, source: { ...row.payload.source, version: null } };
    validateSnapshotEvent(
      { kind: row.kind, occurredAt: row.occurredAt, ordinal: "0", after },
      scope,
    );
  } catch {
    throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  return row;
}

async function readVersions(
  client: pg.PoolClient,
  scope: SourceScope,
  publication: SourceScanPage["publication"],
  input: SourceScanInput,
  after: ScanCursorState["after"],
): Promise<SourceVersion[]> {
  const values = [
    ...scopeValues(scope),
    publication.revision,
    publication.highEventSeq,
    input.since,
    input.until,
    after?.kind ?? null,
    after?.entityKey ?? null,
    after?.eventSeq ?? null,
    input.limit + 1,
  ];
  const result = await client.query<SourceVersion>(versionSql, values);
  if (result.rowCount !== result.rows.length || result.rows.length > input.limit + 1)
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows.map((row) => checkedVersion(row, scope));
}

function page(
  publication: SourceScanPage["publication"],
  input: SourceScanInput,
  scope: SourceScope,
  rows: SourceVersion[],
  key: string,
): SourceScanPage {
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? createScanCursor(key, {
          scope,
          certificateHash: publication.certificateHash,
          revision: publication.revision,
          highEventSeq: publication.highEventSeq,
          since: input.since,
          until: input.until,
          after: { kind: last.kind, entityKey: last.entityKey, eventSeq: last.eventSeq },
          expiresAt: Date.now() + 15 * 60_000,
        })
      : null;
  return { publication, items, nextCursor };
}

async function readPage(
  client: pg.PoolClient,
  actor: SourceReadActor,
  scope: SourceScope,
  input: SourceScanInput,
  state: ScanCursorState | null,
  key: string,
): Promise<SourceScanPage | null> {
  await lockControl(client, scope);
  await readIdentity(client, actor);
  if (!(await currentAccess(client, scope, "reader"))) return null;
  const publication = await readPublication(client, scope, state?.revision ?? null);
  if (!publication) return null;
  pin(state, publication, input);
  const rows = await readVersions(client, scope, publication, input, state?.after ?? null);
  if (!(await currentAccess(client, scope, "reader"))) throw new SourceAccessDenied();
  return page(publication, input, scope, rows, key);
}

export async function scanVersions(
  pool: SourcePool,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  input: SourceScanInput,
): Promise<SourceScanPage | null> {
  validateScanKey(key);
  const state = input.cursor === undefined ? null : readScanCursor(key, input.cursor, scope);
  try {
    return await transaction(
      pool,
      "reader",
      (client) => readPage(client, actor, scope, input, state, key),
      (result) => result === null,
    );
  } catch (error) {
    if (error instanceof SourceAccessDenied) return null;
    throw error;
  }
}
