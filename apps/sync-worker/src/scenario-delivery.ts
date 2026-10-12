import type { SyncRuntimeBootstrap, SyncWorkerPorts } from "@shopmate/database/sync-host";
import { checkRun, controlled } from "./page-controls.js";

type PageHost = Pick<SyncWorkerPorts, "claim" | "renew" | "fail" | "commitPage">;
type DeliveryPorts = Pick<
  SyncWorkerPorts,
  "commitDeliveryPage" | "pendingDeliveryReplays" | "replayDelivery"
>;
export type ScenarioHost = PageHost & Partial<DeliveryPorts>;

async function drainDelivery(ports: DeliveryPorts, deadline: number, signal?: AbortSignal) {
  // Five streams, at most three extra attempts each; retries resume durable ordinals next pass.
  for (let round = 0; round < 3; round++) {
    checkRun(deadline, signal);
    const pending = await controlled(ports.pendingDeliveryReplays(), deadline, signal);
    checkRun(deadline, signal);
    if (!pending.length) return;
    let progressed = false;
    for (const saved of pending) {
      checkRun(deadline, signal);
      // Await the mutative replay and ordinal ACK to preserve uncertain-mutation semantics.
      if ((await ports.replayDelivery(saved)) !== "BUSY") progressed = true;
      checkRun(deadline, signal);
    }
    if (!progressed) return;
  }
}

/** Demo composition owns transport policy; ingestion and the generic runner see normal pages. */
export function scenarioDelivery(host: ScenarioHost, record: SyncRuntimeBootstrap) {
  const config = record.config as { scenarioPlan?: { delivery?: { kind?: string } } } | null;
  if (
    record.provider !== "MOCK" ||
    record.generatorVersion !== "mock-source-v2" ||
    config?.scenarioPlan?.delivery?.kind !== "REPLAY_SAVED_PAGE"
  )
    return null;
  if (!host.commitDeliveryPage || !host.pendingDeliveryReplays || !host.replayDelivery)
    throw new Error("SYNC_DELIVERY_UNAVAILABLE");
  const ports = host as ScenarioHost & DeliveryPorts;
  const pageHost: PageHost = {
    claim: (job) => host.claim(job),
    renew: (job) => host.renew(job),
    fail: (job) => host.fail(job),
    async commitPage(job, pageId, expectedCursor, page) {
      return ports.commitDeliveryPage(job, pageId, expectedCursor, page);
    },
  };
  return {
    pageHost,
    drain: (deadline: number, signal?: AbortSignal) => drainDelivery(ports, deadline, signal),
  };
}
