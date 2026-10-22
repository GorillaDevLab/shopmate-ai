import { z } from "zod";
import {
  MetricComputationV1Schema,
  MetricInputV1Schema,
  MetricSubjectSchema,
  MetricTimestampSchema,
  MetricValueSchema,
  type MetricBusinessClock,
  type MetricCalculator,
  type MetricCalculationRequest,
  type MetricComputationV1,
  type MetricKind,
  type MetricLeafPorts,
  type MetricMeasure,
  type MetricQuality,
  type MetricResult,
  type MetricSubject,
} from "@shopmate/contracts";
import { createPaymentMetricCalculator } from "./payment-metrics.js";
import { createRefundMetricCalculator } from "./refund-metrics.js";
import { ACCEPTED_RESELLABLE_FROZEN_V1, createFrozenCostCalculator } from "./frozen-cost.js";
import { createContributionCalculator } from "./contribution-metrics.js";
import { createInventoryCoverageCalculator } from "./inventory-metrics.js";
import { createFunnelMarketingCalculator } from "./funnel-marketing-metrics.js";
import { createMetricQualityReducer } from "./metric-quality.js";
import { createMetricWindowResolver } from "./metric-window.js";
import { exactMinorMath } from "./exact-math.js";
import {
  METRIC_RUNTIME_DEFINITION_VERSION,
  METRIC_RUNTIME_ROUTES,
  METRIC_RUNTIME_QUALITY_POLICY,
  METRIC_RUNTIME_INVENTORY_POLICY,
  freezeRuntime,
} from "./metric-runtime-policy.js";
import {
  checkedRuntime,
  rejectRuntime,
  RuntimeMetricRejected,
  runtimeWindow,
  runtimeBuyerShipping,
  runtimeSkuSales,
  runtimeDependencyInput,
  unavailableRuntime,
} from "./metric-runtime-facts.js";

export {
  METRIC_RUNTIME_DEFINITION_VERSION,
  METRIC_RUNTIME_DEFINITION_MANIFEST,
  METRIC_RUNTIME_DEFINITION_HASH,
} from "./metric-runtime-policy.js";
type Ports = Omit<MetricLeafPorts, "profitDelta">;
type Measure = MetricMeasure<MetricKind>;
const requestSchema = z.strictObject({
  input: MetricInputV1Schema,
  kind: z.union(MetricValueSchema.options.map((option) => option.unwrap().shape.kind)),
  subject: MetricSubjectSchema,
  computedAt: MetricTimestampSchema,
});
function precise(value: unknown): boolean {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value))
    return !/[1-9]/.test((/\.(\d+)/.exec(value)?.[1] ?? "").slice(3));
  return value === null || typeof value !== "object" || Object.values(value).every(precise);
}
function supported(kind: MetricKind, subject: MetricSubject): boolean {
  const route = METRIC_RUNTIME_ROUTES[kind];
  if (route === "inventory") return subject.kind === "SKU";
  if (kind === "ROAS") return subject.kind === "STORE" || subject.kind === "CAMPAIGN";
  return subject.kind === "STORE";
}
function validate(
  raw: MetricCalculationRequest,
  clock: MetricBusinessClock,
): MetricCalculationRequest {
  const parsed = requestSchema.safeParse(raw);
  const time = z
    .strictObject({ now: MetricTimestampSchema, revision: z.number().int().nonnegative().safe() })
    .safeParse(clock.snapshot());
  if (!parsed.success || !time.success || !precise(parsed.data) || !precise(time.data))
    rejectRuntime("INVALID_INPUT");
  const request = parsed.data;
  if (request.input.definitionVersion !== METRIC_RUNTIME_DEFINITION_VERSION)
    rejectRuntime("VERSION_MISMATCH", request.input.evidenceIds);
  if (!supported(request.kind, request.subject))
    rejectRuntime("SCOPE_MISMATCH", request.input.evidenceIds);
  if (
    Date.parse(request.computedAt) < Date.parse(request.input.visibleAt) ||
    Date.parse(request.input.visibleAt) > Date.parse(time.data.now)
  )
    rejectRuntime("WINDOW_MISMATCH", request.input.evidenceIds);
  return request;
}
function pick(kind: MetricKind, rows: readonly Measure[]): Measure {
  const row = rows.find((measure) => measure.metric.kind === kind);
  if (!row) rejectRuntime("INVALID_INPUT");
  return row;
}
function inventory(request: MetricCalculationRequest, ports: Ports): Measure {
  const { input, subject, kind } = request;
  if (subject.kind !== "SKU") rejectRuntime("SCOPE_MISMATCH");
  const locations = new Set(
    [
      ...(input.inventoryFacts ?? []).map((row) => row.data),
      ...(input.inventoryExtensions ?? []).map((row) => row.data),
    ]
      .filter((data) => data?.externalSkuId === subject.externalSkuId)
      .map((data) => data!.externalLocationId),
  );
  if (locations.size !== 1) return unavailableRuntime(kind, input, "inventoryFacts.location");
  const salesInput = runtimeDependencyInput(
    request,
    kind === "INVENTORY_HOURS_REMAINING"
      ? [{ kind: "PAID_UNITS", collections: ["paymentFacts"] }]
      : [],
  );
  const payments = checkedRuntime(ports.payments.calculate(salesInput));
  const result = checkedRuntime(
    ports.inventory.calculate({
      input,
      externalSkuId: subject.externalSkuId,
      externalLocationId: [...locations][0]!,
      salesWindow: runtimeWindow(input),
      soldUnits: runtimeSkuSales(input, subject.externalSkuId, payments.paidUnits.quality),
      policy: METRIC_RUNTIME_INVENTORY_POLICY,
    }),
  );
  return pick(kind, [result.available, result.hoursRemaining, result.leadTimeHours]);
}
function finance(request: MetricCalculationRequest, ports: Ports): Measure {
  const { input, kind } = request;
  const route = METRIC_RUNTIME_ROUTES[kind];
  if (route === "payments")
    return pick(kind, Object.values(checkedRuntime(ports.payments.calculate(input))));
  if (route === "refunds") {
    const result = checkedRuntime(
      ports.refunds.calculate({ input, paymentCohort: runtimeWindow(input), maturityHours: 24 }),
    );
    return pick(kind, [
      result.settledRefund,
      result.netRevenueSettlement,
      result.refundedCohortOrders,
      result.cohortOrderRate,
      result.cohortAmountRate,
    ]);
  }
  const costInput = route === "contribution" ? contributionDependencyInput(request) : input;
  const costs = checkedRuntime(
    ports.frozenCosts.calculate(costInput, ACCEPTED_RESELLABLE_FROZEN_V1),
  );
  if (route === "costs")
    return pick(kind, [costs.netMerchandiseRevenue, costs.cogs, costs.grossProfit]);
  const result = checkedRuntime(
    ports.contribution.calculate({
      input,
      frozenCosts: costs,
      netBuyerShipping: runtimeBuyerShipping(input, costs.netMerchandiseRevenue.quality),
    }),
  );
  return pick(kind, [result.contribution, result.estimatedNetProfit]);
}
function contributionDependencyInput(request: MetricCalculationRequest) {
  const net = ["paymentFacts", "refundFacts", "refundAllocations"] as const;
  const cost = [...net, "frozenCosts", "returnReceipts"] as const;
  return runtimeDependencyInput(request, [
    { kind: "NET_MERCHANDISE_REVENUE", collections: net },
    { kind: "COGS", collections: cost },
    { kind: "GROSS_PROFIT", collections: cost },
  ]);
}
function dispatch(request: MetricCalculationRequest, ports: Ports): Measure {
  const { input, kind, subject } = request;
  const route = METRIC_RUNTIME_ROUTES[kind];
  if (route === "baseline") return unavailableRuntime(kind, input, "baseline");
  if (route === "inventory") return inventory(request, ports);
  if (route === "funnel")
    return pick(
      kind,
      Object.values(checkedRuntime(ports.funnelMarketing.calculate(input, subject))).map(
        (row) => row.measure,
      ),
    );
  return finance(request, ports);
}
function observedRuntimeAt(request: MetricCalculationRequest): string | null {
  const { input, kind, subject } = request;
  const proofs = input.metricCoverage.filter(
    (row) => row.kind === kind && JSON.stringify(row.subject) === JSON.stringify(subject),
  );
  return (
    proofs
      .map((row) => row.observedAt)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(0) ?? null
  );
}
function reduce(request: MetricCalculationRequest, leaf: Measure, ports: Ports): MetricQuality {
  const { input, kind } = request;
  const quality = leaf.quality;
  const issues =
    input.status === "UNAVAILABLE"
      ? [
          ...quality.issues,
          { code: "NOT_SYNCHRONIZED" as const, field: "input", evidenceIds: input.evidenceIds },
        ]
      : quality.issues;
  return ports.quality.reduce({
    kind,
    window: runtimeWindow(input),
    visibleAt: input.visibleAt,
    policy: METRIC_RUNTIME_QUALITY_POLICY,
    dependencies: [
      {
        field: "leaf",
        ...quality,
        issues,
        status: input.status === "UNAVAILABLE" ? "UNAVAILABLE" : quality.status,
        sourceWatermark: input.sourceWatermark,
        observedAt: observedRuntimeAt(request),
        // Counts project the leaf's observed sample; completeness remains bounded by leaf coverage.
        knownCount: quality.sampleSize,
        expectedCount: quality.sampleSize,
      },
    ],
  });
}
function assemble(
  request: MetricCalculationRequest,
  leaf: Measure,
  ports: Ports,
): MetricComputationV1 {
  const { input, subject, computedAt } = request;
  const { schemaVersion, definitionVersion, inputRevision, binding, visibleAt, sourceWatermark } =
    input;
  const quality = reduce(request, leaf, ports);
  const metric = quality.status === "UNAVAILABLE" ? { ...leaf.metric, value: null } : leaf.metric;
  const parsed = MetricComputationV1Schema.safeParse({
    input,
    snapshot: {
      schemaVersion,
      definitionVersion,
      inputRevision,
      binding,
      visibleAt,
      sourceWatermark,
      ...runtimeWindow(input),
      ...quality,
      metric,
      subject,
      computedAt,
    },
  });
  if (!parsed.success) rejectRuntime("INVALID_INPUT", input.evidenceIds);
  return freezeRuntime(parsed.data);
}
function calculate(raw: MetricCalculationRequest, ports: Ports): MetricResult<MetricComputationV1> {
  try {
    const request = validate(raw, ports.clock);
    return freezeRuntime({ ok: true, value: assemble(request, dispatch(request, ports), ports) });
  } catch (error) {
    if (error instanceof RuntimeMetricRejected)
      return freezeRuntime({ ok: false, error: error.detail });
    if (error instanceof TypeError)
      return freezeRuntime({ ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } });
    throw error;
  }
}
/** Supply the authoritative captured business clock; no registry, source fetch or persistence occurs. */
export function createMetricRuntimeCalculator({
  clock,
}: Readonly<{ clock: MetricBusinessClock }>): MetricCalculator {
  const windows = createMetricWindowResolver(clock),
    math = exactMinorMath;
  const rounding = "HALF_AWAY_FROM_ZERO";
  const refunds = createRefundMetricCalculator({ math, windows, rounding });
  const ports: Ports = {
    clock,
    windows,
    math,
    refunds,
    payments: createPaymentMetricCalculator({ math, windows, rounding }),
    frozenCosts: createFrozenCostCalculator({ math, refunds, rounding }),
    contribution: createContributionCalculator({ math, rounding }),
    inventory: createInventoryCoverageCalculator({ math, clock }),
    funnelMarketing: createFunnelMarketingCalculator({ math, rounding }),
    quality: createMetricQualityReducer(),
  };
  return Object.freeze({
    calculate: (request: MetricCalculationRequest) => calculate(request, ports),
  });
}
