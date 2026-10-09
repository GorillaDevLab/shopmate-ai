import {
  ConnectorInventorySchema,
  ConnectorOrderSchema,
  ConnectorSkuSchema,
  type ConnectorInventory,
  type ConnectorOrder,
  type ConnectorSku,
} from "@shopmate/contracts";
import { z } from "zod";
import { DAY_MS, type MockConfig } from "./mock-config.js";
import { compareTimelineEvents, type TimelineEvent } from "./mock-history.js";
import type { CatalogEntry } from "./mock-catalog.js";
import { newOrder } from "./mock-order.js";

export const kindSchema = z.enum([
  "RESTOCK",
  "RESERVE",
  "PAY",
  "CANCEL",
  "SHIP",
  "COMPLETE",
  "REFUND",
  "RETURN",
]);
export const positionSchema = z.strictObject({
  at: z.number().int().min(-62135596800000).max(253402300799999),
  kind: kindSchema,
  key: z.string().min(1).max(300),
});
export type CausalPosition = z.infer<typeof positionSchema>;
export interface CausalHydration {
  readonly orders: readonly ConnectorOrder[];
  readonly inventory: readonly ConnectorInventory[];
  readonly lastEvent?: CausalPosition | null;
}
const candidateSchema = z.strictObject({
  id: z.string().min(1).max(300),
  at: z.number().int().min(-62135596800000).max(253402300799999),
  sku: ConnectorSkuSchema,
  quantity: z.number().int().min(1).max(2),
  discountBps: z.number().int().min(0).max(10000),
  campaignId: z.string().max(300).nullable(),
  cancel: z.boolean(),
  refund: z.boolean(),
  partialRefund: z.boolean(),
  returnGoods: z.boolean(),
});
const eventSchema = z.strictObject({
  at: z.number().int().min(-62135596800000).max(253402300799999),
  kind: kindSchema,
  candidate: candidateSchema.optional(),
  skuId: z.string().min(1).max(300).optional(),
  stock: z.number().int().min(0).max(100000000).optional(),
});
export const orderLimit = (config: MockConfig) => 7 * Math.ceil(config.dailyOrders * 1.35);
export function owned<T>(value: T): T {
  const copy: T = structuredClone(value);
  return freeze(copy);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function position(event: TimelineEvent): CausalPosition {
  return { at: event.at, kind: event.kind, key: event.candidate?.id ?? event.skuId! };
}
export function comparePosition(a: CausalPosition, b: CausalPosition): number {
  return compareTimelineEvents(
    { at: a.at, kind: a.kind, skuId: a.key },
    { at: b.at, kind: b.kind, skuId: b.key },
  );
}
export function validateEvent(
  input: TimelineEvent,
  config: MockConfig,
  skus: ReadonlyMap<string, ConnectorSku>,
): TimelineEvent {
  const event = eventSchema.parse(input);
  if (event.kind === "RESTOCK") {
    if (!event.skuId || !skus.has(event.skuId) || event.stock === undefined || event.candidate)
      throw new Error("Invalid restock input");
  } else {
    const candidate = event.candidate;
    if (!candidate || event.skuId !== undefined || event.stock !== undefined)
      throw new Error("Missing order candidate");
    if (
      !candidate.id.startsWith(`${config.binding.externalStoreId}:order:`) ||
      candidate.at > event.at ||
      event.at > candidate.at + 5 * DAY_MS
    )
      throw new Error("Invalid candidate scope or settlement time");
    if (JSON.stringify(candidate.sku) !== JSON.stringify(skus.get(candidate.sku.externalSkuId)))
      throw new Error("Candidate differs from frozen catalog");
    validateLifecycle(event);
  }
  return event;
}
export function hydrate(
  input: unknown,
  config: MockConfig,
  skus: ReadonlyMap<string, ConnectorSku>,
  metadata: ReadonlyMap<string, CatalogEntry>,
): CausalHydration {
  const dto = z
    .strictObject({
      orders: z.array(ConnectorOrderSchema).max(orderLimit(config)),
      inventory: z.array(ConnectorInventorySchema).max(skus.size),
      lastEvent: positionSchema.nullable().optional(),
    })
    .parse(input);
  validateCheckpoint(dto.lastEvent, config, skus);
  validateOrders(dto, config, skus);
  validateInventory(dto, config, skus, metadata);
  return owned(dto);
}
function validateCheckpoint(
  checkpoint: CausalPosition | null | undefined,
  config: MockConfig,
  skus: ReadonlyMap<string, ConnectorSku>,
): void {
  if (!checkpoint) return;
  const scoped =
    checkpoint.kind === "RESTOCK"
      ? skus.has(checkpoint.key)
      : checkpoint.key.startsWith(`${config.binding.externalStoreId}:order:`);
  if (!scoped || checkpoint.at < Date.parse(config.historyStart))
    throw new Error("Invalid resume position");
}
function validateOrders(
  dto: CausalHydration,
  config: MockConfig,
  skus: ReadonlyMap<string, ConnectorSku>,
): void {
  const ids = new Set<string>();
  for (const row of dto.orders) {
    if (
      ids.has(row.externalOrderId) ||
      row.externalStoreId !== config.binding.externalStoreId ||
      !row.externalOrderId.startsWith(`${config.binding.externalStoreId}:order:`)
    )
      throw new Error("Invalid hydrated order scope or duplicate");
    ids.add(row.externalOrderId);
    canonical(row.source.updatedAt);
    canonical(row.orderedAt);
    if (row.paidAt !== null) canonical(row.paidAt);
    validateHydratedOrder(row, skus);
    if (dto.lastEvent && Date.parse(row.source.updatedAt!) > dto.lastEvent.at)
      throw new Error("Order ahead of resume position");
  }
}
function validateInventory(
  dto: CausalHydration,
  config: MockConfig,
  skus: ReadonlyMap<string, ConnectorSku>,
  metadata: ReadonlyMap<string, CatalogEntry>,
): void {
  const ids = new Set<string>();
  for (const row of dto.inventory) {
    if (
      ids.has(row.externalSkuId) ||
      row.externalStoreId !== config.binding.externalStoreId ||
      !skus.has(row.externalSkuId) ||
      row.externalLocationId !== `${config.binding.externalStoreId}:warehouse:0` ||
      row.onHand === null ||
      row.reserved === null ||
      row.onHand < row.reserved ||
      row.available !== row.onHand - row.reserved ||
      row.source.updatedAt === null
    )
      throw new Error("Invalid hydrated inventory state");
    canonical(row.source.updatedAt);
    const entry = metadata.get(row.externalSkuId)!;
    if (row.safetyStock !== entry.safetyStock || row.leadTimeDays !== entry.leadTimeDays)
      throw new Error("Inventory metadata differs from catalog");
    if (dto.lastEvent && Date.parse(row.source.updatedAt!) > dto.lastEvent.at)
      throw new Error("Inventory ahead of resume position");
    ids.add(row.externalSkuId);
  }
}
export function validatePrior(
  config: MockConfig,
  order: ConnectorOrder | undefined,
  event: TimelineEvent,
  hasBalance: boolean,
): void {
  if (!order) return;
  if (event.kind === "RESERVE") throw new Error("Order already reserved");
  const expected = newOrder(config, event.candidate!);
  if (
    JSON.stringify(order.items) !== JSON.stringify(expected.items) ||
    order.orderedAt !== expected.orderedAt ||
    order.payableMinor !== expected.payableMinor
  )
    throw new Error("Candidate differs from accepted order");
  const allowed: Partial<Record<TimelineEvent["kind"], readonly string[]>> = {
    PAY: ["PENDING_PAYMENT"],
    CANCEL: ["PENDING_PAYMENT"],
    SHIP: ["PAID"],
    COMPLETE: ["FULFILLED"],
    REFUND: ["FULFILLED", "COMPLETED"],
    RETURN: ["FULFILLED", "COMPLETED"],
  };
  if (!allowed[event.kind]?.includes(order.status))
    throw new Error("Invalid causal order transition");
  if (["CANCEL", "SHIP", "RETURN"].includes(event.kind) && !hasBalance)
    throw new Error("Missing required inventory balance");
  if (
    event.kind === "REFUND" &&
    (order.paidMinor === null || order.paidMinor <= 0 || order.refundedMinor !== 0)
  )
    throw new Error("Invalid causal refund state");
  if (event.kind === "RETURN") validateReturn(order, event);
}

function validateHydratedOrder(row: ConnectorOrder, skus: ReadonlyMap<string, ConnectorSku>): void {
  const item = row.items[0]!;
  const sku = skus.get(item.externalSkuId);
  const paid = ["PAID", "FULFILLED", "COMPLETED"].includes(row.status);
  if (
    row.items.length !== 1 ||
    !sku ||
    item.externalProductId !== sku.externalProductId ||
    item.unitPriceMinor !== sku.salePriceMinor ||
    item.quantity > 2 ||
    item.externalLineId !== `${row.externalOrderId}:line:0`
  )
    throw new Error("Invalid hydrated order item");
  if (
    row.source.updatedAt === null ||
    Date.parse(row.source.updatedAt) < Date.parse(row.orderedAt) ||
    row.shippingMinor !== 600 ||
    row.currency !== "CNY" ||
    row.paidMinor === null ||
    row.refundedMinor === null ||
    row.status === "CLOSED"
  )
    throw new Error("Unknown or inconsistent hydrated order facts");
  if (
    paid
      ? row.paidMinor !== row.payableMinor || row.paidAt === null
      : row.paidMinor !== 0 || row.paidAt !== null || row.refundedMinor !== 0
  )
    throw new Error("Invalid hydrated payment state");
  if (
    row.refundedMinor !== 0 &&
    row.refundedMinor !== row.paidMinor &&
    row.refundedMinor !== Math.floor(row.paidMinor / 2)
  )
    throw new Error("Invalid hydrated refund amount");
}

function validateLifecycle(event: TimelineEvent): void {
  const candidate = event.candidate!;
  const offsets = {
    RESERVE: 0,
    PAY: 300000,
    CANCEL: 1800000,
    SHIP: DAY_MS,
    COMPLETE: 2 * DAY_MS,
    REFUND: 3 * DAY_MS,
    RETURN: 5 * DAY_MS,
    RESTOCK: 0,
  };
  if (event.at !== candidate.at + offsets[event.kind])
    throw new Error("Invalid lifecycle event time");
  if (event.kind === "CANCEL" ? !candidate.cancel : event.kind !== "RESERVE" && candidate.cancel)
    throw new Error("Invalid cancellation lifecycle");
  if (["REFUND", "RETURN"].includes(event.kind) && !candidate.refund)
    throw new Error("Refund outside candidate lifecycle");
  if (event.kind === "RETURN" && !candidate.returnGoods)
    throw new Error("Return outside candidate lifecycle");
}

function canonical(timestamp: string | null): void {
  if (timestamp === null || new Date(timestamp).toISOString() !== timestamp)
    throw new Error("Canonical known UTC timestamp required");
}

function validateReturn(order: ConnectorOrder, event: TimelineEvent): void {
  const expected = event.candidate!.partialRefund
    ? Math.floor(order.paidMinor! / 2)
    : order.paidMinor!;
  if (!order.refundedMinor || order.refundedMinor !== expected)
    throw new Error("Return requires matching accepted refund");
}
