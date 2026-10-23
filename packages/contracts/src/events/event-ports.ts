import type { RobustBaselineV1 } from "./event-evidence.schema.js";
import type {
  BaselineRequest,
  EventAppendEvidenceRequest,
  EventCurrentQuery,
  EventDetectionOutcome,
  EventDetectionRequest,
  EventDetailQuery,
  EventEvidenceQuery,
  EventEvidenceRecord,
  EventHistoryQuery,
  EventListQuery,
  EventRecord,
  EventStateTransition,
} from "./event.schema.js";

export type EventErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "VERSION_MISMATCH"
  | "WINDOW_MISMATCH"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SOURCE_UNAVAILABLE"
  | "OVERFLOW";
export interface EventFailure {
  readonly code: EventErrorCode;
  readonly evidenceIds: readonly string[];
}
export type EventResult<T> = Readonly<{ ok: true; value: T } | { ok: false; error: EventFailure }>;
export interface EventPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
/** Pure selection over supplied observed snapshots; never reads future data or fetches a provider. */
export interface BaselinePort {
  readonly evaluate: (request: BaselineRequest) => EventResult<RobustBaselineV1>;
}
/** A deterministic candidate/quality boundary; no persistence or action authority. */
export interface EventDetector {
  readonly detect: (request: EventDetectionRequest) => EventResult<EventDetectionOutcome>;
}
/** Validate authenticated tenant AND store ownership. Compare expectedRevision atomically. */
export interface EventRepository {
  readonly appendEvidence: (
    request: EventAppendEvidenceRequest,
  ) => Promise<EventResult<EventRecord>>;
  readonly current: (request: EventCurrentQuery) => Promise<EventResult<EventRecord | null>>;
  /** This mutation must share its transaction with the later AuditUoW append. */
  readonly stateTransition: (request: EventStateTransition) => Promise<EventResult<EventRecord>>;
}
/** All reads require server-authenticated scope and enforce store ownership, irrespective of severity. */
export interface EventQueryPort {
  readonly list: (request: EventListQuery) => Promise<EventResult<EventPage<EventRecord>>>;
  readonly detail: (request: EventDetailQuery) => Promise<EventResult<EventRecord>>;
  readonly evidence: (request: EventEvidenceQuery) => Promise<EventResult<EventEvidenceRecord>>;
  readonly history: (
    request: EventHistoryQuery,
  ) => Promise<EventResult<EventPage<EventEvidenceRecord>>>;
}
