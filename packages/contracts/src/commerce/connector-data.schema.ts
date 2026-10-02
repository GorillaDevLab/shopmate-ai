import { z } from "zod";
import {
  CommerceTextSchema,
  ConnectorTimestampSchema,
  CurrencySchema,
  ExternalIdSchema,
  MinorAmountSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "./connector-common.schema.js";

export const CommerceAttributeSchema = z
  .strictObject({
    name: CommerceTextSchema.pipe(z.string().max(100)),
    value: CommerceTextSchema.pipe(z.string().max(200)),
  })
  .readonly();
export const CommerceAttributesSchema = z
  .array(CommerceAttributeSchema)
  .max(30)
  .refine((items) => new Set(items.map((item) => item.name)).size === items.length)
  .readonly();
export const ConnectorQualityIssueSchema = z.enum([
  "COST_MISSING",
  "CATEGORY_MISSING",
  "PAYMENT_UNKNOWN",
  "REFUND_UNKNOWN",
  "INVENTORY_UNKNOWN",
  "INVENTORY_STALE",
  "MARKETING_UNKNOWN",
  "SOURCE_TIME_MISSING",
  "SOURCE_INCONSISTENT",
]);
const QualitySchema = z
  .strictObject({
    state: z.enum(["COMPLETE", "PARTIAL"]),
    issues: z
      .array(ConnectorQualityIssueSchema)
      .max(9)
      .refine((issues) => new Set(issues).size === issues.length)
      .readonly(),
  })
  .refine((quality) => (quality.state === "COMPLETE") === (quality.issues.length === 0))
  .readonly();
export const ConnectorSourceSchema = z
  .strictObject({
    version: SourceVersionSchema.nullable(),
    updatedAt: ConnectorTimestampSchema.nullable(),
    quality: QualitySchema,
  })
  .refine(
    (source) => source.updatedAt !== null || source.quality.issues.includes("SOURCE_TIME_MISSING"),
  )
  .readonly();
type Source = z.infer<typeof ConnectorSourceSchema>;
function declaresMissing(
  source: Source,
  issue: z.infer<typeof ConnectorQualityIssueSchema>,
): boolean {
  return source.quality.state === "PARTIAL" && source.quality.issues.includes(issue);
}
const entityFields = { externalStoreId: ExternalIdSchema, source: ConnectorSourceSchema };
const label = CommerceTextSchema.pipe(z.string().max(200));
export const ConnectorStoreSchema = z
  .strictObject({
    ...entityFields,
    name: label,
    category: label.nullable(),
    currency: CurrencySchema,
    timeZone: z.literal("Asia/Shanghai"),
  })
  .refine((store) => store.category !== null || declaresMissing(store.source, "CATEGORY_MISSING"))
  .readonly();
export const ConnectorSkuSchema = z
  .strictObject({
    externalSkuId: ExternalIdSchema,
    externalProductId: ExternalIdSchema,
    attributes: CommerceAttributesSchema,
    salePriceMinor: MinorAmountSchema,
    costPriceMinor: MinorAmountSchema.nullable(),
    originalPriceMinor: MinorAmountSchema.nullable(),
    status: z.enum(["ACTIVE", "INACTIVE"]),
  })
  .readonly();
export const ConnectorProductSchema = z
  .strictObject({
    ...entityFields,
    externalProductId: ExternalIdSchema,
    title: label,
    description: CommerceTextSchema.nullable(),
    category: label.nullable(),
    brand: label.nullable(),
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "DELETED"]),
    skus: z.array(ConnectorSkuSchema).min(1).max(500).readonly(),
  })
  .refine((product) =>
    product.skus.every((sku) => sku.externalProductId === product.externalProductId),
  )
  .refine(
    (product) => new Set(product.skus.map((sku) => sku.externalSkuId)).size === product.skus.length,
  )
  .refine(
    (product) =>
      product.skus.every((sku) => sku.costPriceMinor !== null) ||
      declaresMissing(product.source, "COST_MISSING"),
  )
  .refine(
    (product) => product.category !== null || declaresMissing(product.source, "CATEGORY_MISSING"),
  )
  .readonly();

export const ConnectorOrderItemSchema = z
  .strictObject({
    externalLineId: ExternalIdSchema,
    externalProductId: ExternalIdSchema,
    externalSkuId: ExternalIdSchema,
    quantity: QuantitySchema.min(1),
    unitPriceMinor: MinorAmountSchema,
    grossMinor: MinorAmountSchema,
    discountMinor: MinorAmountSchema,
    netMinor: MinorAmountSchema,
  })
  .refine(
    (item) =>
      Number.isSafeInteger(item.quantity * item.unitPriceMinor) &&
      item.grossMinor === item.quantity * item.unitPriceMinor,
  )
  .refine(
    (item) =>
      item.discountMinor <= item.grossMinor &&
      item.netMinor === item.grossMinor - item.discountMinor,
  )
  .readonly();
export const ConnectorOrderSchema = z
  .strictObject({
    ...entityFields,
    externalOrderId: ExternalIdSchema,
    status: z.enum(["PENDING_PAYMENT", "PAID", "FULFILLED", "COMPLETED", "CANCELLED", "CLOSED"]),
    orderedAt: ConnectorTimestampSchema,
    paidAt: ConnectorTimestampSchema.nullable(),
    currency: CurrencySchema,
    items: z.array(ConnectorOrderItemSchema).min(1).max(500).readonly(),
    grossMinor: MinorAmountSchema,
    discountMinor: MinorAmountSchema,
    shippingMinor: MinorAmountSchema,
    payableMinor: MinorAmountSchema,
    paidMinor: MinorAmountSchema.nullable(),
    refundedMinor: MinorAmountSchema.nullable(),
  })
  .refine(validOrderAmounts)
  .refine(
    (order) => new Set(order.items.map((item) => item.externalLineId)).size === order.items.length,
  )
  .refine(
    (order) => order.paidAt === null || Date.parse(order.paidAt) >= Date.parse(order.orderedAt),
  )
  .refine((order) => order.paidMinor !== null || declaresMissing(order.source, "PAYMENT_UNKNOWN"))
  .refine(
    (order) => order.refundedMinor !== null || declaresMissing(order.source, "REFUND_UNKNOWN"),
  )
  .readonly();
function validOrderAmounts(order: {
  items: readonly z.infer<typeof ConnectorOrderItemSchema>[];
  grossMinor: number;
  discountMinor: number;
  shippingMinor: number;
  payableMinor: number;
  paidMinor: number | null;
  refundedMinor: number | null;
}): boolean {
  const gross = order.items.reduce((sum, item) => sum + item.grossMinor, 0);
  const discount = order.items.reduce((sum, item) => sum + item.discountMinor, 0);
  const payable = gross - discount + order.shippingMinor;
  return (
    Number.isSafeInteger(gross) &&
    Number.isSafeInteger(discount) &&
    Number.isSafeInteger(payable) &&
    order.grossMinor === gross &&
    order.discountMinor === discount &&
    order.payableMinor === payable &&
    (order.paidMinor === null || order.paidMinor <= payable) &&
    (order.refundedMinor === null || order.refundedMinor <= payable) &&
    (order.refundedMinor === null ||
      order.paidMinor === null ||
      order.refundedMinor <= order.paidMinor)
  );
}
export const ConnectorRefundSchema = z
  .strictObject({
    ...entityFields,
    externalRefundId: ExternalIdSchema,
    externalOrderId: ExternalIdSchema,
    externalSkuId: ExternalIdSchema.nullable(),
    status: z.enum([
      "REQUESTED",
      "APPROVED",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED",
      "REJECTED",
      "CANCELLED",
    ]),
    requestedMinor: MinorAmountSchema,
    succeededMinor: MinorAmountSchema.nullable(),
    requestedAt: ConnectorTimestampSchema,
    succeededAt: ConnectorTimestampSchema.nullable(),
    currency: CurrencySchema,
  })
  .refine(
    (refund) => refund.succeededMinor === null || refund.succeededMinor <= refund.requestedMinor,
  )
  .refine(
    (refund) =>
      refund.succeededAt === null ||
      Date.parse(refund.succeededAt) >= Date.parse(refund.requestedAt),
  )
  .refine(
    (refund) =>
      refund.status !== "SUCCEEDED" ||
      (refund.succeededMinor !== null && refund.succeededAt !== null) ||
      declaresMissing(refund.source, "REFUND_UNKNOWN"),
  )
  .readonly();
export const ConnectorInventorySchema = z
  .strictObject({
    ...entityFields,
    externalSkuId: ExternalIdSchema,
    externalLocationId: ExternalIdSchema,
    available: QuantitySchema.nullable(),
    reserved: QuantitySchema.nullable(),
    onHand: QuantitySchema.nullable(),
    safetyStock: QuantitySchema.nullable(),
    leadTimeDays: z.number().int().min(0).max(365).nullable(),
  })
  .refine(
    (inventory) =>
      [inventory.available, inventory.reserved, inventory.onHand].every(
        (value) => value !== null,
      ) || declaresMissing(inventory.source, "INVENTORY_UNKNOWN"),
  )
  .refine(
    (inventory) =>
      inventory.available === null ||
      inventory.reserved === null ||
      inventory.onHand === null ||
      inventory.available + inventory.reserved <= inventory.onHand,
  )
  .readonly();
export const ConnectorCampaignMetricSchema = z
  .strictObject({
    ...entityFields,
    externalCampaignId: ExternalIdSchema,
    date: z.iso.date(),
    impressions: QuantitySchema.nullable(),
    clicks: QuantitySchema.nullable(),
    attributedOrders: QuantitySchema.nullable(),
    spendMinor: MinorAmountSchema.nullable(),
    attributedRevenueMinor: MinorAmountSchema.nullable(),
    currency: CurrencySchema,
  })
  .refine(
    (metric) =>
      [
        metric.impressions,
        metric.clicks,
        metric.attributedOrders,
        metric.spendMinor,
        metric.attributedRevenueMinor,
      ].every((value) => value !== null) || declaresMissing(metric.source, "MARKETING_UNKNOWN"),
  )
  .readonly();

export type ConnectorStore = z.infer<typeof ConnectorStoreSchema>;
export type ConnectorSku = z.infer<typeof ConnectorSkuSchema>;
export type ConnectorProduct = z.infer<typeof ConnectorProductSchema>;
export type ConnectorOrderItem = z.infer<typeof ConnectorOrderItemSchema>;
export type ConnectorOrder = z.infer<typeof ConnectorOrderSchema>;
export type ConnectorRefund = z.infer<typeof ConnectorRefundSchema>;
export type ConnectorInventory = z.infer<typeof ConnectorInventorySchema>;
export type ConnectorCampaignMetric = z.infer<typeof ConnectorCampaignMetricSchema>;
