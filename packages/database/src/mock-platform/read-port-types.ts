import type { EntityKey, SnapshotKind } from "./publication-types.js";
import type { LatestStatePage } from "./latest-types.js";
import type { SourceReadActor, SourceReadControl, SourceScope } from "./types.js";

export interface SourceReadRequest {
  readonly kind: SnapshotKind;
  readonly requestedUntil: string;
  readonly businessNow: string;
  readonly limit: number;
  readonly contextHash: string;
  readonly cursor?: string;
  readonly entityKey?: EntityKey;
}
export interface SourceReadPage extends LatestStatePage {
  readonly effectiveUntil: string;
}
export interface BoundSourceReadPort {
  read(request: unknown, control?: SourceReadControl): Promise<SourceReadPage | null>;
  refreshCheckpoint(request: unknown, control?: SourceReadControl): Promise<string | null>;
}
export interface SourceReadPorts {
  bind(actor: SourceReadActor, scope: SourceScope): BoundSourceReadPort;
  close(): Promise<void>;
}
