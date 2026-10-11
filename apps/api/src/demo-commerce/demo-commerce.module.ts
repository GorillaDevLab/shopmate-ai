import { Module } from "@nestjs/common";
import { DemoCommerceController } from "./demo-commerce.controller.js";
import { DemoCommerceGuard } from "./demo-commerce.guard.js";
import { DemoCommerceService } from "./demo-commerce.service.js";
import { DEMO_COMMERCE_ENV, readDemoCommerceEnvironment } from "./demo-commerce.environment.js";
import {
  DEMO_COMMERCE_REPOSITORY,
  DatabaseDemoCommerceRepository,
} from "./demo-commerce.repository.js";
import { DemoCommerceConnectorHost } from "./demo-commerce-connector.host.js";
import { DatabasePersistentReadPorts } from "./database-persistent-read-ports.js";
import { DemoFailureRulesController } from "./demo-failure-rules.controller.js";
import { DemoFailureRulesService } from "./demo-failure-rules.service.js";
import {
  DEMO_FAILURE_RULE_REPOSITORY,
  DatabaseDemoFailureRuleRepository,
} from "./demo-failure-rules.repository.js";
@Module({
  controllers: [DemoCommerceController, DemoFailureRulesController],
  providers: [
    DemoCommerceGuard,
    DemoCommerceService,
    DemoFailureRulesService,
    { provide: DEMO_FAILURE_RULE_REPOSITORY, useClass: DatabaseDemoFailureRuleRepository },
    DemoCommerceConnectorHost,
    DatabasePersistentReadPorts,
    { provide: DEMO_COMMERCE_ENV, useFactory: () => readDemoCommerceEnvironment(process.env) },
    { provide: DEMO_COMMERCE_REPOSITORY, useClass: DatabaseDemoCommerceRepository },
  ],
  exports: [DemoCommerceConnectorHost],
})
export class DemoCommerceModule {}
