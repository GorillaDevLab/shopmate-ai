import type {
  ConnectorStore,
  ConnectorProduct,
  ConnectorOrder,
  ConnectorRefund,
  ConnectorInventory,
  ConnectorCampaignMetric,
} from "@shopmate/contracts";
type SnapshotOf<K, R> = {
  readonly kind: K;
  readonly occurredAt: string;
  readonly ordinal: string;
  readonly after: R;
};
/** Provider-neutral synthetic snapshots; the privileged worker adapter allocates source versions. */
export type SourceGroupSnapshot =
  | SnapshotOf<"STORE", ConnectorStore>
  | SnapshotOf<"PRODUCT", ConnectorProduct>
  | SnapshotOf<"ORDER", ConnectorOrder>
  | SnapshotOf<"REFUND", ConnectorRefund>
  | SnapshotOf<"INVENTORY", ConnectorInventory>
  | SnapshotOf<"MARKETING", ConnectorCampaignMetric>;
export type SourceGroupEntityKey =
  | readonly ["STORE" | "PRODUCT" | "ORDER" | "REFUND", string]
  | readonly ["INVENTORY" | "MARKETING", string, string];
