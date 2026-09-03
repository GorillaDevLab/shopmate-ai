import { Module } from "@nestjs/common";

import { AI_LLM_PROVIDER, AiModule } from "../ai/ai.module.js";
import { DeepSeekLLMProvider } from "../ai/providers/deepseek-llm.provider.js";
import { MockLLMProvider } from "../ai/providers/mock-llm.provider.js";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { DashboardService } from "../analytics/dashboard.service.js";
import { LowStockService } from "../analytics/low-stock.service.js";
import { MonitoringController } from "./monitoring.controller.js";
import { MonitoringEvaluator } from "./monitoring-evaluator.js";
import {
  MONITORING_REPOSITORY,
  PrismaMonitoringRepository,
  type MonitoringRepository,
} from "./monitoring.repository.js";
import { MonitoringRuleGenerator } from "./monitoring-rule-generator.js";
import { MonitoringService } from "./monitoring.service.js";

@Module({
  imports: [AnalyticsModule, AiModule],
  controllers: [MonitoringController],
  providers: [
    PrismaMonitoringRepository,
    { provide: MONITORING_REPOSITORY, useExisting: PrismaMonitoringRepository },
    {
      provide: MonitoringEvaluator,
      useFactory: (dashboard: DashboardService, inventory: LowStockService) =>
        new MonitoringEvaluator(dashboard, inventory),
      inject: [DashboardService, LowStockService],
    },
    {
      provide: MonitoringService,
      useFactory: (repository: MonitoringRepository, evaluator: MonitoringEvaluator) =>
        new MonitoringService(repository, evaluator),
      inject: [MONITORING_REPOSITORY, MonitoringEvaluator],
    },
    {
      provide: MonitoringRuleGenerator,
      useFactory: (
        provider: DeepSeekLLMProvider | MockLLMProvider,
        evaluator: MonitoringEvaluator,
      ) => new MonitoringRuleGenerator(provider, evaluator),
      inject: [AI_LLM_PROVIDER, MonitoringEvaluator],
    },
  ],
})
export class MonitoringModule {}
