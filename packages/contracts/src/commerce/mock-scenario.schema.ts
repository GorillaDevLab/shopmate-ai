import { z } from "zod";
export const MockScenarioIdSchema = z.enum([
  "SCENARIO_001",
  "SCENARIO_002",
  "SCENARIO_003",
  "SCENARIO_004",
  "SCENARIO_005",
  "SCENARIO_006",
  "SCENARIO_007",
  "SCENARIO_008",
  "SCENARIO_009",
  "SCENARIO_010",
  "SCENARIO_011",
  "SCENARIO_012",
  "SCENARIO_013",
  "SCENARIO_014",
  "SCENARIO_015",
]);
export const MockScenarioMutationSchema = z.strictObject({
  skuIndex: z.number().int().min(0).max(299),
  retainDemandBps: z.number().int().min(0).max(10000),
  priceBps: z.number().int().min(1000).max(30000),
  discountBps: z.number().int().min(0).max(9000),
  refundBps: z.number().int().min(0).max(10000),
  cancelBps: z.number().int().min(0).max(10000),
  restockBps: z.number().int().min(0).max(100000),
  launchRampDays: z.number().int().min(0).max(14),
  restockDelayDays: z.number().int().min(0).max(5),
});
export const MockScenarioPlanSchema = z
  .strictObject({
    version: z.literal("mock-scenario-v1"),
    scenarioId: MockScenarioIdSchema,
    externalStoreId: z.string().min(1).max(200),
    startDay: z.number().int().min(0).max(364),
    endDay: z.number().int().min(1).max(365),
    mutations: z.array(MockScenarioMutationSchema).max(3),
    campaignSpendBps: z.number().int().min(1000).max(100000),
    campaignConversionBps: z.number().int().min(0).max(10000),
    delivery: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("NORMAL") }),
      z.strictObject({
        kind: z.literal("INTERRUPT"),
        durationMs: z.number().int().min(1).max(86400000),
      }),
      z.strictObject({
        kind: z.literal("REPLAY_SAVED_PAGE"),
        repetitions: z.number().int().min(1).max(3),
      }),
    ]),
  })
  .refine(
    (plan) =>
      plan.startDay < plan.endDay &&
      new Set(plan.mutations.map((m) => m.skuIndex)).size === plan.mutations.length,
  );
export type MockScenarioPlan = z.infer<typeof MockScenarioPlanSchema>;
export type MockScenarioMutation = z.infer<typeof MockScenarioMutationSchema>;
