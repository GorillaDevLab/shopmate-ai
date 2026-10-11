import { describe, expect, it, vi } from "vitest";
import { buildSource } from "./build.js";
import { BuildInterrupted } from "./build-types.js";
import { eventTuple } from "@shopmate/database/mock-platform";
import type { GenerationTools } from "./build-types.js";
import type {
  BuildLease,
  ChunkInput,
  LeaseRef,
  MockSourceWorker,
  SourceBuildWork,
  SourceWorkerActor,
  SnapshotEvent,
} from "@shopmate/database/mock-platform";

const work: SourceBuildWork = {
  actor: { grantId: "g" },
  scope: {
    organizationId: "o",
    workspaceId: "w",
    storeId: "s",
    sessionId: "d",
    connectionId: "c",
    externalStoreId: "m",
    generation: 0,
  },
};
function fixture(sealed = false) {
  const lease: BuildLease = {
    scope: work.scope,
    revision: "1",
    fence: "1",
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
    targetClockRevision: 0,
    targetTime: "2026-01-01T00:00:00.000Z",
    baseRevision: "0",
    baseHighEventSeq: "0",
    leaseUntil: "2026-01-01T00:00:30.000Z",
    checkpointHash: "a".repeat(64),
    checkpoint: {
      codec: "source-checkpoint-v1",
      chunkIndex: "0",
      highEventSeq: "0",
      processedThrough: "2026-01-01T00:00:00.000Z",
      lastEvent: null,
      sealed,
    },
  };
  const worker = {
    initializeGeneration: vi.fn(async () => ({
      status: "CREATED",
      generation: { sourceConfig: {} },
    })),
    claim: vi.fn(async () => ({ status: "CLAIMED", lease })),
    renew: vi.fn(async () => ({ status: "RENEWED", lease })),
    hydrateBuild: vi.fn(async () => ({
      status: "HYDRATED",
      checkpoint: lease.checkpoint,
      checkpointHash: lease.checkpointHash,
      items: [],
    })),
    appendChunk: vi.fn(async (_actor: SourceWorkerActor, _lease: LeaseRef, chunk: ChunkInput) => {
      Object.assign(lease, {
        checkpoint: {
          ...lease.checkpoint,
          chunkIndex: String(Number(lease.checkpoint.chunkIndex) + 1),
          highEventSeq: String(Number(lease.checkpoint.highEventSeq) + chunk.events.length),
          lastEvent: chunk.events.length
            ? eventTuple(chunk.events.at(-1)!)
            : lease.checkpoint.lastEvent,
          processedThrough: chunk.next.processedThrough,
          sealed: chunk.next.sealed,
        },
      });
      return {
        status: "COMMITTED",
        checkpoint: lease.checkpoint,
        checkpointHash: lease.checkpointHash,
      };
    }),
    publish: vi.fn(async () => ({
      status: "PUBLISHED",
      publication: { certificateHash: "b".repeat(64) },
    })),
    fail: vi.fn(async () => ({ status: "FAILED" })),
  };
  const tools: GenerationTools = { hydrationKeys: () => [], create: () => ({ window: () => [] }) };
  return { worker, port: worker as unknown as MockSourceWorker, tools, lease };
}
function storeEvent(at: string, ordinal = "0"): SnapshotEvent {
  return {
    kind: "STORE",
    occurredAt: at,
    ordinal,
    after: {
      externalStoreId: work.scope.externalStoreId,
      name: "Demo",
      category: "Retail",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
      source: {
        version: null,
        updatedAt: at,
        quality: { state: "COMPLETE", issues: [] },
      },
    },
  };
}
describe("source build orchestration", () => {
  it("combines adjacent timestamp groups into one bounded append", async () => {
    const f = fixture(),
      at = f.lease.checkpoint.processedThrough;
    const second = "2026-01-01T00:00:00.500Z";
    Object.assign(f.lease, { targetTime: "2026-01-01T00:00:01.000Z" });
    f.tools.create = () => ({
      window: () => [
        { occurredAt: at, events: [storeEvent(at)] },
        { occurredAt: second, events: [storeEvent(second)] },
      ],
    });
    expect((await buildSource(f.port, work, f.tools)).status).toBe("PUBLISHED");
    expect(f.worker.appendChunk).toHaveBeenCalledTimes(2);
    expect(f.worker.appendChunk.mock.calls[0]![2].events).toHaveLength(2);
  });
  it("replays a completed base boundary without staging an empty duplicate chunk", async () => {
    const f = fixture(),
      at = f.lease.checkpoint.processedThrough;
    Object.assign(f.lease, {
      baseRevision: "1",
      baseHighEventSeq: "1",
      targetTime: "2026-01-01T00:00:01.000Z",
      checkpoint: {
        ...f.lease.checkpoint,
        highEventSeq: "1",
        lastEvent: eventTuple(storeEvent(at)),
      },
    });
    f.tools.create = () => ({ window: () => [{ occurredAt: at, events: [storeEvent(at)] }] });
    expect((await buildSource(f.port, work, f.tools)).status).toBe("PUBLISHED");
    expect(f.worker.appendChunk).toHaveBeenCalledOnce();
    expect(f.worker.appendChunk.mock.calls[0]![2].events).toEqual([]);
  });
  it("recovers a completed own timestamp before advancing the next window", async () => {
    const f = fixture(),
      at = f.lease.checkpoint.processedThrough;
    Object.assign(f.lease, {
      targetTime: "2026-01-01T00:00:01.000Z",
      checkpoint: {
        ...f.lease.checkpoint,
        highEventSeq: "1",
        chunkIndex: "1",
        lastEvent: eventTuple(storeEvent(at)),
      },
    });
    f.tools.create = () => ({ window: () => [{ occurredAt: at, events: [storeEvent(at)] }] });
    expect((await buildSource(f.port, work, f.tools)).status).toBe("PUBLISHED");
    expect(f.worker.appendChunk).toHaveBeenCalledOnce();
    expect(f.worker.appendChunk.mock.calls[0]![2].events).toEqual([]);
  });
  it("publishes an already sealed recovered lease without generating or appending", async () => {
    const f = fixture(true);
    const create = vi.spyOn(f.tools, "create");
    expect((await buildSource(f.port, work, f.tools)).status).toBe("PUBLISHED");
    expect(create).not.toHaveBeenCalled();
    expect(f.worker.appendChunk).not.toHaveBeenCalled();
    expect(f.worker.publish).toHaveBeenCalledWith(
      work.actor,
      expect.objectContaining({ fence: "1" }),
      { expectedBaseRevision: "0", checkpointHash: "a".repeat(64) },
    );
  });
  it("halts a fenced worker before any hydration or business generation", async () => {
    const f = fixture();
    f.worker.renew.mockImplementationOnce(async () => ({ status: "FENCED" }) as never);
    expect(await buildSource(f.port, work, f.tools)).toEqual({ status: "FENCED" });
    expect(f.worker.hydrateBuild).not.toHaveBeenCalled();
    expect(f.worker.appendChunk).not.toHaveBeenCalled();
    expect(f.worker.fail).not.toHaveBeenCalled();
  });
  it("does not claim work when already stopped", async () => {
    const f = fixture();
    const stop = new AbortController();
    stop.abort();
    await expect(buildSource(f.port, work, f.tools, stop.signal)).rejects.toBeInstanceOf(
      BuildInterrupted,
    );
    expect(f.worker.claim).not.toHaveBeenCalled();
  });
  it("seals an exhausted interval even when its checkpoint already reached target", async () => {
    const f = fixture();
    expect((await buildSource(f.port, work, f.tools)).status).toBe("PUBLISHED");
    expect(f.worker.appendChunk).toHaveBeenCalledOnce();
    expect(f.worker.appendChunk.mock.calls[0]![2]).toMatchObject({
      events: [],
      next: { sealed: true },
    });
  });
});
