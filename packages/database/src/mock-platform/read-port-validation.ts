import { SourceStorageError } from "./errors.js";
import { validateLatestInput } from "./latest-validation.js";
import type { LatestStateInput } from "./latest-types.js";
import { validateDataBounds } from "./record-bounds.js";
import { validateUtc } from "./record-primitives.js";
import type { SourceReadRequest } from "./read-port-types.js";
import { exact, object } from "./validation.js";

export function latestReadInput(request: SourceReadRequest, until: string): LatestStateInput {
  return {
    kind: request.kind,
    until,
    limit: request.limit,
    contextHash: request.contextHash,
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    ...(request.entityKey !== undefined ? { entityKey: request.entityKey } : {}),
  };
}

export function checkedReadRequest(value: unknown): SourceReadRequest {
  validateDataBounds(value, 8192, 64, 4, "query-json");
  if (!object(value)) throw new SourceStorageError("SOURCE_INPUT");
  const keys = ["kind", "requestedUntil", "businessNow", "limit", "contextHash"];
  for (const optional of ["cursor", "entityKey"])
    if (Object.hasOwn(value, optional)) keys.push(optional);
  if (
    !exact(value, keys) ||
    !validateUtc(value.requestedUntil) ||
    !validateUtc(value.businessNow) ||
    ("entityKey" in value && !Array.isArray(value.entityKey))
  )
    throw new SourceStorageError("SOURCE_INPUT");
  const request = Object.freeze({
    ...value,
    ...(value.entityKey
      ? { entityKey: Object.freeze([...(value.entityKey as readonly string[])]) }
      : {}),
  }) as unknown as SourceReadRequest;
  validateLatestInput(latestReadInput(request, request.requestedUntil));
  return request;
}
