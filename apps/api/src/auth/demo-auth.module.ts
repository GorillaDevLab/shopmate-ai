import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { MerchantScopeGuard } from "./access/merchant-scope.guard.js";
import { DemoAuthController } from "./demo-auth.controller.js";
import { DEMO_AUTH_CONFIG, readOptionalDemoAuthConfig } from "./demo-auth.config.js";
import { DemoAuthService } from "./demo-auth.service.js";

@Module({
  controllers: [DemoAuthController],
  providers: [
    DemoAuthService,
    {
      provide: APP_GUARD,
      useClass: MerchantScopeGuard,
    },
    {
      provide: DEMO_AUTH_CONFIG,
      useFactory: () => readOptionalDemoAuthConfig(process.env),
    },
  ],
  exports: [DemoAuthService],
})
export class DemoAuthModule {}
