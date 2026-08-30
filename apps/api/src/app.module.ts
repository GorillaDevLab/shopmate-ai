import { Module } from "@nestjs/common";

import { DemoAuthModule } from "./auth/demo-auth.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProductModule } from "./products/product.module.js";

@Module({
  imports: [HealthModule, DemoAuthModule, ProductModule],
})
export class AppModule {}
