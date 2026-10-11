import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  DemoScenarioLoadSchema,
  DemoScenarioViewSchema,
  TenantIdSchema,
  TENANT_ROLE_PERMISSIONS,
  type DemoScenarioLoad,
} from "@shopmate/contracts";
import type { DemoActor, DemoScenarioResult } from "@shopmate/database";
import { createScenarioConfig } from "../integrations/mock/mock-scenario-plans.js";
import { generatorVersion } from "../integrations/mock/mock-config.js";
import {
  DEMO_COMMERCE_REPOSITORY,
  type DemoCommerceRepository,
} from "./demo-commerce.repository.js";
import {
  DEMO_SCENARIO_REPOSITORY,
  type DemoScenarioRepository,
} from "./demo-scenarios.repository.js";
import { DEMO_COMMERCE_ENV, type DemoCommerceEnvironment } from "./demo-commerce.environment.js";
import { databaseCall, demoError, validateResponse } from "./demo-commerce.errors.js";
import { validateDemoRecord, validateStore, configHash } from "./demo-commerce.record.js";
@Injectable()
export class DemoScenariosService {
  constructor(
    @Inject(DEMO_COMMERCE_REPOSITORY) private readonly sessions: DemoCommerceRepository,
    @Inject(DEMO_SCENARIO_REPOSITORY) private readonly scenarios: DemoScenarioRepository,
    @Inject(DEMO_COMMERCE_ENV) private readonly environment: DemoCommerceEnvironment,
  ) {}
  async get(actor: DemoActor, storeId: string) {
    this.enabled(storeId);
    const current = await this.current(actor, storeId);
    const view = await databaseCall(() => this.scenarios.findDemoScenarios(actor, storeId));
    if (!view) throw demoError(404);
    return this.view(view, current.record);
  }
  async load(actor: DemoActor, storeId: string, input: unknown) {
    this.enabled(storeId);
    const parsed = DemoScenarioLoadSchema.safeParse(input);
    if (!parsed.success) throw demoError(400);
    await this.manage(actor, storeId);
    const current = await this.current(actor, storeId),
      command = parsed.data;
    if (current.record.id !== command.confirmSessionId) throw demoError(400);
    const source = plannedSource(current.config, command);
    const result: DemoScenarioResult = await databaseCall(() =>
      this.scenarios.loadDemoScenario(actor, storeId, {
        runId: randomUUID(),
        confirmSessionId: command.confirmSessionId,
        expectedRevision: command.expectedRevision,
        expectedGeneration: command.expectedGeneration,
        ...source,
      }),
    );
    if (result.status !== "WRITTEN") throw demoError(result.status === "CONFLICT" ? 409 : 404);
    return this.view(result.view, current.record);
  }
  private enabled(storeId: string) {
    if (!this.environment.enabled || !this.environment.origin) throw demoError(404);
    if (!TenantIdSchema.safeParse(storeId).success) throw demoError(400);
  }
  private async manage(actor: DemoActor, storeId: string) {
    const row = await databaseCall(() => this.sessions.findDemoStore(actor, storeId));
    if (!row) throw demoError(404);
    const access = validateResponse(() => validateStore(row, actor, storeId));
    if (!TENANT_ROLE_PERMISSIONS[access.role].includes("demo:manage")) throw demoError(403);
  }
  private async current(actor: DemoActor, storeId: string) {
    const row = await databaseCall(() => this.sessions.findDemoSession(actor, storeId));
    if (!row) throw demoError(404);
    return validateResponse(() => validateDemoRecord(row, actor, storeId));
  }
  private view(input: unknown, row: { id: string; externalStoreId: string }) {
    return validateResponse(() => {
      const view = DemoScenarioViewSchema.parse(input);
      if (
        view.sessionId !== row.id ||
        view.runs.some((run) => run.plan.externalStoreId !== row.externalStoreId)
      )
        throw new Error("Invalid scenario ownership");
      return view;
    });
  }
}
function plannedSource(
  config: Parameters<typeof createScenarioConfig>[0],
  command: DemoScenarioLoad,
) {
  try {
    const planned = createScenarioConfig(
      config,
      command.scenarioId,
      command.startDay,
      command.endDay,
    );
    const start = Date.parse(planned.historyStart),
      clock = Date.parse(command.observedAt);
    if (clock < start || clock > start + (planned.days + 5) * 86400000) throw demoError(400);
    return {
      config: planned,
      configHash: configHash(planned),
      generatorVersion: generatorVersion(planned),
      clockNow: new Date(command.observedAt),
    };
  } catch (error) {
    if (error instanceof RangeError || (error instanceof Error && error.name === "ZodError"))
      throw demoError(400);
    throw error;
  }
}
