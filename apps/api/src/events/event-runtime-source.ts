import { Injectable } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import {
  EventEvidenceV1Schema,
  EventSourceReferenceSchema,
  sameEventPeriod,
  type ConnectorBinding,
  type EventEvidenceV1,
  type MetricSnapshotV1,
  type MetricSnapshotQuery,
  type MetricWindow,
  type TenantContext,
} from "@shopmate/contracts";
import {
  decodeNormalizedMetricSourceBundle,
  type NormalizedMetricSourceBundle,
  type StoredMetricSnapshot,
} from "@shopmate/database";
import { MetricRuntimeService } from "../metrics/metric-runtime.service.js";
import { METRIC_RUNTIME_DEFINITION_VERSION } from "../metrics/metric-runtime-calculator.js";
import { EventDecisionUnitOfWork, runtimeControl } from "./event-decision-unit-of-work.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";
import type { EventRuntimeTransaction } from "./event-decision-transaction.js";

export const STOCKOUT_METRIC_KINDS = ["INVENTORY_AVAILABLE"] as const;
export interface RuntimeObservation {
  readonly actor: TenantContext;
  readonly binding: ConnectorBinding;
  readonly externalSkuId: string;
  readonly window: MetricWindow;
  readonly observedAt: string;
}
export interface PersistedRuntimeFrame {
  readonly observation: RuntimeObservation;
  readonly bundle: NormalizedMetricSourceBundle;
  readonly rows: readonly StoredMetricSnapshot[];
  readonly evidence: EventEvidenceV1;
}
export async function readRuntimeBundle(
  scope: EventRuntimeTransaction,
  query: MetricSnapshotQuery,
): Promise<NormalizedMetricSourceBundle> {
  const window = {
    ...query.window,
    periodStart: new Date(query.window.periodStart).toISOString(),
    periodEnd: new Date(query.window.periodEnd).toISOString(),
  };
  const result = await scope.client.query(
    "SELECT public.metric_source_read($1,$2,$3,$4) AS bundle",
    [JSON.stringify(query.binding), JSON.stringify(window), query.visibleAt, query.inputRevision],
  );
  if (result.rows.length !== 1 || !result.rows[0]?.bundle) throw runtimeUnavailable();
  const bundle = decodeNormalizedMetricSourceBundle(result.rows[0].bundle);
  if (
    !isDeepStrictEqual(bundle.binding, query.binding) ||
    !sameEventPeriod(bundle.window, query.window) ||
    Date.parse(bundle.visibleAt) !== Date.parse(query.visibleAt) ||
    bundle.inputRevision !== query.inputRevision ||
    Date.parse(bundle.businessNow) < Date.parse(query.visibleAt)
  )
    throw runtimeUnavailable();
  return bundle;
}
function snapshot(
  rows: readonly StoredMetricSnapshot[],
  kind: (typeof STOCKOUT_METRIC_KINDS)[number],
): MetricSnapshotV1 {
  const matched = rows.filter((row) => row.snapshot.metric.kind === kind);
  if (matched.length !== 1) throw runtimeUnavailable();
  return matched[0]!.snapshot;
}
function references(rows: readonly StoredMetricSnapshot[]) {
  return rows.map(({ id, inputHash, snapshot: row }) =>
    EventSourceReferenceSchema.parse({
      kind: "METRIC_SNAPSHOT",
      id,
      version: row.inputRevision,
      hash: inputHash,
      binding: row.binding,
      definitionVersion: row.definitionVersion,
      period: {
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        timezone: row.timezone,
        currency: row.currency,
      },
      observedAt: row.visibleAt,
      measure: { kind: row.metric.kind, unit: row.metric.unit },
    }),
  );
}
function inventoryFact(frame: Omit<PersistedRuntimeFrame, "evidence">) {
  const facts = frame.bundle.inventory.filter(
    (row) => row.data.externalSkuId === frame.observation.externalSkuId,
  );
  if (facts.length !== 1) return null;
  const metric = snapshot(frame.rows, "INVENTORY_AVAILABLE");
  const fact = facts[0]!;
  if (
    metric.status === "VERIFIED" &&
    (fact.data.available !== metric.metric.value ||
      Date.parse(fact.observedAt) > Date.parse(frame.observation.observedAt))
  )
    throw runtimeUnavailable();
  return fact;
}
function stockoutFacts(frame: Omit<PersistedRuntimeFrame, "evidence">) {
  const inventory = snapshot(frame.rows, "INVENTORY_AVAILABLE");
  const fact = inventoryFact(frame);
  const observedAt = fact?.data.source.updatedAt ?? null;
  return {
    availableUnits: inventory.metric.value,
    salesUnits: null,
    salesWindow: frame.observation.window,
    salesWindowHours:
      (Date.parse(frame.observation.window.periodEnd) -
        Date.parse(frame.observation.window.periodStart)) /
      3600000,
    estimatedHoursRemaining: null,
    supplierLeadTimeHours: null,
    safetyBufferHours: null,
    inboundETA: null,
    inventoryObservedAt: observedAt,
    inventoryAgeSeconds:
      observedAt === null
        ? null
        : (Date.parse(frame.observation.observedAt) - Date.parse(observedAt)) / 1000,
    inventoryStatus: inventory.status,
  };
}
function evidence(frame: Omit<PersistedRuntimeFrame, "evidence">): EventEvidenceV1 {
  const inventory = snapshot(frame.rows, "INVENTORY_AVAILABLE");
  return EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding: frame.observation.binding,
    ...frame.observation.window,
    observedAt: frame.observation.observedAt,
    sourceWatermark: frame.bundle.sourceWatermark,
    dataStatus: inventory.status === "VERIFIED" ? "INSUFFICIENT" : inventory.status,
    sampleSize: inventory.sampleSize,
    coverageBasisPoints: inventory.coverageBasisPoints,
    issues: [
      ...frame.rows.flatMap((row) => row.snapshot.issues),
      { code: "PAYMENT_UNKNOWN", field: "facts.salesUnits", evidenceIds: frame.bundle.evidenceIds },
      {
        code: "LEAD_TIME_MISSING",
        field: "facts.supplierLeadTimeHours",
        evidenceIds: frame.bundle.evidenceIds,
      },
    ],
    definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: references(frame.rows),
    eventType: "STOCKOUT_RISK",
    entity: { kind: "SKU", externalSkuId: frame.observation.externalSkuId },
    facts: stockoutFacts(frame),
  });
}
@Injectable()
export class EventRuntimeSource {
  constructor(
    private readonly metrics: MetricRuntimeService,
    private readonly uow: EventDecisionUnitOfWork,
  ) {}
  private query(observation: RuntimeObservation, revision: string | null): MetricSnapshotQuery {
    return {
      binding: observation.binding,
      window: observation.window,
      visibleAt: observation.observedAt,
      definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
      inputRevision: revision,
      subject: { kind: "SKU", externalSkuId: observation.externalSkuId },
      kinds: [...STOCKOUT_METRIC_KINDS],
    };
  }
  private async observedSnapshots(
    observation: RuntimeObservation,
  ): Promise<readonly MetricSnapshotV1[]> {
    const prior = await this.metrics.read({
      actor: observation.actor,
      query: this.query(observation, null),
    });
    if (!prior.ok) throw runtimeUnavailable();
    const exact = prior.value.filter(
      (row) => Date.parse(row.visibleAt) === Date.parse(observation.observedAt),
    );
    if (exact.length === 0) return this.compute(observation);
    if (
      exact.length !== STOCKOUT_METRIC_KINDS.length ||
      new Set(exact.map((row) => row.inputRevision)).size !== 1
    )
      throw runtimeUnavailable();
    return exact;
  }
  private async compute(observation: RuntimeObservation) {
    const bundle = await this.captureCurrent(observation);
    const subject = { kind: "SKU" as const, externalSkuId: observation.externalSkuId };
    const computed = await this.metrics.compute({
      actor: observation.actor,
      computedAt: observation.observedAt,
      query: {
        binding: observation.binding,
        window: observation.window,
        visibleAt: observation.observedAt,
        definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
        inputRevision: bundle.inputRevision,
        coverageRequests: STOCKOUT_METRIC_KINDS.map((kind) => ({ kind, subject })),
      },
    });
    if (!computed.ok || computed.value.length !== STOCKOUT_METRIC_KINDS.length)
      throw runtimeUnavailable();
    return computed.value;
  }
  private captureCurrent(observation: RuntimeObservation): Promise<NormalizedMetricSourceBundle> {
    if (!["OWNER", "ADMIN"].includes(observation.actor.role)) throw runtimeUnavailable();
    return this.uow.transaction(
      {
        actor: observation.actor,
        binding: observation.binding,
        generation: null,
        revisions: [],
        recipientId: null,
        writable: true,
        control: runtimeControl(),
      },
      async (scope) => {
        const sql = "SELECT public.metric_source_capture($1,$2,$3) AS bundle";
        const values = [
          JSON.stringify(observation.binding),
          JSON.stringify(observation.window),
          observation.observedAt,
        ];
        let result = await scope.client.query(sql, values);
        if (!result.rows[0]?.bundle) result = await scope.client.query(sql, values);
        if (result.rows.length !== 1 || !result.rows[0]?.bundle) throw runtimeUnavailable();
        const bundle = decodeNormalizedMetricSourceBundle(result.rows[0].bundle);
        // Only a live capture can authorize first publication; persisted reads remain replayable.
        if (
          !isDeepStrictEqual(bundle.binding, observation.binding) ||
          !sameEventPeriod(bundle.window, observation.window) ||
          Date.parse(bundle.visibleAt) !== Date.parse(observation.observedAt) ||
          Date.parse(bundle.businessNow) !== Date.parse(observation.observedAt)
        )
          throw runtimeUnavailable();
        return bundle;
      },
    );
  }
  async prepare(observation: RuntimeObservation): Promise<PersistedRuntimeFrame> {
    observation = {
      ...observation,
      observedAt: new Date(observation.observedAt).toISOString(),
      window: {
        ...observation.window,
        periodStart: new Date(observation.window.periodStart).toISOString(),
        periodEnd: new Date(observation.window.periodEnd).toISOString(),
      },
    };
    const computed = await this.observedSnapshots(observation);
    const revision = computed[0]!.inputRevision;
    const query = this.query(observation, revision);
    const history = await this.metrics.history({
      actor: observation.actor,
      query,
      limit: 100,
      cursor: null,
    });
    if (
      !history.ok ||
      history.value.nextCursor !== null ||
      history.value.items.length !== computed.length
    )
      throw runtimeUnavailable();
    this.matchRows(history.value.items, computed, observation);
    const bundle = await this.uow.read(observation.actor, observation.binding, (scope) =>
      readRuntimeBundle(scope, query),
    );
    const frame = { observation, bundle, rows: history.value.items };
    return { ...frame, evidence: evidence(frame) };
  }
  private matchRows(
    rows: readonly StoredMetricSnapshot[],
    computed: readonly MetricSnapshotV1[],
    observation: RuntimeObservation,
  ): void {
    for (const row of rows) {
      const matches = computed.filter((item) => item.metric.kind === row.snapshot.metric.kind);
      if (
        matches.length !== 1 ||
        !isDeepStrictEqual(matches[0], row.snapshot) ||
        Date.parse(row.snapshot.visibleAt) !== Date.parse(observation.observedAt) ||
        Date.parse(row.snapshot.computedAt) !== Date.parse(observation.observedAt) ||
        row.snapshot.sourceWatermark === null
      )
        throw runtimeUnavailable();
    }
  }
}
