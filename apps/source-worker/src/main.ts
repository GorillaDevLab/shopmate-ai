import { setTimeout } from "node:timers/promises";
import { createMockSourceWorker } from "@shopmate/database/mock-platform";
import { BuildInterrupted } from "./build-types.js";
import { runSourcePass } from "./runner.js";

function stopped(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error instanceof BuildInterrupted || (error instanceof Error && error.name === "AbortError"))
  );
}
async function main(): Promise<void> {
  if (process.env.APP_ENV !== "demo" || process.env.ENABLE_DEMO_MODE !== "true")
    throw new Error("SOURCE_WORKER_DEMO_REQUIRED");
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--once"))
    throw new Error("SOURCE_WORKER_INVALID_ARGUMENTS");
  const worker = createMockSourceWorker(process.env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      await runSourcePass(worker, controller.signal);
      if (args[0] === "--once" || controller.signal.aborted) break;
      await setTimeout(5000, undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  } catch (error) {
    if (!stopped(error, controller.signal)) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await worker.close();
  }
}
main().catch(() => {
  process.stderr.write("SOURCE_WORKER_FAILED\n");
  process.exitCode = 1;
});
