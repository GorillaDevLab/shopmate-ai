import type { Publication, SnapshotKind } from "./publication-types.js";

export interface SourceScanInput {
  readonly since: string;
  readonly until: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly kind?: SnapshotKind;
  readonly entityKey?: string;
}

export interface SourceVersion {
  readonly kind: SnapshotKind;
  readonly entityKey: string;
  readonly eventSeq: string;
  readonly releaseRevision: string;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly versionHash: string;
}

export interface SourceScanPage {
  readonly publication: Publication;
  readonly items: readonly SourceVersion[];
  readonly nextCursor: string | null;
}
