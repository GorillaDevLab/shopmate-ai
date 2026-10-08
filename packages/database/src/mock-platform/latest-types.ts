import type { Publication, SnapshotKind } from "./publication-types.js";
import type { SourceVersion } from "./scan-types.js";

export interface LatestStateInput {
  /** Inclusive UTC cutoff, no later than the pinned publication target. */
  readonly until: string;
  /** Candidate keys scanned per page, capped at 32 even when a larger limit is requested. */
  readonly limit: number;
  readonly cursor?: string;
  readonly kind?: SnapshotKind;
  readonly entityKey?: string;
}

export interface LatestStatePage {
  readonly publication: Publication;
  readonly items: readonly SourceVersion[];
  /** Follow even when items is empty; the cursor advances scanned keys in the pinned publication. */
  readonly nextCursor: string | null;
}
