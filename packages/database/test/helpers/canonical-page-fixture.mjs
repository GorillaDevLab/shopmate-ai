import { syncScope } from "./sync-host-fixture.mjs";
const since = "2026-01-01T00:00:00.000Z";
export function canonicalRecord(stream, id = "one", updatedAt = since) {
  const base = {
    externalStoreId: syncScope().externalStoreId,
    source: { version: "opaque:9", updatedAt, quality: { state: "COMPLETE", issues: [] } },
  };
  const values = {
    ORDERS: {
      externalOrderId: id,
      status: "PAID",
      orderedAt: since,
      paidAt: since,
      currency: "CNY",
      grossMinor: 100,
      discountMinor: 0,
      shippingMinor: 0,
      payableMinor: 100,
      paidMinor: 100,
      refundedMinor: 0,
      items: [
        {
          externalLineId: "line",
          externalProductId: "no-product",
          externalSkuId: "no-sku",
          quantity: 1,
          unitPriceMinor: 100,
          grossMinor: 100,
          discountMinor: 0,
          netMinor: 100,
        },
      ],
    },
    REFUNDS: {
      externalRefundId: id,
      externalOrderId: "unseen",
      externalSkuId: null,
      status: "SUCCEEDED",
      requestedMinor: 100,
      succeededMinor: 100,
      requestedAt: since,
      succeededAt: since,
      currency: "CNY",
    },
    INVENTORY: {
      externalSkuId: id,
      externalLocationId: "loc",
      available: 1,
      reserved: 2,
      onHand: 3,
      safetyStock: null,
      leadTimeDays: null,
    },
    MARKETING: {
      externalCampaignId: id,
      date: "2026-01-01",
      impressions: 10,
      clicks: 1,
      attributedOrders: 1,
      spendMinor: 0,
      attributedRevenueMinor: 100,
      currency: "CNY",
    },
  };
  return { ...base, ...values[stream] };
}
