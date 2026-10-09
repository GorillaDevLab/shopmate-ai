import { ConnectorRefundSchema } from "@shopmate/contracts";
import { sourceAt } from "./mock-catalog.js";
import type { MockConfig } from "./mock-config.js";
import type { TimelineEvent } from "./mock-history.js";
import { newEconomics, newOrder } from "./mock-order.js";
import type { InventoryEvent, ReplayState } from "./mock-types.js";

function stockChange(
  state: ReplayState,
  event: TimelineEvent,
  kind: InventoryEvent["kind"],
  onHandDelta: number,
  reservedDelta: number,
): void {
  const skuId = event.skuId ?? event.candidate!.sku.externalSkuId;
  const at = new Date(event.at).toISOString();
  const balance = state.balances.get(skuId) ?? { onHand: 0, reserved: 0, updatedAt: at };
  const onHand = balance.onHand + onHandDelta;
  const reserved = balance.reserved + reservedDelta;
  if (reserved < 0 || onHand < reserved) throw new Error("Mock inventory conservation failure");
  state.balances.set(skuId, { onHand, reserved, updatedAt: at });
  state.ledger.push({
    eventId: `${event.candidate?.id ?? skuId}:${kind}:${event.at}`,
    externalSkuId: skuId,
    externalOrderId: event.candidate?.id ?? null,
    kind,
    at,
    onHandDelta,
    reservedDelta,
  });
}

function reserve(config: MockConfig, state: ReplayState, event: TimelineEvent): void {
  const candidate = event.candidate!;
  const balance = state.balances.get(candidate.sku.externalSkuId);
  // Lost demand is not a fulfilled order and never makes inventory negative.
  if (!balance || balance.onHand - balance.reserved < candidate.quantity) return;
  stockChange(state, event, "RESERVE", 0, candidate.quantity);
  state.orders.set(candidate.id, newOrder(config, candidate));
  state.economics.set(candidate.id, newEconomics(candidate));
}

function refund(config: MockConfig, state: ReplayState, event: TimelineEvent): void {
  const candidate = event.candidate!;
  const order = state.orders.get(candidate.id)!;
  const at = new Date(event.at).toISOString();
  const amount = candidate.partialRefund ? Math.floor(order.paidMinor! / 2) : order.paidMinor!;
  order.refundedMinor = amount;
  state.refunds.push(
    ConnectorRefundSchema.parse({
      externalStoreId: config.binding.externalStoreId,
      externalRefundId: `${candidate.id}:refund`,
      externalOrderId: candidate.id,
      externalSkuId: candidate.sku.externalSkuId,
      source: sourceAt(at),
      status: "SUCCEEDED",
      requestedMinor: amount,
      succeededMinor: amount,
      requestedAt: at,
      succeededAt: at,
      currency: "CNY",
    }),
  );
}

function applyOrderEvent(config: MockConfig, state: ReplayState, event: TimelineEvent): void {
  const candidate = event.candidate!;
  const order = state.orders.get(candidate.id);
  if (!order) return;
  const economics = state.economics.get(candidate.id)!;
  const at = new Date(event.at).toISOString();
  order.source = sourceAt(at);
  if (event.kind === "PAY") {
    order.status = "PAID";
    order.paidAt = at;
    order.paidMinor = order.payableMinor;
    economics.platformFeeMinor = Math.floor((order.paidMinor * 200) / 10_000);
    economics.paymentFeeMinor = Math.floor((order.paidMinor * 60) / 10_000);
  } else if (event.kind === "CANCEL") {
    order.status = "CANCELLED";
    stockChange(state, event, "RELEASE", 0, -candidate.quantity);
  } else if (event.kind === "SHIP") {
    order.status = "FULFILLED";
    economics.fulfillmentShippingMinor = 700;
    stockChange(state, event, "SHIP", -candidate.quantity, -candidate.quantity);
  } else if (event.kind === "COMPLETE") order.status = "COMPLETED";
  else if (event.kind === "REFUND") refund(config, state, event);
  else if (event.kind === "RETURN" && !candidate.partialRefund) {
    stockChange(state, event, "RETURN", candidate.quantity, 0);
  }
}

export function replayTimeline(
  config: MockConfig,
  timeline: readonly TimelineEvent[],
): ReplayState {
  const state: ReplayState = {
    orders: new Map(),
    economics: new Map(),
    balances: new Map(),
    refunds: [],
    ledger: [],
  };
  for (const event of timeline) {
    applyTimelineEvent(config, state, event);
  }
  return state;
}

function replenish(state: ReplayState, event: TimelineEvent): void {
  const balance = state.balances.get(event.skuId!);
  const available = balance ? balance.onHand - balance.reserved : 0;
  // Order up to a target; additive full batches would hide stockouts behind unlimited accumulation.
  stockChange(state, event, "RESTOCK", Math.max(0, event.stock! - available), 0);
}

/** Shared causal commerce transition; callers own and drain the scratch effects. */
export function applyTimelineEvent(
  config: MockConfig,
  state: ReplayState,
  event: TimelineEvent,
): void {
  if (event.kind === "RESTOCK") replenish(state, event);
  else if (event.kind === "RESERVE") reserve(config, state, event);
  else applyOrderEvent(config, state, event);
}
