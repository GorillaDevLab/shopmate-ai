import { Module } from "@nestjs/common";

import { AnalyticsModule } from "../analytics/analytics.module.js";
import { ProductModule } from "../products/product.module.js";
import { DashboardService } from "../analytics/dashboard.service.js";
import { LowStockService } from "../analytics/low-stock.service.js";
import { ProductPerformanceService } from "../analytics/product-performance.service.js";
import { ProductService } from "../products/product.service.js";
import { DeepSeekLLMProvider } from "./providers/deepseek-llm.provider.js";
import { MockLLMProvider } from "./providers/mock-llm.provider.js";
import { AiChatController } from "./chat/ai-chat.controller.js";
import { AssistantRunController } from "./chat/assistant-run.controller.js";
import { AiChatService } from "./chat/ai-chat.service.js";
import { BusinessAgent } from "./agent/business-agent.js";
import {
  createBestSellersToolRegistration,
  createProductPerformanceToolRegistration,
  createSalesSummaryToolRegistration,
  createSalesTrendToolRegistration,
} from "./tools/sales-dashboard-read.tools.js";
import {
  createInventoryRisksToolRegistration,
  createProductDetailsToolRegistration,
} from "./tools/inventory-product-read.tools.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import {
  GENERATE_PRODUCT_COPY_TOOL_NAME,
  ProductCopyService,
  createGenerateProductCopyToolRegistration,
} from "./tools/product-copy.tool.js";
import { AI_READ_TOOL_NAMES } from "@shopmate/contracts";
import { DashboardInsightController } from "./insights/dashboard-insight.controller.js";
import { DashboardInsightExecutor } from "./insights/dashboard-insight-executor.js";
import { DashboardInsightService } from "./insights/dashboard-insight.service.js";
import { StoreSalesReader } from "./insights/store-sales-reader.js";
import {
  createStoreCatalogTool,
  createBusinessQueryTool,
  createBusinessChartTool,
} from "./tools/business-query.tools.js";

import { AnalyticsOverviewService } from "../analytics/analytics-overview.service.js";
import {
  BUSINESS_OVERVIEW_TOOL_NAME,
  createBusinessOverviewTool,
} from "./tools/business-overview.tool.js";

import { AgentActionStore } from "./actions/agent-action-store.js";
import {
  PROPOSE_ACTION_TOOL_NAMES,
  createProposeInventoryThresholdTool,
  createProposeMonitoringRuleTool,
  createProposeSaveChartTool,
} from "./actions/propose-action.tools.js";
import { PrismaInventoryAlertUpdateRepository } from "./tools/inventory-alert-update.repository.js";

export const AI_LLM_PROVIDER = Symbol("AI_LLM_PROVIDER");
export const AI_ACTION_STORE = Symbol("AI_ACTION_STORE");
export const AI_TOOL_REGISTRY = Symbol("AI_TOOL_REGISTRY");
export const AI_BUSINESS_AGENT = Symbol("AI_BUSINESS_AGENT");

@Module({
  imports: [AnalyticsModule, ProductModule],
  controllers: [AiChatController, DashboardInsightController, AssistantRunController],
  providers: [
    { provide: AI_ACTION_STORE, useFactory: () => new AgentActionStore() },
    {
      provide: AI_LLM_PROVIDER,
      useFactory: () => {
        if (!process.env.DEEPSEEK_API_KEY?.trim()) return new MockLLMProvider();
        return new DeepSeekLLMProvider();
      },
    },
    {
      provide: AI_TOOL_REGISTRY,
      useFactory: (
        dashboardService: Parameters<typeof createSalesSummaryToolRegistration>[0],
        lowStockService: Parameters<typeof createInventoryRisksToolRegistration>[0],
        productService: Parameters<typeof createProductDetailsToolRegistration>[0],
        performanceService: Parameters<typeof createBestSellersToolRegistration>[0],
        provider: DeepSeekLLMProvider | MockLLMProvider,
        insightExecutor: DashboardInsightExecutor,
        overviewService: AnalyticsOverviewService,
        actionStore: AgentActionStore,
      ) => {
        const registry = new ToolRegistry({
          allowedToolNames: [
            ...AI_READ_TOOL_NAMES,
            GENERATE_PRODUCT_COPY_TOOL_NAME,
            "get_store_catalog",
            "query_business_data",
            "create_business_chart",
            BUSINESS_OVERVIEW_TOOL_NAME,
            ...PROPOSE_ACTION_TOOL_NAMES,
          ],
        });
        registry.register(createProductDetailsToolRegistration(productService));
        registry.register(createInventoryRisksToolRegistration(lowStockService));
        registry.register(createSalesSummaryToolRegistration(dashboardService));
        registry.register(createSalesTrendToolRegistration(dashboardService));
        registry.register(createBestSellersToolRegistration(performanceService));
        registry.register(createProductPerformanceToolRegistration(performanceService));
        registry.register(createStoreCatalogTool(new StoreSalesReader()));
        registry.register(createBusinessQueryTool(insightExecutor));
        registry.register(createBusinessChartTool(insightExecutor));
        registry.register(createBusinessOverviewTool(overviewService));
        registry.register(
          createProposeInventoryThresholdTool(
            actionStore,
            new PrismaInventoryAlertUpdateRepository(),
          ),
        );
        registry.register(createProposeMonitoringRuleTool(actionStore));
        registry.register(createProposeSaveChartTool(actionStore));

        const productCopyService = new ProductCopyService(productService, provider);
        registry.register(createGenerateProductCopyToolRegistration(productCopyService));

        return registry;
      },
      inject: [
        DashboardService,
        LowStockService,
        ProductService,
        ProductPerformanceService,
        AI_LLM_PROVIDER,
        DashboardInsightExecutor,
        AnalyticsOverviewService,
        AI_ACTION_STORE,
      ],
    },
    {
      provide: AI_BUSINESS_AGENT,
      useFactory: (provider: DeepSeekLLMProvider | MockLLMProvider, registry: ToolRegistry) =>
        new BusinessAgent(provider, registry),
      inject: [AI_LLM_PROVIDER, AI_TOOL_REGISTRY],
    },
    {
      provide: AiChatService,
      useFactory: (agent: BusinessAgent, registry: ToolRegistry) =>
        new AiChatService(agent, registry),
      inject: [AI_BUSINESS_AGENT, AI_TOOL_REGISTRY],
    },
    {
      provide: DashboardInsightExecutor,
      useFactory: (
        dashboard: DashboardService,
        performance: ProductPerformanceService,
        inventory: LowStockService,
      ) => new DashboardInsightExecutor(dashboard, performance, inventory),
      inject: [DashboardService, ProductPerformanceService, LowStockService],
    },
    {
      provide: DashboardInsightService,
      useFactory: (
        provider: DeepSeekLLMProvider | MockLLMProvider,
        executor: DashboardInsightExecutor,
      ) => new DashboardInsightService(provider, executor),
      inject: [AI_LLM_PROVIDER, DashboardInsightExecutor],
    },
  ],
  exports: [AiChatService, AI_LLM_PROVIDER, AI_ACTION_STORE],
})
export class AiModule {}
