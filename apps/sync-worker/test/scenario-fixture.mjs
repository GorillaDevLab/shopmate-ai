import assert from "node:assert/strict";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { openingTime } from "@shopmate/api/mock-generator";
import { createScenarioConfig } from "../../api/dist/integrations/mock/mock-scenario-plans.js";
import { createMockSourceWorker } from "@shopmate/database/mock-platform";
import { createMockSourceReadPorts } from "@shopmate/database/mock-platform-read";
import { SyncWorkerPorts } from "@shopmate/database/sync-host";
import {
  createSyncDatabase,
  closeSyncDatabase,
} from "../../../packages/database/test/helpers/sync-host-fixture.mjs";
import {
  scopeFor,
  configFor,
  hashConfig,
  sourceEnv,
  loginUrl,
  createSourceSession,
  grantSource,
  readerActor,
} from "../../../packages/database/test/helpers/mock-platform-fixture.mjs";
import {
  grantControl,
  maintenanceClient,
} from "../../../packages/database/test/helpers/mock-source-control-fixture.mjs";
import { publishProfile, createProfileGrant } from "./profile-fixture.mjs";

async function scenarioControl(database) {
  await grantControl(database.admin, "scenario_pipeline_app");
  await database.admin.query(
    'GRANT SELECT,INSERT ON demo."DemoScenarioRun",demo."DemoScenarioRunAudit" TO scenario_pipeline_app',
  );
  await database.admin.query(
    "GRANT EXECUTE ON FUNCTION demo.has_scenario_access(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BOOLEAN) TO scenario_pipeline_app",
  );
}

export async function createScenarioFixture() {
  const database = await createSyncDatabase("worker");
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    SYNC_WORKER_DATABASE_URL: process.env.SYNC_WORKER_DATABASE_URL,
  };
  const env = { ...sourceEnv(database.url), MOCK_SOURCE_CURSOR_KEY: "s".repeat(32) };
  const fixture = {
    database,
    admin: database.admin,
    env,
    hosts: new Set(),
    previous,
  };
  try {
    await scenarioControl(database);
    process.env.DATABASE_URL = loginUrl(database.url, "scenario_pipeline_app");
    process.env.SYNC_WORKER_DATABASE_URL = loginUrl(database.url, "sync_worker_login");
    fixture.repo = await import("@shopmate/database");
    fixture.sources = createMockSourceReadPorts(env);
    fixture.context = {
      env,
      admin: maintenanceClient(database.admin, readerActor.userId),
      worker: createMockSourceWorker(env),
    };
    return fixture;
  } catch (error) {
    await closeScenarioFixture(fixture);
    throw error;
  }
}

export async function closeScenarioFixture(fixture) {
  const cleanup = [
    ...[...fixture.hosts].map((host) => host.close()),
    fixture.sources?.close(),
    fixture.context?.worker.close(),
    fixture.repo?.disconnectPrismaClient(),
  ];
  const results = await Promise.allSettled(cleanup);
  for (const [key, value] of Object.entries(fixture.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeSyncDatabase(fixture.database);
  const errors = results.filter((result) => result.status === "rejected");
  if (errors.length) throw new AggregateError(errors.map((result) => result.reason));
}

function scenarioScope() {
  const suffix = randomUUID().slice(0, 8);
  return {
    ...scopeFor(),
    storeId: `scenario-store-${suffix}`,
    sessionId: `scenario-session-${suffix}`,
    connectionId: `scenario-connection-${suffix}`,
    externalStoreId: `mock/scenario.${suffix}`,
  };
}

async function loadScenario(fixture, scope, id, options) {
  const days = options.days ?? 14;
  const baseline = {
    ...configFor(scope, "mature", days),
    dailyOrders: options.dailyOrders ?? 12,
    productCount: options.productCount ?? 6,
  };
  const config = createScenarioConfig(baseline, id, options.startDay ?? 3, options.endDay ?? 9);
  const until =
    options.until ?? new Date(Date.parse(config.historyStart) + days * 86400000).toISOString();
  const runId = `scenario-run-${randomUUID()}`;
  const result = await fixture.repo.loadDemoScenario(readerActor, scope.storeId, {
    runId,
    confirmSessionId: scope.sessionId,
    expectedRevision: 0,
    expectedGeneration: 0,
    config,
    configHash: hashConfig(config),
    generatorVersion: "mock-source-v2",
    clockNow: new Date(until),
  });
  assert.equal(result.status, "WRITTEN");
  assert.equal(result.view.generation, 1);
  return { config, until, runId, revision: result.view.revision };
}

export async function prepareScenario(fixture, id, options = {}) {
  const scope = scenarioScope();
  await createSourceSession(fixture.admin, scope, "mature", options.days ?? 14);
  const loaded = await loadScenario(fixture, scope, id, options);
  scope.generation = 1;
  const actor = { grantId: `scenario-source-${scope.sessionId}` };
  await grantSource(fixture.admin, scope, actor.grantId);
  assert.equal((await fixture.context.worker.initializeGeneration(actor, scope)).status, "CREATED");
  const state = {
    ...loaded,
    scope,
    actor,
    opening: new Date(openingTime(loaded.config)).toISOString(),
  };
  state.grant = await createProfileGrant(fixture.admin, state);
  return state;
}

export async function publishScenario(fixture, state) {
  return publishProfile(fixture.context, state);
}

export async function connectScenario(fixture, state) {
  const host = await SyncWorkerPorts.connectGrant(state.grant);
  fixture.hosts.add(host);
  return host;
}

export async function advanceScenario(fixture, state, durationMs) {
  const result = await fixture.repo.advanceDemoSession(readerActor, state.scope.storeId, {
    expectedRevision: state.revision,
    durationMs,
  });
  assert.equal(result.status, "WRITTEN");
  state.revision = result.record.revision;
  return result.record.clockNow.toISOString();
}
