import { Module } from "@nestjs/common";

import { AnalyticsModule } from "./analytics/analytics.module.js";
import { DemoAuthModule } from "./auth/demo-auth.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProductModule } from "./products/product.module.js";
import { AiModule } from "./ai/ai.module.js";
import { DashboardLayoutModule } from "./dashboard-layout/dashboard-layout.module.js";
import { MonitoringModule } from "./monitoring/monitoring.module.js";
import { TenantModule } from "./tenant/tenant.module.js";

@Module({
  imports: [
    HealthModule,
    DemoAuthModule,
    ProductModule,
    AnalyticsModule,
    AiModule,
    DashboardLayoutModule,
    MonitoringModule,
    TenantModule,
  ],
})
export class AppModule {}
