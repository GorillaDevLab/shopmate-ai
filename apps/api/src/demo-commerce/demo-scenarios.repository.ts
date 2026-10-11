import { Injectable } from "@nestjs/common";
import { findDemoScenarios, loadDemoScenario } from "@shopmate/database";
export const DEMO_SCENARIO_REPOSITORY = Symbol("DEMO_SCENARIO_REPOSITORY");
export interface DemoScenarioRepository {
  findDemoScenarios: typeof findDemoScenarios;
  loadDemoScenario: typeof loadDemoScenario;
}
@Injectable()
export class DatabaseDemoScenarioRepository implements DemoScenarioRepository {
  readonly findDemoScenarios = findDemoScenarios;
  readonly loadDemoScenario = loadDemoScenario;
}
