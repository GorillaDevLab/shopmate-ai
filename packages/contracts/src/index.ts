export {
  DashboardMetricSchema,
  DashboardPreviewSchema,
} from "./dashboard/dashboard-preview.schema.js";
export type { DashboardMetric, DashboardPreview } from "./dashboard/dashboard-preview.schema.js";
export {
  MoneySchema,
  PaginationSchema,
  ProductDetailParamsSchema,
  ProductDetailSchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  ProductSkuSchema,
  ProductStatusFilterSchema,
  ProductStatusSchema,
  ProductSummarySchema,
} from "./product/product.schema.js";
export type {
  Money,
  Pagination,
  ProductDetail,
  ProductDetailParams,
  ProductListQuery,
  ProductListResponse,
  ProductSku,
  ProductStatus,
  ProductStatusFilter,
  ProductSummary,
} from "./product/product.schema.js";
export {
  DashboardHotProductSchema,
  DashboardInventoryAlertSchema,
  DashboardStockForecastSchema,
} from "./dashboard/dashboard-products.schema.js";
export type {
  DashboardHotProduct,
  DashboardInventoryAlert,
  DashboardStockForecast,
} from "./dashboard/dashboard-products.schema.js";
export {
  AnalyticsDashboardQuerySchema,
  AnalyticsDashboardResponseSchema,
} from "./analytics/dashboard-api.schema.js";
export type {
  AnalyticsDashboardQuery,
  AnalyticsDashboardResponse,
} from "./analytics/dashboard-api.schema.js";

export {
  DASHBOARD_COMPONENT_REGISTRY,
  DashboardLayoutCardSchema,
  DashboardLayoutComponentSchema,
  DashboardLayoutSchema,
  DashboardLayoutSizeSchema,
  DashboardLayoutVersionSchema,
  DEFAULT_DASHBOARD_LAYOUT,
} from "./dashboard/dashboard-layout.schema.js";
export type {
  DashboardLayout,
  DashboardLayoutCard,
  DashboardLayoutComponent,
  DashboardLayoutSize,
  DashboardLayoutVersion,
} from "./dashboard/dashboard-layout.schema.js";

export {
  DEFAULT_LLM_LOCALE,
  DEFAULT_LLM_SYSTEM_POLICY_ZH_CN,
  LLMProviderError,
} from "./ai/llm-provider.js";

export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  LLMAssistantMessage,
  LLMFinishReason,
  LLMGenerationRequest,
  LLMGenerationResult,
  LLMMessage,
  LLMProvider,
  LLMProviderErrorCode,
  LLMProviderErrorOptions,
  LLMRole,
  LLMSystemMessage,
  LLMTokenUsage,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolMessage,
  LLMUserMessage,
} from "./ai/llm-provider.js";

export {
  AI_READ_TOOL_CONTRACTS,
  AI_READ_TOOL_NAMES,
  AiReadToolEmptySchema,
  AiReadToolErrorSchema,
  GetBestSellersTool,
  GetInventoryRisksTool,
  GetProductDetailsTool,
  GetProductPerformanceTool,
  GetSalesSummaryTool,
  GetSalesTrendTool,
} from "./ai/read-tools.schema.js";

export { AiChatRequestSchema, AiChatResponseSchema } from "./ai/chat-api.schema.js";
export type { AiChatRequest, AiChatResponse } from "./ai/chat-api.schema.js";
export type {
  AiReadToolContract,
  AiReadToolEmpty,
  AiReadToolError,
  AiReadToolName,
  AiReadToolSchema,
} from "./ai/read-tools.schema.js";

export {
  INVENTORY_ALERT_CONFIRMATION_PROTOCOL,
  INVENTORY_ALERT_CONFIRMATION_TTL_MS,
  InventoryAlertUpdateBindingSchema,
  InventoryAlertUpdateCancelCommandSchema,
  InventoryAlertUpdateConfirmCommandSchema,
  InventoryAlertUpdateConfirmedSchema,
  InventoryAlertUpdateCancelledSchema,
  InventoryAlertUpdateConflictSchema,
  InventoryAlertUpdateExpiredSchema,
  InventoryAlertUpdateOutcomeSchema,
  InventoryAlertUpdatePreviewSchema,
  hasInventoryAlertUpdateConflict,
  isInventoryAlertConfirmationExpired,
  matchesInventoryAlertConfirmationActor,
} from "./inventory/inventory-alert-update.schema.js";

export type {
  InventoryAlertActor,
  InventoryAlertSkuSnapshot,
  InventoryAlertUpdateBinding,
  InventoryAlertUpdateCancelCommand,
  InventoryAlertUpdateConfirmCommand,
  InventoryAlertUpdateOutcome,
  InventoryAlertUpdatePreview,
} from "./inventory/inventory-alert-update.schema.js";
