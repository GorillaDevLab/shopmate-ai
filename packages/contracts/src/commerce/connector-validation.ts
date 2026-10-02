import { z } from "zod";
import {
  matchesVerificationExpectation,
  VerificationResultSchema,
  VerifyActionQuerySchema,
} from "./connector-action.schema.js";
import type { VerificationResult } from "./connector-action.schema.js";
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
type ScopedSource = {
  readonly externalStoreId: string;
  readonly source: { readonly updatedAt: string | null };
};

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

export function parseConnectorPage<T extends ScopedSource>(
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
  const cutoff = Math.min(Date.parse(window.data.until), Date.parse(page.observedAt));
  if (
    page.items.length > window.data.limit ||
    page.items.some(
      (item) =>
        item.externalStoreId !== scope.data ||
        (item.source.updatedAt !== null &&
          (!Number.isFinite(Date.parse(item.source.updatedAt)) ||
            Date.parse(item.source.updatedAt) > cutoff)),
    ) ||
    (page.nextCursor !== null && page.nextCursor === window.data.cursor) ||
    (page.sourceWatermark !== null && Date.parse(page.sourceWatermark) > cutoff)
  )
    return invalid("INVALID_RESPONSE");
  return Object.freeze({ ok: true, data: page });
}

/** Adapters must additionally obtain a fresh readback under the call deadline. */
export function parseConnectorVerification(
  externalStoreId: unknown,
  query: unknown,
  payload: unknown,
): ConnectorResult<VerificationResult> {
  const scope = ExternalIdSchema.safeParse(externalStoreId);
  const request = VerifyActionQuerySchema.safeParse(query);
  if (!scope.success || !request.success) return invalid("INVALID_INPUT");
  const parsed = VerificationResultSchema.safeParse(payload);
  if (!parsed.success || parsed.data.executionId !== request.data.executionId) {
    return invalid("INVALID_RESPONSE");
  }
  const result = parsed.data;
  if (
    (result.status === "VERIFIED" || result.status === "MISMATCH") &&
    (result.snapshot.externalStoreId !== scope.data ||
      !matchesVerificationExpectation(result.snapshot, request.data.expected))
  )
    return invalid("INVALID_RESPONSE");
  return Object.freeze({ ok: true, data: result });
}
