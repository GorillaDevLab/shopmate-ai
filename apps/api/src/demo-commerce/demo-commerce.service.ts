import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  DemoSessionCreateSchema,
  DemoSessionAdvanceSchema,
  DemoSessionResetSchema,
  DemoSessionDisconnectSchema,
  TenantIdSchema,
  TENANT_ROLE_PERMISSIONS,
  type DemoSourceSettings,
} from "@shopmate/contracts";
import type { DemoActor, DemoMutationResult, DemoStoreAccess } from "@shopmate/database";
import { z } from "zod";
import { GENERATOR_VERSION, MockConfigSchema } from "../integrations/mock/mock-config.js";
import { DEMO_COMMERCE_ENV, type DemoCommerceEnvironment } from "./demo-commerce.environment.js";
import {
  DEMO_COMMERCE_REPOSITORY,
  type DemoCommerceRepository,
} from "./demo-commerce.repository.js";
import {
  configHash,
  validateDemoRecord,
  validateStore,
  validateMutationResult,
} from "./demo-commerce.record.js";
import { databaseCall, demoError, validateResponse } from "./demo-commerce.errors.js";

@Injectable()
export class DemoCommerceService {
  constructor(
    @Inject(DEMO_COMMERCE_REPOSITORY) private readonly repository: DemoCommerceRepository,
    @Inject(DEMO_COMMERCE_ENV) private readonly environment: DemoCommerceEnvironment,
  ) {}
  async get(actor: DemoActor, storeId: string) {
    this.requireEnabled(storeId);
    return (await this.current(actor, storeId)).view;
  }
  async create(actor: DemoActor, storeId: string, input: unknown) {
    this.requireEnabled(storeId);
    const command = parseCommand(DemoSessionCreateSchema, input);
    const access = await this.manage(actor, storeId);
    const id = randomUUID();
    const connectionId = randomUUID();
    const externalStoreId = `mock:${storeId}`;
    const source = sourceInput(
      access,
      connectionId,
      externalStoreId,
      command.settings,
      command.observedAt,
    );
    return this.write(actor, storeId, () =>
      this.repository.createDemoSession(actor, storeId, {
        id,
        connectionId,
        externalStoreId,
        ...source,
      }),
    );
  }
  async advance(actor: DemoActor, storeId: string, input: unknown) {
    this.requireEnabled(storeId);
    const command = parseCommand(DemoSessionAdvanceSchema, input);
    await this.manage(actor, storeId);
    return this.write(actor, storeId, () =>
      this.repository.advanceDemoSession(actor, storeId, command),
    );
  }
  async reset(actor: DemoActor, storeId: string, input: unknown) {
    this.requireEnabled(storeId);
    const command = parseCommand(DemoSessionResetSchema, input);
    const access = await this.manage(actor, storeId);
    const { record } = await this.confirm(actor, storeId, command.confirmSessionId);
    const source = sourceInput(
      access,
      record.connectionId,
      record.externalStoreId,
      command.settings,
      command.observedAt,
    );
    return this.write(actor, storeId, () =>
      this.repository.resetDemoSession(actor, storeId, {
        expectedRevision: command.expectedRevision,
        ...source,
      }),
    );
  }
  async disconnect(actor: DemoActor, storeId: string, input: unknown) {
    this.requireEnabled(storeId);
    const command = parseCommand(DemoSessionDisconnectSchema, input);
    await this.manage(actor, storeId);
    await this.confirm(actor, storeId, command.confirmSessionId);
    return this.write(actor, storeId, () =>
      this.repository.disconnectDemoSession(actor, storeId, command.expectedRevision),
    );
  }
  private requireEnabled(storeId: string): void {
    if (!this.environment.enabled || !this.environment.origin) throw demoError(404);
    parseCommand(TenantIdSchema, storeId);
  }
  private async current(actor: DemoActor, storeId: string) {
    const record = await databaseCall(() => this.repository.findDemoSession(actor, storeId));
    if (!record) throw demoError(404);
    return validateResponse(() => validateDemoRecord(record, actor, storeId));
  }
  private async manage(actor: DemoActor, storeId: string) {
    const record = await databaseCall(() => this.repository.findDemoStore(actor, storeId));
    if (!record) throw demoError(404);
    const access = validateResponse(() => validateStore(record, actor, storeId));
    if (!TENANT_ROLE_PERMISSIONS[access.role].includes("demo:manage")) throw demoError(403);
    return access;
  }
  private async confirm(actor: DemoActor, storeId: string, id: string) {
    const current = await this.current(actor, storeId);
    if (current.record.id !== id) throw demoError(400);
    return current;
  }
  private async write(
    actor: DemoActor,
    storeId: string,
    action: () => Promise<DemoMutationResult>,
  ) {
    const input = await databaseCall(action);
    const result = validateResponse(() => validateMutationResult(input));
    if (result.status !== "WRITTEN") throw demoError(result.status === "CONFLICT" ? 409 : 404);
    return validateResponse(() => validateDemoRecord(result.record, actor, storeId).view);
  }
}
function parseCommand<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw demoError(400);
  return parsed.data;
}
function sourceInput(
  access: DemoStoreAccess,
  connectionId: string,
  externalStoreId: string,
  settings: DemoSourceSettings,
  observedAt: string,
) {
  const config = parseCommand(MockConfigSchema, {
    ...settings,
    binding: {
      organizationId: access.organizationId,
      workspaceId: access.workspaceId,
      storeId: access.storeId,
      connectionId,
      externalStoreId,
    },
  });
  return {
    config,
    configHash: configHash(config),
    generatorVersion: GENERATOR_VERSION,
    clockNow: new Date(observedAt),
  };
}
