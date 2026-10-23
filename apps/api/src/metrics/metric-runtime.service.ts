import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import {
  ConnectorBindingSchema,
  TenantContextSchema,
  type AuthorizedMetricRead,
  type ConnectorBinding,
  type MetricResult,
  type MetricSnapshotV1,
  type MetricSourceQuery,
  type TenantContext,
} from "@shopmate/contracts";
import {
  createMetricSourceBundleRepository,
  createMetricRuntimePool,
  ensureMetricDefinitions,
  type MetricHistoryPage,
  type MetricRuntimePool,
  type MetricSourceBundleRepository,
} from "@shopmate/database";
import { metricEnvironment, type MetricsEnvironment } from "./metrics.environment.js";
import {
  PersistedMetricReadAdapter,
  type AuthorizedMetricHistoryRead,
} from "./metrics-query.service.js";
import { createMetricComputationService } from "./metric-computation.service.js";
import { createNormalizedMetricSourceAdapter } from "./normalized-metric-source.adapter.js";
import { METRIC_RUNTIME_DEFINITION_VERSION } from "./metric-runtime-calculator.js";
import {
  runtimeDefinitions,
  runtimeFailure,
  runtimeRegistry,
  runtimeRequestSchema,
  runtimeStore,
  computeRuntimeMetrics,
} from "./metric-runtime-composition.js";

@Injectable()
export class MetricRuntimeService implements OnModuleDestroy {
  private readonly configuration: MetricsEnvironment | null = metricEnvironment(process.env);
  private pool: MetricRuntimePool | undefined;
  private definitionPool: MetricRuntimePool | undefined;
  private reads: PersistedMetricReadAdapter | undefined;

  private source(actor: TenantContext): MetricSourceBundleRepository {
    if (!this.configuration) throw new Error("Metric runtime unavailable");
    this.pool ??= createMetricRuntimePool(this.configuration.databaseUrl, "runtime");
    return createMetricSourceBundleRepository({ pool: this.pool, actor });
  }
  private reader(): PersistedMetricReadAdapter {
    if (!this.configuration) throw new Error("Metric runtime unavailable");
    this.pool ??= createMetricRuntimePool(this.configuration.databaseUrl, "runtime");
    const pool = this.pool;
    this.reads ??= new PersistedMetricReadAdapter(
      (actor) => runtimeStore(pool, actor),
      this.configuration.cursorSecret,
    );
    return this.reads;
  }
  async resolve(actor: TenantContext, storeId: string): Promise<ConnectorBinding | null> {
    const result = await this.source(actor).resolve(storeId);
    if (result.ok) return result.value;
    if (result.error.code === "NOT_FOUND" || result.error.code === "FORBIDDEN") return null;
    throw new Error("Metric runtime unavailable");
  }
  async read(request: AuthorizedMetricRead): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
    try {
      return await this.reader().read(request);
    } catch {
      return runtimeFailure("SOURCE_UNAVAILABLE");
    }
  }
  async history(request: AuthorizedMetricHistoryRead): Promise<MetricResult<MetricHistoryPage>> {
    try {
      return await this.reader().history(request);
    } catch {
      return runtimeFailure("SOURCE_UNAVAILABLE");
    }
  }
  private async authorize(
    source: MetricSourceBundleRepository,
    binding: ConnectorBinding,
  ): Promise<MetricResult<ConnectorBinding>> {
    const result = await source.resolve(binding.storeId);
    return result.ok && !isDeepStrictEqual(result.value, binding)
      ? runtimeFailure("NOT_FOUND")
      : result;
  }
  /** Explicit release operation. No HTTP route or read path invokes definition provisioning. */
  async provisionDefinitions(request: {
    readonly actor: TenantContext;
    readonly binding: ConnectorBinding;
  }): Promise<MetricResult<true>> {
    if (!this.configuration?.definitionUrl) return runtimeFailure("SOURCE_UNAVAILABLE");
    const actor = TenantContextSchema.safeParse(request?.actor);
    const binding = ConnectorBindingSchema.safeParse(request?.binding);
    if (!actor.success || !binding.success) return runtimeFailure("INVALID_INPUT");
    try {
      const authorized = await this.authorize(this.source(actor.data), binding.data);
      if (!authorized.ok) return authorized;
      this.definitionPool ??= createMetricRuntimePool(
        this.configuration.definitionUrl,
        "definition",
      );
      return await ensureMetricDefinitions(
        { pool: this.definitionPool, actor: actor.data },
        binding.data,
        runtimeDefinitions(),
        true,
      );
    } catch {
      return runtimeFailure("SOURCE_UNAVAILABLE");
    }
  }
  /** Server-only entry point, with a fresh binding and the archive's authoritative business clock. */
  async compute(request: {
    readonly actor: TenantContext;
    readonly query: MetricSourceQuery;
    readonly computedAt: string;
  }): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
    if (!this.configuration) return runtimeFailure("SOURCE_UNAVAILABLE");
    const parsed = runtimeRequestSchema.safeParse(request);
    if (!parsed.success) return runtimeFailure("INVALID_INPUT");
    if (parsed.data.query.definitionVersion !== METRIC_RUNTIME_DEFINITION_VERSION)
      return runtimeFailure("VERSION_MISMATCH");
    try {
      return await this.computeAuthorized(parsed.data);
    } catch {
      return runtimeFailure("SOURCE_UNAVAILABLE");
    }
  }
  private async computeAuthorized(request: {
    readonly actor: TenantContext;
    readonly query: MetricSourceQuery;
    readonly computedAt: string;
  }): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
    const { actor, query, computedAt } = request;
    const source = this.source(actor);
    const authorized = await this.authorize(source, query.binding);
    if (!authorized.ok) return authorized;
    const pool = this.pool!;
    const definitions = runtimeDefinitions(query.coverageRequests.map((item) => item.kind));
    const checked = await ensureMetricDefinitions({ pool, actor }, query.binding, definitions);
    if (!checked.ok) return checked;
    const context = { binding: query.binding, window: query.window, visibleAt: query.visibleAt };
    const captured =
      query.inputRevision === null
        ? await source.capture(context)
        : await source.read({ ...context, inputRevision: query.inputRevision });
    if (!captured.ok) return captured;
    const registry = runtimeRegistry(captured.value);
    const service = createMetricComputationService({
      actor,
      registry,
      source: createNormalizedMetricSourceAdapter(source),
      repository: runtimeStore(pool, actor, registry),
      authorizeBinding: (_actor, binding) => this.authorize(source, binding),
    });
    return computeRuntimeMetrics(
      service,
      { ...query, inputRevision: captured.value.inputRevision },
      computedAt,
    );
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.pool?.end(), this.definitionPool?.end()]);
  }
}
