import { SourceStorageError } from "./errors.js";
import { validPublicationPin } from "./latest-publication.js";
import type { LatestStateInput } from "./latest-types.js";
import { snapshotKinds } from "./record-codec.js";
import { validateDataBounds } from "./record-bounds.js";
import type { SnapshotKind } from "./publication-types.js";
import {
  list,
  representable,
  requireInput,
  validateDate,
  validateUtc,
} from "./record-primitives.js";
import { exact, integer, object } from "./validation.js";

function queryId(value: unknown): boolean {
  /* eslint-disable no-control-regex -- Contract identifiers exclude hidden controls. */
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
  /* eslint-enable no-control-regex */
}
function assertKey(kind: unknown, value: unknown): void {
  if (!snapshotKinds.includes(kind as SnapshotKind)) throw new SourceStorageError("SOURCE_INPUT");
  if (typeof value === "string") {
    if (!value.length || value.length > 1024 || !representable(value))
      throw new SourceStorageError("SOURCE_INPUT");
    return;
  }
  const triple = kind === "INVENTORY" || kind === "MARKETING";
  requireInput(list(value, triple ? 3 : 2, triple ? 3 : 2) && value[0] === kind);
  requireInput(queryId(value[1]));
  if (kind === "INVENTORY") requireInput(queryId(value[2]));
  if (kind === "MARKETING") requireInput(validateDate(value[2]));
}

export function validateLatestInput(value: unknown): asserts value is LatestStateInput {
  validateDataBounds(value, 8192, 64, 4, "query-json");
  if (!object(value)) throw new SourceStorageError("SOURCE_INPUT");
  const keys = ["until", "limit"];
  for (const optional of ["cursor", "kind", "entityKey", "contextHash", "publication"])
    if (Object.hasOwn(value, optional)) keys.push(optional);
  if (
    !exact(value, keys) ||
    !validateUtc(value.until) ||
    !integer(value.limit, 1, 200) ||
    ("publication" in value && !validPublicationPin(value.publication)) ||
    ("kind" in value && !snapshotKinds.includes(value.kind as SnapshotKind)) ||
    ("contextHash" in value &&
      (typeof value.contextHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contextHash))) ||
    ("cursor" in value &&
      (typeof value.cursor !== "string" || !value.cursor.length || value.cursor.length > 4096))
  )
    throw new SourceStorageError("SOURCE_INPUT");
  if ("entityKey" in value) assertKey(value.kind, value.entityKey);
}
