import {
  ConnectorBindingSchema,
  ConnectorFailureSchema,
  ConnectorTimestampSchema,
  CursorSchema,
  TenantIdSchema,
  parseConnectorPage,
  ConnectorProductSchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  type CommerceConnector,
  type ConnectorFailureCode,
  type ConnectorPage,
  type ConnectorProduct,
  type ConnectorOrder,
  type ConnectorRefund,
  type ConnectorInventory,
  type ConnectorCampaignMetric,
  type ReadOptions,
} from "@shopmate/contracts";
import { z } from "zod";
import { boundedRead } from "./bounded-read.js";

export class SyncPageInputError extends Error {
  constructor() {
    super("Invalid sync page request");
    this.name = "SyncPageInputError";
  }
}

const RequestSchema = z
  .strictObject({
    stream: z.enum(["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"]),
    since: ConnectorTimestampSchema,
    until: ConnectorTimestampSchema,
    limit: z.number().int().min(1).max(200),
    cursor: CursorSchema.optional(),
  })
  .refine((value) => Date.parse(value.since) <= Date.parse(value.until));
const CallSchema = z.strictObject({
  requestId: TenantIdSchema,
  deadlineAt: ConnectorTimestampSchema,
  signal: z.instanceof(AbortSignal).optional(),
});

type SyncRequest = z.infer<typeof RequestSchema>;
type SyncItem =
  | ConnectorProduct
  | ConnectorOrder
  | ConnectorRefund
  | ConnectorInventory
  | ConnectorCampaignMetric;
type SyncPage = ConnectorPage<SyncItem>;
export type SyncPageResult =
  | { readonly status: "PAGE" | "PARTIAL" | "COMPLETE"; readonly page: SyncPage }
  | {
      readonly status: "FAILED";
      readonly code: ConnectorFailureCode;
      readonly retryAfterMs?: number | null;
    };

function queryFor(request: SyncRequest) {
  const { since, until, limit, cursor } = request;
  return {
    until,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(request.stream === "INVENTORY" ? {} : { since }),
  };
}

function readPage(
  connector: CommerceConnector,
  request: SyncRequest,
  options: ReadOptions,
): Promise<unknown> {
  const query = queryFor(request);
  switch (request.stream) {
    case "PRODUCTS":
      return connector.listProducts(query, options);
    case "ORDERS":
      return connector.listOrders(query, options);
    case "REFUNDS":
      return connector.listRefunds(query, options);
    case "INVENTORY":
      return connector.getInventory(query, options);
    case "MARKETING":
      return connector.getMarketingMetrics({ ...query, since: request.since }, options);
  }
}

function validPage(request: SyncRequest, externalStoreId: string, raw: unknown) {
  const query = queryFor(request);
  switch (request.stream) {
    case "PRODUCTS":
      return parseConnectorPage(ConnectorProductSchema, externalStoreId, query, raw);
    case "ORDERS":
      return parseConnectorPage(ConnectorOrderSchema, externalStoreId, query, raw);
    case "REFUNDS":
      return parseConnectorPage(ConnectorRefundSchema, externalStoreId, query, raw);
    case "INVENTORY":
      return parseConnectorPage(ConnectorInventorySchema, externalStoreId, query, raw);
    case "MARKETING":
      return parseConnectorPage(ConnectorCampaignMetricSchema, externalStoreId, query, raw);
  }
}

function failure(code: ConnectorFailureCode, retryAfterMs?: number | null): SyncPageResult {
  return { status: "FAILED", code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function interpret(request: SyncRequest, externalStoreId: string, raw: unknown): SyncPageResult {
  if (raw === null || typeof raw !== "object" || !("ok" in raw)) return failure("INVALID_RESPONSE");
  if (raw.ok === false && "error" in raw) {
    const parsed = ConnectorFailureSchema.safeParse(raw.error);
    return parsed.success
      ? failure(parsed.data.code, parsed.data.retryAfterMs)
      : failure("INVALID_RESPONSE");
  }
  if (raw.ok !== true || !("data" in raw)) return failure("INVALID_RESPONSE");
  const parsed = validPage(request, externalStoreId, raw.data);
  if (!parsed.ok) return failure(parsed.error.code);
  const page = parsed.data;
  const status =
    page.nextCursor !== null
      ? "PAGE"
      : page.sourceWatermark !== null &&
          Date.parse(page.sourceWatermark) >= Date.parse(request.until)
        ? "COMPLETE"
        : "PARTIAL";
  return { status, page };
}

export async function fetchSyncPage(
  connector: CommerceConnector,
  input: unknown,
  options: ReadOptions,
): Promise<SyncPageResult> {
  const request = RequestSchema.safeParse(input);
  const binding = ConnectorBindingSchema.safeParse(connector.binding);
  const call = CallSchema.safeParse(options);
  if (!request.success || !binding.success || !call.success) throw new SyncPageInputError();
  if (options.signal?.aborted) return failure("ABORTED");
  if (Date.now() >= Date.parse(options.deadlineAt)) return failure("TIMEOUT");
  const result = await boundedRead(
    (signal) => readPage(connector, request.data, { ...options, signal }),
    options,
  );
  if (result.status !== "RESPONSE") return failure(result.status);
  return interpret(request.data, binding.data.externalStoreId, result.value);
}
