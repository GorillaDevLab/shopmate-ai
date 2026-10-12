import { setTimeout } from "node:timers/promises";
import type { EventEmitter } from "node:events";
import { SyncWorkerPorts } from "@shopmate/database/sync-host";
import {
  createMockSourceReadPorts,
  type SourceReadPorts,
} from "@shopmate/database/mock-platform-read";
import { SyncCoordinator, type SyncPassResult } from "./coordinator.js";
type WorkerHost = ConstructorParameters<typeof SyncCoordinator>[0] & Pick<SyncWorkerPorts, "close">;
export interface SyncWorkerDependencies {
  readonly signals: Pick<EventEmitter, "on" | "off">;
  readonly source: (env: NodeJS.ProcessEnv) => SourceReadPorts;
  readonly connect: (grantId: string) => Promise<WorkerHost>;
  readonly coordinator: (
    host: WorkerHost,
    sources: SourceReadPorts,
  ) => Pick<SyncCoordinator, "pass">;
  poll: (signal: AbortSignal) => Promise<void>;
  readonly report: (result: SyncPassResult) => void;
}
function databaseUrl(value: string | undefined): URL {
  try {
    if (!value || value.length > 8192) throw new Error("INVALID_URL");
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname ||
      url.pathname === "/" ||
      url.hash
    )
      throw new Error("INVALID_URL");
    return url;
  } catch {
    throw new Error("SYNC_WORKER_CONFIGURATION");
  }
}
function startup(env: NodeJS.ProcessEnv, args: readonly string[]) {
  if (env.APP_ENV !== "demo" || env.ENABLE_DEMO_MODE !== "true")
    throw new Error("SYNC_WORKER_DEMO_REQUIRED");
  if (args.length > 1 || (args.length === 1 && args[0] !== "--once"))
    throw new Error("SYNC_WORKER_INVALID_ARGUMENTS");
  const grant = env.SYNC_WORKER_GRANT_ID;
  if (!grant || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(grant))
    throw new Error("SYNC_WORKER_CONFIGURATION");
  const worker = databaseUrl(env.SYNC_WORKER_DATABASE_URL);
  const reader = databaseUrl(env.MOCK_PLATFORM_READ_DATABASE_URL);
  const bytes = Buffer.byteLength(env.MOCK_SOURCE_CURSOR_KEY ?? "", "utf8");
  if (worker.username === reader.username || bytes < 32 || bytes > 4096)
    throw new Error("SYNC_WORKER_CONFIGURATION");
  return { grant, once: args[0] === "--once" };
}
export async function waitForNextSyncPass(signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(5000, undefined, { signal });
  } catch (error) {
    if (!signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}
function report(result: SyncPassResult): void {
  process.stdout.write(
    JSON.stringify({
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      created: result.created.length,
      outcomes: result.outcomes.length,
      succeeded: result.outcomes.filter((item) => item.reason === "SUCCEEDED").length,
    }) + "\n",
  );
}
function production(): SyncWorkerDependencies {
  return {
    signals: process,
    source: createMockSourceReadPorts,
    connect: (grant) => SyncWorkerPorts.connectGrant(grant),
    coordinator: (host, sources) => new SyncCoordinator(host, sources),
    poll: waitForNextSyncPass,
    report,
  };
}
async function close(
  host: WorkerHost | undefined,
  source: SourceReadPorts | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => host?.close()),
    Promise.resolve().then(() => source?.close()),
  ]);
  if (results.some((result) => result.status === "rejected"))
    throw new Error("SYNC_WORKER_CLEANUP_FAILED");
}
async function passes(
  coordinator: Pick<SyncCoordinator, "pass">,
  once: boolean,
  signal: AbortSignal,
  dependencies: SyncWorkerDependencies,
): Promise<void> {
  while (!signal.aborted) {
    const result = await coordinator.pass({ signal });
    dependencies.report(result);
    if (once || signal.aborted) return;
    await dependencies.poll(signal);
  }
}
export async function runSyncWorker(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  dependencies: SyncWorkerDependencies = production(),
): Promise<void> {
  const selected = startup(env, args);
  const controller = new AbortController(),
    stop = () => controller.abort();
  let source: SourceReadPorts | undefined, host: WorkerHost | undefined;
  dependencies.signals.on("SIGINT", stop);
  dependencies.signals.on("SIGTERM", stop);
  try {
    source = dependencies.source(env);
    host = await dependencies.connect(selected.grant);
    await passes(
      dependencies.coordinator(host, source),
      selected.once,
      controller.signal,
      dependencies,
    );
  } finally {
    dependencies.signals.off("SIGINT", stop);
    dependencies.signals.off("SIGTERM", stop);
    await close(host, source);
  }
}
