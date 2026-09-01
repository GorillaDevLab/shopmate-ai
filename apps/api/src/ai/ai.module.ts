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
import { AI_READ_TOOL_NAMES } from "@shopmate/contracts";

export const AI_LLM_PROVIDER = Symbol("AI_LLM_PROVIDER");
export const AI_TOOL_REGISTRY = Symbol("AI_TOOL_REGISTRY");
export const AI_BUSINESS_AGENT = Symbol("AI_BUSINESS_AGENT");

@Module({
  imports: [AnalyticsModule, ProductModule],
  controllers: [AiChatController],
  providers: [
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
      ) => {
        const registry = new ToolRegistry({ allowedToolNames: AI_READ_TOOL_NAMES });
        registry.register(createProductDetailsToolRegistration(productService));
        registry.register(createInventoryRisksToolRegistration(lowStockService));
        registry.register(createSalesSummaryToolRegistration(dashboardService));
        registry.register(createSalesTrendToolRegistration(dashboardService));
        registry.register(createBestSellersToolRegistration(performanceService));
        registry.register(createProductPerformanceToolRegistration(performanceService));
        return registry;
      },
      inject: [DashboardService, LowStockService, ProductService, ProductPerformanceService],
    },
    {
      provide: AI_BUSINESS_AGENT,
      useFactory: (provider: DeepSeekLLMProvider | MockLLMProvider, registry: ToolRegistry) =>
        new BusinessAgent(provider, registry),
      inject: [AI_LLM_PROVIDER, AI_TOOL_REGISTRY],
    },
    {
      provide: AiChatService,
      useFactory: (agent: BusinessAgent) => new AiChatService(agent),
      inject: [AI_BUSINESS_AGENT],
    },
  ],
  exports: [AiChatService],
})
export class AiModule {}
