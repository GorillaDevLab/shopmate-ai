import { Injectable } from "@nestjs/common";
import {
  findDemoStore,
  findDemoSession,
  createDemoSession,
  advanceDemoSession,
  resetDemoSession,
  disconnectDemoSession,
} from "@shopmate/database";

export const DEMO_COMMERCE_REPOSITORY = Symbol("DEMO_COMMERCE_REPOSITORY");
export interface DemoCommerceRepository {
  findDemoStore: typeof findDemoStore;
  findDemoSession: typeof findDemoSession;
  createDemoSession: typeof createDemoSession;
  advanceDemoSession: typeof advanceDemoSession;
  resetDemoSession: typeof resetDemoSession;
  disconnectDemoSession: typeof disconnectDemoSession;
}
@Injectable()
export class DatabaseDemoCommerceRepository implements DemoCommerceRepository {
  readonly findDemoStore = findDemoStore;
  readonly findDemoSession = findDemoSession;
  readonly createDemoSession = createDemoSession;
  readonly advanceDemoSession = advanceDemoSession;
  readonly resetDemoSession = resetDemoSession;
  readonly disconnectDemoSession = disconnectDemoSession;
}
