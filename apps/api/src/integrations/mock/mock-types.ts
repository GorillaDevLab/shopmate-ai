import type {
  ConnectorBinding,
  ConnectorCampaignMetric,
  ConnectorInventory,
  ConnectorOrder,
  ConnectorRefund,
  ConnectorStore,
} from "@shopmate/contracts";
import type { CatalogEntry } from "./mock-catalog.js";

export interface InventoryEvent {
  readonly eventId: string;
  readonly externalSkuId: string;
  readonly externalOrderId: string | null;
  readonly kind: "RESTOCK" | "RESERVE" | "RELEASE" | "SHIP" | "RETURN";
  readonly at: string;
  readonly onHandDelta: number;
  readonly reservedDelta: number;
}

export interface OrderEconomics {
  readonly externalOrderId: string;
  readonly campaignId: string | null;
  readonly costMinor: number | null;
  readonly fulfillmentShippingMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
}

export interface MockSnapshot {
  readonly generatorVersion: string;
  readonly binding: ConnectorBinding;
  readonly observedAt: string;
  readonly historyUntil: string;
  readonly datasetHash: string;
  readonly store: ConnectorStore | null;
  readonly catalog: readonly CatalogEntry[];
  readonly orders: readonly ConnectorOrder[];
  readonly economics: readonly OrderEconomics[];
  readonly refunds: readonly ConnectorRefund[];
  readonly inventory: readonly ConnectorInventory[];
  readonly ledger: readonly InventoryEvent[];
  readonly marketing: readonly ConnectorCampaignMetric[];
}

export type Mutable<T> = { -readonly [P in keyof T]: T[P] };
export interface InventoryBalance {
  onHand: number;
  reserved: number;
  updatedAt: string;
}
export interface ReplayState {
  orders: Map<string, Mutable<ConnectorOrder>>;
  economics: Map<string, Mutable<OrderEconomics>>;
  balances: Map<string, InventoryBalance>;
  refunds: ConnectorRefund[];
  ledger: InventoryEvent[];
}
