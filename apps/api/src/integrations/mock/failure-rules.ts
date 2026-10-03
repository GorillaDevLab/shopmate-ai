import { ConnectorTimestampSchema, TenantIdSchema } from "@shopmate/contracts";
import { z } from "zod";
import { MockConnectorError } from "./mock-call.js";

export const MockReadMethodSchema = z.enum([
  "getStore",
  "listProducts",
  "getProduct",
  "listOrders",
  "getOrder",
  "listRefunds",
  "getInventory",
  "getMarketingMetrics",
]);
export type MockReadMethod = z.infer<typeof MockReadMethodSchema>;

const failureEffectSchema = z
  .strictObject({
    kind: z.literal("FAIL"),
    code: z.enum(["TIMEOUT", "RATE_LIMIT", "AUTH_EXPIRED", "TEMPORARY", "INVALID_RESPONSE"]),
    retryAfterMs: z.number().int().min(1).max(86_400_000).nullable(),
  })
  .refine((effect) => (effect.code === "RATE_LIMIT") === (effect.retryAfterMs !== null));

export const MockReadFailureEffectSchema = z
  .discriminatedUnion("kind", [
    failureEffectSchema,
    z.strictObject({ kind: z.literal("DELAY"), delayMs: z.number().int().min(1).max(30_000) }),
  ])
  .readonly();

const timestampSchema = ConnectorTimestampSchema.refine(
  (value) => value.slice(0, 4) !== "0000" && Number.isFinite(Date.parse(value)),
)
  .transform((value) => new Date(value).toISOString())
  .pipe(ConnectorTimestampSchema.refine((value) => value.slice(0, 4) !== "0000"));

export const MockReadFailureRulesSchema = z
  .array(
    z
      .strictObject({
        id: TenantIdSchema,
        priority: z.number().int().min(0).max(1000),
        startsAt: timestampSchema,
        endsAt: timestampSchema,
        methods: z
          .array(MockReadMethodSchema)
          .min(1)
          .max(8)
          .refine((methods) => new Set(methods).size === methods.length)
          .readonly(),
        effect: MockReadFailureEffectSchema,
      })
      .refine((rule) => Date.parse(rule.endsAt) > Date.parse(rule.startsAt))
      .readonly(),
  )
  .max(32)
  .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length)
  .readonly();

export interface MockReadFailureDecision {
  readonly ruleId: string;
  readonly effect: z.infer<typeof MockReadFailureEffectSchema>;
}

/** One deterministic winning condition; activation never uses real-time call counters. */
export function selectMockReadFailure(
  unknownRules: unknown,
  method: MockReadMethod,
  observedAt: unknown,
): Readonly<MockReadFailureDecision> | null {
  const rules = MockReadFailureRulesSchema.safeParse(unknownRules);
  const at = timestampSchema.safeParse(observedAt);
  if (!rules.success || !at.success) throw new MockConnectorError("INVALID_RESPONSE");
  const now = Date.parse(at.data);
  const winner = rules.data
    .filter(
      (rule) =>
        rule.methods.includes(method) &&
        Date.parse(rule.startsAt) <= now &&
        now < Date.parse(rule.endsAt),
    )
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return winner ? Object.freeze({ ruleId: winner.id, effect: winner.effect }) : null;
}
