import {
  ConnectorBindingSchema,
  ConnectorCapabilitiesSchema,
  ConnectorStoreSchema,
  ConnectorProductSchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  ExternalProductRefSchema,
  ExternalOrderRefSchema,
  SetPriceCommandSchema,
  SetInventoryCommandSchema,
  CreateProductCommandSchema,
  UpdateProductCommandSchema,
  VerifyActionQuerySchema,
  parseConnectorRead,
  parseConnectorPage,
  type CommerceConnector,
  type ConnectorBinding,
  type ConnectorResult,
  type ConnectorPage,
  type ReadOptions,
  type TenantPermission,
} from "@shopmate/contracts";
import type { z } from "zod";
import type { BusinessClock } from "./business-clock.js";
import { executeMockRead, MockConnectorError, mockFailure } from "./mock-call.js";
import type { MockReadAccess } from "./mock-commerce-connector.js";
import { rejectMockWrite } from "./mock-write.js";
import { PersistentSourceScopeSchema } from "./persistent-source-mapping.js";
import {
  validatePersistentPage,
  type PersistentScope,
  type PersistentReadPort,
  type PersistentKind,
  type PersistentReadRequest,
} from "./persistent-read-port.js";
import {
  parsePersistentQuery,
  persistentRequest,
  withinPersistentWindow,
  persistentTime,
} from "./persistent-query.js";

/** Inject only a server-owned, freshly authorized reader; no synthetic replay fallback. */
export class PersistentCommerceConnector implements CommerceConnector {
  readonly binding: ConnectorBinding;
  readonly capabilities = ConnectorCapabilitiesSchema.parse({
    readProducts: true,
    readOrders: true,
    readRefunds: true,
    readInventory: true,
    readMarketing: true,
    writePrice: false,
    writeInventory: false,
    publishProduct: false,
    webhookMode: "NONE",
    idempotencyMode: "UNSUPPORTED",
    preconditionMode: "UNSUPPORTED",
  });
  private readonly scope: PersistentScope;
  private disposed = false;
  constructor(
    scope: unknown,
    private readonly clock: BusinessClock,
    private readonly access: MockReadAccess,
    private readonly port: PersistentReadPort,
  ) {
    this.scope = PersistentSourceScopeSchema.parse(scope);
    this.binding = ConnectorBindingSchema.parse({
      organizationId: this.scope.organizationId,
      workspaceId: this.scope.workspaceId,
      storeId: this.scope.storeId,
      connectionId: this.scope.connectionId,
      externalStoreId: this.scope.externalStoreId,
    });
  }
  getStore(options: unknown) {
    return this.point(
      "STORE",
      "tenant:read",
      ConnectorStoreSchema,
      ["STORE", this.binding.externalStoreId],
      options,
    );
  }
  getProduct(ref: unknown, options: unknown) {
    return this.read("products:read", options, async (call) => {
      const parsed = ExternalProductRefSchema.safeParse(ref);
      if (!parsed.success) return mockFailure("INVALID_INPUT");
      return this.readPoint(
        "PRODUCT",
        ConnectorProductSchema,
        ["PRODUCT", parsed.data.externalProductId],
        call,
        "products:read",
      );
    });
  }
  getOrder(ref: unknown, options: unknown) {
    return this.read("orders:read", options, async (call) => {
      const parsed = ExternalOrderRefSchema.safeParse(ref);
      if (!parsed.success) return mockFailure("INVALID_INPUT");
      return this.readPoint(
        "ORDER",
        ConnectorOrderSchema,
        ["ORDER", parsed.data.externalOrderId],
        call,
        "orders:read",
      );
    });
  }
  listProducts(query: unknown, options: unknown) {
    return this.list("PRODUCT", "products:read", ConnectorProductSchema, query, options);
  }
  listOrders(query: unknown, options: unknown) {
    return this.list("ORDER", "orders:read", ConnectorOrderSchema, query, options);
  }
  listRefunds(query: unknown, options: unknown) {
    return this.list("REFUND", "orders:read", ConnectorRefundSchema, query, options);
  }
  getInventory(query: unknown, options: unknown) {
    return this.list("INVENTORY", "inventory:read", ConnectorInventorySchema, query, options);
  }
  getMarketingMetrics(query: unknown, options: unknown) {
    return this.list("MARKETING", "tenant:read", ConnectorCampaignMetricSchema, query, options);
  }
  updatePrice(command: unknown, options: unknown) {
    return this.rejectWrite(SetPriceCommandSchema, command, options);
  }
  updateInventory(command: unknown, options: unknown) {
    return this.rejectWrite(SetInventoryCommandSchema, command, options);
  }
  createProduct(command: unknown, options: unknown) {
    return this.rejectWrite(CreateProductCommandSchema, command, options);
  }
  updateProduct(command: unknown, options: unknown) {
    return this.rejectWrite(UpdateProductCommandSchema, command, options);
  }
  verifyAction(query: unknown, options: unknown) {
    return this.read("tenant:read", options, async () =>
      mockFailure(
        VerifyActionQuerySchema.safeParse(query).success ? "UNSUPPORTED" : "INVALID_INPUT",
      ),
    );
  }
  dispose(): void {
    this.disposed = true;
  }

  private async authorize(permission: TenantPermission, call: ReadOptions): Promise<void> {
    if (this.disposed) throw new MockConnectorError("AUTH_EXPIRED");
    if ((await this.access(permission, call)) !== true)
      throw new MockConnectorError("PERMISSION_DENIED");
    if (this.disposed) throw new MockConnectorError("AUTH_EXPIRED");
    if (call.signal?.aborted) throw new MockConnectorError("ABORTED");
    if (Date.now() >= Date.parse(call.deadlineAt)) throw new MockConnectorError("TIMEOUT");
  }
  private read<T>(
    permission: TenantPermission,
    options: unknown,
    operation: (call: ReadOptions) => Promise<ConnectorResult<T>>,
  ) {
    return executeMockRead(options, async (call) => {
      await this.authorize(permission, call);
      return operation(call);
    });
  }
  private async fetch(
    request: PersistentReadRequest,
    call: ReadOptions,
    permission: TenantPermission,
  ) {
    const response = await this.port.read(request, call);
    // Authorization can change while SQL is in flight. Check before inspecting or returning data.
    await this.authorize(permission, call);
    return validatePersistentPage(response, this.scope, request);
  }
  private point<T extends { readonly externalStoreId: string }>(
    kind: PersistentKind,
    permission: TenantPermission,
    schema: z.ZodType<T>,
    key: readonly string[],
    options: unknown,
  ) {
    return this.read(permission, options, (call) =>
      this.readPoint(kind, schema, key, call, permission),
    );
  }
  private async readPoint<T extends { readonly externalStoreId: string }>(
    kind: PersistentKind,
    schema: z.ZodType<T>,
    key: readonly string[],
    call: ReadOptions,
    permission: TenantPermission,
  ): Promise<ConnectorResult<T>> {
    const now = persistentTime(this.clock.snapshot().now);
    const page = await this.fetch(
      persistentRequest(kind, { until: now, limit: 1 }, now, key),
      call,
      permission,
    );
    if (page.nextCursor !== null) return mockFailure("INVALID_RESPONSE");
    return page.items[0]
      ? parseConnectorRead(schema, this.binding.externalStoreId, page.items[0].record)
      : mockFailure("NOT_FOUND");
  }
  private list<
    T extends {
      readonly externalStoreId: string;
      readonly source: { readonly updatedAt: string | null };
    },
  >(
    kind: PersistentKind,
    permission: TenantPermission,
    schema: z.ZodType<T>,
    input: unknown,
    options: unknown,
  ): Promise<ConnectorResult<ConnectorPage<T>>> {
    return this.read(permission, options, async (call) => {
      const query = parsePersistentQuery(kind, input);
      const now = persistentTime(this.clock.snapshot().now);
      const page = await this.fetch(persistentRequest(kind, query, now), call, permission);
      return parseConnectorPage(schema, this.binding.externalStoreId, query, {
        items: page.items
          .filter((item) => withinPersistentWindow(item, query))
          .map((item) => item.record),
        nextCursor: page.nextCursor,
        observedAt: now,
        sourceWatermark: page.effectiveUntil,
      });
    });
  }
  private rejectWrite(schema: z.ZodType, command: unknown, options: unknown) {
    return rejectMockWrite(schema, command, options, (call) => this.authorize("tenant:read", call));
  }
}
