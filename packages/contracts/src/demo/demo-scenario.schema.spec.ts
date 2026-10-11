import { expect, it } from "vitest";
import { DemoScenarioLoadSchema, DemoScenarioViewSchema } from "./demo-scenario.schema.js";
const command = {
  scenarioId: "SCENARIO_008",
  confirmSessionId: "session-a",
  expectedRevision: 0,
  expectedGeneration: 0,
  observedAt: "2026-01-01T16:00:00.000Z",
};
it("accepts only bounded scenario load commands and normalizes the clock", () => {
  expect(DemoScenarioLoadSchema.parse(command)).toEqual(command);
  expect(
    DemoScenarioLoadSchema.parse({ ...command, observedAt: "2026-01-02T00:00:00+08:00" })
      .observedAt,
  ).toBe(command.observedAt);
  for (const change of [
    { scenarioId: "SCENARIO_016" },
    { expectedGeneration: -1 },
    { expectedRevision: 2147483647 },
    { startDay: 9, endDay: 3 },
    { endDay: 366 },
    { organizationId: "foreign" },
    { observedAt: "0000-01-01T00:00:00Z" },
  ])
    expect(DemoScenarioLoadSchema.safeParse({ ...command, ...change }).success).toBe(false);
});
it("distinguishes database load time from the independently controlled business clock", () => {
  const run = {
    id: "run-a",
    generation: 1,
    loadedRevision: 1,
    configHash: "a".repeat(64),
    loadedAt: "2026-10-11T00:00:00.000Z",
    businessClock: command.observedAt,
    status: "ACTIVE",
    plan: {
      version: "mock-scenario-v1",
      scenarioId: "SCENARIO_009",
      externalStoreId: "m",
      startDay: 3,
      endDay: 9,
      mutations: [],
      campaignSpendBps: 10000,
      campaignConversionBps: 10000,
      delivery: { kind: "INTERRUPT", durationMs: 3600000 },
    },
  };
  const view = {
    sessionId: "session-a",
    generation: 1,
    revision: 1,
    clockNow: command.observedAt,
    runs: [run],
  };
  expect(DemoScenarioViewSchema.parse(view).runs[0]?.businessClock).toBe(command.observedAt);
  expect(
    DemoScenarioViewSchema.safeParse({ ...view, runs: [{ ...run, businessClock: undefined }] })
      .success,
  ).toBe(false);
});
