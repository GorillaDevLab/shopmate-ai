import { z } from "zod";
import {
  ConnectorTimestampSchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import { TenantIdSchema } from "../tenant/tenant.schema.js";

const DAY_MS = 86_400_000;
const profileSchema = z.enum(["growing", "problematic", "mature", "new"]);
const seedSchema = z.number().int().min(0).max(0xffff_ffff);
const counterSchema = z.number().int().min(0).max(2_147_483_647);
const expectedRevisionSchema = counterSchema.max(2_147_483_646);
const profileDailyOrders = Object.freeze({ growing: 180, problematic: 140, mature: 100, new: 6 });

const canonicalTimestampSchema = ConnectorTimestampSchema.refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "Invalid clock instant" },
)
  .transform((value) => new Date(value).toISOString())
  .pipe(ConnectorTimestampSchema)
  // PostgreSQL has no year zero; validate the UTC year after offset normalization.
  .refine((value) => !value.startsWith("0000-"), { message: "Clock year must be at least 0001" });

function hasSettlementRange(input: { historyStart: string; days: number }): boolean {
  const settlement = Date.parse(input.historyStart) + (input.days + 5) * DAY_MS;
  return (
    Number.isFinite(settlement) &&
    Math.abs(settlement) <= 8_640_000_000_000_000 &&
    canonicalTimestampSchema.safeParse(new Date(settlement).toISOString()).success
  );
}

export const DemoSourceSettingsSchema = z
  .strictObject({
    profile: profileSchema,
    seed: seedSchema,
    historyStart: canonicalTimestampSchema,
    days: z.number().int().min(1).max(365).default(180),
    productCount: z.number().int().min(1).max(100).default(60),
    variantsPerProduct: z.number().int().min(1).max(3).default(3),
    dailyOrders: z.number().int().min(1).max(300).optional(),
    growthBps: z.number().int().min(0).max(10_000).optional(),
    refundBps: z.number().int().min(0).max(5000).optional(),
    adSpendMinor: z.number().int().min(0).max(100_000_000).optional(),
  })
  .refine((input) => (Date.parse(input.historyStart) + 8 * 3_600_000) % DAY_MS === 0, {
    message: "History must start at Asia/Shanghai midnight",
    path: ["historyStart"],
  })
  .refine(
    (input) =>
      input.days * Math.ceil((input.dailyOrders ?? profileDailyOrders[input.profile]) * 1.35) <=
      150_000,
    { message: "Mock generation budget exceeded", path: ["dailyOrders"] },
  )
  .refine(hasSettlementRange, {
    message: "History and settlement timestamps exceed connector calendar range",
    path: ["historyStart"],
  })
  .readonly();

const sourceCommandFields = {
  settings: DemoSourceSettingsSchema,
  observedAt: canonicalTimestampSchema,
};

function observesHistory(input: { settings: DemoSourceSettings; observedAt: string }): boolean {
  return Date.parse(input.observedAt) >= Date.parse(input.settings.historyStart);
}

export const DemoSessionCreateSchema = z
  .strictObject(sourceCommandFields)
  .refine(observesHistory, { message: "Observation precedes history", path: ["observedAt"] })
  .readonly();

export const DemoSessionAdvanceSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    durationMs: z.number().int().min(1).max(2_592_000_000),
  })
  .readonly();

const confirmationFields = {
  expectedRevision: expectedRevisionSchema,
  confirmSessionId: TenantIdSchema,
};

export const DemoSessionResetSchema = z
  .strictObject({ ...confirmationFields, ...sourceCommandFields })
  .refine(observesHistory, { message: "Observation precedes history", path: ["observedAt"] })
  .readonly();

export const DemoSessionDisconnectSchema = z.strictObject(confirmationFields).readonly();

export const DemoSessionViewSchema = z
  .strictObject({
    id: TenantIdSchema,
    storeId: TenantIdSchema,
    connectionId: TenantIdSchema,
    profile: profileSchema,
    seed: seedSchema,
    generatorVersion: SourceVersionSchema,
    configHash: z.string().regex(/^[a-fA-F0-9]{64}$/u),
    clockNow: canonicalTimestampSchema,
    clockRevision: counterSchema,
    revision: counterSchema,
    generation: counterSchema,
    status: z.enum(["ACTIVE", "DISCONNECTED"]),
  })
  .readonly();

export type DemoSourceSettings = z.infer<typeof DemoSourceSettingsSchema>;
export type DemoSessionView = z.infer<typeof DemoSessionViewSchema>;
