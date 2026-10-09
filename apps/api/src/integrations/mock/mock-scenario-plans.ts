import { MockScenarioIdSchema, MockScenarioPlanSchema, type MockScenarioMutation, type MockScenarioPlan } from "@shopmate/contracts";
import { MockConfigSchema, type MockConfig } from "./mock-config.js";
import { owned } from "./mock-causal-state.js";
const neutral: MockScenarioMutation = {
  skuIndex: 0, retainDemandBps: 10000, priceBps: 10000, discountBps: 500,
  refundBps: 400, cancelBps: 1200, restockBps: 10000, restockDelayDays: 0,
};
function mutations(id: string, baselineRefund: number): MockScenarioMutation[] {
  const base = { ...neutral, refundBps: baselineRefund };
  const change = (values: Partial<MockScenarioMutation>) => ({ ...base, ...values });
  switch (id) {
    case "SCENARIO_001": return [change({ restockBps: 0 })];
    case "SCENARIO_002": return [change({ refundBps: 8000 })];
    case "SCENARIO_003": return [change({ discountBps: 7000 })];
    case "SCENARIO_005": return [change({ priceBps: 15000, retainDemandBps: 3500 })];
    case "SCENARIO_006": return [change({ retainDemandBps: 500, restockBps: 100000 })];
    case "SCENARIO_007": return [change({ restockDelayDays: 5 })];
    case "SCENARIO_008": return [change({ skuIndex: 1, retainDemandBps: 10000, restockBps: 100000 })];
    case "SCENARIO_011": return [change({ discountBps: 8500 })];
    case "SCENARIO_012": return [change({ cancelBps: 9000 })];
    case "SCENARIO_015": return [change({ restockBps: 0 }), change({ skuIndex: 1, refundBps: 8500 }), change({ skuIndex: 2, discountBps: 8500 })];
    default: return [];
  }
}
/** Frozen causal inputs only; delivery policies require a future adapter to execute. */
export function createScenarioPlan(input: unknown, idInput: unknown, startDay: number, endDay: number): MockScenarioPlan {
  const config = MockConfigSchema.parse(input), scenarioId = MockScenarioIdSchema.parse(idInput);
  const advertising = ["SCENARIO_003", "SCENARIO_004", "SCENARIO_015"].includes(scenarioId);
  const plan = MockScenarioPlanSchema.parse({
    version: "mock-scenario-v1", scenarioId, externalStoreId: config.binding.externalStoreId,
    startDay, endDay, mutations: mutations(scenarioId, config.refundBps),
    campaignSpendBps: advertising ? 50000 : 10000,
    campaignConversionBps: scenarioId === "SCENARIO_004" ? 1000 : 10000,
    delivery: scenarioId === "SCENARIO_009" ? { kind: "INTERRUPT", durationMs: 3600000 }
      : scenarioId === "SCENARIO_010" ? { kind: "REPLAY_SAVED_PAGE", repetitions: 1 } : { kind: "NORMAL" },
  });
  if (endDay > config.days || plan.mutations.some((m) => m.skuIndex >= config.productCount * config.variantsPerProduct))
    throw new RangeError("Scenario exceeds frozen commerce scope");
  return owned(plan);
}
export function scenarioAt(config: MockConfig, at: number): MockScenarioPlan | undefined {
  const plan = config.scenarioPlan;
  const day = (at - Date.parse(config.historyStart)) / 86400000;
  return plan && day >= plan.startDay && day < plan.endDay ? plan : undefined;
}
