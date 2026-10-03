import {
  ConnectorBindingSchema,
  ConnectorCapabilitiesSchema,
  ExternalProductRefSchema,
  ExternalOrderRefSchema,
  SyncPageQuerySchema,
  InventoryQuerySchema,
  MarketingQuerySchema,
  type CommerceConnector,
  type ConnectorBinding,
  type ConnectorCapabilities,
  type ConnectorResult,
  type ReadOptions,
  type TenantPermission,
} from "@shopmate/contracts";
import type { z } from "zod";
import type { BusinessClock } from "./business-clock.js";
import type { MockReadAccess } from "./mock-commerce-connector.js";
import { executeMockRead, MockConnectorError, mockFailure } from "./mock-call.js";
import { selectMockReadFailure, type MockReadMethod } from "./failure-rules.js";
import { canonicalMockTime } from "./mock-frame-store.js";

function hasSupportedPageTimes(query: {
  readonly until: string;
  readonly since?: string;
}): boolean {
  try {
    // Match the pager's UTC range before fault selection without creating or reading a frame.
    canonicalMockTime(query.until);
    if (query.since !== undefined) canonicalMockTime(query.since);
    return true;
  } catch (error) {
    if (error instanceof MockConnectorError && error.code === "INVALID_INPUT") return false;
    throw error;
  }
}

const syncReadQuerySchema = SyncPageQuerySchema.refine(hasSupportedPageTimes);
const inventoryReadQuerySchema = InventoryQuerySchema.refine(hasSupportedPageTimes);
const marketingReadQuerySchema = MarketingQuerySchema.refine(hasSupportedPageTimes).refine(
  (query) => (Date.parse(query.since) + 8 * 3_600_000) % 86_400_000 === 0,
);

function assertActive(options: ReadOptions): void {
  if (options.signal?.aborted) throw new MockConnectorError("ABORTED");
  if (Date.now() >= Date.parse(options.deadlineAt)) throw new MockConnectorError("TIMEOUT");
}

/** TIMEOUT waits for the call gate's real deadline; business-clock advances cannot release it. */
function waitForGate(options: ReadOptions, delayMs?: number): Promise<void> {
  assertActive(options);
  return new Promise((resolve, reject) => {
    const signal = options.signal!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new MockConnectorError("ABORTED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (delayMs !== undefined)
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
    if (signal.aborted) onAbort();
  });
}

/** Server-only read wrapper. The host owns access and rules for the already bound session. */
export class ReadFaultInjectingConnector implements CommerceConnector {
  readonly binding: ConnectorBinding;
  readonly capabilities: ConnectorCapabilities;

  constructor(
    private readonly base: CommerceConnector,
    private readonly clock: BusinessClock,
    private readonly authorize: MockReadAccess,
    private readonly loadRules: (options: ReadOptions) => Promise<unknown>,
  ) {
    const binding = ConnectorBindingSchema.safeParse(base.binding);
    const capabilities = ConnectorCapabilitiesSchema.safeParse(base.capabilities);
    if (!binding.success || !capabilities.success) throw new MockConnectorError("INVALID_RESPONSE");
    const caps = capabilities.data;
    if (
      caps.writePrice ||
      caps.writeInventory ||
      caps.publishProduct ||
      caps.idempotencyMode !== "UNSUPPORTED" ||
      caps.preconditionMode !== "UNSUPPORTED"
    ) {
      throw new MockConnectorError("UNSUPPORTED");
    }
    this.binding = binding.data;
    this.capabilities = caps;
  }

  getStore(options: unknown): ReturnType<CommerceConnector["getStore"]> {
    return this.read("getStore", "tenant:read", options, (call) => this.base.getStore(call));
  }

  listProducts(query: unknown, options: unknown): ReturnType<CommerceConnector["listProducts"]> {
    return this.validatedRead(
      "listProducts",
      "products:read",
      syncReadQuerySchema,
      query,
      options,
      (input, call) => this.base.listProducts(input, call),
    );
  }

  getProduct(ref: unknown, options: unknown): ReturnType<CommerceConnector["getProduct"]> {
    return this.validatedRead(
      "getProduct",
      "products:read",
      ExternalProductRefSchema,
      ref,
      options,
      (input, call) => this.base.getProduct(input, call),
    );
  }

  listOrders(query: unknown, options: unknown): ReturnType<CommerceConnector["listOrders"]> {
    return this.validatedRead(
      "listOrders",
      "orders:read",
      syncReadQuerySchema,
      query,
      options,
      (input, call) => this.base.listOrders(input, call),
    );
  }

  getOrder(ref: unknown, options: unknown): ReturnType<CommerceConnector["getOrder"]> {
    return this.validatedRead(
      "getOrder",
      "orders:read",
      ExternalOrderRefSchema,
      ref,
      options,
      (input, call) => this.base.getOrder(input, call),
    );
  }

  listRefunds(query: unknown, options: unknown): ReturnType<CommerceConnector["listRefunds"]> {
    return this.validatedRead(
      "listRefunds",
      "orders:read",
      syncReadQuerySchema,
      query,
      options,
      (input, call) => this.base.listRefunds(input, call),
    );
  }

  getInventory(query: unknown, options: unknown): ReturnType<CommerceConnector["getInventory"]> {
    return this.validatedRead(
      "getInventory",
      "inventory:read",
      inventoryReadQuerySchema,
      query,
      options,
      (input, call) => this.base.getInventory(input, call),
    );
  }

  getMarketingMetrics(
    query: unknown,
    options: unknown,
  ): ReturnType<CommerceConnector["getMarketingMetrics"]> {
    return this.validatedRead(
      "getMarketingMetrics",
      "tenant:read",
      marketingReadQuerySchema,
      query,
      options,
      (input, call) => this.base.getMarketingMetrics(input, call),
    );
  }

  // Forward untrusted write inputs unchanged: only the base adapter owns their rejection/correlation.
  updatePrice(command: unknown, options: unknown): ReturnType<CommerceConnector["updatePrice"]> {
    return this.base.updatePrice(
      command as Parameters<CommerceConnector["updatePrice"]>[0],
      options as ReadOptions,
    );
  }
  updateInventory(
    command: unknown,
    options: unknown,
  ): ReturnType<CommerceConnector["updateInventory"]> {
    return this.base.updateInventory(
      command as Parameters<CommerceConnector["updateInventory"]>[0],
      options as ReadOptions,
    );
  }
  createProduct(
    command: unknown,
    options: unknown,
  ): ReturnType<CommerceConnector["createProduct"]> {
    return this.base.createProduct(
      command as Parameters<CommerceConnector["createProduct"]>[0],
      options as ReadOptions,
    );
  }
  updateProduct(
    command: unknown,
    options: unknown,
  ): ReturnType<CommerceConnector["updateProduct"]> {
    return this.base.updateProduct(
      command as Parameters<CommerceConnector["updateProduct"]>[0],
      options as ReadOptions,
    );
  }
  verifyAction(query: unknown, options: unknown): ReturnType<CommerceConnector["verifyAction"]> {
    return this.base.verifyAction(
      query as Parameters<CommerceConnector["verifyAction"]>[0],
      options as ReadOptions,
    );
  }

  private validatedRead<I, T>(
    method: MockReadMethod,
    permission: TenantPermission,
    schema: z.ZodType<I>,
    input: unknown,
    options: unknown,
    operation: (input: I, call: ReadOptions) => Promise<ConnectorResult<T>>,
  ): Promise<ConnectorResult<T>> {
    return executeMockRead(options, async (call) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return mockFailure("INVALID_INPUT");
      return this.performRead(method, permission, call, (linked) => operation(parsed.data, linked));
    });
  }

  private read<T>(
    method: MockReadMethod,
    permission: TenantPermission,
    options: unknown,
    operation: (call: ReadOptions) => Promise<ConnectorResult<T>>,
  ): Promise<ConnectorResult<T>> {
    return executeMockRead(options, (call) =>
      this.performRead(method, permission, call, operation),
    );
  }

  private async performRead<T>(
    method: MockReadMethod,
    permission: TenantPermission,
    call: ReadOptions,
    operation: (call: ReadOptions) => Promise<ConnectorResult<T>>,
  ): Promise<ConnectorResult<T>> {
    const allowed = await this.authorize(permission, call);
    assertActive(call);
    if (allowed !== true) return mockFailure("PERMISSION_DENIED");
    const rules = await this.loadRules(call);
    assertActive(call);
    const decision = selectMockReadFailure(rules, method, this.clock.snapshot().now);
    const effect = decision?.effect;
    if (effect?.kind === "FAIL" && effect.code !== "TIMEOUT") {
      return Object.freeze({
        ok: false,
        error: Object.freeze({ code: effect.code, retryAfterMs: effect.retryAfterMs }),
      });
    }
    if (effect?.kind === "DELAY") await waitForGate(call, effect.delayMs);
    if (effect?.kind === "FAIL") await waitForGate(call);
    assertActive(call);
    return operation(call);
  }
}
