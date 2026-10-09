import {
  MockScenarioIdSchema,
  MockScenarioPlanSchema,
  type MockScenarioMutation,
  type MockScenarioPlan,
} from "@shopmate/contracts";
import { MockConfigSchema, type MockConfig } from "./mock-config.js";
import { owned } from "./mock-causal-state.js";
const neutral: MockScenarioMutation = {
  skuIndex: 0,
  retainDemandBps: 10000,
  priceBps: 10000,
  discountBps: 500,
  refundBps: 400,
  cancelBps: 1200,
  restockBps: 10000,
  launchRampDays: 0,
  restockDelayDays: 0,
};
const mutationPresets: Readonly<Record<string, readonly Partial<MockScenarioMutation>[]>> = {
  SCENARIO_001: [{ restockBps: 0 }],
  SCENARIO_002: [{ refundBps: 8000 }],
  SCENARIO_003: [{ priceBps: 13000, discountBps: 2500 }],
  SCENARIO_005: [{ priceBps: 15000, retainDemandBps: 3500 }],
  SCENARIO_006: [{ retainDemandBps: 500, restockBps: 100000 }],
  SCENARIO_007: [{ restockDelayDays: 5 }],
  SCENARIO_008: [{ restockBps: 100000, launchRampDays: 5 }],
  SCENARIO_011: [{ discountBps: 8500 }],
  SCENARIO_012: [{ cancelBps: 9000 }],
  SCENARIO_015: [
    { restockBps: 0 },
    { skuIndex: 1, refundBps: 8500 },
    { skuIndex: 2, discountBps: 8500 },
  ],
};
function mutations(id: string, baselineRefund: number, variants: number): MockScenarioMutation[] {
  return (mutationPresets[id] ?? []).map((values) => ({
    ...neutral,
    refundBps: baselineRefund,
    ...(id === "SCENARIO_008" ? { skuIndex: variants } : {}),
    ...values,
  }));
}
function delivery(scenarioId: string): MockScenarioPlan["delivery"] {
  if (scenarioId === "SCENARIO_009") return { kind: "INTERRUPT", durationMs: 3600000 };
  if (scenarioId === "SCENARIO_010") return { kind: "REPLAY_SAVED_PAGE", repetitions: 1 };
  return { kind: "NORMAL" };
}
/** Frozen causal inputs only; delivery policies require a future adapter to execute. */
export function createScenarioPlan(
  input: unknown,
  idInput: unknown,
  startDay: number,
  endDay: number,
): MockScenarioPlan {
  const config = MockConfigSchema.parse(input),
    scenarioId = MockScenarioIdSchema.parse(idInput);
  const advertising = ["SCENARIO_003", "SCENARIO_004", "SCENARIO_015"].includes(scenarioId);
  const plan = MockScenarioPlanSchema.parse({
    version: "mock-scenario-v1",
    scenarioId,
    externalStoreId: config.binding.externalStoreId,
    startDay,
    endDay,
    mutations: mutations(scenarioId, config.refundBps, config.variantsPerProduct),
    campaignSpendBps: advertising ? 50000 : 10000,
    campaignConversionBps: scenarioId === "SCENARIO_004" ? 1000 : 10000,
    delivery: delivery(scenarioId),
  });
  if (
    endDay > config.days ||
    plan.mutations.some((m) => m.skuIndex >= config.productCount * config.variantsPerProduct)
  )
    throw new RangeError("Scenario exceeds frozen commerce scope");
  return owned(plan);
}
export function scenarioAt(config: MockConfig, at: number): MockScenarioPlan | undefined {
  const plan = config.scenarioPlan;
  const day = (at - Date.parse(config.historyStart)) / 86400000;
  return plan && day >= plan.startDay && day < plan.endDay ? plan : undefined;
}

/** Build a scenario configuration without changing an existing accepted generation. */
export function createScenarioConfig(
  input: unknown,
  id: unknown,
  startDay?: number,
  endDay?: number,
): MockConfig {
  const baseline = MockConfigSchema.parse(input),
    scenarioId = MockScenarioIdSchema.parse(id);
  const config =
    scenarioId === "SCENARIO_014"
      ? MockConfigSchema.parse({ ...baseline, profile: "new", dailyOrders: 6, growthBps: 0 })
      : baseline;
  const start =
    startDay ?? Math.max(config.profile === "new" ? config.days - 14 : 0, config.days - 28);
  return owned(
    MockConfigSchema.parse({
      ...config,
      scenarioPlan: createScenarioPlan(config, scenarioId, start, endDay ?? config.days),
    }),
  );
}
