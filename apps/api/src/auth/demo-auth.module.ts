import { Module } from "@nestjs/common";

import { DemoAuthController } from "./demo-auth.controller.js";
import { DEMO_AUTH_CONFIG, readDemoAuthConfig } from "./demo-auth.config.js";
import { DemoAuthService } from "./demo-auth.service.js";

@Module({
  controllers: [DemoAuthController],
  providers: [
    DemoAuthService,
    {
      provide: DEMO_AUTH_CONFIG,
      useFactory: () => readDemoAuthConfig(process.env),
    },
  ],
  exports: [DemoAuthService],
})
export class DemoAuthModule {}
