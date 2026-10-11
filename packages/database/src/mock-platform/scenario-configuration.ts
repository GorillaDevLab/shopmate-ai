import { exact, integer, object } from "./validation.js";
const planKeys = [
  "version",
  "scenarioId",
  "externalStoreId",
  "startDay",
  "endDay",
  "mutations",
  "campaignSpendBps",
  "campaignConversionBps",
  "delivery",
];
const ranges = {
  skuIndex: [0, 299],
  retainDemandBps: [0, 10000],
  priceBps: [1000, 30000],
  discountBps: [0, 9000],
  refundBps: [0, 10000],
  cancelBps: [0, 10000],
  restockBps: [0, 100000],
  launchRampDays: [0, 14],
  restockDelayDays: [0, 5],
} as const;
function validDelivery(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "NORMAL") return exact(value, ["kind"]);
  if (value.kind === "INTERRUPT")
    return exact(value, ["kind", "durationMs"]) && integer(value.durationMs, 1, 86400000);
  return (
    value.kind === "REPLAY_SAVED_PAGE" &&
    exact(value, ["kind", "repetitions"]) &&
    integer(value.repetitions, 1, 3)
  );
}
export function validScenario(config: Record<string, unknown>): boolean {
  const plan = config.scenarioPlan,
    binding = config.binding as Record<string, unknown>;
  if (!exact(plan, planKeys) || !Array.isArray(plan.mutations) || plan.mutations.length > 3)
    return false;
  return (
    plan.version === "mock-scenario-v1" &&
    typeof plan.scenarioId === "string" &&
    /^SCENARIO_00[1-9]$|^SCENARIO_01[0-5]$/u.test(plan.scenarioId) &&
    plan.externalStoreId === binding.externalStoreId &&
    integer(plan.startDay, 0, 364) &&
    integer(plan.endDay, 1, config.days as number) &&
    plan.startDay < plan.endDay &&
    integer(plan.campaignSpendBps, 1000, 100000) &&
    integer(plan.campaignConversionBps, 0, 10000) &&
    validDelivery(plan.delivery) &&
    new Set(plan.mutations.map((m: unknown) => (object(m) ? m.skuIndex : null))).size ===
      plan.mutations.length &&
    plan.mutations.every(
      (m: unknown) =>
        exact(m, Object.keys(ranges)) &&
        Object.entries(ranges).every(([key, [min, max]]) => integer(m[key], min, max)) &&
        (m.skuIndex as number) <
          (config.productCount as number) * (config.variantsPerProduct as number),
    )
  );
}
/** SQL JSONB field order is arbitrary; hash only the approved closed schema order. */
export function canonicalScenario(input: unknown): Record<string, unknown> {
  const plan = input as Record<string, unknown>,
    delivery = plan.delivery as Record<string, unknown>;
  const ordered = Object.fromEntries(planKeys.map((key) => [key, plan[key]]));
  ordered.mutations = (plan.mutations as Record<string, unknown>[]).map((m) =>
    Object.fromEntries(Object.keys(ranges).map((key) => [key, m[key]])),
  );
  ordered.delivery =
    delivery.kind === "NORMAL"
      ? { kind: delivery.kind }
      : delivery.kind === "INTERRUPT"
        ? { kind: delivery.kind, durationMs: delivery.durationMs }
        : { kind: delivery.kind, repetitions: delivery.repetitions };
  return ordered;
}
