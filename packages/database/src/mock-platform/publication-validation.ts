import { SourceStorageError } from "./errors.js";
import type {
  BuildLease,
  Checkpoint,
  ChunkInput,
  LastEvent,
  LeaseRef,
  Publication,
  PublishInput,
  SnapshotEvent,
  SnapshotKind,
} from "./publication-types.js";
import type { SourceScope } from "./types.js";
import { integer, validateScope } from "./validation.js";
import { validateDataBounds } from "./record-bounds.js";
import {
  fields,
  list,
  oneOf,
  positiveUInt,
  requireInput,
  validateUInt,
  validateUtc,
} from "./record-primitives.js";
import {
  compareEventTuples,
  eventTuple,
  snapshotKinds,
  validateEntityKey,
} from "./record-codec.js";
import { validateRecord } from "./record-validation.js";

export { incrementUInt, validateUInt, validateUtc } from "./record-primitives.js";
const leaseKeys = ["scope", "revision", "fence", "ownerId"];
const buildKeys = [
  ...leaseKeys,
  "targetClockRevision",
  "targetTime",
  "baseRevision",
  "baseHighEventSeq",
  "checkpoint",
  "checkpointHash",
  "leaseUntil",
];
function hash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function uuid(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}
function integrity(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof SourceStorageError) throw new SourceStorageError("SOURCE_INTEGRITY");
    throw error;
  }
}
export function validateSnapshotEvent(
  value: unknown,
  scope: SourceScope,
): asserts value is SnapshotEvent {
  validateDataBounds(value, 256 * 1024 + 1024, 20010, 13);
  validateDataBounds(scope, 4096);
  validateScope(scope);
  const event = fields(value, ["kind", "occurredAt", "ordinal", "after"]);
  requireInput(
    oneOf(event.kind, snapshotKinds) &&
      validateUtc(event.occurredAt) &&
      validateUInt(event.ordinal),
  );
  validateDataBounds(event.after, 256 * 1024);
  validateRecord(event.kind as SnapshotKind, event.after, scope, event.occurredAt);
}
export function validateChunk(value: unknown, scope: SourceScope): asserts value is ChunkInput {
  validateDataBounds(value, 2 * 1024 * 1024, 2001000, 15);
  const input = fields(value, ["expectedCheckpointHash", "next", "events"]);
  const next = fields(input.next, ["processedThrough", "sealed"]);
  requireInput(
    hash(input.expectedCheckpointHash) &&
      validateUtc(next.processedThrough) &&
      typeof next.sealed === "boolean" &&
      list(input.events, 0, 100),
  );
  let previous: LastEvent | null = null;
  for (const event of input.events) {
    validateSnapshotEvent(event, scope);
    const tuple = eventTuple(event);
    requireInput(
      event.occurredAt <= next.processedThrough &&
        (!previous || compareEventTuples(previous, tuple) < 0),
    );
    previous = tuple;
  }
  // Empty seal/progress chunks still validate the frozen scope before any connection.
  validateDataBounds(scope, 4096);
  validateScope(scope);
}
function leaseFields(value: Record<string, unknown>): void {
  validateScope(value.scope);
  requireInput(positiveUInt(value.revision) && positiveUInt(value.fence) && uuid(value.ownerId));
}
export function validateLeaseRef(value: unknown): asserts value is LeaseRef {
  validateDataBounds(value, 4096);
  leaseFields(fields(value, leaseKeys));
}
function lastEvent(value: unknown): asserts value is LastEvent {
  const event = fields(value, ["occurredAt", "kind", "entityKey", "ordinal"]);
  requireInput(
    validateUtc(event.occurredAt) &&
      oneOf(event.kind, snapshotKinds) &&
      validateUInt(event.ordinal),
  );
  validateEntityKey(event.kind as SnapshotKind, event.entityKey);
}
export function validateCheckpoint(value: unknown): asserts value is Checkpoint {
  integrity(() => {
    validateDataBounds(value, 4096);
    const checkpoint = fields(value, [
      "codec",
      "chunkIndex",
      "highEventSeq",
      "processedThrough",
      "lastEvent",
      "sealed",
    ]);
    requireInput(
      checkpoint.codec === "source-checkpoint-v1" &&
        validateUInt(checkpoint.chunkIndex) &&
        validateUInt(checkpoint.highEventSeq) &&
        validateUtc(checkpoint.processedThrough) &&
        typeof checkpoint.sealed === "boolean",
    );
    if (checkpoint.lastEvent !== null) {
      lastEvent(checkpoint.lastEvent);
      requireInput(
        checkpoint.lastEvent.occurredAt <= checkpoint.processedThrough &&
          checkpoint.highEventSeq !== "0",
      );
    }
  });
}
export function validateBuildLease(value: unknown): asserts value is BuildLease {
  integrity(() => {
    validateDataBounds(value, 8192);
    const lease = fields(value, buildKeys);
    leaseFields(lease);
    validateCheckpoint(lease.checkpoint);
    requireInput(
      integer(lease.targetClockRevision, 0, 2147483647) &&
        validateUtc(lease.targetTime) &&
        validateUtc(lease.leaseUntil) &&
        validateUInt(lease.baseRevision) &&
        validateUInt(lease.baseHighEventSeq) &&
        hash(lease.checkpointHash),
    );
    requireInput(
      BigInt(lease.revision as string) > BigInt(lease.baseRevision) &&
        lease.checkpoint.processedThrough <= lease.targetTime &&
        BigInt(lease.checkpoint.highEventSeq) >= BigInt(lease.baseHighEventSeq),
    );
  });
}
export function validatePublishInput(value: unknown): asserts value is PublishInput {
  validateDataBounds(value, 4096);
  const input = fields(value, ["expectedBaseRevision", "checkpointHash"]);
  requireInput(validateUInt(input.expectedBaseRevision) && hash(input.checkpointHash));
}
function publicationFields(value: unknown): Publication {
  const result = fields(value, [
    "scope",
    "revision",
    "targetClockRevision",
    "targetTime",
    "baseRevision",
    "baseHighEventSeq",
    "highEventSeq",
    "eventCount",
    "versionCount",
    "processedThrough",
    "generatorVersion",
    "runtimeVersion",
    "codec",
    "publishedAt",
    "certificateHash",
  ]);
  validateScope(result.scope);
  requireInput(positiveUInt(result.revision) && integer(result.targetClockRevision, 0, 2147483647));
  requireInput(
    [
      result.baseRevision,
      result.baseHighEventSeq,
      result.highEventSeq,
      result.eventCount,
      result.versionCount,
    ].every(validateUInt),
  );
  requireInput([result.targetTime, result.processedThrough, result.publishedAt].every(validateUtc));
  requireInput(
    result.generatorVersion === "mock-source-v1" &&
      result.runtimeVersion === "mock-runtime-v2" &&
      result.codec === "source-snapshot-v1" &&
      hash(result.certificateHash),
  );
  return result as unknown as Publication;
}
export function validatePublication(value: unknown): asserts value is Publication {
  integrity(() => {
    validateDataBounds(value, 8192);
    const publication = publicationFields(value);
    requireInput(
      publication.processedThrough === publication.targetTime &&
        publication.eventCount === publication.versionCount,
    );
    requireInput(
      BigInt(publication.highEventSeq) ===
        BigInt(publication.baseHighEventSeq) + BigInt(publication.eventCount) &&
        BigInt(publication.revision) > BigInt(publication.baseRevision),
    );
  });
}
