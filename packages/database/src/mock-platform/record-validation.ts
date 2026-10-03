import type {
  SnapshotKind,
  SourceRecordMetadata,
  SourceProductRecord,
  SourceOrderRecord,
  SourceOrderItemRecord,
  SourceRefundRecord,
  SourceInventoryRecord,
} from "./publication-types.js";
import type { SourceScope } from "./types.js";
import { externalId } from "./validation.js";
import {
  amount,
  fields,
  id,
  list,
  nullable,
  oneOf,
  requireInput,
  representable,
  text,
  unique,
  validateDate,
  validateUtc,
} from "./record-primitives.js";
import {
  declares,
  validInventory,
  validLine,
  validOrderAmounts,
  validPaymentState,
  validRefund,
} from "./record-finance.js";

const commonKeys = ["externalStoreId", "source"];
const issues = [
  "COST_MISSING",
  "CATEGORY_MISSING",
  "PAYMENT_UNKNOWN",
  "REFUND_UNKNOWN",
  "INVENTORY_UNKNOWN",
  "INVENTORY_STALE",
  "MARKETING_UNKNOWN",
  "SOURCE_TIME_MISSING",
  "SOURCE_INCONSISTENT",
];
type Guard = (value: unknown) => boolean;
type Rules = Readonly<Record<string, Guard>>;
const label: Guard = (v) => text(v, 200);
const maybeLabel: Guard = (v) => nullable(v, label);
const maybeAmount: Guard = (v) => nullable(v, amount);
const maybeUtc: Guard = (v) => nullable(v, validateUtc);
const currency: Guard = (v) => v === "CNY";
function shape(value: unknown, rules: Rules, entity = true): Record<string, unknown> {
  const result = fields(value, [...(entity ? commonKeys : []), ...Object.keys(rules)]);
  requireInput(Object.entries(rules).every(([key, guard]) => guard(result[key])));
  return result;
}
function validateSource(value: unknown, occurredAt: string): SourceRecordMetadata {
  const result = fields(value, ["version", "updatedAt", "quality"]);
  const quality = fields(result.quality, ["state", "issues"]);
  requireInput(
    result.version === null && result.updatedAt === occurredAt && validateUtc(result.updatedAt),
  );
  requireInput(oneOf(quality.state, ["COMPLETE", "PARTIAL"]) && list(quality.issues, 0, 9));
  requireInput(quality.issues.every((v) => oneOf(v, issues)) && unique(quality.issues));
  requireInput((quality.state === "COMPLETE") === (quality.issues.length === 0));
  return result as unknown as SourceRecordMetadata;
}
function attributes(value: unknown): boolean {
  if (!list(value, 0, 30)) return false;
  const entries = value.map((v) =>
    shape(v, { name: (n) => text(n, 100), value: (n) => text(n, 200) }, false),
  );
  return unique(entries.map((v) => v.name));
}
function skus(value: unknown): boolean {
  if (!list(value, 1)) return false;
  const rules = {
    externalSkuId: id,
    externalProductId: id,
    attributes,
    salePriceMinor: amount,
    costPriceMinor: maybeAmount,
    originalPriceMinor: maybeAmount,
    status: (v: unknown) => oneOf(v, ["ACTIVE", "INACTIVE"]),
  };
  value.forEach((v) => shape(v, rules, false));
  return true;
}
function items(value: unknown): boolean {
  if (!list(value, 1)) return false;
  const rules = {
    externalLineId: id,
    externalProductId: id,
    externalSkuId: id,
    quantity: (v: unknown) => amount(v) && v > 0,
    unitPriceMinor: amount,
    grossMinor: amount,
    discountMinor: amount,
    netMinor: amount,
  };
  return value.every((v) => validLine(shape(v, rules, false) as unknown as SourceOrderItemRecord));
}
const rules: Readonly<Record<SnapshotKind, Rules>> = {
  STORE: { name: label, category: maybeLabel, currency, timeZone: (v) => v === "Asia/Shanghai" },
  PRODUCT: {
    externalProductId: id,
    title: label,
    description: (v) => nullable(v, text),
    category: maybeLabel,
    brand: maybeLabel,
    status: (v) => oneOf(v, ["DRAFT", "ACTIVE", "INACTIVE", "DELETED"]),
    skus,
  },
  ORDER: {
    externalOrderId: id,
    status: (v) =>
      oneOf(v, ["PENDING_PAYMENT", "PAID", "FULFILLED", "COMPLETED", "CANCELLED", "CLOSED"]),
    orderedAt: validateUtc,
    paidAt: maybeUtc,
    currency,
    items,
    grossMinor: amount,
    discountMinor: amount,
    shippingMinor: amount,
    payableMinor: amount,
    paidMinor: maybeAmount,
    refundedMinor: maybeAmount,
  },
  REFUND: {
    externalRefundId: id,
    externalOrderId: id,
    externalSkuId: (v) => nullable(v, id),
    status: (v) =>
      oneOf(v, [
        "REQUESTED",
        "APPROVED",
        "PROCESSING",
        "SUCCEEDED",
        "FAILED",
        "REJECTED",
        "CANCELLED",
      ]),
    requestedMinor: amount,
    succeededMinor: maybeAmount,
    requestedAt: validateUtc,
    succeededAt: maybeUtc,
    currency,
  },
  INVENTORY: {
    externalSkuId: id,
    externalLocationId: id,
    available: maybeAmount,
    reserved: maybeAmount,
    onHand: maybeAmount,
    safetyStock: maybeAmount,
    leadTimeDays: (v) => v === null || (amount(v) && v <= 365),
  },
  MARKETING: {
    externalCampaignId: id,
    date: validateDate,
    impressions: maybeAmount,
    clicks: maybeAmount,
    attributedOrders: maybeAmount,
    spendMinor: maybeAmount,
    attributedRevenueMinor: maybeAmount,
    currency,
  },
};
function validProduct(value: SourceProductRecord): boolean {
  return (
    value.skus.every((s) => s.externalProductId === value.externalProductId) &&
    unique(value.skus.map((s) => s.externalSkuId)) &&
    (value.skus.every((s) => s.costPriceMinor !== null) ||
      declares(value.source, "COST_MISSING")) &&
    (value.category !== null || declares(value.source, "CATEGORY_MISSING"))
  );
}
function validOrder(value: SourceOrderRecord): boolean {
  return (
    validOrderAmounts(value) &&
    validPaymentState(value) &&
    unique(value.items.map((i) => i.externalLineId)) &&
    (value.paidAt === null || value.paidAt >= value.orderedAt) &&
    (value.paidMinor !== null || declares(value.source, "PAYMENT_UNKNOWN")) &&
    (value.refundedMinor !== null || declares(value.source, "REFUND_UNKNOWN"))
  );
}
function refinements(
  kind: SnapshotKind,
  value: Record<string, unknown>,
  source: SourceRecordMetadata,
): boolean {
  switch (kind) {
    case "STORE":
      return value.category !== null || declares(source, "CATEGORY_MISSING");
    case "PRODUCT":
      return validProduct(value as unknown as SourceProductRecord);
    case "ORDER":
      return validOrder(value as unknown as SourceOrderRecord);
    case "REFUND":
      return validRefund(value as unknown as SourceRefundRecord);
    case "INVENTORY":
      return validInventory(value as unknown as SourceInventoryRecord);
    case "MARKETING":
      return (
        [
          value.impressions,
          value.clicks,
          value.attributedOrders,
          value.spendMinor,
          value.attributedRevenueMinor,
        ].every((v) => v !== null) || declares(source, "MARKETING_UNKNOWN")
      );
  }
}
// Called only after descriptor-safe bounds validation; no getters are read here.
export function validateRecord(
  kind: SnapshotKind,
  value: unknown,
  scope: SourceScope,
  occurredAt: string,
): void {
  const record = shape(value, rules[kind]);
  requireInput(
    externalId(record.externalStoreId) &&
      representable(record.externalStoreId) &&
      record.externalStoreId === scope.externalStoreId,
  );
  const source = validateSource(record.source, occurredAt);
  requireInput(refinements(kind, record, source));
}
