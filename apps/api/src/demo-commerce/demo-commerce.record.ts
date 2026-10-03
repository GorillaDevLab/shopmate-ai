import { createHash } from "node:crypto";
import {
  DemoSessionViewSchema,
  DemoSourceSettingsSchema,
  TenantContextSchema,
  TenantIdSchema,
  TenantRoleSchema,
  TENANT_ROLE_PERMISSIONS,
} from "@shopmate/contracts";
import type { DemoActor } from "@shopmate/database";
import { z } from "zod";
import {
  GENERATOR_VERSION,
  MockConfigSchema,
  type MockConfig,
} from "../integrations/mock/mock-config.js";

export const StoreAccessSchema = z.strictObject({
  userId: TenantIdSchema,
  merchantId: TenantIdSchema,
  organizationId: TenantIdSchema,
  workspaceId: TenantIdSchema,
  storeId: TenantIdSchema,
  role: TenantRoleSchema,
});
const count = z.number().int().min(0).max(2_147_483_647);
const RecordSchema = StoreAccessSchema.extend({
  id: TenantIdSchema,
  connectionId: TenantIdSchema,
  externalStoreId: z.string().min(1).max(200),
  config: z.unknown(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/u),
  generatorVersion: z.literal(GENERATOR_VERSION),
  clockNow: z.date(),
  clockRevision: count,
  revision: count,
  generation: count,
  status: z.enum(["ACTIVE", "DISCONNECTED"]),
  environmentMarker: z.literal("DEMO"),
  demoTenant: z.literal(true),
});

export function configHash(config: MockConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
const MutationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("WRITTEN"), record: z.unknown() }),
  z.strictObject({ status: z.enum(["NOT_FOUND", "CONFLICT"]) }),
]);
export function validateMutationResult(input: unknown) {
  return MutationSchema.parse(input);
}
export function validateStore(input: unknown, actor: DemoActor, storeId: string) {
  const access = StoreAccessSchema.parse(input);
  if (
    access.userId !== actor.userId ||
    access.merchantId !== actor.merchantId ||
    access.storeId !== storeId
  )
    throw new Error("Invalid demo ownership");
  return access;
}
export function validateDemoRecord(input: unknown, actor: DemoActor, storeId: string) {
  const record = RecordSchema.parse(input);
  validateStore(
    {
      userId: record.userId,
      merchantId: record.merchantId,
      organizationId: record.organizationId,
      workspaceId: record.workspaceId,
      storeId: record.storeId,
      role: record.role,
    },
    actor,
    storeId,
  );
  const config = MockConfigSchema.parse(record.config);
  validateConfig(record, config);
  return { record, config, context: currentContext(record), view: sessionView(record, config) };
}

type ValidRecord = z.infer<typeof RecordSchema>;
function validateConfig(record: ValidRecord, config: MockConfig): void {
  const { binding, ...settings } = config;
  DemoSourceSettingsSchema.parse(settings);
  if (
    binding.organizationId !== record.organizationId ||
    binding.workspaceId !== record.workspaceId ||
    binding.storeId !== record.storeId ||
    binding.connectionId !== record.connectionId ||
    binding.externalStoreId !== record.externalStoreId ||
    configHash(config) !== record.configHash ||
    record.clockNow.getTime() < Date.parse(config.historyStart)
  )
    throw new Error("Invalid demo configuration");
}
function currentContext(record: ValidRecord) {
  return TenantContextSchema.parse({
    userId: record.userId,
    merchantId: record.merchantId,
    organizationId: record.organizationId,
    workspaceId: record.workspaceId,
    role: record.role,
    permissions: [...TENANT_ROLE_PERMISSIONS[record.role]],
  });
}
function sessionView(record: ValidRecord, config: MockConfig) {
  return DemoSessionViewSchema.parse({
    id: record.id,
    storeId: record.storeId,
    connectionId: record.connectionId,
    profile: config.profile,
    seed: config.seed,
    generatorVersion: record.generatorVersion,
    configHash: record.configHash,
    clockNow: record.clockNow.toISOString(),
    clockRevision: record.clockRevision,
    revision: record.revision,
    generation: record.generation,
    status: record.status,
  });
}
