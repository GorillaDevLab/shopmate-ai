import { MockConnectorError } from "@shopmate/api/mock-commerce";
import type { SyncJob, SyncRuntimeBootstrap, SyncWorkerPorts } from "@shopmate/database/sync-host";
import type { SourceReadPorts } from "@shopmate/database/mock-platform-read";
import type { CommerceConnector } from "@shopmate/contracts";
import { SyncCommerce } from "./commerce.js";
import { createSyncFailureRuleLoader, requireSameRuntime } from "./failure-loader.js";
import { sameScope } from "./planner-input.js";
import { planSyncWindows } from "./planner.js";
import type { SyncWindowPlan, VerifiedWindowPublication, WaitingReason } from "./planner-types.js";
import { projectSyncWork, type ProjectedSyncWork } from "./work.js";
import { SyncPageRunner, type PageRunResult } from "./page-runner.js";
import {
  boundedControls,
  checkRun,
  controlled,
  pageOptions,
  PageRunPause,
  type PageRunControls,
} from "./page-controls.js";
import { checkedJob } from "./page-job.js";
import { scenarioDelivery, type ScenarioHost } from "./scenario-delivery.js";
type CoordinatorHost = Pick<
  SyncWorkerPorts,
  | "runtimeBootstrap"
  | "runtimeFailureRules"
  | "listWork"
  | "createWindow"
  | "claim"
  | "renew"
  | "fail"
  | "commitPage"
> &
  ScenarioHost;
type Bounds = ReturnType<typeof boundedControls>;
export interface SyncPassResult {
  readonly status: "WAITING" | "PROGRESSED" | "BUDGET" | "STOPPED";
  readonly reason?: WaitingReason;
  readonly created: readonly SyncJob[];
  readonly outcomes: readonly PageRunResult[];
}
interface PassState {
  created: SyncJob[];
  outcomes: PageRunResult[];
}
export class SyncCoordinator {
  private pinned: SyncRuntimeBootstrap | null = null;
  private readonly runners = new Map<string, SyncPageRunner>();
  private running = false;
  constructor(
    private readonly host: CoordinatorHost,
    private readonly sources: SourceReadPorts,
    private readonly commerce?: Pick<SyncCommerce, "open">,
  ) {}
  private async fresh(bounds: Bounds, initial = false): Promise<SyncRuntimeBootstrap | null> {
    checkRun(bounds.deadline, bounds.signal);
    const current = await controlled(this.host.runtimeBootstrap(), bounds.deadline, bounds.signal);
    checkRun(bounds.deadline, bounds.signal);
    if (this.pinned) return requireSameRuntime(current, this.pinned);
    if (!current || current.state !== "READY" || !current.runtimeOpening) {
      if (initial) return null;
      throw new MockConnectorError("PERMISSION_DENIED");
    }
    this.pinned = requireSameRuntime(current, current);
    return current;
  }
  private async publication(
    record: SyncRuntimeBootstrap,
    bounds: Bounds,
  ): Promise<VerifiedWindowPublication | null> {
    checkRun(bounds.deadline, bounds.signal);
    const source = this.sources.bind(
      { userId: record.principalUserId, merchantId: record.merchantId },
      record.scope,
    );
    const control = pageOptions(
      "sync-publication",
      Math.min(bounds.deadline, Date.now() + 25000),
      bounds.signal,
    );
    const publication = await controlled(
      source.findPublication({
        deadlineAt: control.deadlineAt,
        signal: control.signal,
      }),
      bounds.deadline,
      bounds.signal,
    ).catch((error) => {
      checkRun(bounds.deadline, bounds.signal);
      throw error;
    });
    checkRun(bounds.deadline, bounds.signal);
    if (!publication) return null;
    if (
      !sameScope(publication.scope, record.scope) ||
      publication.generatorVersion !== record.generatorVersion
    )
      throw new MockConnectorError("PERMISSION_DENIED");
    return {
      scope: publication.scope,
      targetTime: publication.targetTime,
      processedThrough: publication.processedThrough,
    };
  }
  private plan(
    record: SyncRuntimeBootstrap,
    work: ProjectedSyncWork,
    publication: VerifiedWindowPublication | null,
  ): SyncWindowPlan {
    return planSyncWindows({
      binding: work.binding,
      bootstrap: { scope: record.scope, businessNow: record.businessNow, state: record.state },
      publication,
      latestJobs: work.latestJobs,
    });
  }
  private async create(
    plan: Extract<SyncWindowPlan, { status: "PLANNED" }>,
    bounds: Bounds,
    state: PassState,
  ): Promise<boolean> {
    for (const window of plan.windows) {
      const current = await this.fresh(bounds);
      if (!current || Date.parse(current.businessNow) < Date.parse(plan.targetTime)) return false;
      checkRun(bounds.deadline, bounds.signal);
      // Await uncertain mutations and retain actual returned jobs on mid-RPC stop/budget.
      const value = await this.host.createWindow(window.stream, plan.targetTime);
      const job = checkedJob(value, value, "INPUT");
      if (
        job.stream !== window.stream ||
        job.since !== window.since ||
        job.until !== plan.targetTime ||
        job.provider !== current.provider ||
        !sameScope({ ...job, sessionId: current.scope.sessionId }, current.scope) ||
        state.created.some((created) => created.id === job.id)
      )
        throw new Error("SYNC_RUN_RESULT_INVALID");
      state.created.push(job);
      checkRun(bounds.deadline, bounds.signal);
    }
    return true;
  }
  private async selected(record: SyncRuntimeBootstrap, bounds: Bounds): Promise<CommerceConnector> {
    const commerce =
      this.commerce ??
      new SyncCommerce(this.host, this.sources, createSyncFailureRuleLoader(this.host, record));
    const result = await controlled(
      commerce.open(
        pageOptions("sync-open", Math.min(bounds.deadline, Date.now() + 25000), bounds.signal),
      ),
      bounds.deadline,
      bounds.signal,
    );
    checkRun(bounds.deadline, bounds.signal);
    if (!result.ok) throw new MockConnectorError(result.error.code);
    if (!result.data) throw new MockConnectorError("PERMISSION_DENIED");
    requireSameRuntime(result.data.bootstrap, record);
    return result.data.connector;
  }
  private async resume(
    jobs: readonly SyncJob[],
    connector: CommerceConnector,
    bounds: Bounds,
    state: PassState,
    delivery: ReturnType<typeof scenarioDelivery>,
  ): Promise<void> {
    const latest = new Set(jobs.map((job) => job.id));
    for (const id of this.runners.keys()) if (!latest.has(id)) this.runners.delete(id);
    for (const job of jobs) {
      if (job.status === "SUCCEEDED") {
        this.runners.delete(job.id);
        continue;
      }
      checkRun(bounds.deadline, bounds.signal);
      let runner = this.runners.get(job.id);
      if (!runner) {
        runner = new SyncPageRunner(
          delivery?.pageHost ?? this.host,
          connector,
          this.pinned!.runtimeOpening!,
        );
        this.runners.set(job.id, runner);
      } else runner.updateConnector(connector);
      const result = await runner.run(
        job,
        {
          maxPages: bounds.maxPages,
          budgetMs: Math.max(1, bounds.deadline - Date.now()),
          ...(bounds.signal ? { signal: bounds.signal } : {}),
        },
        bounds.deadline,
      );
      state.outcomes.push(result);
      await delivery?.drain(bounds.deadline, bounds.signal);
      if (result.reason === "SUCCEEDED") this.runners.delete(job.id);
      if (result.reason === "BUDGET" || result.reason === "STOPPED")
        throw new PageRunPause(result.reason);
    }
  }
  private async execute(bounds: Bounds, state: PassState): Promise<SyncPassResult> {
    const record = await this.fresh(bounds, true);
    if (!record) return { status: "WAITING", reason: "WAITING_RUNTIME", ...state };
    const delivery = scenarioDelivery(this.host, record);
    await delivery?.drain(bounds.deadline, bounds.signal);
    const publication = await this.publication(record, bounds);
    await this.fresh(bounds);
    const raw = await controlled(this.host.listWork(), bounds.deadline, bounds.signal);
    const latest = await this.fresh(bounds);
    const work = projectSyncWork(raw, latest!);
    const plan = this.plan(latest!, work, publication);
    if (plan.status === "WAITING") return { status: "WAITING", reason: plan.reason, ...state };
    if (!(await this.create(plan, bounds, state)))
      return { status: "WAITING", reason: "WAITING_COVERAGE", ...state };
    const selected = await this.selected(latest!, bounds);
    await this.resume(
      [...work.jobs.filter((job) => plan.existingStreams.includes(job.stream)), ...state.created],
      selected,
      bounds,
      state,
      delivery,
    );
    checkRun(bounds.deadline, bounds.signal);
    return { status: "PROGRESSED", ...state };
  }
  async pass(input: PageRunControls = {}): Promise<SyncPassResult> {
    const bounds = boundedControls(input);
    if (this.running) throw new Error("SYNC_RUN_BUSY");
    const state: PassState = { created: [], outcomes: [] };
    this.running = true;
    try {
      return await this.execute(bounds, state);
    } catch (error) {
      if (error instanceof PageRunPause) return { status: error.reason, ...state };
      throw error;
    } finally {
      this.running = false;
    }
  }
}
