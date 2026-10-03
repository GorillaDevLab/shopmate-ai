import { Inject, Injectable } from "@nestjs/common";
import { DatabaseMockConnectorAccessResolver } from "../integrations/mock/database-mock-connector-access-resolver.js";
import { MockConnectorFactory } from "../integrations/mock/mock-connector-factory.js";
import { PersistentMockClock } from "../integrations/mock/persistent-mock-clock.js";
import {
  DEMO_COMMERCE_REPOSITORY,
  type DemoCommerceRepository,
} from "./demo-commerce.repository.js";
import { DEMO_COMMERCE_ENV, type DemoCommerceEnvironment } from "./demo-commerce.environment.js";

@Injectable()
export class DemoCommerceConnectorHost {
  constructor(
    @Inject(DEMO_COMMERCE_REPOSITORY) private readonly repository: DemoCommerceRepository,
    @Inject(DEMO_COMMERCE_ENV) private readonly environment: DemoCommerceEnvironment,
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
    ).open(identity, storeId, options);
  }
}
