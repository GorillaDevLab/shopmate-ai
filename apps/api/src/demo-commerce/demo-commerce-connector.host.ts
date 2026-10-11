import { Inject, Injectable } from "@nestjs/common";
import { DatabaseMockConnectorAccessResolver } from "../integrations/mock/database-mock-connector-access-resolver.js";
import { MockConnectorFactory } from "../integrations/mock/mock-connector-factory.js";
import { PersistentMockClock } from "../integrations/mock/persistent-mock-clock.js";
import type { PersistentReadBinder } from "../integrations/mock/persistent-read-port.js";
import { DatabasePersistentReadPorts } from "./database-persistent-read-ports.js";
import {
  DEMO_COMMERCE_REPOSITORY,
  type DemoCommerceRepository,
} from "./demo-commerce.repository.js";
import { DEMO_COMMERCE_ENV, type DemoCommerceEnvironment } from "./demo-commerce.environment.js";
import {
  DEMO_FAILURE_RULE_REPOSITORY,
  type DemoFailureRuleRepository,
} from "./demo-failure-rules.repository.js";
import { MockConnectorError } from "../integrations/mock/mock-call.js";

@Injectable()
export class DemoCommerceConnectorHost {
  constructor(
    @Inject(DEMO_COMMERCE_REPOSITORY) private readonly repository: DemoCommerceRepository,
    @Inject(DEMO_COMMERCE_ENV) private readonly environment: DemoCommerceEnvironment,
    @Inject(DatabasePersistentReadPorts) private readonly binder: PersistentReadBinder,
    @Inject(DEMO_FAILURE_RULE_REPOSITORY) private readonly rules: DemoFailureRuleRepository,
  ) {}
  open(identity: unknown, storeId: unknown, options: unknown) {
    // A clock belongs to this selected connector; interleaved sessions never share business time.
    const clock = new PersistentMockClock();
    const resolver = new DatabaseMockConnectorAccessResolver(this.repository, clock);
    const enabled = this.environment.enabled && this.environment.origin !== null;
    return new MockConnectorFactory(
      { appEnv: "demo", enableDemoMode: enabled },
      resolver,
      clock,
      this.binder,
      async (actor, scope) => {
        try {
          const view = await this.rules.findDemoFailureRules(actor, scope.storeId);
          if (!view || view.sessionId !== scope.sessionId || view.generation !== scope.generation)
            throw new MockConnectorError("AUTH_EXPIRED");
          return view.rules;
        } catch (error) {
          if (error instanceof MockConnectorError) throw error;
          throw new MockConnectorError("TEMPORARY");
        }
      },
    ).open(identity, storeId, options);
  }
}
