import { Module } from "@nestjs/common";

import { DemoAuthController } from "./demo-auth.controller.js";
import { DEMO_AUTH_CONFIG, readOptionalDemoAuthConfig } from "./demo-auth.config.js";
import { DemoAuthService } from "./demo-auth.service.js";

@Module({
  controllers: [DemoAuthController],
  providers: [
    DemoAuthService,
    {
      provide: DEMO_AUTH_CONFIG,
      useFactory: () => readOptionalDemoAuthConfig(process.env),
    },
  ],
  exports: [DemoAuthService],
})
export class DemoAuthModule {}
