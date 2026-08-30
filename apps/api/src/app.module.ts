import { Module } from "@nestjs/common";

import { DemoAuthModule } from "./auth/demo-auth.module.js";
import { HealthModule } from "./health/health.module.js";

@Module({
  imports: [HealthModule, DemoAuthModule],
})
export class AppModule {}
