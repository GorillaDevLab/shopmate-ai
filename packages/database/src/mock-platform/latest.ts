import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceAccessDenied, SourceStorageError } from "./errors.js";
import { journalScopeWhere } from "./journal-state.js";
import {
  createLatestCursor,
  readLatestCursor,
  type LatestCursorState,
  type LatestPosition,
} from "./latest-cursor.js";
import { restoreLatestPosition } from "./latest-witness.js";
import { assertLatestPublication, validPublicationPin } from "./latest-publication.js";
import type { LatestStateInput, LatestStatePage } from "./latest-types.js";
import { readPublication } from "./publication-certificate.js";
import { representable, validateUtc } from "./record-primitives.js";
import { checkedVersion } from "./scan.js";
import { validateScanKey } from "./scan-cursor.js";
import type { SourceVersion } from "./scan-types.js";
import {
  currentAccess,
  lockControl,
  readIdentity,
  scopeValues,
  transaction,
} from "./transaction.js";
import type { SourceReadActor, SourceScope } from "./types.js";
import { exact, integer, object } from "./validation.js";

const keySql = `SELECT kind,"entityKey","eventSeq"::text AS "eventSeq" FROM mock_platform."EntityVersion" v
  WHERE ${journalScopeWhere}
    AND ($8::text IS NULL OR kind COLLATE "C"=$8::text COLLATE "C")
    AND ($9::text IS NULL OR "entityKey" COLLATE "C"=$9::text COLLATE "C")
    AND ($10::text IS NULL OR (kind COLLATE "C","entityKey" COLLATE "C") >
      ($10::text COLLATE "C",$11::text COLLATE "C"))
    AND "eventSeq"<=$12::bigint AND "releaseRevision"<=$13::bigint
    AND "occurredAt"<=$14::timestamp
  ORDER BY kind COLLATE "C","entityKey" COLLATE "C",v."occurredAt" DESC,v."eventSeq" DESC LIMIT 1`;
const latestSql = `SELECT kind,"entityKey","eventSeq"::text AS "eventSeq",
  "releaseRevision"::text AS "releaseRevision",
  to_char("occurredAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
  payload,"versionHash" FROM mock_platform."EntityVersion" v
  WHERE ${journalScopeWhere} AND kind COLLATE "C"=$8::text COLLATE "C"
    AND "entityKey" COLLATE "C"=$9::text COLLATE "C"
    AND "occurredAt"<=$10::timestamp AND "eventSeq"<=$11::bigint
    AND "releaseRevision"<=$12::bigint
  ORDER BY v."occurredAt" DESC,v."eventSeq" DESC LIMIT 1`;
const kinds = ["STORE", "PRODUCT", "ORDER", "REFUND", "INVENTORY", "MARKETING"];
const CANDIDATE_BUDGET = 32;
// Pin discovery as well as values so later publications cannot expose keys in an old cursor.
// The index matches C ordering; qualify ORDER BY columns to avoid formatted DTO aliases.

export function validateLatestInput(value: unknown): asserts value is LatestStateInput {
  if (!object(value)) throw new SourceStorageError("SOURCE_INPUT");
  const keys = ["until", "limit"];
  for (const optional of ["cursor", "kind", "entityKey", "contextHash", "publication"])
    if (Object.hasOwn(value, optional)) keys.push(optional);
  if (
    !exact(value, keys) ||
    !validateUtc(value.until) ||
    !integer(value.limit, 1, 200) ||
    ("publication" in value && !validPublicationPin(value.publication)) ||
    ("kind" in value && !kinds.includes(value.kind as string)) ||
    ("contextHash" in value &&
      (typeof value.contextHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contextHash))) ||
    ("entityKey" in value &&
      (!("kind" in value) ||
        typeof value.entityKey !== "string" ||
        value.entityKey.length === 0 ||
        value.entityKey.length > 1024 ||
        !representable(value.entityKey))) ||
    ("cursor" in value &&
      (typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 4096))
  )
    throw new SourceStorageError("SOURCE_INPUT");
}

async function nextKey(
  client: pg.PoolClient,
  scope: SourceScope,
  input: LatestStateInput,
  after: LatestPosition | null,
  publication: LatestStatePage["publication"],
): Promise<LatestPosition | null> {
  const result = await client.query<LatestPosition>(keySql, [
    ...scopeValues(scope),
    input.kind ?? null,
    input.entityKey ?? null,
    after?.kind ?? null,
    after?.entityKey ?? null,
    publication.highEventSeq,
    publication.revision,
    publication.targetTime,
  ]);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return result.rows[0];
}

async function latestVersion(
  client: pg.PoolClient,
  scope: SourceScope,
  publication: LatestStatePage["publication"],
  input: LatestStateInput,
  key: LatestPosition,
): Promise<SourceVersion | null> {
  const result = await client.query<SourceVersion>(latestSql, [
    ...scopeValues(scope),
    key.kind,
    key.entityKey,
    input.until,
    publication.highEventSeq,
    publication.revision,
  ]);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) throw new SourceStorageError("SOURCE_INTEGRITY");
  return checkedVersion(result.rows[0], scope);
}

async function collectPage(
  client: pg.PoolClient,
  scope: SourceScope,
  publication: LatestStatePage["publication"],
  input: LatestStateInput,
  after: LatestPosition | null,
): Promise<{ items: SourceVersion[]; after: LatestPosition | null; more: boolean }> {
  const items: SourceVersion[] = [];
  let position = after;
  for (let scanned = 0; scanned < Math.min(input.limit, CANDIDATE_BUDGET); scanned += 1) {
    const candidate = await nextKey(client, scope, input, position, publication);
    if (!candidate) return { items, after: position, more: false };
    position = candidate;
    const version = await latestVersion(client, scope, publication, input, candidate);
    if (version) items.push(version);
  }
  return {
    items,
    after: position,
    more: (await nextKey(client, scope, input, position, publication)) !== null,
  };
}

async function readPage(
  client: pg.PoolClient,
  actor: SourceReadActor,
  scope: SourceScope,
  input: LatestStateInput,
  state: LatestCursorState | null,
  key: string,
): Promise<LatestStatePage | null> {
  await lockControl(client, scope);
  await readIdentity(client, actor);
  if (!(await currentAccess(client, scope, "reader"))) return null;
  const publication = await readPublication(
    client,
    scope,
    state?.revision ?? input.publication?.revision ?? null,
  );
  if (!publication && (state || input.publication))
    throw new SourceStorageError("SOURCE_INTEGRITY");
  if (!publication) return null;
  assertLatestPublication(state, publication, input);
  const after = state
    ? await restoreLatestPosition(client, scope, publication, state, input)
    : null;
  const collected = await collectPage(client, scope, publication, input, after);
  if (!(await currentAccess(client, scope, "reader"))) throw new SourceAccessDenied();
  const nextCursor =
    collected.more && collected.after
      ? createLatestCursor(
          key,
          scope,
          publication,
          input,
          collected.after,
          state?.expiresAt ?? Date.now() + 15 * 60_000,
        )
      : null;
  return { publication, items: collected.items, nextCursor };
}

export async function readLatestStates(
  pool: SourcePool,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  input: LatestStateInput,
): Promise<LatestStatePage | null> {
  validateScanKey(key);
  const state =
    input.cursor === undefined ? null : readLatestCursor(key, input.cursor, scope, input);
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
