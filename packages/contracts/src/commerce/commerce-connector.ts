import type {
  ConnectorBinding,
  ConnectorCapabilities,
  ConnectorPage,
  ConnectorResult,
  ExternalOrderRef,
  ExternalProductRef,
  InventoryQuery,
  MarketingQuery,
  ReadOptions,
  SyncPageQuery,
} from "./connector-common.schema.js";
import type {
  ConnectorCampaignMetric,
  ConnectorInventory,
  ConnectorOrder,
  ConnectorProduct,
  ConnectorRefund,
  ConnectorStore,
} from "./connector-data.schema.js";
import type {
  CreateProductCommand,
  SetInventoryCommand,
  SetPriceCommand,
  UpdateProductCommand,
  VerificationResult,
  VerifyActionQuery,
  WriteReceipt,
} from "./connector-action.schema.js";

/**
 * A server-side instance is bound to one verified Store/Connection.
 * Adapters validate unknown inputs and outputs and enforce deadlines/cancellation.
 * Capabilities describe provider behavior; the caller still enforces authorization.
 * ACCEPTED is a receipt, and UNKNOWN requires readback before deciding to retry.
 */
export interface CommerceConnector {
  readonly binding: ConnectorBinding;
  readonly capabilities: ConnectorCapabilities;
  getStore(options: ReadOptions): Promise<ConnectorResult<ConnectorStore>>;
  listProducts(
    query: SyncPageQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorProduct>>>;
  getProduct(
    ref: ExternalProductRef,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorProduct>>;
  listOrders(
    query: SyncPageQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorOrder>>>;
  getOrder(ref: ExternalOrderRef, options: ReadOptions): Promise<ConnectorResult<ConnectorOrder>>;
  listRefunds(
    query: SyncPageQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorRefund>>>;
  getInventory(
    query: InventoryQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorInventory>>>;
  getMarketingMetrics(
    query: MarketingQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorCampaignMetric>>>;
  updatePrice(command: SetPriceCommand, options: ReadOptions): Promise<WriteReceipt>;
  updateInventory(command: SetInventoryCommand, options: ReadOptions): Promise<WriteReceipt>;
  createProduct(command: CreateProductCommand, options: ReadOptions): Promise<WriteReceipt>;
  updateProduct(command: UpdateProductCommand, options: ReadOptions): Promise<WriteReceipt>;
  verifyAction(
    query: VerifyActionQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<VerificationResult>>;
}
