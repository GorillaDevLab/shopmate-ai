import {
  ConnectorBindingSchema,
  ConnectorStoreSchema,
  ConnectorProductSchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  TenantIdSchema,
  type ConnectorResult,
} from "@shopmate/contracts";
import { z } from "zod";
import { mockFailure } from "./mock-call.js";

export const PersistentSourceScopeSchema = z.strictObject({
  ...ConnectorBindingSchema.unwrap().shape,
  sessionId: TenantIdSchema,
  generation: z.number().int().min(0).max(2_147_483_647),
});
const positiveUInt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .pipe(z.string().refine((value) => BigInt(value) <= 9223372036854775807n));
const utc = z.iso
  .datetime({ precision: 3 })
  .pipe(
    z
      .string()
      .refine((value) => !value.startsWith("0000") && new Date(value).toISOString() === value),
  );
export const PersistentSourceVersionSchema = z.strictObject({
  kind: z.enum(["STORE", "PRODUCT", "ORDER", "REFUND", "INVENTORY", "MARKETING"]),
  entityKey: z.string().min(1).max(1024),
  eventSeq: positiveUInt,
  releaseRevision: positiveUInt,
  occurredAt: utc,
  payload: z.unknown(),
  versionHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
const MappedSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("STORE"), record: ConnectorStoreSchema }),
    z.strictObject({ kind: z.literal("PRODUCT"), record: ConnectorProductSchema }),
    z.strictObject({ kind: z.literal("ORDER"), record: ConnectorOrderSchema }),
    z.strictObject({ kind: z.literal("REFUND"), record: ConnectorRefundSchema }),
    z.strictObject({ kind: z.literal("INVENTORY"), record: ConnectorInventorySchema }),
    z.strictObject({ kind: z.literal("MARKETING"), record: ConnectorCampaignMetricSchema }),
  ])
  .readonly();
export type PersistentSourceRecord = z.infer<typeof MappedSchema>;

/** DTO validation only. Callers must obtain versions through the certificate-validating reader
 * under fresh authorization; a well-shaped hash or scope is never proof of access or integrity.
 */
export function mapPersistentSourceVersion(
  scopeInput: unknown,
  versionInput: unknown,
): ConnectorResult<PersistentSourceRecord> {
  const scope = PersistentSourceScopeSchema.safeParse(scopeInput);
  if (!scope.success) return mockFailure("INVALID_INPUT");
  const version = PersistentSourceVersionSchema.safeParse(versionInput);
  if (!version.success) return mockFailure("INVALID_RESPONSE");
  const mapped = MappedSchema.safeParse({ kind: version.data.kind, record: version.data.payload });
  if (!mapped.success) return mockFailure("INVALID_RESPONSE");
  const { record } = mapped.data;
  if (
    record.externalStoreId !== scope.data.externalStoreId ||
    record.source.version !==
      `mock-runtime-v2:g:${scope.data.generation}:e:${version.data.eventSeq}` ||
    record.source.updatedAt !== version.data.occurredAt ||
    !matchesEntityKey(version.data.entityKey, mapped.data)
  )
    return mockFailure("INVALID_RESPONSE");
  return Object.freeze({ ok: true, data: mapped.data });
}

function matchesEntityKey(input: string, mapped: PersistentSourceRecord): boolean {
  try {
    const key: unknown = JSON.parse(input);
    return Array.isArray(key) && JSON.stringify(key) === JSON.stringify(entityKey(mapped));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function entityKey(mapped: PersistentSourceRecord): readonly string[] {
  switch (mapped.kind) {
    case "STORE":
      return [mapped.kind, mapped.record.externalStoreId];
    case "PRODUCT":
      return [mapped.kind, mapped.record.externalProductId];
    case "ORDER":
      return [mapped.kind, mapped.record.externalOrderId];
    case "REFUND":
      return [mapped.kind, mapped.record.externalRefundId];
    case "INVENTORY":
      return [mapped.kind, mapped.record.externalSkuId, mapped.record.externalLocationId];
    case "MARKETING":
      return [mapped.kind, mapped.record.externalCampaignId, mapped.record.date];
  }
}
