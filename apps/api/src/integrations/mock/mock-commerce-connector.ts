import {
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
  type CommerceConnector,
  type ConnectorBinding,
  type ConnectorProduct,
  type ConnectorOrder,
  type ConnectorRefund,
  type ConnectorInventory,
  type ConnectorCampaignMetric,
  type ConnectorStore,
  type ConnectorPage,
  type ConnectorResult,
  type ReadOptions,
  type WriteReceipt,
  type VerificationResult,
  type TenantPermission,
} from "@shopmate/contracts";
import type { z } from "zod";
import type { BusinessClock } from "./business-clock.js";
import { executeMockRead, MockConnectorError, mockFailure } from "./mock-call.js";
import { MockFrameStore } from "./mock-frame-store.js";
import { MockPager, type MockReadKind, type MockScopedRow } from "./mock-page.js";
import type { MockSnapshot } from "./mock-types.js";
import { rejectMockWrite } from "./mock-write.js";

export type MockReadAccess = (
  permission: TenantPermission,
  options: ReadOptions,
) => Promise<boolean>;

/** Low-level server adapter. Public callers must use the factory's fresh authoritative access resolver. */
export class MockCommerceConnector implements CommerceConnector {
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
  private readonly frames: MockFrameStore;
  private readonly pager: MockPager;
  private disposed = false;

  constructor(
    config: unknown,
    clock: BusinessClock,
    private readonly access: MockReadAccess,
  ) {
    this.frames = new MockFrameStore(config, clock);
    this.binding = this.frames.config.binding;
    this.pager = new MockPager(this.frames);
  }

  getStore(options: unknown): Promise<ConnectorResult<ConnectorStore>> {
    return this.read("tenant:read", options, () => {
      const store = this.frames.at(this.frames.current()).store;
      return store
        ? parseConnectorRead(ConnectorStoreSchema, this.binding.externalStoreId, store)
        : mockFailure("NOT_FOUND");
    });
  }

  getProduct(ref: unknown, options: unknown): Promise<ConnectorResult<ConnectorProduct>> {
    return this.point(
      "products:read",
      ConnectorProductSchema,
      ExternalProductRefSchema,
      ref,
      (frame, key) =>
        frame.catalog.find((entry) => entry.product.externalProductId === key.externalProductId)
          ?.product,
      options,
    );
  }

  getOrder(ref: unknown, options: unknown): Promise<ConnectorResult<ConnectorOrder>> {
    return this.point(
      "orders:read",
      ConnectorOrderSchema,
      ExternalOrderRefSchema,
      ref,
      (frame, key) => frame.orders.find((order) => order.externalOrderId === key.externalOrderId),
      options,
    );
  }

  listProducts(
    query: unknown,
    options: unknown,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorProduct>>> {
    return this.list(
      "products",
      "products:read",
      query,
      options,
      ConnectorProductSchema,
      (frame) => frame.catalog.map((entry) => entry.product),
      (item) => item.externalProductId,
    );
  }

  listOrders(
    query: unknown,
    options: unknown,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorOrder>>> {
    return this.list(
      "orders",
      "orders:read",
      query,
      options,
      ConnectorOrderSchema,
      (frame) => frame.orders,
      (item) => item.externalOrderId,
    );
  }

  listRefunds(
    query: unknown,
    options: unknown,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorRefund>>> {
    return this.list(
      "refunds",
      "orders:read",
      query,
      options,
      ConnectorRefundSchema,
      (frame) => frame.refunds,
      (item) => item.externalRefundId,
    );
  }

  getInventory(
    query: unknown,
    options: unknown,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorInventory>>> {
    return this.list(
      "inventory",
      "inventory:read",
      query,
      options,
      ConnectorInventorySchema,
      (frame) => frame.inventory,
      (item) => JSON.stringify([item.externalSkuId, item.externalLocationId]),
    );
  }

  getMarketingMetrics(
    query: unknown,
    options: unknown,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorCampaignMetric>>> {
    return this.list(
      "marketing",
      "tenant:read",
      query,
      options,
      ConnectorCampaignMetricSchema,
      (frame) => frame.marketing,
      (item) => JSON.stringify([item.date, item.externalCampaignId]),
    );
  }

  updatePrice(command: unknown, options: unknown): Promise<WriteReceipt> {
    return this.rejectWrite(SetPriceCommandSchema, command, options);
  }
  updateInventory(command: unknown, options: unknown): Promise<WriteReceipt> {
    return this.rejectWrite(SetInventoryCommandSchema, command, options);
  }
  createProduct(command: unknown, options: unknown): Promise<WriteReceipt> {
    return this.rejectWrite(CreateProductCommandSchema, command, options);
  }
  updateProduct(command: unknown, options: unknown): Promise<WriteReceipt> {
    return this.rejectWrite(UpdateProductCommandSchema, command, options);
  }

  verifyAction(query: unknown, options: unknown): Promise<ConnectorResult<VerificationResult>> {
    return this.read("tenant:read", options, () =>
      mockFailure(
        VerifyActionQuerySchema.safeParse(query).success ? "UNSUPPORTED" : "INVALID_INPUT",
      ),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.frames.clear();
    this.pager.clear();
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
    operation: () => ConnectorResult<T>,
  ): Promise<ConnectorResult<T>> {
    return executeMockRead(options, async (call) => {
      await this.authorize(permission, call);
      return operation();
    });
  }

  private point<T extends { readonly externalStoreId: string }, R>(
    permission: TenantPermission,
    schema: z.ZodType<T>,
    refSchema: z.ZodType<R>,
    input: unknown,
    select: (frame: MockSnapshot, ref: R) => T | undefined,
    options: unknown,
  ): Promise<ConnectorResult<T>> {
    return this.read(permission, options, () => {
      const ref = refSchema.safeParse(input);
      if (!ref.success) return mockFailure("INVALID_INPUT");
      const row = select(this.frames.at(this.frames.current()), ref.data);
      return row
        ? parseConnectorRead(schema, this.binding.externalStoreId, row)
        : mockFailure("NOT_FOUND");
    });
  }

  private list<T extends MockScopedRow>(
    kind: MockReadKind,
    permission: TenantPermission,
    query: unknown,
    options: unknown,
    schema: z.ZodType<T>,
    rows: (frame: MockSnapshot) => readonly T[],
    id: (row: T) => string,
  ): Promise<ConnectorResult<ConnectorPage<T>>> {
    return this.read(permission, options, () => this.pager.page(kind, query, schema, rows, id));
  }

  private rejectWrite(
    schema: z.ZodType,
    command: unknown,
    options: unknown,
  ): Promise<WriteReceipt> {
    return rejectMockWrite(schema, command, options, (call) => this.authorize("tenant:read", call));
  }
}
