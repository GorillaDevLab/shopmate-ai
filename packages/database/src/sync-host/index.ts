import pg from "pg";
import { randomUUID } from "node:crypto";
import { encodeWorkerPage, workerCursor, workerDatabaseUrl, workerId, workerStream, workerTime, type SyncStream } from "./input.js";

export type { SyncStream } from "./input.js";
export interface SyncJob {
  id: string; stream: SyncStream; fence: number; since: string; until: string;
  cursor: string | null; status: "READY" | "RUNNING" | "FAILED" | "SUCCEEDED";
  pageCount: number; successfulThrough: string | null; observedAt: string | null; sourceWatermark: string | null;
  organizationId: string; workspaceId: string; storeId: string; connectionId: string;
  externalStoreId: string; provider: string; generation: number;
}
export interface SyncPageRequest {
  job: Readonly<SyncJob>; cursor: string | null; limit: number;
}
export type SyncPageFetcher = (request: SyncPageRequest) => Promise<unknown>;
export interface WorkerBinding { grantId: string; principalUserId: string }

function readJob(value: unknown): SyncJob {
  if (!value || typeof value !== "object") throw new Error("SYNC_RESULT_INVALID");
  const job = value as SyncJob;
  workerId(job.id); workerStream(job.stream); workerCursor(job.cursor);
  if (!Number.isSafeInteger(job.fence) || job.fence < 0 || !Number.isSafeInteger(job.pageCount) || job.pageCount < 0 ||
    !["READY", "RUNNING", "FAILED", "SUCCEEDED"].includes(job.status)) throw new Error("SYNC_RESULT_INVALID");
  return Object.freeze({ ...job, since: new Date(`${job.since}Z`).toISOString(), until: new Date(`${job.until}Z`).toISOString() });
}

/** One dedicated backend owns the lease while connector fetches run outside transactions. */
export class SyncWorkerPorts {
  private readonly owner = `worker-${randomUUID()}`;
  private running = false;
  readonly #client: pg.Client;
  private constructor(client: pg.Client) { this.#client = client; }
  static async connect(binding: WorkerBinding): Promise<SyncWorkerPorts> {
    workerId(binding.grantId); workerId(binding.principalUserId);
    const client = new pg.Client({ connectionString: workerDatabaseUrl(process.env), application_name: "shopmate-sync-worker" });
    try {
      await client.connect();
      const check = await client.query("SELECT session_user=current_user AND sync_host.safe_login(session_user) AS safe");
      if (check.rows[0]?.safe !== true) throw new Error("SYNC_AUTHORITY_DENIED");
      await client.query("SELECT set_config('app.user_id',$1,false),set_config('sync.grant_id',$2,false)", [binding.principalUserId, binding.grantId]);
      const ports = new SyncWorkerPorts(client);
      await ports.listWork();
      return ports;
    } catch {
      await client.end();
      throw new Error("SYNC_WORKER_CONNECTION_FAILED");
    }
  }
  async #rpc(sql: string, values: readonly unknown[] = []): Promise<unknown> {
    try { return (await this.#client.query(sql, [...values])).rows[0]?.result as unknown; }
    catch { throw new Error("SYNC_WORKER_OPERATION_FAILED"); }
  }
  async listWork(): Promise<unknown> { return this.#rpc("SELECT sync_host.list_work() AS result"); }
  async createWindow(stream: SyncStream, until: string): Promise<SyncJob> {
    return readJob(await this.#rpc("SELECT sync_host.create_window($1,$2::timestamp) AS result", [workerStream(stream), workerTime(until)]));
  }
  private async lease(job: SyncJob, action: "CLAIM" | "RENEW" | "FAIL"): Promise<SyncJob> {
    return readJob(await this.#rpc("SELECT sync_host.control_lease($1,$2,$3,$4) AS result", [workerId(job.id), action, job.fence, this.owner]));
  }
  async claim(job: SyncJob): Promise<SyncJob> { return this.lease(job, "CLAIM"); }
  async renew(job: SyncJob): Promise<SyncJob> { return this.lease(job, "RENEW"); }
  async fail(job: SyncJob): Promise<SyncJob> { return this.lease(job, "FAIL"); }
  async commitPage(job: SyncJob, pageId: string, expectedCursor: string | null, page: unknown): Promise<SyncJob> {
    const result = await this.#rpc("SELECT sync_host.commit_worker_page($1,$2,$3,$4,$5::jsonb) AS result",
      [workerId(job.id), job.fence, workerId(pageId), workerCursor(expectedCursor), encodeWorkerPage(workerStream(job.stream), page)]);
    if (!result || typeof result !== "object" || !("job" in result)) throw new Error("SYNC_RESULT_INVALID");
    return readJob(result.job);
  }
  private async fetch(job: SyncJob, fetchPage: SyncPageFetcher): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fetchPage({ job, cursor: job.cursor, limit: job.stream === "ORDERS" ? 10 : 200 }); }
      catch {
        if (attempt === 2) {
          await this.fail(job);
          throw new Error("SYNC_CONNECTOR_FAILED");
        }
      }
    }
    throw new Error("SYNC_CONNECTOR_FAILED");
  }
  async run(job: SyncJob, fetchPage: SyncPageFetcher, maxPages = 100): Promise<SyncJob> {
    if (this.running || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error("SYNC_INPUT_INVALID");
    this.running = true;
    try {
      let current = job.status === "RUNNING" ? await this.renew(job) : await this.claim(job);
      for (let count = 0; count < maxPages && current.status !== "SUCCEEDED"; count++) {
        current = await this.renew(current);
        // No BEGIN surrounds provider I/O; commitPage is one atomic server statement.
        const page = await this.fetch(current, fetchPage);
        current = await this.commitPage(current, `page-${current.pageCount + 1}`, current.cursor, page);
      }
      return current;
    } finally { this.running = false; }
  }
  async close(): Promise<void> { await this.#client.end(); }
}
