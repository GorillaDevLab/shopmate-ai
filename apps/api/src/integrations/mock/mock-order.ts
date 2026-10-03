import type { ConnectorOrder, ConnectorOrderItem } from "@shopmate/contracts";
import { sourceAt } from "./mock-catalog.js";
import type { MockConfig } from "./mock-config.js";
import type { OrderCandidate } from "./mock-history.js";
import type { Mutable, OrderEconomics } from "./mock-types.js";

function orderItem(candidate: OrderCandidate): ConnectorOrderItem {
  const grossMinor = candidate.sku.salePriceMinor * candidate.quantity;
  const discountMinor = Math.floor((grossMinor * candidate.discountBps) / 10_000);
  return {
    externalLineId: `${candidate.id}:line:0`,
    externalProductId: candidate.sku.externalProductId,
    externalSkuId: candidate.sku.externalSkuId,
    quantity: candidate.quantity,
    unitPriceMinor: candidate.sku.salePriceMinor,
    grossMinor,
    discountMinor,
    netMinor: grossMinor - discountMinor,
  };
}

export function newOrder(config: MockConfig, candidate: OrderCandidate): Mutable<ConnectorOrder> {
  const item = orderItem(candidate);
  const at = new Date(candidate.at).toISOString();
  return {
    externalStoreId: config.binding.externalStoreId,
    externalOrderId: candidate.id,
    source: sourceAt(at),
    status: "PENDING_PAYMENT",
    orderedAt: at,
    paidAt: null,
    currency: "CNY",
    items: [item],
    grossMinor: item.grossMinor,
    discountMinor: item.discountMinor,
    shippingMinor: 600,
    payableMinor: item.netMinor + 600,
    paidMinor: 0,
    refundedMinor: 0,
  };
}

export function newEconomics(candidate: OrderCandidate): Mutable<OrderEconomics> {
  const unitCost = candidate.sku.costPriceMinor;
  return {
    externalOrderId: candidate.id,
    campaignId: candidate.campaignId,
    costMinor: unitCost === null ? null : unitCost * candidate.quantity,
    fulfillmentShippingMinor: 0,
    platformFeeMinor: 0,
    paymentFeeMinor: 0,
  };
}
