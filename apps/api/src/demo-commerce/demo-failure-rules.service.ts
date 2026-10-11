import { Inject, Injectable } from "@nestjs/common";
import {
  DemoFailureRuleCreateSchema,
  DemoFailureRuleRemoveSchema,
  DemoFailureRuleTimestampSchema,
  MockReadFailureRulesSchema,
  TenantIdSchema,
  TENANT_ROLE_PERMISSIONS,
} from "@shopmate/contracts";
import type { DemoActor, DemoFailureRuleResult } from "@shopmate/database";
import { z } from "zod";
import {
  DEMO_COMMERCE_REPOSITORY,
  type DemoCommerceRepository,
} from "./demo-commerce.repository.js";
import {
  DEMO_FAILURE_RULE_REPOSITORY,
  type DemoFailureRuleRepository,
} from "./demo-failure-rules.repository.js";
import { DEMO_COMMERCE_ENV, type DemoCommerceEnvironment } from "./demo-commerce.environment.js";
import { databaseCall, demoError, validateResponse } from "./demo-commerce.errors.js";
import { validateStore } from "./demo-commerce.record.js";

const counter = z.number().int().min(0).max(2_147_483_647);
const viewSchema = z
  .strictObject({
    sessionId: TenantIdSchema,
    generation: counter,
    revision: counter,
    clockNow: DemoFailureRuleTimestampSchema,
    rules: MockReadFailureRulesSchema,
  })
  .readonly();
@Injectable()
export class DemoFailureRulesService {
  constructor(
    @Inject(DEMO_COMMERCE_REPOSITORY) private readonly sessions: DemoCommerceRepository,
    @Inject(DEMO_FAILURE_RULE_REPOSITORY) private readonly rules: DemoFailureRuleRepository,
    @Inject(DEMO_COMMERCE_ENV) private readonly environment: DemoCommerceEnvironment,
  ) {}
  async get(actor: DemoActor, storeId: string) {
    this.enabled(storeId);
    const view = await databaseCall(() => this.rules.findDemoFailureRules(actor, storeId));
    if (!view) throw demoError(404);
    return validateResponse(() => viewSchema.parse(view));
  }
  async create(actor: DemoActor, storeId: string, input: unknown) {
    this.enabled(storeId);
    const command = parse(DemoFailureRuleCreateSchema, input);
    await this.manage(actor, storeId);
    return this.write(() => this.rules.createDemoFailureRule(actor, storeId, command));
  }
  async remove(actor: DemoActor, storeId: string, input: unknown) {
    this.enabled(storeId);
    const command = parse(DemoFailureRuleRemoveSchema, input);
    await this.manage(actor, storeId);
    return this.write(() => this.rules.removeDemoFailureRule(actor, storeId, command));
  }
  private enabled(storeId: string): void {
    if (!this.environment.enabled || !this.environment.origin) throw demoError(404);
    parse(TenantIdSchema, storeId);
  }
  private async manage(actor: DemoActor, storeId: string): Promise<void> {
    const record = await databaseCall(() => this.sessions.findDemoStore(actor, storeId));
    if (!record) throw demoError(404);
    const access = validateResponse(() => validateStore(record, actor, storeId));
    if (!TENANT_ROLE_PERMISSIONS[access.role].includes("demo:manage")) throw demoError(403);
  }
  private async write(action: () => Promise<DemoFailureRuleResult>) {
    const result = await databaseCall(action);
    if (result.status !== "WRITTEN") throw demoError(result.status === "CONFLICT" ? 409 : 404);
    return validateResponse(() => viewSchema.parse(result.view));
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw demoError(400);
  return result.data;
}
