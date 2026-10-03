import type { EntityKey, LastEvent, SnapshotEvent, SnapshotKind } from "./publication-types.js";
import { id, list, requireInput, validateDate } from "./record-primitives.js";
import { externalId } from "./validation.js";

export const snapshotKinds = [
  "STORE",
  "PRODUCT",
  "ORDER",
  "REFUND",
  "INVENTORY",
  "MARKETING",
] as const;
export const phaseRanks: Readonly<Record<SnapshotKind, number>> = {
  STORE: 0,
  PRODUCT: 10,
  ORDER: 20,
  REFUND: 30,
  INVENTORY: 40,
  MARKETING: 50,
};
export function entityKey(event: SnapshotEvent): EntityKey {
  switch (event.kind) {
    case "STORE":
      return ["STORE", event.after.externalStoreId];
    case "PRODUCT":
      return ["PRODUCT", event.after.externalProductId];
    case "ORDER":
      return ["ORDER", event.after.externalOrderId];
    case "REFUND":
      return ["REFUND", event.after.externalRefundId];
    case "INVENTORY":
      return ["INVENTORY", event.after.externalSkuId, event.after.externalLocationId];
    case "MARKETING":
      return ["MARKETING", event.after.externalCampaignId, event.after.date];
  }
}
export function validateEntityKey(kind: SnapshotKind, value: unknown): void {
  const triple = kind === "INVENTORY" || kind === "MARKETING";
  requireInput(list(value, triple ? 3 : 2, triple ? 3 : 2) && value[0] === kind);
  requireInput(kind === "STORE" ? externalId(value[1]) : id(value[1]));
  if (kind === "INVENTORY") requireInput(id(value[2]));
  if (kind === "MARKETING") requireInput(validateDate(value[2]));
}
function databaseKeyText(key: EntityKey): string {
  // Ordering only: a closed array of validated strings, comma-space separators.
  // PostgreSQL constructs every hash envelope; this is not a general JSONB encoder.
  return `[${key.map((part) => JSON.stringify(part)).join(", ")}]`;
}
export function compareEventTuples(left: LastEvent, right: LastEvent): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? -1 : 1;
  const phase = phaseRanks[left.kind] - phaseRanks[right.kind];
  if (phase) return phase;
  // PostgreSQL COLLATE C orders UTF-8 bytes, unlike JavaScript UTF-16 ordering.
  const key = Buffer.compare(
    Buffer.from(databaseKeyText(left.entityKey)),
    Buffer.from(databaseKeyText(right.entityKey)),
  );
  if (key) return key;
  const a = BigInt(left.ordinal),
    b = BigInt(right.ordinal);
  return a === b ? 0 : a < b ? -1 : 1;
}
export function eventTuple(event: SnapshotEvent): LastEvent {
  return {
    kind: event.kind,
    occurredAt: event.occurredAt,
    entityKey: entityKey(event),
    ordinal: event.ordinal,
  };
}
