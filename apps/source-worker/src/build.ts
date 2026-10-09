import {
  packSourceChunk,
  eventTuple,
  compareEventTuples,
  SourceStorageError,
  type BuildLease,
  type MockSourceWorker,
  type SourceBuildWork,
  type SnapshotEvent,
  type ChunkInput,
} from "@shopmate/database/mock-platform";
import {
  BuildHalted,
  BuildInterrupted,
  type BuildOutcome,
  type GenerationTools,
  type HydratedRows,
} from "./build-types.js";

const DAY_MS = 86_400_000;
function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BuildInterrupted();
}
export async function buildSource(
  worker: MockSourceWorker,
  work: SourceBuildWork,
  tools: GenerationTools,
  signal?: AbortSignal,
): Promise<BuildOutcome> {
  active(signal);
  const initialized = await worker.initializeGeneration(work.actor, work.scope);
  if (initialized.status === "DENIED") return { status: "DENIED" };
  active(signal);
  const claimed = await worker.claim(work.actor, work.scope);
  if (claimed.status !== "CLAIMED") return { status: claimed.status };
  const execution = new BuildExecution(worker, work, claimed.lease, tools, signal);
  try {
    return await execution.run(initialized.generation.sourceConfig);
  } catch (error) {
    if (error instanceof BuildHalted) return { status: error.status };
    await execution.release(error);
    throw error;
  }
}
class BuildExecution {
  constructor(
    private readonly worker: MockSourceWorker,
    private readonly work: SourceBuildWork,
    private lease: BuildLease,
    private readonly tools: GenerationTools,
    private readonly signal?: AbortSignal,
  ) {}
  async renew(): Promise<void> {
    active(this.signal);
    const renewed = await this.worker.renew(this.work.actor, this.lease);
    if (renewed.status !== "RENEWED") throw new BuildHalted(renewed.status);
    this.lease = renewed.lease;
    active(this.signal);
  }
  async run(config: unknown): Promise<BuildOutcome> {
    await this.renew();
    if (!this.lease.checkpoint.sealed) await this.generate(config);
    await this.renew();
    const published = await this.worker.publish(this.work.actor, this.lease, {
      expectedBaseRevision: this.lease.baseRevision,
      checkpointHash: this.lease.checkpointHash,
    });
    if (published.status !== "PUBLISHED" && published.status !== "ALREADY_PUBLISHED")
      throw new BuildHalted(published.status);
    return { status: "PUBLISHED", publication: published.publication };
  }
  private async hydrate(config: unknown, before: string): Promise<HydratedRows> {
    const keys = this.tools.hydrationKeys(config, before);
    if (keys.length > 5000) throw new Error("SOURCE_HYDRATION_BUDGET");
    const rows: Record<"ORDER" | "INVENTORY" | "MARKETING", unknown[]> = {
      ORDER: [],
      INVENTORY: [],
      MARKETING: [],
    };
    for (const kind of ["ORDER", "INVENTORY", "MARKETING"] as const) {
      const selected = keys.filter((key) => key[0] === kind);
      for (let offset = 0; offset < selected.length; offset += 100) {
        await this.renew();
        const result = await this.worker.hydrateBuild(this.work.actor, this.lease, {
          kind,
          beforeTime: before,
          expectedCheckpointHash: this.lease.checkpointHash,
          entityKeys: selected.slice(offset, offset + 100),
        });
        if (result.status !== "HYDRATED") throw new BuildHalted(result.status);
        if (result.checkpointHash !== this.lease.checkpointHash)
          throw new SourceStorageError("SOURCE_INTEGRITY");
        rows[kind].push(...result.items.map((item) => item.payload));
      }
    }
    return rows;
  }
  private async generate(config: unknown): Promise<void> {
    const before = this.lease.checkpoint.processedThrough;
    let after = new Date(Date.parse(before) - 1).toISOString();
    const rows = await this.hydrate(config, before);
    const generator = this.tools.create(config, rows, before);
    while (!this.lease.checkpoint.sealed) {
      const until = new Date(
        Math.min(Date.parse(after) + DAY_MS, Date.parse(this.lease.targetTime)),
      ).toISOString();
      await this.renew();
      for (const group of generator.window(after, until)) {
        active(this.signal);
        await this.group(group.events, group.occurredAt);
      }
      if (!this.lease.checkpoint.sealed) await this.group([], until);
      after = until;
    }
  }
  private async group(events: readonly SnapshotEvent[], until: string): Promise<void> {
    if (this.covered(events, until)) return;
    while (!this.lease.checkpoint.sealed) {
      await this.renew();
      const chunk = this.pack(events, until);
      await this.renew();
      const result = await this.worker.appendChunk(this.work.actor, this.lease, chunk);
      if (result.status !== "COMMITTED" && result.status !== "ALREADY_COMMITTED")
        throw new BuildHalted(result.status);
      this.lease = {
        ...this.lease,
        checkpoint: result.checkpoint,
        checkpointHash: result.checkpointHash,
      };
      if (
        !chunk.events.length ||
        JSON.stringify(chunk.events.at(-1)) === JSON.stringify(events.at(-1))
      )
        return;
    }
  }
  private covered(events: readonly SnapshotEvent[], until: string): boolean {
    const checkpoint = this.lease.checkpoint;
    if (until > checkpoint.processedThrough || until === this.lease.targetTime) return false;
    const last = events.at(-1);
    return (
      !last ||
      checkpoint.highEventSeq === this.lease.baseHighEventSeq ||
      (!!checkpoint.lastEvent && compareEventTuples(eventTuple(last), checkpoint.lastEvent) <= 0)
    );
  }
  private pack(events: readonly SnapshotEvent[], until: string): ChunkInput {
    return packSourceChunk(
      {
        scope: this.lease.scope,
        checkpoint: this.lease.checkpoint,
        baseRevision: this.lease.baseRevision,
        baseHighEventSeq: this.lease.baseHighEventSeq,
        expectedCheckpointHash: this.lease.checkpointHash,
        windowEnd: until,
        targetTime: this.lease.targetTime,
      },
      events,
      20,
    );
  }
  async release(error: unknown): Promise<void> {
    const invalid =
      error instanceof SourceStorageError
        ? ["SOURCE_INPUT", "SOURCE_INTEGRITY"].includes(error.code)
        : !(error instanceof BuildInterrupted);
    await this.worker.fail(
      this.work.actor,
      this.lease,
      invalid ? "GENERATOR_INVALID" : "INTERRUPTED",
    );
  }
}
