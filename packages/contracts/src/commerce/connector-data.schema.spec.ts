import { describe, expect, it } from "vitest";
import * as schema from "./connector-data.schema.js";

const time = "2026-10-03T00:00:00Z";
const source = { version: "v1", updatedAt: time, quality: { state: "COMPLETE", issues: [] } };
const sku = {
  externalSkuId: "sku-a",
  externalProductId: "product-a",
  attributes: [{ name: "颜色", value: "黑色" }],
  salePriceMinor: 5900,
  costPriceMinor: 2000,
  originalPriceMinor: 6900,
  status: "ACTIVE",
};
const product = {
  externalStoreId: "store-a",
  externalProductId: "product-a",
  title: "手机支架",
  description: null,
  category: "3C",
  brand: null,
  status: "ACTIVE",
  skus: [sku],
  source,
};
const item = {
  externalLineId: "line-a",
  externalProductId: "product-a",
  externalSkuId: "sku-a",
  quantity: 2,
  unitPriceMinor: 5900,
  grossMinor: 11800,
  discountMinor: 1800,
  netMinor: 10000,
};
const order = {
  externalStoreId: "store-a",
  externalOrderId: "order-a",
  status: "PAID",
  orderedAt: time,
  paidAt: time,
  currency: "CNY",
  items: [item],
  grossMinor: 11800,
  discountMinor: 1800,
  shippingMinor: 600,
  payableMinor: 10600,
  paidMinor: 10600,
  refundedMinor: 0,
  source,
};
const inventory = {
  externalStoreId: "store-a",
  externalSkuId: "sku-a",
  externalLocationId: "warehouse-a",
  available: 10,
  reserved: 3,
  onHand: 15,
  safetyStock: 4,
  leadTimeDays: 7,
  source,
};
const refund = {
  externalStoreId: "store-a",
  externalRefundId: "refund-a",
  externalOrderId: "order-a",
  externalSkuId: "sku-a",
  status: "SUCCEEDED",
  requestedMinor: 5900,
  succeededMinor: 5900,
  requestedAt: time,
  succeededAt: time,
  currency: "CNY",
  source,
};
const campaign = {
  externalStoreId: "store-a",
  externalCampaignId: "campaign-a",
  date: "2026-10-03",
  impressions: 1000,
  clicks: 30,
  attributedOrders: 5,
  spendMinor: 10000,
  attributedRevenueMinor: 29500,
  currency: "CNY",
  source,
};

describe("normalized connector source records", () => {
  it("parses complete data with immutable collections", () => {
    const parsed = schema.ConnectorProductSchema.parse(product);
    expect(parsed.title).toBe("手机支架");
    expect(Object.isFrozen(parsed.skus)).toBe(true);
    expect(schema.ConnectorOrderSchema.parse(order).payableMinor).toBe(10600);
    expect(schema.ConnectorRefundSchema.parse(refund).succeededMinor).toBe(5900);
    expect(schema.ConnectorInventorySchema.parse(inventory).available).toBe(10);
    expect(schema.ConnectorCampaignMetricSchema.parse(campaign).spendMinor).toBe(10000);
  });
  it.each(["customer", "buyerPhone", "shippingAddress", "accessToken"])(
    "rejects extra sensitive field %s",
    (field) => {
      expect(schema.ConnectorOrderSchema.safeParse({ ...order, [field]: "private" }).success).toBe(
        false,
      );
    },
  );
  it("rejects customer PII embedded in order lines", () => {
    expect(
      schema.ConnectorOrderSchema.safeParse({
        ...order,
        items: [{ ...item, buyerEmail: "private" }],
      }).success,
    ).toBe(false);
  });
  it("requires explicit quality issues for missing cost", () => {
    const incomplete = { ...product, skus: [{ ...sku, costPriceMinor: null }] };
    expect(schema.ConnectorProductSchema.safeParse(incomplete).success).toBe(false);
    const parsed = schema.ConnectorProductSchema.parse({
      ...incomplete,
      source: { ...source, quality: { state: "PARTIAL", issues: ["COST_MISSING"] } },
    });
    expect(parsed.skus[0]?.costPriceMinor).toBeNull();
  });
  it("rejects a sku mapped to another product and duplicate source sku ids", () => {
    expect(
      schema.ConnectorProductSchema.safeParse({
        ...product,
        skus: [{ ...sku, externalProductId: "foreign" }],
      }).success,
    ).toBe(false);
    expect(schema.ConnectorProductSchema.safeParse({ ...product, skus: [sku, sku] }).success).toBe(
      false,
    );
  });
  it.each([
    { grossMinor: 100 },
    { discountMinor: 20000 },
    { payableMinor: 59 },
    { paidMinor: 20000 },
    { refundedMinor: 10601 },
    { items: [item, item] },
    { paidAt: "2026-10-02T00:00:00Z" },
  ])("rejects inconsistent order %o", (changes) => {
    expect(schema.ConnectorOrderSchema.safeParse({ ...order, ...changes }).success).toBe(false);
  });
  it("does not substitute zero for unknown payment or refunded amount", () => {
    const parsed = schema.ConnectorOrderSchema.parse({
      ...order,
      paidMinor: null,
      refundedMinor: null,
      source: { ...source, quality: { state: "PARTIAL", issues: ["PAYMENT_UNKNOWN"] } },
    });
    expect(parsed.paidMinor).toBeNull();
    expect(parsed.refundedMinor).toBeNull();
  });
  it("rejects unsafe order line multiplication", () => {
    expect(
      schema.ConnectorOrderItemSchema.safeParse({
        ...item,
        quantity: 2,
        unitPriceMinor: Number.MAX_SAFE_INTEGER,
        grossMinor: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(false);
  });
  it("rejects refund overflow and a success timestamp before request", () => {
    expect(
      schema.ConnectorRefundSchema.safeParse({ ...refund, succeededMinor: 6000 }).success,
    ).toBe(false);
    expect(
      schema.ConnectorRefundSchema.safeParse({ ...refund, succeededAt: "2026-10-02T00:00:00Z" })
        .success,
    ).toBe(false);
  });
  it("distinguishes unknown inventory from actual zero", () => {
    expect(schema.ConnectorInventorySchema.parse({ ...inventory, available: 0 }).available).toBe(0);
    expect(
      schema.ConnectorInventorySchema.safeParse({ ...inventory, available: null }).success,
    ).toBe(false);
    expect(
      schema.ConnectorInventorySchema.parse({
        ...inventory,
        available: null,
        source: { ...source, quality: { state: "PARTIAL", issues: ["INVENTORY_UNKNOWN"] } },
      }).available,
    ).toBeNull();
    expect(schema.ConnectorInventorySchema.safeParse({ ...inventory, available: 20 }).success).toBe(
      false,
    );
  });
  it("does not fabricate marketing spend or attributed revenue", () => {
    const missing = { ...campaign, spendMinor: null, attributedRevenueMinor: null };
    expect(schema.ConnectorCampaignMetricSchema.safeParse(missing).success).toBe(false);
    expect(
      schema.ConnectorCampaignMetricSchema.parse({
        ...missing,
        source: { ...source, quality: { state: "PARTIAL", issues: ["MARKETING_UNKNOWN"] } },
      }).spendMinor,
    ).toBeNull();
  });
  it("rejects contradictory and duplicate quality labels", () => {
    expect(
      schema.ConnectorSourceSchema.safeParse({
        ...source,
        quality: { state: "COMPLETE", issues: ["COST_MISSING"] },
      }).success,
    ).toBe(false);
    expect(
      schema.ConnectorSourceSchema.safeParse({
        ...source,
        quality: { state: "PARTIAL", issues: [] },
      }).success,
    ).toBe(false);
    expect(
      schema.ConnectorSourceSchema.safeParse({
        ...source,
        quality: { state: "PARTIAL", issues: ["COST_MISSING", "COST_MISSING"] },
      }).success,
    ).toBe(false);
  });
});
