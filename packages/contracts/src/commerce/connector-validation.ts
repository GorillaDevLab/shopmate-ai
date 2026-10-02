import { z } from "zod";
import {
  ConnectorPageSchema,
  ExternalIdSchema,
  InventoryQuerySchema,
  MarketingQuerySchema,
  SyncPageQuerySchema,
} from "./connector-common.schema.js";
import type {
  ConnectorFailureCode,
  ConnectorPage,
  ConnectorResult,
} from "./connector-common.schema.js";

const PageQuerySchema = z.union([SyncPageQuerySchema, InventoryQuerySchema, MarketingQuerySchema]);

function invalid(code: ConnectorFailureCode): ConnectorResult<never> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, retryAfterMs: null }) });
}

/** Scope must come from the trusted binding; parsing cannot establish ownership. */
export function parseConnectorRead<T extends { readonly externalStoreId: string }>(
  schema: z.ZodType<T>,
  externalStoreId: unknown,
  payload: unknown,
): ConnectorResult<T> {
  const scope = ExternalIdSchema.safeParse(externalStoreId);
  if (!scope.success) return invalid("INVALID_INPUT");
  const parsed = schema.safeParse(payload);
  if (!parsed.success || parsed.data.externalStoreId !== scope.data) {
    return invalid("INVALID_RESPONSE");
  }
  return Object.freeze({ ok: true, data: parsed.data });
}

export function parseConnectorPage<T extends { readonly externalStoreId: string }>(
  schema: z.ZodType<T>,
  externalStoreId: unknown,
  query: unknown,
  payload: unknown,
): ConnectorResult<ConnectorPage<T>> {
  const scope = ExternalIdSchema.safeParse(externalStoreId);
  const window = PageQuerySchema.safeParse(query);
  if (!scope.success || !window.success) return invalid("INVALID_INPUT");
  const parsed = ConnectorPageSchema(schema).safeParse(payload);
  if (!parsed.success) return invalid("INVALID_RESPONSE");
  const page = parsed.data;
  if (
    page.items.length > window.data.limit ||
    page.items.some((item) => item.externalStoreId !== scope.data) ||
    (page.nextCursor !== null && page.nextCursor === window.data.cursor) ||
    (page.sourceWatermark !== null &&
      Date.parse(page.sourceWatermark) > Date.parse(window.data.until))
  )
    return invalid("INVALID_RESPONSE");
  return Object.freeze({ ok: true, data: page });
}
