import { readWindowPlannerInput, sameScope } from "./planner-input.js";
import { MAX_WINDOW_MS, SYNC_STREAMS } from "./planner-types.js";
import type {
  LatestWindowJob,
  PlannedWindow,
  SyncWindowPlan,
  WaitingReason,
  WindowPlannerInput,
} from "./planner-types.js";

function conflict(condition: boolean): void {
  if (condition) throw new Error("SYNC_PLAN_CONFLICT");
}
function validateIdentity(input: WindowPlannerInput): void {
  const { binding, bootstrap, publication, latestJobs } = input;
  conflict(!sameScope(binding.scope, bootstrap.scope));
  if (publication) conflict(!sameScope(binding.scope, publication.scope));
  for (const job of latestJobs) {
    conflict(
      !sameScope(binding.scope, job.scope) ||
        job.grantId !== binding.grantId ||
        job.provider !== binding.provider ||
        job.since < binding.initialSince,
    );
  }
}
function waiting(reason: WaitingReason): SyncWindowPlan {
  return { status: "WAITING", reason, windows: [] };
}
function starts(input: WindowPlannerInput): PlannedWindow[] {
  return SYNC_STREAMS.map((stream) => {
    const job = input.latestJobs.find((item) => item.stream === stream);
    // A terminal receipt proves the completed interval even if source freshness is unknown.
    const since =
      job?.status === "SUCCEEDED" ? job.until : (job?.since ?? input.binding.initialSince);
    return { stream, since, until: since };
  });
}
function frozenTarget(jobs: readonly LatestWindowJob[]): string | null {
  const targets = new Set(jobs.filter((job) => job.status !== "SUCCEEDED").map((job) => job.until));
  conflict(targets.size > 1);
  return targets.values().next().value ?? null;
}
function validateFrozen(
  windows: readonly PlannedWindow[],
  jobs: readonly LatestWindowJob[],
  target: string,
): void {
  conflict(jobs.some((job) => job.status === "SUCCEEDED" && job.until > target));
  for (const window of windows) {
    conflict(
      window.since > target || Date.parse(target) - Date.parse(window.since) > MAX_WINDOW_MS,
    );
  }
}
function planned(
  windows: readonly PlannedWindow[],
  jobs: readonly LatestWindowJob[],
  targetTime: string,
  frozen: boolean,
): SyncWindowPlan {
  const existingStreams = SYNC_STREAMS.filter((stream) =>
    jobs.some((job) => job.stream === stream && job.status !== "SUCCEEDED"),
  );
  return {
    status: "PLANNED",
    targetTime,
    frozen,
    existingStreams,
    windows: windows
      .filter((window) => window.since < targetTime && !existingStreams.includes(window.stream))
      .map((window) => ({ ...window, until: targetTime })),
  };
}
/** Pure advisory plan. SQL authority, history proof, leases and atomic receipts remain server owned. */
export function planSyncWindows(value: unknown): SyncWindowPlan {
  const input = readWindowPlannerInput(value);
  validateIdentity(input);
  const windows = starts(input);
  const frozen = frozenTarget(input.latestJobs);
  if (frozen) validateFrozen(windows, input.latestJobs, frozen);
  if (input.bootstrap.state === "WAITING_RUNTIME") return waiting("WAITING_RUNTIME");
  if (!input.publication) return waiting("WAITING_PUBLICATION");
  const available = Math.min(
    Date.parse(input.bootstrap.businessNow),
    Date.parse(input.publication.targetTime),
    Date.parse(input.publication.processedThrough),
  );
  if (frozen) {
    if (available < Date.parse(frozen)) return waiting("WAITING_COVERAGE");
    return planned(windows, input.latestJobs, frozen, true);
  }
  const target = Math.min(
    available,
    ...windows.map((window) => Date.parse(window.since) + MAX_WINDOW_MS),
  );
  if (windows.some((window) => Date.parse(window.since) > target))
    return waiting("WAITING_COVERAGE");
  if (windows.every((window) => Date.parse(window.since) === target)) return waiting("CAUGHT_UP");
  return planned(windows, input.latestJobs, new Date(target).toISOString(), false);
}
