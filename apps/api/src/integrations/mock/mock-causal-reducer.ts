import {
  ConnectorInventorySchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  type ConnectorInventory,
  type ConnectorOrder,
  type ConnectorRefund,
  type ConnectorSku,
} from "@shopmate/contracts";
import { generateCatalog, sourceAt, type CatalogEntry } from "./mock-catalog.js";
import { DAY_MS, MockConfigSchema, type MockConfig } from "./mock-config.js";
import type { TimelineEvent } from "./mock-history.js";
import { newEconomics } from "./mock-order.js";
import { applyTimelineEvent } from "./mock-replay.js";
import type { ReplayState } from "./mock-types.js";
import {
  comparePosition,
  hydrate,
  orderLimit,
  owned,
  position,
  validateEvent,
  validatePrior,
  type CausalHydration,
  type CausalPosition,
} from "./mock-causal-state.js";
export type CausalMutation =
  | { readonly kind: "ORDER"; readonly occurredAt: string; readonly after: ConnectorOrder }
  | { readonly kind: "INVENTORY"; readonly occurredAt: string; readonly after: ConnectorInventory }
  | { readonly kind: "REFUND"; readonly occurredAt: string; readonly after: ConnectorRefund };
export interface CausalReducer {
  apply(event: TimelineEvent): readonly CausalMutation[];
  snapshot(): CausalHydration;
}
interface AcceptedState {
  config: MockConfig;
  skus: ReadonlyMap<string, ConnectorSku>;
  metadata: ReadonlyMap<string, CatalogEntry>;
  orders: Map<string, ConnectorOrder>;
  inventory: Map<string, ConnectorInventory>;
  lastEvent: CausalPosition | null;
}
/** Bounded, pure accepted state; SQL allocation and timestamp-group ordinals belong to the host. */
export function createCausalReducer(
  input: unknown,
  initial: unknown = { orders: [], inventory: [] },
): CausalReducer {
  const config = owned(MockConfigSchema.parse(input));
  const catalog = owned(generateCatalog(config));
  const skus = new Map(
    catalog.flatMap((entry) => entry.product.skus.map((sku) => [sku.externalSkuId, sku] as const)),
  );
  const metadata = new Map(
    catalog.flatMap((entry) =>
      entry.product.skus.map((sku) => [sku.externalSkuId, entry] as const),
    ),
  );
  const hydration = hydrate(initial, config, skus, metadata);
  const state: AcceptedState = {
    config,
    skus,
    metadata,
    orders: new Map(hydration.orders.map((row) => [row.externalOrderId, row])),
    inventory: new Map(hydration.inventory.map((row) => [row.externalSkuId, row])),
    lastEvent: hydration.lastEvent ?? null,
  };
  return Object.freeze({
    apply: (event: TimelineEvent) => apply(state, event),
    snapshot: (): CausalHydration =>
      owned({
        orders: [...state.orders.values()],
        inventory: [...state.inventory.values()],
        lastEvent: state.lastEvent,
      }),
  });
}
function scratchFor(
  accepted: AcceptedState,
  event: TimelineEvent,
  order: ConnectorOrder | undefined,
): ReplayState {
  const state: ReplayState = {
    orders: new Map(),
    economics: new Map(),
    balances: new Map(),
    refunds: [],
    ledger: [],
  };
  const candidate = event.candidate;
  const balance = accepted.inventory.get(candidate?.sku.externalSkuId ?? event.skuId!);
  if (order && candidate) {
    state.orders.set(candidate.id, structuredClone(order));
    const economics = newEconomics(candidate);
    // Hydration requires known paid amounts; unknown finance never becomes historical zero.
    economics.platformFeeMinor = Math.floor((order.paidMinor! * 200) / 10000);
    economics.paymentFeeMinor = Math.floor((order.paidMinor! * 60) / 10000);
    economics.fulfillmentShippingMinor = ["FULFILLED", "COMPLETED"].includes(order.status)
      ? 700
      : 0;
    state.economics.set(candidate.id, economics);
  }
  if (balance)
    state.balances.set(balance.externalSkuId, {
      onHand: balance.onHand!,
      reserved: balance.reserved!,
      updatedAt: balance.source.updatedAt!,
    });
  return state;
}
function inventoryAfter(
  accepted: AcceptedState,
  state: ReplayState,
  skuId: string,
  occurredAt: string,
): ConnectorInventory {
  const balance = state.balances.get(skuId)!;
  const entry = accepted.metadata.get(skuId)!;
  return ConnectorInventorySchema.parse({
    externalStoreId: accepted.config.binding.externalStoreId,
    externalSkuId: skuId,
    externalLocationId: `${accepted.config.binding.externalStoreId}:warehouse:0`,
    source: { ...sourceAt(occurredAt), version: null },
    onHand: balance.onHand,
    reserved: balance.reserved,
    available: balance.onHand - balance.reserved,
    safetyStock: entry.safetyStock,
    leadTimeDays: entry.leadTimeDays,
  });
}
function mutations(
  accepted: AcceptedState,
  state: ReplayState,
  event: TimelineEvent,
): readonly CausalMutation[] {
  const occurredAt = new Date(event.at).toISOString();
  const effects: CausalMutation[] = [];
  const order = event.candidate && state.orders.get(event.candidate.id);
  if (order)
    effects.push({
      kind: "ORDER",
      occurredAt,
      after: ConnectorOrderSchema.parse({ ...order, source: { ...order.source, version: null } }),
    });
  for (const change of state.ledger)
    effects.push({
      kind: "INVENTORY",
      occurredAt,
      after: inventoryAfter(accepted, state, change.externalSkuId, occurredAt),
    });
  for (const refund of state.refunds)
    effects.push({
      kind: "REFUND",
      occurredAt,
      after: ConnectorRefundSchema.parse({
        ...refund,
        source: { ...refund.source, version: null },
      }),
    });
  return owned(effects);
}
function apply(accepted: AcceptedState, inputEvent: TimelineEvent): readonly CausalMutation[] {
  const event = validateEvent(inputEvent, accepted.config, accepted.skus);
  const next = position(event);
  if (accepted.lastEvent && comparePosition(next, accepted.lastEvent) <= 0)
    throw new Error("Non-monotonic causal event");
  const expired = [...accepted.orders.values()]
    .filter((order) => Date.parse(order.orderedAt) + 5 * DAY_MS < event.at)
    .map((order) => order.externalOrderId);
  const prior =
    event.candidate && !expired.includes(event.candidate.id)
      ? accepted.orders.get(event.candidate.id)
      : undefined;
  validateChronology(accepted, event);
  validatePrior(
    accepted.config,
    prior,
    event,
    accepted.inventory.has(event.candidate?.sku.externalSkuId ?? event.skuId!),
  );
  const state = scratchFor(accepted, event, prior);
  applyTimelineEvent(accepted.config, state, event);
  const effects = mutations(accepted, state, event);
  if (
    accepted.orders.size -
      expired.length +
      (event.kind === "RESERVE" && state.orders.size ? 1 : 0) >
    orderLimit(accepted.config)
  )
    throw new Error("Active order budget exceeded");
  // Commit only after validation and scratch conservation succeed, so failures leave accepted state intact.
  expired.forEach((id) => accepted.orders.delete(id));
  for (const effect of effects) {
    if (effect.kind === "ORDER") accepted.orders.set(effect.after.externalOrderId, effect.after);
    if (effect.kind === "INVENTORY")
      accepted.inventory.set(effect.after.externalSkuId, effect.after);
  }
  accepted.lastEvent = owned(next);
  return effects;
}
function validateChronology(accepted: AcceptedState, event: TimelineEvent): void {
  const order = event.candidate && accepted.orders.get(event.candidate.id);
  const inventory = accepted.inventory.get(event.candidate?.sku.externalSkuId ?? event.skuId!);
  for (const row of [order, inventory]) {
    if (row && Date.parse(row.source.updatedAt!) > event.at)
      throw new Error("Accepted state is ahead of causal event");
  }
}
