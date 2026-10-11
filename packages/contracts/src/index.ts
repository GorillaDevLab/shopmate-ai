export type { CommerceConnector } from "./commerce/commerce-connector.js";
export {
  parseConnectorRead,
  parseConnectorPage,
  parseConnectorVerification,
} from "./commerce/connector-validation.js";
export * from "./commerce/connector-common.schema.js";
export * from "./commerce/connector-data.schema.js";
export * from "./commerce/connector-action.schema.js";

export {
  DemoSourceSettingsSchema,
  DemoSessionCreateSchema,
  DemoSessionAdvanceSchema,
  DemoSessionResetSchema,
  DemoSessionDisconnectSchema,
  DemoSessionViewSchema,
} from "./demo/demo-commerce.schema.js";
export type { DemoSourceSettings, DemoSessionView } from "./demo/demo-commerce.schema.js";

export {
  TenantIdSchema,
  TenantRoleSchema,
  TenantPermissionSchema,
  TenantContextSchema,
  TenantResourceSchema,
} from "./tenant/tenant.schema.js";
export type {
  TenantRole,
  TenantPermission,
  TenantContext,
  TenantResource,
} from "./tenant/tenant.schema.js";
export { TENANT_ROLE_PERMISSIONS, canAccessTenantResource } from "./tenant/tenant-policy.js";

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
  ANALYTICS_OVERVIEW_MAX_CHANNELS,
  ANALYTICS_OVERVIEW_MAX_DAYS,
  ANALYTICS_OVERVIEW_TOP_PRODUCTS,
  AnalyticsChannelSchema,
  AnalyticsOverviewResponseSchema,
  AnalyticsProductSchema,
} from "./analytics/analytics-overview.schema.js";
export type {
  AnalyticsChannel,
  AnalyticsOverviewResponse,
  AnalyticsProduct,
} from "./analytics/analytics-overview.schema.js";
export {
  ANALYTICS_MAX_AI_CARDS,
  AnalyticsAiCardSchema,
  AnalyticsCardIdSchema,
  isAnalyticsAiCard,
  AnalyticsCardSpanSchema,
  AnalyticsLayoutReadResponseSchema,
  AnalyticsLayoutSaveRequestSchema,
  AnalyticsLayoutSchema,
  DEFAULT_ANALYTICS_LAYOUT,
} from "./analytics/analytics-layout.schema.js";
export type {
  AnalyticsAiCard,
  AnalyticsBuiltinCard,
  AnalyticsLayoutCard,
  AnalyticsCardId,
  AnalyticsCardSpan,
  AnalyticsLayout,
  AnalyticsLayoutReadResponse,
  AnalyticsLayoutSaveRequest,
} from "./analytics/analytics-layout.schema.js";

export {
  DASHBOARD_COMPONENT_REGISTRY,
  DashboardLayoutCardSchema,
  DashboardLayoutComponentSchema,
  DashboardLayoutSchema,
  DashboardLayoutSizeSchema,
  DashboardLayoutVersionSchema,
  DEFAULT_DASHBOARD_LAYOUT,
  parseDashboardLayout,
} from "./dashboard/dashboard-layout.schema.js";
export type {
  DashboardLayout,
  DashboardLayoutCard,
  DashboardLayoutComponent,
  DashboardLayoutSize,
  DashboardLayoutVersion,
} from "./dashboard/dashboard-layout.schema.js";
export {
  DashboardLayoutReadResponseSchema,
  DashboardLayoutSaveRequestSchema,
} from "./dashboard/dashboard-layout-api.schema.js";
export type {
  DashboardLayoutReadResponse,
  DashboardLayoutSaveRequest,
} from "./dashboard/dashboard-layout-api.schema.js";

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
export {
  DashboardInsightAggregationSchema,
  DashboardInsightDatasetSchema,
  DashboardInsightDimensionSchema,
  DashboardInsightExecuteRequestSchema,
  DashboardInsightExecuteResponseSchema,
  DashboardInsightGenerateRequestSchema,
  DashboardInsightKindSchema,
  DashboardInsightMetricSchema,
  DashboardInsightPreviewResponseSchema,
  DashboardInsightQuerySchema,
  DashboardInsightResultSchema,
  DashboardChartViewSchema,
  getDashboardInsightLayoutViews,
  getDashboardInsightViews,
} from "./ai/dashboard-insight.schema.js";
export type {
  DashboardChartView,
  DashboardInsightKind,
  DashboardInsightGenerateRequest,
  DashboardInsightExecuteRequest,
  DashboardInsightExecuteResponse,
  DashboardInsightPreviewResponse,
  DashboardInsightQuery,
  DashboardInsightResult,
} from "./ai/dashboard-insight.schema.js";
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

export {
  InventoryThresholdRuleSchema,
  MonitoringFrequencySchema,
  MonitoringResourceTypeSchema,
  MonitoringRuleDefinitionSchema,
  MonitoringRuleStatusSchema,
  MonitoringSeveritySchema,
  SalesThresholdRuleSchema,
} from "./monitoring/monitoring-rule.schema.js";
export type {
  MonitoringFrequency,
  MonitoringResourceType,
  MonitoringRuleDefinition,
  MonitoringRuleStatus,
  MonitoringSeverity,
} from "./monitoring/monitoring-rule.schema.js";
export {
  MonitoringEvaluationSchema,
  MonitoringMatchSchema,
  MonitoringNotificationListResponseSchema,
  MonitoringNotificationViewSchema,
  MonitoringReadAllResponseSchema,
  MonitoringReadResponseSchema,
  MonitoringRuleCreateRequestSchema,
  MonitoringRuleListResponseSchema,
  MonitoringRulePreviewRequestSchema,
  MonitoringRulePreviewResponseSchema,
  MonitoringRuleResponseSchema,
  MonitoringRuleRunResponseSchema,
  MonitoringRuleStatusRequestSchema,
  MonitoringRuleViewSchema,
  MonitoringSyncResponseSchema,
  MonitoringUnreadCountResponseSchema,
} from "./monitoring/monitoring-api.schema.js";
export type {
  MonitoringEvaluation,
  MonitoringMatch,
  MonitoringNotificationListResponse,
  MonitoringNotificationView,
  MonitoringReadAllResponse,
  MonitoringReadResponse,
  MonitoringRuleCreateRequest,
  MonitoringRuleListResponse,
  MonitoringRulePreviewRequest,
  MonitoringRulePreviewResponse,
  MonitoringRuleResponse,
  MonitoringRuleRunResponse,
  MonitoringRuleStatusRequest,
  MonitoringRuleView,
  MonitoringSyncResponse,
  MonitoringUnreadCountResponse,
} from "./monitoring/monitoring-api.schema.js";

export type {
  InventoryAlertActor,
  InventoryAlertSkuSnapshot,
  InventoryAlertUpdateBinding,
  InventoryAlertUpdateCancelCommand,
  InventoryAlertUpdateConfirmCommand,
  InventoryAlertUpdateOutcome,
  InventoryAlertUpdatePreview,
} from "./inventory/inventory-alert-update.schema.js";

export {
  DouyinProductCopySchema,
  GeneralProductCopySchema,
  ProductCopyContentSchema,
  ProductCopyOutputSchema,
  ProductCopyRequestSchema,
  ProductCopyTypeSchema,
  ProductDescriptionCopySchema,
  ProductTitleCopySchema,
  XiaohongshuProductCopySchema,
} from "./ai/product-copy.schema.js";

export type {
  ProductCopyContent,
  ProductCopyOutput,
  ProductCopyRequest,
  ProductCopyType,
} from "./ai/product-copy.schema.js";
export { sanitizeDebugData, DebugReportSchema } from "./debug-report.js";
export {
  AssistantRunRequestSchema,
  AssistantRunEventSchema,
  AssistantReplySchema,
} from "./ai/assistant-run.schema.js";
export type {
  AssistantRunRequest,
  AssistantRunEvent,
  AssistantReply,
  AssistantProgress,
} from "./ai/assistant-run.schema.js";
export {
  AssistantIdentitySchema,
  WorkspaceSnapshotSchema,
} from "./ai/assistant-workspace.schema.js";
export type {
  AssistantIdentity,
  WorkspaceSnapshot,
  WorkspaceSession,
  WorkspaceMessage,
} from "./ai/assistant-workspace.schema.js";

export {
  AGENT_ACTION_MAX_PER_REPLY,
  AGENT_ACTION_TTL_MS,
  AgentActionCancelResponseSchema,
  AgentActionConfirmResponseSchema,
  AgentActionKindSchema,
  AgentActionOutcomeSchema,
  AgentActionProposalSchema,
  AgentActionIdSchema,
} from "./ai/agent-actions.schema.js";
export type {
  AgentActionConfirmResponse,
  AgentActionKind,
  AgentActionOutcome,
  AgentActionProposal,
} from "./ai/agent-actions.schema.js";

export {
  ASSISTANT_MEMORY_LIMIT,
  ASSISTANT_MEMORY_MAX_LENGTH,
  ASSISTANT_WORKSPACE_MAX_BYTES,
  AssistantMemoryContentSchema,
  AssistantMemoryListResponseSchema,
  AssistantMemorySchema,
  AssistantWorkspaceReadResponseSchema,
  AssistantWorkspaceSaveRequestSchema,
  AssistantWorkspaceSaveResponseSchema,
} from "./ai/assistant-memory.schema.js";
export type {
  AssistantMemory,
  AssistantMemoryListResponse,
  AssistantWorkspaceReadResponse,
  AssistantWorkspaceSaveRequest,
} from "./ai/assistant-memory.schema.js";
export { MockScenarioIdSchema, MockScenarioPlanSchema } from "./commerce/mock-scenario.schema.js";
export type { MockScenarioPlan, MockScenarioMutation } from "./commerce/mock-scenario.schema.js";
export { DemoScenarioLoadSchema, DemoScenarioViewSchema } from "./demo/demo-scenario.schema.js";
export type { DemoScenarioLoad, DemoScenarioView } from "./demo/demo-scenario.schema.js";
export {
  MockReadMethodSchema,
  MockReadFailureEffectSchema,
  MockReadFailureRuleSchema,
  MockReadFailureRulesSchema,
  DemoFailureRuleTimestampSchema,
  DemoFailureRuleCreateSchema,
  DemoFailureRuleRemoveSchema,
} from "./demo/demo-failure-rules.schema.js";
export type { MockReadFailureRule } from "./demo/demo-failure-rules.schema.js";
