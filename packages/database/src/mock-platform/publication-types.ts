import type { SourceScope } from "./types.js";

export type UInt = string;
export type Utc = string;
export type Hash = string;
export type SourceQualityIssue =
  | "COST_MISSING"
  | "CATEGORY_MISSING"
  | "PAYMENT_UNKNOWN"
  | "REFUND_UNKNOWN"
  | "INVENTORY_UNKNOWN"
  | "INVENTORY_STALE"
  | "MARKETING_UNKNOWN"
  | "SOURCE_TIME_MISSING"
  | "SOURCE_INCONSISTENT";
export interface SourceRecordMetadata {
  readonly version: string | null;
  readonly updatedAt: Utc | null;
  readonly quality: {
    readonly state: "COMPLETE" | "PARTIAL";
    readonly issues: readonly SourceQualityIssue[];
  };
}
interface SourceRecord {
  readonly externalStoreId: string;
  readonly source: SourceRecordMetadata;
}
export interface SourceStoreRecord extends SourceRecord {
  readonly name: string;
  readonly category: string | null;
  readonly currency: "CNY";
  readonly timeZone: "Asia/Shanghai";
}
export interface SourceSkuRecord {
  readonly externalSkuId: string;
  readonly externalProductId: string;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly salePriceMinor: number;
  readonly costPriceMinor: number | null;
  readonly originalPriceMinor: number | null;
  readonly status: "ACTIVE" | "INACTIVE";
}
export interface SourceProductRecord extends SourceRecord {
  readonly externalProductId: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly brand: string | null;
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE" | "DELETED";
  readonly skus: readonly SourceSkuRecord[];
}
export interface SourceOrderItemRecord {
  readonly externalLineId: string;
  readonly externalProductId: string;
  readonly externalSkuId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly netMinor: number;
}
export interface SourceOrderRecord extends SourceRecord {
  readonly externalOrderId: string;
  readonly status: "PENDING_PAYMENT" | "PAID" | "FULFILLED" | "COMPLETED" | "CANCELLED" | "CLOSED";
  readonly orderedAt: Utc;
  readonly paidAt: Utc | null;
  readonly currency: "CNY";
  readonly items: readonly SourceOrderItemRecord[];
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly shippingMinor: number;
  readonly payableMinor: number;
  readonly paidMinor: number | null;
  readonly refundedMinor: number | null;
}
export interface SourceRefundRecord extends SourceRecord {
  readonly externalRefundId: string;
  readonly externalOrderId: string;
  readonly externalSkuId: string | null;
  readonly status:
    | "REQUESTED"
    | "APPROVED"
    | "PROCESSING"
    | "SUCCEEDED"
    | "FAILED"
    | "REJECTED"
    | "CANCELLED";
  readonly requestedMinor: number;
  readonly succeededMinor: number | null;
  readonly requestedAt: Utc;
  readonly succeededAt: Utc | null;
  readonly currency: "CNY";
}
export interface SourceInventoryRecord extends SourceRecord {
  readonly externalSkuId: string;
  readonly externalLocationId: string;
  readonly available: number | null;
  readonly reserved: number | null;
  readonly onHand: number | null;
  readonly safetyStock: number | null;
  readonly leadTimeDays: number | null;
}
export interface SourceMarketingRecord extends SourceRecord {
  readonly externalCampaignId: string;
  readonly date: string;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly attributedOrders: number | null;
  readonly spendMinor: number | null;
  readonly attributedRevenueMinor: number | null;
  readonly currency: "CNY";
}
type EventOf<K, R> = {
  readonly kind: K;
  readonly occurredAt: Utc;
  readonly ordinal: UInt;
  readonly after: R;
};
export type SnapshotEvent =
  | EventOf<"STORE", SourceStoreRecord>
  | EventOf<"PRODUCT", SourceProductRecord>
  | EventOf<"ORDER", SourceOrderRecord>
  | EventOf<"REFUND", SourceRefundRecord>
  | EventOf<"INVENTORY", SourceInventoryRecord>
  | EventOf<"MARKETING", SourceMarketingRecord>;
export type SnapshotKind = SnapshotEvent["kind"];
export type EntityKey =
  | readonly ["STORE" | "PRODUCT" | "ORDER" | "REFUND", string]
  | readonly ["INVENTORY", string, string]
  | readonly ["MARKETING", string, string];
export interface LastEvent {
  readonly occurredAt: Utc;
  readonly kind: SnapshotKind;
  readonly entityKey: EntityKey;
  readonly ordinal: UInt;
}
export interface Checkpoint {
  readonly codec: "source-checkpoint-v1";
  readonly chunkIndex: UInt;
  readonly highEventSeq: UInt;
  readonly processedThrough: Utc;
  readonly lastEvent: LastEvent | null;
  readonly sealed: boolean;
}
export interface LeaseRef {
  readonly scope: SourceScope;
  readonly revision: UInt;
  readonly fence: UInt;
  readonly ownerId: string;
}
export interface BuildLease extends LeaseRef {
  readonly targetClockRevision: number;
  readonly targetTime: Utc;
  readonly baseRevision: UInt;
  readonly baseHighEventSeq: UInt;
  readonly checkpoint: Checkpoint;
  readonly checkpointHash: Hash;
  readonly leaseUntil: Utc;
}
export interface ChunkInput {
  readonly expectedCheckpointHash: Hash;
  readonly next: { readonly processedThrough: Utc; readonly sealed: boolean };
  readonly events: readonly SnapshotEvent[];
}
export interface PublishInput {
  readonly expectedBaseRevision: UInt;
  readonly checkpointHash: Hash;
}
export interface Publication {
  readonly scope: SourceScope;
  readonly revision: UInt;
  readonly targetClockRevision: number;
  readonly targetTime: Utc;
  readonly baseRevision: UInt;
  readonly baseHighEventSeq: UInt;
  readonly highEventSeq: UInt;
  readonly eventCount: UInt;
  readonly versionCount: UInt;
  readonly processedThrough: Utc;
  readonly generatorVersion: "mock-source-v1";
  readonly runtimeVersion: "mock-runtime-v2";
  readonly codec: "source-snapshot-v1";
  readonly publishedAt: Utc;
  readonly certificateHash: Hash;
}
export type ClaimResult =
  | { readonly status: "CLAIMED"; readonly lease: BuildLease }
  | { readonly status: "IDLE" | "BUSY" | "DENIED" | "UNINITIALIZED" };
export type RenewResult =
  | { readonly status: "RENEWED"; readonly lease: BuildLease }
  | { readonly status: "FENCED" | "DENIED" };
export type AppendResult =
  | {
      readonly status: "COMMITTED" | "ALREADY_COMMITTED";
      readonly checkpoint: Checkpoint;
      readonly checkpointHash: Hash;
    }
  | { readonly status: "FENCED" | "CONFLICT" | "DENIED" };
export type FailResult = { readonly status: "FAILED" } | { readonly status: "FENCED" | "DENIED" };
export type PublishResult =
  | { readonly status: "PUBLISHED" | "ALREADY_PUBLISHED"; readonly publication: Publication }
  | { readonly status: "FENCED" | "CONFLICT" | "DENIED" };
