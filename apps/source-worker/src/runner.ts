import type { MockSourceWorker } from "@shopmate/database/mock-platform";
import { buildSource } from "./build.js";
import type { BuildOutcome } from "./build-types.js";
import { generationTools } from "./generation-tools.js";

export async function runSourcePass(
  worker: MockSourceWorker,
  signal?: AbortSignal,
): Promise<readonly BuildOutcome[]> {
  if (signal?.aborted) return [];
  const work = await worker.listBuildScopes();
  const outcomes: BuildOutcome[] = [];
  for (const scope of work) {
    if (signal?.aborted) break;
    outcomes.push(await buildSource(worker, scope, generationTools, signal));
  }
  return outcomes;
}
