import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TenantContextSchema,
  TenantIdSchema,
  canAccessTenantResource,
  type CommerceConnector,
  type ConnectorResult,
  type ReadOptions,
  type TenantPermission,
} from "@shopmate/contracts";
import { AuthPermission, type AuthContext } from "../../auth/contracts/index.js";
import type { BusinessClock } from "./business-clock.js";
import { executeMockRead, MockConnectorError } from "./mock-call.js";
import { PersistentCommerceConnector } from "./persistent-commerce-connector.js";
import type { PersistentReadBinder } from "./persistent-read-port.js";
import { MockConfigSchema } from "./mock-config.js";
import { ReadFaultInjectingConnector } from "./read-fault-connector.js";
import type { PersistentScope } from "./persistent-read-port.js";
export type MockFailureRuleLoader = (
  actor: { readonly userId: string; readonly merchantId: string },
  scope: PersistentScope,
  options: ReadOptions,
) => Promise<unknown>;

const IdentitySchema = z
  .strictObject({
    userId: TenantIdSchema,
    merchantId: TenantIdSchema,
    permissions: z
      .array(z.enum(Object.values(AuthPermission)))
      .max(4)
      .refine((values) => new Set(values).size === values.length)
      .readonly(),
  })
  .readonly();
const EnvironmentSchema = z.strictObject({
  appEnv: z.enum(["local", "test", "demo", "staging", "production"]),
  enableDemoMode: z.boolean(),
});
const AccessSchema = z.strictObject({
  sessionId: TenantIdSchema,
  context: TenantContextSchema,
  config: MockConfigSchema,
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  environmentMarker: z.string(),
  demoTenant: z.boolean(),
});
type AccessRecord = z.infer<typeof AccessSchema>;

/** Host-owned port: resolve fresh membership, Store ownership and approved demo connection internally.
 * AuthContext must originate from the server session guard, never from a request body.
 */
export interface MockConnectorAccessResolver {
  resolve(identity: AuthContext, storeId: string, options: ReadOptions): Promise<unknown | null>;
}

export class MockConnectorFactory {
  private readonly enabled: boolean;
  constructor(
    environment: unknown,
    private readonly resolver: MockConnectorAccessResolver,
    private readonly clock: BusinessClock,
    private readonly binder: PersistentReadBinder,
    private readonly loadFailureRules?: MockFailureRuleLoader,
  ) {
    const parsed = EnvironmentSchema.safeParse(environment);
    this.enabled = parsed.success && parsed.data.appEnv === "demo" && parsed.data.enableDemoMode;
  }

  open(
    identity: unknown,
    storeId: unknown,
    options: unknown,
  ): Promise<ConnectorResult<CommerceConnector>> {
    return executeMockRead(options, async (call) => {
      this.requireDemo();
      const actor = IdentitySchema.safeParse(identity);
      const selected = TenantIdSchema.safeParse(storeId);
      if (!actor.success || !selected.success) throw new MockConnectorError("INVALID_INPUT");
      const record = await this.resolve(actor.data, selected.data, call);
      this.requirePermission(record, "tenant:read");
      return { ok: true, data: this.connector(record, actor.data, selected.data) };
    });
  }

  private connector(record: AccessRecord, actor: AuthContext, storeId: string): CommerceConnector {
    const fingerprint = connectionFingerprint(record);
    const scope = {
      ...record.config.binding,
      sessionId: record.sessionId,
      generation: record.generation,
    };
    const sourceActor = { userId: record.context.userId, merchantId: record.context.merchantId };
    const authorize = (permission: TenantPermission, next: ReadOptions) =>
      this.verify(actor, storeId, fingerprint, permission, next);
    const connector = new PersistentCommerceConnector(
      scope,
      this.clock,
      authorize,
      this.binder.bind(sourceActor, scope),
    );
    const loader = this.loadFailureRules;
    return loader
      ? new ReadFaultInjectingConnector(connector, this.clock, authorize, (next) =>
          loader(sourceActor, scope, next),
        )
      : connector;
  }

  private async verify(
    identity: AuthContext,
    storeId: string,
    expected: string,
    permission: TenantPermission,
    call: ReadOptions,
  ): Promise<boolean> {
    const record = await this.resolve(identity, storeId, call);
    if (connectionFingerprint(record) !== expected) throw new MockConnectorError("AUTH_EXPIRED");
    this.requirePermission(record, permission);
    return true;
  }

  private async resolve(
    identity: AuthContext,
    storeId: string,
    call: ReadOptions,
  ): Promise<AccessRecord> {
    this.requireDemo();
    const record = AccessSchema.safeParse(await this.resolver.resolve(identity, storeId, call));
    if (!record.success || !correlates(record.data, identity, storeId))
      throw new MockConnectorError("PERMISSION_DENIED");
    if (call.signal?.aborted) throw new MockConnectorError("ABORTED");
    if (Date.now() >= Date.parse(call.deadlineAt)) throw new MockConnectorError("TIMEOUT");
    return record.data;
  }

  private requirePermission(record: AccessRecord, permission: TenantPermission): void {
    const { organizationId, workspaceId } = record.config.binding;
    if (!canAccessTenantResource(record.context, { organizationId, workspaceId }, permission))
      throw new MockConnectorError("PERMISSION_DENIED");
  }

  private requireDemo(): void {
    if (!this.enabled) throw new MockConnectorError("PERMISSION_DENIED");
  }
}

function correlates(record: AccessRecord, identity: AuthContext, storeId: string): boolean {
  const { context, config, environmentMarker, demoTenant } = record;
  const binding = config.binding;
  return (
    environmentMarker === "demo" &&
    demoTenant &&
    context.userId === identity.userId &&
    context.merchantId === identity.merchantId &&
    binding.storeId === storeId &&
    binding.organizationId === context.organizationId &&
    binding.workspaceId === context.workspaceId
  );
}

function connectionFingerprint(record: AccessRecord): string {
  return createHash("sha256")
    .update(JSON.stringify([record.sessionId, record.generation, record.config]))
    .digest("hex");
}
