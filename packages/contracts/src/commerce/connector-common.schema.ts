import { z } from "zod";
import { TenantIdSchema } from "../tenant/tenant.schema.js";

/* eslint-disable no-control-regex -- Boundary validators deliberately reject hidden control characters. */
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;
const unsafeTextCharacters =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */
export const CurrencySchema = z.literal("CNY");
export const MinorAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const QuantitySchema = MinorAmountSchema;
export const ExternalIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !controlCharacters.test(value));
export const SourceVersionSchema = ExternalIdSchema;
export const CommerceTextSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/gu, "\n").trim().normalize("NFC"))
  .pipe(
    z
      .string()
      .min(1)
      .max(5000)
      .refine((value) => !unsafeTextCharacters.test(value)),
  );
export const ConnectorTimestampSchema = z.iso.datetime({ offset: true });
export const CursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim() === value && !controlCharacters.test(value));
export const ConnectorBindingSchema = z
  .strictObject({
    organizationId: TenantIdSchema,
    workspaceId: TenantIdSchema,
    storeId: TenantIdSchema,
    connectionId: TenantIdSchema,
    externalStoreId: ExternalIdSchema,
  })
  .readonly();
export const ConnectorCapabilitiesSchema = z
  .strictObject({
    readProducts: z.boolean(),
    readOrders: z.boolean(),
    readRefunds: z.boolean(),
    readInventory: z.boolean(),
    readMarketing: z.boolean(),
    writePrice: z.boolean(),
    writeInventory: z.boolean(),
    publishProduct: z.boolean(),
    webhookMode: z.enum(["NONE", "SUPPORTED"]),
    idempotencyMode: z.enum(["NATIVE", "EMULATED", "UNSUPPORTED"]),
    preconditionMode: z.enum(["NATIVE", "READ_THEN_WRITE", "UNSUPPORTED"]),
  })
  .readonly();
export const ConnectorFailureCodeSchema = z.enum([
  "TIMEOUT",
  "RATE_LIMIT",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "TEMPORARY",
  "CONFLICT",
  "INVALID_INPUT",
  "INVALID_RESPONSE",
  "UNSUPPORTED",
  "ABORTED",
]);
export const ConnectorFailureSchema = z
  .strictObject({
    code: ConnectorFailureCodeSchema,
    retryAfterMs: z.number().int().min(1).max(86_400_000).nullable(),
  })
  .readonly();
export const ReadOptionsSchema = z
  .strictObject({ requestId: TenantIdSchema, deadlineAt: ConnectorTimestampSchema })
  .readonly();

const pageFields = {
  cursor: CursorSchema.optional(),
  until: ConnectorTimestampSchema,
  limit: z.number().int().min(1).max(200),
};
export const SyncPageQuerySchema = z
  .strictObject({ ...pageFields, since: ConnectorTimestampSchema.optional() })
  .refine((query) => !query.since || Date.parse(query.since) <= Date.parse(query.until), {
    message: "Invalid source window",
  })
  .readonly();
export const InventoryQuerySchema = z
  .strictObject({
    ...pageFields,
    externalSkuIds: z
      .array(ExternalIdSchema)
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length)
      .readonly()
      .optional(),
  })
  .readonly();
export const MarketingQuerySchema = z
  .strictObject({ ...pageFields, since: ConnectorTimestampSchema })
  .refine((query) => Date.parse(query.since) <= Date.parse(query.until), {
    message: "Invalid source window",
  })
  .readonly();
export const ExternalProductRefSchema = z
  .strictObject({ externalProductId: ExternalIdSchema })
  .readonly();
export const ExternalOrderRefSchema = z
  .strictObject({ externalOrderId: ExternalIdSchema })
  .readonly();

export function ConnectorPageSchema<T extends z.ZodType>(item: T) {
  return z
    .strictObject({
      items: z.array(item).max(200).readonly(),
      nextCursor: CursorSchema.nullable(),
      observedAt: ConnectorTimestampSchema,
      sourceWatermark: ConnectorTimestampSchema.nullable(),
    })
    .readonly();
}
export function ConnectorResultSchema<T extends z.ZodType>(data: T) {
  return z
    .discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), data }),
      z.strictObject({ ok: z.literal(false), error: ConnectorFailureSchema }),
    ])
    .readonly();
}

export type ConnectorBinding = z.infer<typeof ConnectorBindingSchema>;
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;
export type ConnectorFailureCode = z.infer<typeof ConnectorFailureCodeSchema>;
export type ConnectorFailure = z.infer<typeof ConnectorFailureSchema>;
export type ReadOptions = z.infer<typeof ReadOptionsSchema> & { readonly signal?: AbortSignal };
export type SyncPageQuery = z.infer<typeof SyncPageQuerySchema>;
export type InventoryQuery = z.infer<typeof InventoryQuerySchema>;
export type MarketingQuery = z.infer<typeof MarketingQuerySchema>;
export type ExternalProductRef = z.infer<typeof ExternalProductRefSchema>;
export type ExternalOrderRef = z.infer<typeof ExternalOrderRefSchema>;
export interface ConnectorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly observedAt: string;
  readonly sourceWatermark: string | null;
}
export type ConnectorResult<T> = Readonly<
  { ok: true; data: T } | { ok: false; error: ConnectorFailure }
>;
