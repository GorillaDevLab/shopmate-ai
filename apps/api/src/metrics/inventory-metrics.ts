import type {
  DataQualityIssueV1,
  ExactMinorMath,
  InventoryCoverageCalculator,
  InventoryCoverageMetrics,
  InventoryCoverageRequest,
  MetricBusinessClock,
  MetricMeasure,
  MetricQuality,
  MetricStatus,
} from "@shopmate/contracts";

type Dependencies = Readonly<{ math: ExactMinorMath; clock: MetricBusinessClock }>;
type Kind = "INVENTORY_AVAILABLE" | "INVENTORY_HOURS_REMAINING" | "LEAD_TIME_HOURS";
function quality(request: InventoryCoverageRequest, kind: Kind, missing = false): MetricQuality {
  const input = request.input;
  const stock = input.inventoryFacts?.find(
    ({ data }) =>
      data.externalSkuId === request.externalSkuId &&
      data.externalLocationId === request.externalLocationId,
  );
  const rule = request.policy.rules.find((row) => row.kind === kind)!;
  const stale =
    kind !== "LEAD_TIME_HOURS" &&
    stock?.data.source.updatedAt !== null &&
    stock !== undefined &&
    Date.parse(input.visibleAt) - Date.parse(stock.data.source.updatedAt!) >
      rule.maximumAgeHours * 3600000;
  const issues: DataQualityIssueV1[] = [];
  if (missing)
    issues.push({
      code: kind === "LEAD_TIME_HOURS" ? "LEAD_TIME_MISSING" : "ZERO_DENOMINATOR",
      field: kind,
      evidenceIds: [...input.evidenceIds],
    });
  if (stale)
    issues.push({
      code: "STALE_SOURCE",
      field: "inventoryFacts.source.updatedAt",
      evidenceIds: [...stock!.evidenceIds],
    });
  const status: MetricStatus = missing ? "UNAVAILABLE" : stale ? "STALE" : "VERIFIED";
  return {
    status,
    issues,
    evidenceIds: [...input.evidenceIds],
    sampleSize: kind === "INVENTORY_HOURS_REMAINING" ? request.soldUnits.quality.sampleSize : 1,
    coverageBasisPoints: 10000,
  };
}
function measure<K extends Kind>(
  request: InventoryCoverageRequest,
  kind: K,
  value: number | null,
): MetricMeasure<K> {
  return {
    metric: {
      kind,
      unit: kind === "INVENTORY_AVAILABLE" ? "units" : "hours",
      value,
    } as MetricMeasure<K>["metric"],
    quality: quality(request, kind, value === null),
  };
}
function calculate(
  request: InventoryCoverageRequest,
  dependencies: Dependencies,
): InventoryCoverageMetrics {
  dependencies.clock.snapshot();
  const stock = request.input.inventoryFacts?.find(
    ({ data }) =>
      data.externalSkuId === request.externalSkuId &&
      data.externalLocationId === request.externalLocationId,
  );
  const ext = request.input.inventoryExtensions?.find(
    ({ data }) =>
      data?.externalSkuId === request.externalSkuId &&
      data.externalLocationId === request.externalLocationId,
  )?.data;
  const available = stock?.data.available ?? null;
  const soldUnits = request.soldUnits.metric.value;
  const salesWindowHours =
    (Date.parse(request.salesWindow.periodEnd) - Date.parse(request.salesWindow.periodStart)) /
    3600000;
  const salesUnitsPerHour = soldUnits === null ? null : soldUnits / salesWindowHours;
  const hours =
    available === null || !soldUnits ? null : (available / soldUnits) * salesWindowHours;
  const lead = ext?.leadTimeHours ?? null;
  const buffer = ext?.safetyBufferHours ?? null;
  return {
    available: measure(request, "INVENTORY_AVAILABLE", available),
    soldUnits,
    salesWindowHours,
    salesUnitsPerHour,
    hoursRemaining: measure(request, "INVENTORY_HOURS_REMAINING", hours),
    daysRemaining: hours === null ? null : hours / 24,
    leadTimeHours: measure(request, "LEAD_TIME_HOURS", lead),
    safetyBufferHours: buffer,
    eta: ext?.eta ?? null,
    belowLeadTimeWithBuffer:
      hours === null || lead === null || buffer === null ? null : hours < lead + buffer,
  };
}
export function createInventoryCoverageCalculator(
  dependencies: Dependencies,
): InventoryCoverageCalculator {
  return Object.freeze({
    calculate: (request: InventoryCoverageRequest) => ({
      ok: true,
      value: calculate(request, dependencies),
    }),
  });
}
