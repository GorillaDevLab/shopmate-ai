import {
  ConnectorBindingSchema,
  ConnectorTimestampSchema,
  MockScenarioPlanSchema,
} from "@shopmate/contracts";
import { z } from "zod";

export const DAY_MS = 86_400_000;
export const GENERATOR_VERSION = "mock-source-v1";
export const profileDefaults = Object.freeze({
  growing: Object.freeze({
    dailyOrders: 180,
    growthBps: 8000,
    refundBps: 400,
    adSpendMinor: 30_000,
  }),
  problematic: Object.freeze({
    dailyOrders: 140,
    growthBps: 3500,
    refundBps: 700,
    adSpendMinor: 50_000,
  }),
  mature: Object.freeze({ dailyOrders: 100, growthBps: 0, refundBps: 150, adSpendMinor: 10_000 }),
  new: Object.freeze({ dailyOrders: 6, growthBps: 0, refundBps: 300, adSpendMinor: 1000 }),
});

const inputSchema = z.strictObject({
  binding: ConnectorBindingSchema,
  seed: z.number().int().min(0).max(0xffff_ffff),
  profile: z.enum(["growing", "problematic", "mature", "new"]),
  historyStart: ConnectorTimestampSchema,
  days: z.number().int().min(1).max(365).default(180),
  productCount: z.number().int().min(1).max(100).default(60),
  variantsPerProduct: z.number().int().min(1).max(3).default(3),
  dailyOrders: z.number().int().min(1).max(300).optional(),
  growthBps: z.number().int().min(0).max(10_000).optional(),
  refundBps: z.number().int().min(0).max(5000).optional(),
  adSpendMinor: z.number().int().min(0).max(100_000_000).optional(),
  scenarioPlan: MockScenarioPlanSchema.optional(),
});

export const MockConfigSchema = inputSchema
  .refine(
    (input) =>
      !input.scenarioPlan ||
      (input.scenarioPlan.externalStoreId === input.binding.externalStoreId &&
        input.scenarioPlan.endDay <= input.days &&
        input.scenarioPlan.mutations.every(
          (m) => m.skuIndex < input.productCount * input.variantsPerProduct,
        )),
    { message: "Scenario exceeds frozen commerce scope" },
  )
  .refine((input) => input.binding.externalStoreId.length <= 200, {
    message: "External store namespace exceeds derived ID budget",
  })
  .refine((input) => (Date.parse(input.historyStart) + 8 * 3_600_000) % DAY_MS === 0, {
    message: "History must start at Asia/Shanghai midnight",
  })
  .transform((input) => ({
    ...input,
    dailyOrders: input.dailyOrders ?? profileDefaults[input.profile].dailyOrders,
    growthBps: input.growthBps ?? profileDefaults[input.profile].growthBps,
    refundBps: input.refundBps ?? profileDefaults[input.profile].refundBps,
    adSpendMinor: input.adSpendMinor ?? profileDefaults[input.profile].adSpendMinor,
    historyStart: new Date(input.historyStart).toISOString(),
  }))
  .refine((input) => input.days * Math.ceil(input.dailyOrders * 1.35) <= 150_000, {
    message: "Mock generation budget exceeded",
  })
  .refine((input) =>
    Number.isFinite(new Date(Date.parse(input.historyStart) + input.days * DAY_MS).getTime()),
  )
  .refine(
    (input) =>
      ConnectorTimestampSchema.safeParse(input.historyStart).success &&
      ConnectorTimestampSchema.safeParse(
        new Date(Date.parse(input.historyStart) + (input.days + 5) * DAY_MS).toISOString(),
      ).success,
    { message: "History and settlement timestamps exceed connector calendar range" },
  )
  .transform((input) => {
    if (!input.scenarioPlan) return input;
    const { scenarioPlan, ...base } = input;
    return { ...base, scenarioPlan };
  })
  .readonly();

export type MockConfig = z.infer<typeof MockConfigSchema>;

export function openingTime(config: MockConfig): number {
  const offset = config.profile === "new" ? Math.max(0, config.days - 14) : 0;
  return Date.parse(config.historyStart) + offset * DAY_MS;
}

export function generatorVersion(config: MockConfig): "mock-source-v1" | "mock-source-v2" {
  return config.scenarioPlan ? "mock-source-v2" : GENERATOR_VERSION;
}
