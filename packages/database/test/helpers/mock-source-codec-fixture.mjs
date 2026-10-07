import { scopeFor } from "./mock-platform-fixture.mjs";
export const codecTime = "2024-02-29T00:00:00.000Z";
const common = () => ({
  externalStoreId: scopeFor().externalStoreId,
  source: { version: null, updatedAt: codecTime, quality: { state: "COMPLETE", issues: [] } },
});
const sku = {
  externalSkuId: "sku",
  externalProductId: "product",
  attributes: [{ name: "颜色", value: "红" }],
  salePriceMinor: 100,
  costPriceMinor: 50,
  originalPriceMinor: null,
  status: "ACTIVE",
};
const item = {
  externalLineId: "line",
  externalProductId: "product",
  externalSkuId: "sku",
  quantity: 2,
  unitPriceMinor: 100,
  grossMinor: 200,
  discountMinor: 10,
  netMinor: 190,
};
export const codecRecords = {
  STORE: {
    ...common(),
    name: "商店",
    category: "零售",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  PRODUCT: {
    ...common(),
    externalProductId: "product",
    title: "产品",
    description: "详情\n第二行",
    category: "类别",
    brand: null,
    status: "DELETED",
    skus: [sku],
  },
  ORDER: {
    ...common(),
    externalOrderId: "order",
    status: "PAID",
    orderedAt: codecTime,
    paidAt: codecTime,
    currency: "CNY",
    items: [item],
    grossMinor: 200,
    discountMinor: 10,
    shippingMinor: 5,
    payableMinor: 195,
    paidMinor: 195,
    refundedMinor: 0,
  },
  REFUND: {
    ...common(),
    externalRefundId: "refund",
    externalOrderId: "order",
    externalSkuId: null,
    status: "SUCCEEDED",
    requestedMinor: 10,
    succeededMinor: 10,
    requestedAt: codecTime,
    succeededAt: codecTime,
    currency: "CNY",
  },
  INVENTORY: {
    ...common(),
    externalSkuId: "sku",
    externalLocationId: "location",
    available: 8,
    reserved: 2,
    onHand: 10,
    safetyStock: null,
    leadTimeDays: null,
  },
  MARKETING: {
    ...common(),
    externalCampaignId: "campaign",
    date: "2024-02-29",
    impressions: 100,
    clicks: 10,
    attributedOrders: 1,
    spendMinor: 10,
    attributedRevenueMinor: 195,
    currency: "CNY",
  },
};
export const codecSchemas = {
  STORE: "ConnectorStoreSchema",
  PRODUCT: "ConnectorProductSchema",
  ORDER: "ConnectorOrderSchema",
  REFUND: "ConnectorRefundSchema",
  INVENTORY: "ConnectorInventorySchema",
  MARKETING: "ConnectorCampaignMetricSchema",
};
export function codecRecord(kind, change = () => {}) {
  const record = globalThis.structuredClone(codecRecords[kind]);
  change(record);
  return record;
}
export function partial(record, issues) {
  record.source.quality = { state: "PARTIAL", issues };
}
