import { Module } from "@nestjs/common";

import { AnalyticsLayoutService } from "../../analytics/analytics-layout.service.js";
import { AnalyticsModule } from "../../analytics/analytics.module.js";
import { MonitoringModule } from "../../monitoring/monitoring.module.js";
import { MonitoringService } from "../../monitoring/monitoring.service.js";
import { AI_ACTION_STORE, AiModule } from "../ai.module.js";
import { PrismaInventoryAlertUpdateRepository } from "../tools/inventory-alert-update.repository.js";
import { AgentActionController } from "./agent-action.controller.js";
import { AgentActionService } from "./agent-action.service.js";
import type { AgentActionStore } from "./agent-action-store.js";

// 执行放在独立模块：监听模块依赖 AI 模块，AI 模块不能反过来依赖监听模块。
@Module({
  imports: [AiModule, AnalyticsModule, MonitoringModule],
  controllers: [AgentActionController],
  providers: [
    {
      provide: AgentActionService,
      useFactory: (
        store: AgentActionStore,
        monitoring: MonitoringService,
        layouts: AnalyticsLayoutService,
      ) =>
        new AgentActionService(
          store,
          new PrismaInventoryAlertUpdateRepository(),
          monitoring,
          layouts,
        ),
      inject: [AI_ACTION_STORE, MonitoringService, AnalyticsLayoutService],
    },
  ],
})
export class AgentActionsModule {}
