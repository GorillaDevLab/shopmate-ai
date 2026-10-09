import type { Checkpoint, ChunkInput, LastEvent, SnapshotEvent } from "./publication-types.js";
import type { SourceScope } from "./types.js";
import {
  validateChunk,
  validateCheckpoint,
  validateSnapshotEvent,
} from "./publication-validation.js";
import { compareEventTuples, eventTuple } from "./record-codec.js";
import { validateDataBounds } from "./record-bounds.js";
import { fields, requireInput, validateUtc, validateUInt } from "./record-primitives.js";
import { validateScope } from "./validation.js";

export interface SourceChunkPlan {
  readonly scope: SourceScope;
  readonly checkpoint: Checkpoint;
  readonly baseRevision: string;
  readonly baseHighEventSeq: string;
  readonly expectedCheckpointHash: string;
  readonly windowEnd: string;
  readonly targetTime: string;
}
interface PackingState {
  readonly events: SnapshotEvent[];
  readonly baseBytes: number;
  eventBytes: number;
  examined: number;
  examinedBytes: number;
  previous: LastEvent | null;
}
function validatePlan(plan: SourceChunkPlan): void {
  validateDataBounds(plan, 8192);
  fields(plan, [
    "scope",
    "checkpoint",
    "baseRevision",
    "baseHighEventSeq",
    "expectedCheckpointHash",
    "windowEnd",
    "targetTime",
  ]);
  validateScope(plan.scope);
  validateCheckpoint(plan.checkpoint);
  requireInput(
    validateUInt(plan.baseRevision) &&
      validateUInt(plan.baseHighEventSeq) &&
      BigInt(plan.baseHighEventSeq) <= BigInt(plan.checkpoint.highEventSeq) &&
      (plan.baseRevision !== "0" || plan.baseHighEventSeq === "0"),
  );
  requireInput(
    typeof plan.expectedCheckpointHash === "string" &&
      /^[a-f0-9]{64}$/u.test(plan.expectedCheckpointHash),
  );
  requireInput(
    validateUtc(plan.windowEnd) &&
      validateUtc(plan.targetTime) &&
      !plan.checkpoint.sealed &&
      plan.windowEnd >= plan.checkpoint.processedThrough &&
      plan.windowEnd <= plan.targetTime,
  );
}
function inspectEvent(
  plan: SourceChunkPlan,
  state: PackingState,
  event: SnapshotEvent,
): {
  readonly tuple: LastEvent;
  readonly encoded: string;
} {
  // Recovery replays only a bounded timestamp group, never the accepted history.
  requireInput(++state.examined <= 16384);
  validateSnapshotEvent(event, plan.scope);
  const encoded = JSON.stringify(event);
  state.examinedBytes += Buffer.byteLength(encoded, "utf8");
  requireInput(state.examinedBytes <= 64 * 1024 * 1024);
  const tuple = eventTuple(event);
  requireInput(
    event.occurredAt <= plan.windowEnd &&
      (!state.previous || compareEventTuples(state.previous, tuple) < 0),
  );
  state.previous = tuple;
  return { tuple, encoded };
}
function unaccepted(plan: SourceChunkPlan, tuple: LastEvent): boolean {
  const checkpoint = plan.checkpoint;
  if (tuple.occurredAt > checkpoint.processedThrough) return true;
  if (
    tuple.occurredAt === checkpoint.processedThrough &&
    plan.baseRevision === "0" &&
    checkpoint.chunkIndex === "0" &&
    checkpoint.highEventSeq === "0" &&
    checkpoint.lastEvent === null
  )
    return true;
  return (
    tuple.occurredAt === checkpoint.processedThrough &&
    BigInt(checkpoint.highEventSeq) > BigInt(plan.baseHighEventSeq) &&
    checkpoint.lastEvent?.occurredAt === checkpoint.processedThrough &&
    compareEventTuples(checkpoint.lastEvent, tuple) < 0
  );
}
function addEvent(state: PackingState, encoded: string): boolean {
  const bytes = Buffer.byteLength(encoded, "utf8") + (state.events.length ? 1 : 0);
  if (state.events.length === 100 || state.baseBytes + state.eventBytes + bytes > 2 * 1024 * 1024)
    return false;
  // Validation already forbids accessors, serializers and non-JSON values. Own the
  // snapshot so later generator mutation cannot change a prepared append receipt.
  state.events.push(JSON.parse(encoded) as SnapshotEvent);
  state.eventBytes += bytes;
  return true;
}
function packingState(plan: SourceChunkPlan): PackingState {
  const base = {
    expectedCheckpointHash: plan.expectedCheckpointHash,
    next: { processedThrough: plan.windowEnd, sealed: false },
    events: [],
  };
  return {
    events: [],
    baseBytes: Buffer.byteLength(JSON.stringify(base)),
    eventBytes: 0,
    examined: 0,
    examinedBytes: 0,
    previous: null,
  };
}
/** Pure preparation only: no sequence allocation, hashing proof, SQL or authorization.
 * The caller must regenerate deferred events from the returned durable checkpoint.
 */
export function packSourceChunk(
  plan: SourceChunkPlan,
  events: Iterable<SnapshotEvent>,
): ChunkInput {
  validatePlan(plan);
  const state = packingState(plan);
  let exhausted = true;
  for (const event of events) {
    const { tuple, encoded } = inspectEvent(plan, state, event);
    if (!unaccepted(plan, tuple)) continue;
    if (!addEvent(state, encoded)) {
      requireInput(state.events.length > 0);
      exhausted = false;
      break;
    }
  }
  return packedChunk(plan, state, exhausted);
}
function packedChunk(plan: SourceChunkPlan, state: PackingState, exhausted: boolean): ChunkInput {
  const chunk: ChunkInput = {
    expectedCheckpointHash: plan.expectedCheckpointHash,
    next: {
      processedThrough: exhausted ? plan.windowEnd : state.events.at(-1)!.occurredAt,
      sealed: exhausted && plan.windowEnd === plan.targetTime,
    },
    events: state.events,
  };
  requireInput(
    chunk.events.length > 0 ||
      chunk.next.sealed ||
      chunk.next.processedThrough > plan.checkpoint.processedThrough,
  );
  validateChunk(chunk, plan.scope);
  return chunk;
}
