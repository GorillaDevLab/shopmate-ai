import {
  InventoryQuerySchema,
  MarketingQuerySchema,
  SyncPageQuerySchema,
  parseConnectorPage,
  type ConnectorPage,
  type ConnectorResult,
} from "@shopmate/contracts";
import type { z } from "zod";
import { MockConnectorError } from "./mock-call.js";
import { DAY_MS } from "./mock-config.js";
import { MockCursorStore } from "./mock-cursor-store.js";
import { canonicalMockTime, MockFrameStore } from "./mock-frame-store.js";
import type { MockSnapshot } from "./mock-types.js";

export type MockReadKind = "products" | "orders" | "refunds" | "inventory" | "marketing";
export interface MockPageQuery {
  readonly until: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly since?: string;
  readonly externalSkuIds?: readonly string[];
}
export interface MockScopedRow {
  readonly externalStoreId: string;
  readonly source: { readonly updatedAt: string | null };
}

function parseQuery(kind: MockReadKind, input: unknown): MockPageQuery {
  const schema =
    kind === "inventory"
      ? InventoryQuerySchema
      : kind === "marketing"
        ? MarketingQuerySchema
        : SyncPageQuerySchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MockConnectorError("INVALID_INPUT");
  const query: MockPageQuery = parsed.data;
  const since = query.since ? canonicalMockTime(query.since) : undefined;
  if (kind === "marketing" && (Date.parse(since!) + 8 * 3_600_000) % DAY_MS !== 0)
    throw new MockConnectorError("INVALID_INPUT");
  return {
    ...query,
    until: canonicalMockTime(query.until),
    since,
    externalSkuIds: query.externalSkuIds ? [...query.externalSkuIds].sort() : undefined,
  };
}

function queryKey(kind: MockReadKind, query: MockPageQuery): string {
  return JSON.stringify([
    kind,
    query.until,
    query.since ?? null,
    query.limit,
    query.externalSkuIds ?? null,
  ]);
}

function withinWindow(row: MockScopedRow, query: MockPageQuery, kind: MockReadKind): boolean {
  if (kind === "inventory" && query.externalSkuIds) {
    return query.externalSkuIds.includes(
      (row as MockScopedRow & { readonly externalSkuId: string }).externalSkuId,
    );
  }
  if (kind === "marketing") {
    const date = (row as MockScopedRow & { readonly date: string }).date;
    return Date.parse(`${date}T00:00:00+08:00`) >= Date.parse(query.since!);
  }
  return (
    !query.since ||
    (row.source.updatedAt !== null && Date.parse(row.source.updatedAt) >= Date.parse(query.since))
  );
}

export class MockPager {
  private readonly cursors = new MockCursorStore();
  constructor(private readonly frames: MockFrameStore) {}

  page<T extends MockScopedRow>(
    kind: MockReadKind,
    input: unknown,
    schema: z.ZodType<T>,
    rows: (frame: MockSnapshot) => readonly T[],
    id: (item: T) => string,
  ): ConnectorResult<ConnectorPage<T>> {
    const query = parseQuery(kind, input);
    const key = queryKey(kind, query);
    const position = query.cursor ? this.cursors.read(query.cursor, key) : null;
    const frame = position ? this.frames.pinned(position.frameHash) : this.frames.at(query.until);
    const selected = rows(frame)
      .filter((row) => withinWindow(row, query, kind))
      .sort((a, b) => compareId(id(a), id(b)));
    const offset = position?.offset ?? 0;
    const items = selected.slice(offset, offset + query.limit);
    const nextCursor =
      offset + items.length < selected.length
        ? this.cursors.next(key, frame.datasetHash, offset + items.length, position ?? undefined)
        : null;
    const originalQuery = stripInternalFields(kind, query);
    return parseConnectorPage(schema, this.frames.config.binding.externalStoreId, originalQuery, {
      items,
      nextCursor,
      observedAt: frame.observedAt,
      sourceWatermark: frame.store ? frame.historyUntil : null,
    });
  }

  clear(): void {
    this.cursors.clear();
  }
}

function stripInternalFields(kind: MockReadKind, query: MockPageQuery): MockPageQuery {
  const { since, externalSkuIds, ...base } = query;
  if (kind === "inventory") return { ...base, ...(externalSkuIds ? { externalSkuIds } : {}) };
  return { ...base, ...(since ? { since } : {}) };
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
