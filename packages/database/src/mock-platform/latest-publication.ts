import { SourceStorageError } from "./errors.js";
import type { LatestCursorState } from "./latest-cursor.js";
import type { LatestStateInput, PublicationPin } from "./latest-types.js";
import type { Publication } from "./publication-types.js";
import { positiveUInt, validateUInt } from "./record-primitives.js";
import { exact } from "./validation.js";

export function validPublicationPin(value: unknown): value is PublicationPin {
  return (
    exact(value, ["revision", "highEventSeq", "certificateHash"]) &&
    positiveUInt(value.revision) &&
    validateUInt(value.highEventSeq) &&
    typeof value.certificateHash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.certificateHash)
  );
}

export function assertLatestPublication(
  state: LatestCursorState | null,
  publication: Publication,
  input: LatestStateInput,
): void {
  if (input.until > publication.targetTime) throw new SourceStorageError("SOURCE_INPUT");
  for (const pin of [state, input.publication]) {
    if (
      pin &&
      (pin.certificateHash !== publication.certificateHash ||
        pin.revision !== publication.revision ||
        pin.highEventSeq !== publication.highEventSeq)
    )
      throw new SourceStorageError("SOURCE_INTEGRITY");
  }
}
