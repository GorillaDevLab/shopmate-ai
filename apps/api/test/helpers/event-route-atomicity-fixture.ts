import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { TENANT_ROLE_PERMISSIONS, type TenantContext } from "@shopmate/contracts";
import { disconnectPrismaClient } from "@shopmate/database";
import { vi } from "vitest";
import {
  childDatabase,
  migrate,
  tenantEnvironment,
} from "../../../../packages/database/test/helpers/event-decision-concurrency-fixture.mjs";
import {
  EventDecisionsApiFixture,
  binding,
  observedAt,
  window,
} from "../../../../packages/database/test/helpers/event-decisions-api-fixture.mjs";
import {
  prepareTenantApiRuntime,
  prepareMetricApiRuntime,
  prepareEventDecisionRuntime,
} from "../../../../packages/database/test/helpers/tenant-api-fixture.mjs";
import { EventDecisionUnitOfWork } from "../../src/events/event-decision-unit-of-work.js";
import { EventDecisionRuntimeService } from "../../src/events/event-decision-runtime.service.js";
import { MetricRuntimeService } from "../../src/metrics/metric-runtime.service.js";
import { AuthPermission, createAuthContext } from "../../src/auth/contracts/index.js";
import { signDemoSession } from "../../src/auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../../src/auth/session/demo-session-cookie.js";

export { binding, observedAt };
export const actor: TenantContext = {
  userId: "event-runtime-human",
  merchantId: "event-runtime-merchant",
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  role: "OWNER",
  permissions: TENANT_ROLE_PERMISSIONS.OWNER,
};
export const identity = createAuthContext({ ...actor, permissions: Object.values(AuthPermission) });
export interface AtomicityFixture {
  app: INestApplication;
  source: EventDecisionsApiFixture;
  uow: EventDecisionUnitOfWork;
  runtime: EventDecisionRuntimeService;
  cookie: string;
}
async function environment(url: string, signingKey: string) {
  const runtimeUrl = await prepareTenantApiRuntime(url);
  const metrics = {
    ...(await prepareMetricApiRuntime(url)),
    EVENT_DECISION_DATABASE_URL: await prepareEventDecisionRuntime(url),
  };
  const values = tenantEnvironment(process.env, url, runtimeUrl, metrics);
  Object.keys(process.env)
    .filter((key) => !(key in values))
    .forEach((key) => vi.stubEnv(key, undefined));
  Object.entries(values).forEach(([key, value]) => vi.stubEnv(key, value));
  const auth = {
    NODE_ENV: "test",
    DEMO_AUTH_EMAIL: "atomicity@example.test",
    DEMO_AUTH_PASSWORD: randomBytes(24).toString("hex"),
    DEMO_AUTH_USER_ID: actor.userId,
    DEMO_AUTH_MERCHANT_ID: actor.merchantId,
    DEMO_SESSION_SECRET: signingKey,
  };
  Object.entries(auth).forEach(([key, value]) => vi.stubEnv(key, value));
}
interface OwnedApp {
  module?: TestingModule;
  app?: INestApplication;
}
async function startApp(owned: OwnedApp) {
  const [{ AppModule }, { configureApp }] = await Promise.all([
    import("../../src/app.module.js"),
    import("../../src/app.config.js"),
  ]);
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  owned.module = module;
  const app = module.createNestApplication();
  owned.app = app;
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return {
    app,
    metrics: module.get(MetricRuntimeService),
    runtime: module.get(EventDecisionRuntimeService),
    uow: module.get(EventDecisionUnitOfWork),
  };
}
async function disposeAtomicity(
  workFailures: unknown[],
  disposers: Array<() => void | Promise<void>>,
) {
  const failures: unknown[] = [];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError([...workFailures, ...failures], "Atomicity fixture cleanup failed");
}
export async function withAtomicity(work: (fixture: AtomicityFixture) => Promise<void>) {
  await childDatabase(async ({ admin, url }) => {
    await migrate(admin);
    const source = new EventDecisionsApiFixture(url.toString());
    const owned: OwnedApp = {};
    const workFailures: unknown[] = [];
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External transport prohibited"));
    try {
      await source.initialize();
      await source.seed();
      const signingKey = randomBytes(48).toString("hex");
      await environment(url.toString(), signingKey);
      const started = await startApp(owned);
      const provisioned = await started.metrics.provisionDefinitions({ actor, binding });
      if (!provisioned.ok)
        throw new Error(`Metric definition fixture unavailable: ${JSON.stringify(provisioned)}`);
      const cookie = `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession(identity, signingKey, 3600).token}`;
      await work({ ...started, source, cookie });
      if (transport.mock.calls.length) throw new Error("Unexpected vendor transport");
    } catch (error) {
      workFailures.push(error);
      throw error;
    } finally {
      await disposeAtomicity(workFailures, [
        () => (owned.app ? owned.app.close() : owned.module?.close()),
        disconnectPrismaClient,
        () => source.close(),
        () => {
          vi.unstubAllEnvs();
        },
        () => {
          transport.mockRestore();
        },
      ]);
    }
  });
}
export function evaluateDefault(fixture: AtomicityFixture) {
  return fixture.runtime.evaluate({
    identity,
    workspaceId: actor.workspaceId,
    storeId: binding.storeId,
    externalSkuId: "one",
    window,
    observedAt,
    recipientId: "event-runtime-recipient",
  });
}
