import { Module } from "@nestjs/common";
import { DebugReportModule } from "./debug-report/debug-report.module.js";

import { AnalyticsModule } from "./analytics/analytics.module.js";
import { DemoAuthModule } from "./auth/demo-auth.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProductModule } from "./products/product.module.js";
import { AiModule } from "./ai/ai.module.js";
import { DashboardLayoutModule } from "./dashboard-layout/dashboard-layout.module.js";
import { MonitoringModule } from "./monitoring/monitoring.module.js";

@Module({
  imports: [
    DebugReportModule,
    HealthModule,
    DemoAuthModule,
    ProductModule,
    AnalyticsModule,
    AiModule,
    DashboardLayoutModule,
    MonitoringModule,
  ],
})
export class AppModule {}
