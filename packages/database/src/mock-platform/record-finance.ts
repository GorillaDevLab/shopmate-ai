import type {
  SourceOrderItemRecord,
  SourceOrderRecord,
  SourceRefundRecord,
  SourceInventoryRecord,
  SourceRecordMetadata,
  SourceQualityIssue,
} from "./publication-types.js";

export function declares(source: SourceRecordMetadata, issue: SourceQualityIssue): boolean {
  return source.quality.state === "PARTIAL" && source.quality.issues.includes(issue);
}
export function validLine(item: SourceOrderItemRecord): boolean {
  const gross = BigInt(item.quantity) * BigInt(item.unitPriceMinor);
  return (
    gross <= BigInt(Number.MAX_SAFE_INTEGER) &&
    BigInt(item.grossMinor) === gross &&
    item.discountMinor <= item.grossMinor &&
    BigInt(item.netMinor) === gross - BigInt(item.discountMinor)
  );
}
export function validOrderAmounts(order: SourceOrderRecord): boolean {
  const gross = order.items.reduce((sum, item) => sum + BigInt(item.grossMinor), 0n);
  const discount = order.items.reduce((sum, item) => sum + BigInt(item.discountMinor), 0n);
  const payable = gross - discount + BigInt(order.shippingMinor);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return (
    gross <= max &&
    discount <= max &&
    payable <= max &&
    BigInt(order.grossMinor) === gross &&
    BigInt(order.discountMinor) === discount &&
    BigInt(order.payableMinor) === payable &&
    (order.paidMinor === null || BigInt(order.paidMinor) <= payable) &&
    (order.refundedMinor === null || BigInt(order.refundedMinor) <= payable) &&
    (order.refundedMinor === null ||
      order.paidMinor === null ||
      order.refundedMinor <= order.paidMinor)
  );
}
export function validPaymentState(order: SourceOrderRecord): boolean {
  const settled = ["PAID", "FULFILLED", "COMPLETED"].includes(order.status);
  const contradicts =
    (settled && order.paidMinor !== null && order.paidMinor !== order.payableMinor) ||
    (order.status === "PENDING_PAYMENT" &&
      ((order.paidMinor !== null && order.paidMinor > 0) || order.paidAt !== null));
  if (contradicts && !declares(order.source, "SOURCE_INCONSISTENT")) return false;
  return (
    order.paidAt !== null ||
    (!settled && (order.paidMinor === null || order.paidMinor === 0)) ||
    declares(order.source, "PAYMENT_UNKNOWN")
  );
}
export function validRefund(refund: SourceRefundRecord): boolean {
  const missing = declares(refund.source, "REFUND_UNKNOWN");
  const inconsistent = declares(refund.source, "SOURCE_INCONSISTENT");
  return (
    (refund.succeededMinor === null || refund.succeededMinor <= refund.requestedMinor) &&
    (refund.succeededAt === null || refund.succeededAt >= refund.requestedAt) &&
    (refund.status !== "SUCCEEDED" ||
      (refund.succeededMinor !== null && refund.succeededAt !== null) ||
      missing) &&
    (refund.status === "SUCCEEDED" ||
      ((refund.succeededMinor === null || refund.succeededMinor === 0) &&
        refund.succeededAt === null) ||
      inconsistent)
  );
}
export function validInventory(inventory: SourceInventoryRecord): boolean {
  if (inventory.available === null || inventory.reserved === null || inventory.onHand === null)
    return declares(inventory.source, "INVENTORY_UNKNOWN");
  return BigInt(inventory.available) + BigInt(inventory.reserved) <= BigInt(inventory.onHand);
}
