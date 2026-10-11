import type { SourceScope } from "@shopmate/database/mock-platform";
import type { SyncRuntimeBootstrap, SyncStream } from "@shopmate/database/sync-host";

export const SYNC_STREAMS = [
  "PRODUCTS",
  "ORDERS",
  "REFUNDS",
  "INVENTORY",
  "MARKETING",
] as const satisfies readonly SyncStream[];
export const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
export interface WindowBinding {
  readonly grantId: string;
  readonly provider: "MOCK";
  readonly scope: Readonly<SourceScope>;
  readonly initialSince: string;
}
/** Project only after the bootstrap SDK has checked READY/runtime opening consistency. */
export type WindowBootstrap = Pick<SyncRuntimeBootstrap, "scope" | "businessNow" | "state">;
/** The restricted source reader must verify the immutable certificate before projection. */
export interface VerifiedWindowPublication {
  readonly scope: Readonly<SourceScope>;
  readonly targetTime: string;
  readonly processedThrough: string;
}
/** One latest job per stream, projected after parsing raw list_work SQL JSON. */
export interface LatestWindowJob {
  readonly grantId: string;
  readonly provider: "MOCK";
  readonly scope: Readonly<SourceScope>;
  readonly stream: SyncStream;
  readonly since: string;
  readonly until: string;
  readonly status: "READY" | "RUNNING" | "FAILED" | "SUCCEEDED";
}
export interface WindowPlannerInput {
  readonly binding: WindowBinding;
  readonly bootstrap: WindowBootstrap;
  readonly publication: VerifiedWindowPublication | null;
  readonly latestJobs: readonly LatestWindowJob[];
}
export interface PlannedWindow {
  readonly stream: SyncStream;
  readonly since: string;
  readonly until: string;
}
export type WaitingReason =
  | "WAITING_RUNTIME"
  | "WAITING_PUBLICATION"
  | "WAITING_COVERAGE"
  | "CAUGHT_UP";
export type SyncWindowPlan =
  | { readonly status: "WAITING"; readonly reason: WaitingReason; readonly windows: readonly [] }
  | {
      readonly status: "PLANNED";
      readonly targetTime: string;
      readonly frozen: boolean;
      readonly windows: readonly PlannedWindow[];
      readonly existingStreams: readonly SyncStream[];
    };
