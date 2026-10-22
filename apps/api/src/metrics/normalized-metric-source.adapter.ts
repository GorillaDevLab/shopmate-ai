import {
  MetricInputV1Schema,
  type MetricCoverageRequest,
  type MetricCoverageV1,
  type MetricInputV1,
  type MetricResult,
  type MetricSourceQuery,
  type MetricSourceReader,
} from "@shopmate/contracts";
import type {
  MetricSourceBundleRepository,
  MetricSourcePrefix,
  NormalizedMetricFact,
  NormalizedMetricSourceBundle,
} from "@shopmate/database";
import {
  freezeNormalized,
  normalizedBundleProofValid,
  normalizedContextMismatch,
  normalizedFailure,
  normalizedSourceBundleSchema,
  normalizedSourceQuerySchema,
  normalizedSourceResultSchema,
  normalizedStreamPrefixes,
} from "./normalized-metric-source.validation.js";

function context(bundle: NormalizedMetricSourceBundle, query: MetricSourceQuery) {
  return {
    schemaVersion: 1 as const,
    binding: query.binding,
    ...query.window,
    visibleAt: query.visibleAt,
    definitionVersion: query.definitionVersion,
    inputRevision: bundle.inputRevision,
    sourceWatermark: bundle.sourceWatermark,
    evidenceIds: bundle.evidenceIds,
  };
}
function mappedFact<T extends { readonly source: { readonly version: string | null } }>(
  fact: NormalizedMetricFact<T>,
  bundle: NormalizedMetricSourceBundle,
) {
  return {
    data: fact.data,
    binding: bundle.binding,
    observedAt: fact.observedAt,
    sourceVersion: fact.data.source.version ?? `p2-record:${fact.sourcePayloadHash}`,
    evidenceIds: bundle.evidenceIds,
  };
}
function dependencies(request: MetricCoverageRequest): readonly MetricSourcePrefix["stream"][] {
  if (request.subject.kind === "CAMPAIGN") return [];
  if (["GMV", "PAID_REVENUE", "PAID_ORDERS", "PAID_UNITS", "AOV"].includes(request.kind))
    return ["ORDERS"];
  if (
    [
      "REFUND_SETTLED_AMOUNT",
      "NET_REVENUE_SETTLEMENT",
      "REFUNDED_COHORT_ORDERS",
      "REFUND_COHORT_ORDER_RATE",
      "REFUND_COHORT_AMOUNT_RATE",
    ].includes(request.kind)
  )
    return ["ORDERS", "REFUNDS"];
  return request.kind === "INVENTORY_AVAILABLE" && request.subject.kind === "SKU"
    ? ["INVENTORY"]
    : [];
}
function coverage(
  bundle: NormalizedMetricSourceBundle,
  query: MetricSourceQuery,
): readonly MetricCoverageV1[] {
  const collections = {
    ORDERS: "paymentFacts",
    REFUNDS: "refundFacts",
    INVENTORY: "inventoryFacts",
    MARKETING: "campaignFacts",
  } as const;
  return query.coverageRequests.flatMap((request) => {
    const streams = dependencies(request);
    if (!streams.length) return [];
    const proofs = streams.flatMap((stream) => normalizedStreamPrefixes(bundle, stream));
    const observedAt = new Date(
      Math.max(...proofs.map((item) => Date.parse(item.proof.observedAt))),
    ).toISOString();
    if (Date.parse(observedAt) < Date.parse(query.window.periodEnd)) return [];
    return [
      {
        ...context(bundle, query),
        ...request,
        observedAt,
        sourceVersion: bundle.inputRevision,
        collections: streams.map((stream) => collections[stream]),
        coverageBasisPoints: 10000,
      },
    ];
  });
}
function mapBundle(
  bundle: NormalizedMetricSourceBundle,
  query: MetricSourceQuery,
): MetricResult<MetricInputV1> {
  const parsed = MetricInputV1Schema.safeParse({
    ...context(bundle, query),
    status: "ESTIMATED",
    paymentFacts: bundle.orders.map((fact) => mappedFact(fact, bundle)),
    refundFacts: bundle.refunds.map((fact) => mappedFact(fact, bundle)),
    inventoryFacts: bundle.inventory.map((fact) => mappedFact(fact, bundle)),
    campaignFacts: bundle.campaigns.map((fact) => ({
      ...mappedFact(fact, bundle),
      measuredCoverage: null,
    })),
    frozenCosts: null,
    refundAllocations: null,
    returnReceipts: null,
    fees: null,
    traffic: null,
    inventoryExtensions: null,
    metricCoverage: coverage(bundle, query),
  });
  return parsed.success
    ? { ok: true, value: freezeNormalized(parsed.data) }
    : normalizedFailure("INVALID_INPUT");
}
function decode(value: unknown, query: MetricSourceQuery): MetricResult<MetricInputV1> {
  const envelope = normalizedSourceResultSchema.safeParse(value);
  if (!envelope.success) return normalizedFailure("INVALID_INPUT");
  if (!envelope.data.ok) return freezeNormalized(envelope.data);
  const parsed = normalizedSourceBundleSchema.safeParse(envelope.data.value);
  if (!parsed.success) return normalizedFailure("INVALID_INPUT");
  const mismatch = normalizedContextMismatch(parsed.data, query);
  if (mismatch) return normalizedFailure(mismatch);
  if (!normalizedBundleProofValid(parsed.data)) return normalizedFailure("INVALID_INPUT");
  return mapBundle(parsed.data, query);
}

export function createNormalizedMetricSourceAdapter(
  repository: Pick<MetricSourceBundleRepository, "read">,
): MetricSourceReader {
  const read = repository.read.bind(repository);
  return freezeNormalized({
    read: async (query: MetricSourceQuery) => {
      const parsed = normalizedSourceQuerySchema.safeParse(query);
      if (!parsed.success) return normalizedFailure<MetricInputV1>("INVALID_INPUT");
      try {
        const { binding, window, visibleAt, inputRevision } = parsed.data;
        return decode(await read({ binding, window, visibleAt, inputRevision }), parsed.data);
      } catch {
        return normalizedFailure<MetricInputV1>("SOURCE_UNAVAILABLE");
      }
    },
  });
}
