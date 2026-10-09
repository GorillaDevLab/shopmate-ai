import { z } from "zod";
import { ConnectorTimestampSchema } from "../commerce/connector-common.schema.js";
import { TenantIdSchema } from "../tenant/tenant.schema.js";

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
export const DemoFailureRuleTimestampSchema = timestampSchema;

export const MockReadFailureRuleSchema = z
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
  .readonly();

export const MockReadFailureRulesSchema = z
  .array(MockReadFailureRuleSchema)
  .max(32)
  .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length)
  .readonly();

function boundedData(input: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (input === null || ["string", "number", "boolean"].includes(typeof input))
    return typeof input !== "string" || input.length <= 200;
  if (typeof input !== "object") return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return false;
  const keys = Reflect.ownKeys(input);
  if (keys.length > 40) return false;
  return keys.every((key) => {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return Boolean(descriptor && "value" in descriptor && boundedData(descriptor.value, depth + 1));
  });
}

const commandGate = z.unknown().superRefine((input, context) => {
  let valid = false;
  try {
    valid = boundedData(input);
  } catch {
    // Reflection traps are untrusted input failures, never database or transport errors.
    valid = false;
  }
  if (!valid) context.addIssue({ code: "custom", message: "Invalid demo controls" });
});
const revisionSchema = z.number().int().min(0).max(2_147_483_646);
export const DemoFailureRuleCreateSchema = commandGate.pipe(
  z
    .strictObject({
      expectedRevision: revisionSchema,
      rule: MockReadFailureRuleSchema.refine(
        (rule) => Date.parse(rule.endsAt) - Date.parse(rule.startsAt) <= 2_592_000_000,
      ),
    })
    .readonly(),
);
export const DemoFailureRuleRemoveSchema = commandGate.pipe(
  z
    .strictObject({
      expectedRevision: revisionSchema,
      confirmSessionId: TenantIdSchema,
      ruleId: TenantIdSchema,
    })
    .readonly(),
);
export type MockReadFailureRule = z.infer<typeof MockReadFailureRuleSchema>;
