import { Injectable } from "@nestjs/common";
import {
  findDemoFailureRules,
  createDemoFailureRule,
  removeDemoFailureRule,
} from "@shopmate/database";
export const DEMO_FAILURE_RULE_REPOSITORY = Symbol("DEMO_FAILURE_RULE_REPOSITORY");
export interface DemoFailureRuleRepository {
  findDemoFailureRules: typeof findDemoFailureRules;
  createDemoFailureRule: typeof createDemoFailureRule;
  removeDemoFailureRule: typeof removeDemoFailureRule;
}
@Injectable()
export class DatabaseDemoFailureRuleRepository implements DemoFailureRuleRepository {
  readonly findDemoFailureRules = findDemoFailureRules;
  readonly createDemoFailureRule = createDemoFailureRule;
  readonly removeDemoFailureRule = removeDemoFailureRule;
}
