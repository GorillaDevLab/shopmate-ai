import { createHmac } from "node:crypto";
import { SourceStorageError } from "./errors.js";
import { createScanCursor, readScanCursor, type ScanCursorState } from "./scan-cursor.js";
import type { LatestStateInput } from "./latest-types.js";
import type { Publication } from "./publication-types.js";
import type { SourceScope } from "./types.js";

export interface LatestPosition {
  readonly kind: string;
  readonly entityKey: string;
}

function domainKey(key: string): string {
  return createHmac("sha256", key).update("mock-source-latest-v1").digest("base64url");
}

export function readLatestCursor(
  key: string,
  cursor: string,
  scope: SourceScope,
  input: LatestStateInput,
): ScanCursorState {
  const state = readScanCursor(domainKey(key), cursor, scope);
  if (
    state.since !== input.until ||
    state.until !== input.until ||
    state.kind !== (input.kind ?? null) ||
    state.entityKey !== (input.entityKey ?? null) ||
    state.after?.eventSeq !== String(input.limit)
  )
    throw new SourceStorageError("SOURCE_INPUT");
  return state;
}

export function createLatestCursor(
  key: string,
  scope: SourceScope,
  publication: Publication,
  input: LatestStateInput,
  after: LatestPosition,
  expiresAt: number,
): string {
  return createScanCursor(domainKey(key), {
    scope,
    certificateHash: publication.certificateHash,
    revision: publication.revision,
    highEventSeq: publication.highEventSeq,
    since: input.until,
    until: input.until,
    kind: input.kind ?? null,
    entityKey: input.entityKey ?? null,
    after: { ...after, eventSeq: String(input.limit) },
    expiresAt,
  });
}
