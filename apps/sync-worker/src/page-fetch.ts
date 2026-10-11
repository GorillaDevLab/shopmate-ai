import {
  ConnectorBindingSchema,
  ConnectorFailureSchema,
  ConnectorProductSchema,
  ConnectorOrderSchema,
  ConnectorRefundSchema,
  ConnectorInventorySchema,
  ConnectorCampaignMetricSchema,
  parseConnectorPage,
  type CommerceConnector,
  type ConnectorResult,
  type ReadOptions,
  type ConnectorPage,
  type SyncPageQuery,
} from "@shopmate/contracts";
import type { SyncJob } from "@shopmate/database/sync-host";
export type BusinessPage = ConnectorPage<unknown>;
export function checkConnectorBinding(connector: CommerceConnector, job: SyncJob): void {
  const parsed = ConnectorBindingSchema.safeParse(connector.binding);
  if (
    !parsed.success ||
    Object.entries(parsed.data).some(([key, value]) => value !== job[key as keyof SyncJob])
  )
    throw new Error("SYNC_RUN_BINDING_INVALID");
}
async function sourceRead(
  connector: CommerceConnector,
  job: SyncJob,
  query: SyncPageQuery,
  opening: string,
  options: ReadOptions,
): Promise<ConnectorResult<BusinessPage>> {
  switch (job.stream) {
    case "PRODUCTS":
      return connector.listProducts(query, options);
    case "ORDERS":
      return connector.listOrders(query, options);
    case "REFUNDS":
      return connector.listRefunds(query, options);
    case "INVENTORY":
      return connector.getInventory(query, options);
    case "MARKETING":
      return connector.getMarketingMetrics({ ...query, since: opening }, options);
  }
}
function validatedPage(
  job: SyncJob,
  query: SyncPageQuery,
  opening: string,
  page: BusinessPage,
): ConnectorResult<BusinessPage> {
  switch (job.stream) {
    case "PRODUCTS":
      return parseConnectorPage(ConnectorProductSchema, job.externalStoreId, query, page);
    case "ORDERS":
      return parseConnectorPage(ConnectorOrderSchema, job.externalStoreId, query, page);
    case "REFUNDS":
      return parseConnectorPage(ConnectorRefundSchema, job.externalStoreId, query, page);
    case "INVENTORY":
      return parseConnectorPage(ConnectorInventorySchema, job.externalStoreId, query, page);
    case "MARKETING":
      return parseConnectorPage(
        ConnectorCampaignMetricSchema,
        job.externalStoreId,
        { ...query, since: opening },
        page,
      );
  }
}
export async function fetchBusinessPage(
  connector: CommerceConnector,
  job: SyncJob,
  opening: string,
  options: ReadOptions,
): Promise<ConnectorResult<BusinessPage>> {
  const query: SyncPageQuery = {
    until: job.until,
    limit: job.stream === "ORDERS" ? 10 : 200,
    ...(job.cursor === null ? {} : { cursor: job.cursor }),
  };
  const result = await sourceRead(connector, job, query, opening, options);
  return result.ok ? validatedPage(job, query, opening, result.data) : result;
}
export function retryableFailure(result: Extract<ConnectorResult<BusinessPage>, { ok: false }>) {
  const parsed = ConnectorFailureSchema.safeParse(result.error);
  if (!parsed.success) throw new Error("SYNC_CONNECTOR_INVALID_RESPONSE");
  if (!["TEMPORARY", "TIMEOUT", "RATE_LIMIT"].includes(parsed.data.code))
    throw new Error(`SYNC_CONNECTOR_${parsed.data.code}`);
  return parsed.data;
}
