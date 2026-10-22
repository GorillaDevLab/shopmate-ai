import type {
  ConnectorBinding,
  ConnectorOrder,
  ConnectorRefund,
  ConnectorInventory,
  ConnectorCampaignMetric,
  MetricResult,
  MetricSnapshotQuery,
  TenantContext,
} from "@shopmate/contracts";
import type { Pool } from "pg";

export type MetricSourceStream = "ORDERS" | "REFUNDS" | "INVENTORY" | "MARKETING";
export interface NormalizedMetricFact<T> {
  readonly data: T;
  readonly sourcePayloadHash: string;
  /** Conservative maximum actual business observation across this stream's committed pages. */
  readonly observedAt: string;
  readonly ingestedAt: string;
}
export interface MetricSourceReceipt {
  readonly pageId: string;
  readonly pageHash: string;
  readonly expectedCursor: string | null;
  readonly nextCursor: string | null;
  readonly observedAt: string;
  readonly sourceWatermark: string;
  readonly ingestedAt: string;
}
export interface MetricSourcePrefix {
  readonly jobId: string;
  readonly stream: MetricSourceStream;
  readonly since: string;
  readonly until: string;
  readonly successfulThrough: string;
  readonly proof: Readonly<{
    pageCount: number;
    terminalCount: 1;
    knownCount: number;
    sourceWatermark: string;
    observedAt: string;
  }>;
  readonly receipts: readonly MetricSourceReceipt[];
}
export interface NormalizedMetricSourceBundle {
  readonly mappingVersion: "p2-normalized-v1";
  readonly binding: ConnectorBinding;
  readonly scopeId: string;
  readonly provider: "MOCK";
  readonly generation: number;
  readonly window: MetricSnapshotQuery["window"];
  readonly visibleAt: string;
  readonly businessNow: string;
  readonly clockRevision: number;
  readonly sourceOpening: string;
  readonly sourceWatermark: string;
  readonly inputRevision: string;
  readonly capturedAt: string;
  readonly evidenceIds: readonly string[];
  readonly prefixes: readonly MetricSourcePrefix[];
  readonly orders: readonly NormalizedMetricFact<ConnectorOrder>[];
  readonly refunds: readonly NormalizedMetricFact<ConnectorRefund>[];
  readonly inventory: readonly NormalizedMetricFact<ConnectorInventory>[];
  readonly campaigns: readonly NormalizedMetricFact<ConnectorCampaignMetric>[];
}
export interface MetricSourceCaptureRequest {
  readonly binding: ConnectorBinding;
  readonly window: MetricSnapshotQuery["window"];
  readonly visibleAt: string;
}
export interface MetricSourceReadRequest extends MetricSourceCaptureRequest {
  readonly inputRevision: string;
}
export interface MetricSourceBundleRepository {
  readonly resolve: (storeId: string) => Promise<MetricResult<ConnectorBinding>>;
  readonly capture: (
    request: MetricSourceCaptureRequest,
  ) => Promise<MetricResult<NormalizedMetricSourceBundle>>;
  readonly read: (
    request: MetricSourceReadRequest,
  ) => Promise<MetricResult<NormalizedMetricSourceBundle>>;
}
export interface MetricSourceBundleRepositoryOptions {
  readonly pool: Pick<Pool, "connect">;
  readonly actor: TenantContext;
}
