import { Module } from "@nestjs/common";

import { AnalyticsModule } from "./analytics/analytics.module.js";
import { DemoAuthModule } from "./auth/demo-auth.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProductModule } from "./products/product.module.js";
import { AiModule } from "./ai/ai.module.js";

@Module({
  imports: [HealthModule, DemoAuthModule, ProductModule, AnalyticsModule, AiModule],
})
export class AppModule {}
