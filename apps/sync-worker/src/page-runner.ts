import type { CommerceConnector } from "@shopmate/contracts";
import type { SyncJob, SyncWorkerPorts } from "@shopmate/database/sync-host";
import { checkedJob } from "./page-job.js";
import { sqlTime } from "./work.js";
import {
  checkRun,
  boundedControls,
  controlled,
  pageOptions,
  PageRunPause,
  retryWait,
  type PageRunControls,
  type PageRunReason,
} from "./page-controls.js";
import {
  fetchBusinessPage,
  checkConnectorBinding,
  retryableFailure,
  type BusinessPage,
} from "./page-fetch.js";
type PageHost = Pick<SyncWorkerPorts, "claim" | "renew" | "fail" | "commitPage">;
export interface PageRunResult {
  readonly job: SyncJob;
  readonly reason: PageRunReason;
}
export class SyncPageRunner {
  private owned: SyncJob | null = null;
  private ownedUntil = 0;
  private running = false;
  constructor(
    private readonly host: PageHost,
    private readonly connector: CommerceConnector,
    private readonly runtimeOpening: string,
  ) {
    if (sqlTime(runtimeOpening) !== runtimeOpening) throw new Error("SYNC_RUN_INPUT_INVALID");
  }
  private async acquire(job: SyncJob): Promise<SyncJob> {
    // Only a lease captured by this instance on this pinned host proves ownership.
    const retained = this.owned;
    const owns = Boolean(
      retained &&
        Date.now() < this.ownedUntil &&
        retained.id === job.id &&
        retained.fence === job.fence &&
        retained.cursor === job.cursor &&
        retained.pageCount === job.pageCount,
    );
    const started = Date.now();
    const current = owns ? await this.host.renew(job) : await this.host.claim(job);
    this.owned = checkedJob(current, job, owns ? "RENEW" : "CLAIM");
    this.ownedUntil = started + 120000;
    return this.owned;
  }
  private async fetch(
    job: SyncJob,
    pageId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<BusinessPage> {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkRun(deadline, signal);
      const result = await controlled(
        fetchBusinessPage(
          this.connector,
          job,
          this.runtimeOpening,
          pageOptions(pageId, deadline, signal),
        ),
        deadline,
        signal,
      );
      checkRun(deadline, signal);
      if (result.ok) return result.data;
      const failure = retryableFailure(result);
      if (attempt === 2) {
        checkRun(deadline, signal);
        await this.host.fail(job);
        this.owned = null;
        throw new Error("SYNC_CONNECTOR_FAILED");
      }
      await retryWait(failure.retryAfterMs, deadline, signal);
    }
    throw new Error("SYNC_CONNECTOR_FAILED");
  }
  private async page(job: SyncJob, deadline: number, signal?: AbortSignal): Promise<SyncJob> {
    checkRun(deadline, signal);
    const started = Date.now();
    const current = checkedJob(await this.host.renew(job), job, "RENEW");
    this.owned = current;
    this.ownedUntil = started + 120000;
    const originalCursor = job.cursor,
      pageId = `page-${job.pageCount + 1}`;
    const pageDeadline = Math.min(deadline, Date.now() + 25000);
    const page = await this.fetch(current, pageId, pageDeadline, signal);
    checkRun(pageDeadline, signal);
    const renewedAt = Date.now();
    const renewed = checkedJob(await this.host.renew(current), current, "RENEW");
    this.owned = renewed;
    this.ownedUntil = renewedAt + 120000;
    checkRun(pageDeadline, signal);
    // Commit errors may be lost acknowledgements. Never refetch or classify them as provider failures.
    const committed = checkedJob(
      await this.host.commitPage(renewed, pageId, originalCursor, page),
      renewed,
      "COMMIT",
    );
    this.owned = committed.status === "RUNNING" ? committed : null;
    return committed;
  }
  async run(job: SyncJob, controls: PageRunControls = {}): Promise<PageRunResult> {
    if (this.running) throw new Error("SYNC_RUN_BUSY");
    let current = checkedJob(job, job, "INPUT");
    checkConnectorBinding(this.connector, current);
    const bounds = boundedControls(controls);
    this.running = true;
    try {
      checkRun(bounds.deadline, bounds.signal);
      if (current.status === "SUCCEEDED") return { job: current, reason: "SUCCEEDED" };
      current = await this.acquire(current);
      for (let index = 0; index < bounds.maxPages; index++) {
        current = await this.page(current, bounds.deadline, bounds.signal);
        if (current.status === "SUCCEEDED") return { job: current, reason: "SUCCEEDED" };
      }
      return { job: current, reason: "PAGE_LIMIT" };
    } catch (error) {
      if (error instanceof PageRunPause) return { job: current, reason: error.reason };
      throw error;
    } finally {
      this.running = false;
    }
  }
}
