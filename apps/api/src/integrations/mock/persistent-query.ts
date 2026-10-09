import {
  InventoryQuerySchema,
  MarketingQuerySchema,
  SyncPageQuerySchema,
  ConnectorTimestampSchema,
} from "@shopmate/contracts";
import { MockConnectorError } from "./mock-call.js";
import type { MockPageQuery } from "./mock-page.js";
import {
  persistentContext,
  type PersistentKind,
  type PersistentReadRequest,
  type PersistentSourceRecord,
} from "./persistent-read-port.js";

export function persistentTime(input: unknown): string {
  const parsed = ConnectorTimestampSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(parsed.data)))
    throw new MockConnectorError("INVALID_INPUT");
  const normalized = new Date(parsed.data).toISOString();
  if (!/^[0-9]{4}-/u.test(normalized) || normalized.startsWith("0000"))
    throw new MockConnectorError("INVALID_INPUT");
  return normalized;
}

export function parsePersistentQuery(kind: PersistentKind, input: unknown): MockPageQuery {
  const schema =
    kind === "INVENTORY"
      ? InventoryQuerySchema
      : kind === "MARKETING"
        ? MarketingQuerySchema
        : SyncPageQuerySchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MockConnectorError("INVALID_INPUT");
  const query: MockPageQuery = parsed.data;
  const since = query.since ? persistentTime(query.since) : undefined;
  if (kind === "MARKETING" && (Date.parse(since!) + 8 * 3600000) % 86400000 !== 0)
    throw new MockConnectorError("INVALID_INPUT");
  return {
    ...query,
    until: persistentTime(query.until),
    ...(since ? { since } : {}),
    ...(query.externalSkuIds ? { externalSkuIds: [...query.externalSkuIds].sort() } : {}),
  };
}
export function persistentRequest(
  kind: PersistentKind,
  query: MockPageQuery,
  businessNow: string,
  entityKey?: readonly string[],
): PersistentReadRequest {
  return {
    kind,
    requestedUntil: query.until,
    businessNow,
    limit: query.limit,
    contextHash: persistentContext([
      kind,
      query.until,
      query.since ?? null,
      query.limit,
      query.externalSkuIds ?? null,
      entityKey ?? null,
    ]),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(entityKey ? { entityKey } : {}),
  };
}
export function withinPersistentWindow(
  item: PersistentSourceRecord,
  query: MockPageQuery,
): boolean {
  if (item.kind === "INVENTORY" && query.externalSkuIds)
    return query.externalSkuIds.includes(item.record.externalSkuId);
  if (item.kind === "MARKETING")
    return Date.parse(`${item.record.date}T00:00:00+08:00`) >= Date.parse(query.since!);
  return (
    !query.since ||
    (item.record.source.updatedAt !== null &&
      Date.parse(item.record.source.updatedAt) >= Date.parse(query.since))
  );
}
