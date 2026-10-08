import { createHash } from "node:crypto";
import { SourceStorageError } from "./errors.js";
import { decodeCompactLatest, encodeCompactLatest } from "./latest-cursor-codec.js";
import type { LatestStateInput } from "./latest-types.js";
import type { Publication } from "./publication-types.js";
import type { SourceScope } from "./types.js";
import { scopeKeys, validateScope } from "./validation.js";

export interface LatestPosition {
  readonly kind: string;
  readonly entityKey: string;
  readonly eventSeq: string;
}
export interface LatestCursorState {
  readonly certificateHash: string;
  readonly revision: string;
  readonly highEventSeq: string;
  readonly until: string;
  readonly afterEventSeq: string;
  readonly expiresAt: number;
}

function digest(values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values), "utf8").digest("base64url");
}
function scopeDigest(scope: SourceScope): string {
  validateScope(scope);
  return digest(scopeKeys.map((field) => scope[field]));
}
function queryDigest(input: LatestStateInput): string {
  return digest([
    input.until,
    input.limit,
    input.kind ?? null,
    input.entityKey ?? null,
    input.contextHash ?? null,
  ]);
}

export function readLatestCursor(
  key: string,
  cursor: string,
  scope: SourceScope,
  input: LatestStateInput,
  now = Date.now(),
): LatestCursorState {
  const state = decodeCompactLatest(key, cursor, now);
  if (state.s !== scopeDigest(scope) || state.q !== queryDigest(input) || state.t !== input.until)
    throw new SourceStorageError("SOURCE_INPUT");
  return {
    certificateHash: state.c,
    revision: state.r,
    highEventSeq: state.h,
    until: state.t,
    afterEventSeq: state.a,
    expiresAt: state.e,
  };
}

export function createLatestCursor(
  key: string,
  scope: SourceScope,
  publication: Publication,
  input: LatestStateInput,
  after: LatestPosition,
  expiresAt: number,
  now = Date.now(),
): string {
  return encodeCompactLatest(
    key,
    {
      v: 1,
      s: scopeDigest(scope),
      q: queryDigest(input),
      c: publication.certificateHash,
      r: publication.revision,
      h: publication.highEventSeq,
      t: input.until,
      a: after.eventSeq,
      e: expiresAt,
    },
    now,
  );
}
