import { SourceStorageError } from "./errors.js";
import { validPublicationPin } from "./latest-publication.js";
import type { LatestStateInput } from "./latest-types.js";
import { snapshotKinds, validateEntityKey } from "./record-codec.js";
import type { SnapshotKind } from "./publication-types.js";
import { representable, validateUtc } from "./record-primitives.js";
import { exact, integer, object } from "./validation.js";

function assertKey(kind: unknown, value: unknown): void {
  if (!snapshotKinds.includes(kind as SnapshotKind)) throw new SourceStorageError("SOURCE_INPUT");
  if (typeof value === "string") {
    if (!value.length || value.length > 1024 || !representable(value))
      throw new SourceStorageError("SOURCE_INPUT");
    return;
  }
  validateEntityKey(kind as SnapshotKind, value);
  if (!(value as readonly string[]).every(representable))
    throw new SourceStorageError("SOURCE_INPUT");
}

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
    ("kind" in value && !snapshotKinds.includes(value.kind as SnapshotKind)) ||
    ("contextHash" in value &&
      (typeof value.contextHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contextHash))) ||
    ("cursor" in value &&
      (typeof value.cursor !== "string" || !value.cursor.length || value.cursor.length > 4096))
  )
    throw new SourceStorageError("SOURCE_INPUT");
  if ("entityKey" in value) assertKey(value.kind, value.entityKey);
}
